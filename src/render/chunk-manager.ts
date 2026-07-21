import * as THREE from 'three';
import type { BlockDef } from '../core/model-loader';
import type { World } from '../world/world';
import { chunkKey } from '../world/world';
import type { WorldGen, Dimension } from '../world/worldgen';
import {
  ATLAS_COLS,
  ATLAS_ROWS,
  TILE_SIZE,
  type AtlasResult,
} from '../core/atlas';
import type { JobOut, PackedGeometry } from './mesher-worker';

// ============================================================
// 区块管理：
//  - 地形生成 + 网格化全部在 Worker 池执行（主线程零噪声计算）
//  - 优先级 = 距玩家距离；每帧限量上传 GPU
//  - 编辑只重建本区块（边界加邻区块）
// ============================================================

export const RENDER_DIST = 8;

const PAD_X = 18;
const PAD_Z = 18;
const H = 128;

interface WaitingJob {
  cx: number;
  cz: number;
  version: number;
}
interface ChunkMeshes {
  opaque: THREE.Mesh | null;
  translucent: THREE.Mesh | null;
}
interface FlightInfo {
  worker: Worker;
  since: number;
}

/** 注入图集 UV 重映射 shader：uv 为“格内局部坐标”，aTile 为图集格号；
 *  aLight 为逐顶点方块光，与日光 uDay 取最大（MC 光曲线近似：0 级保底 0.08）
 *  图集尺寸由 ATLAS_COLS/ROWS/TILE_SIZE 常量注入，扩容时无需改这里。 */
const ATLAS_W = ATLAS_COLS * TILE_SIZE;
const ATLAS_H = ATLAS_ROWS * TILE_SIZE;
const MAP_FRAG = /* glsl */ `
#ifdef USE_MAP
  float tileCol = mod(vTile, ${ATLAS_COLS.toFixed(1)});
  float tileRow = floor(vTile / ${ATLAS_COLS.toFixed(1)});
  vec2 fuv = fract(vMapUv);
  vec2 atlasUv = vec2(
    (tileCol * ${TILE_SIZE.toFixed(1)} + 0.5 + fuv.x * ${(TILE_SIZE - 1).toFixed(1)}) / ${ATLAS_W.toFixed(1)},
    ((tileRow + 1.0) * ${TILE_SIZE.toFixed(1)} - 0.5 - fuv.y * ${(TILE_SIZE - 1).toFixed(1)}) / ${ATLAS_H.toFixed(1)}
  );
  diffuseColor *= texture2D(map, atlasUv);
#endif
  float mcBright = max(uDay, 0.08 + 0.92 * (vLight / 15.0));
  diffuseColor.rgb *= mcBright;
`;

function patchAtlasUv(
  mat: THREE.MeshBasicMaterial,
  dayUniform: { value: number },
): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDay = dayUniform;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aTile;\nattribute float aLight;\nvarying float vTile;\nvarying float vLight;',
      )
      .replace(
        '#include <uv_vertex>',
        '#include <uv_vertex>\nvTile = aTile;\nvLight = aLight;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uDay;\nvarying float vTile;\nvarying float vLight;',
      )
      .replace('#include <map_fragment>', MAP_FRAG);
  };
}

export class ChunkManager {
  readonly opaqueMat: THREE.MeshBasicMaterial;
  readonly waterMat: THREE.MeshBasicMaterial;
  /** 全局日光强度（0~1），sky 每帧写入，所有区块材质共享 */
  readonly dayUniform = { value: 1.0 };

  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private waiting = new Map<string, WaitingJob>();
  private inFlight = new Map<
    string,
    { version: number; worker: Worker; since: number }
  >();
  private genInFlight = new Map<string, FlightInfo>();
  private versions = new Map<string, number>();
  private results: JobOut[] = [];
  private meshes = new Map<string, ChunkMeshes>();
  private workerDefs: (BlockDef | null)[];
  /** Worker 异常计数（诊断用） */
  workerErrors = 0;
  /** 当前渲染距离（区块），运行时可调 */
  public rd = RENDER_DIST;
  /** 平滑光照（AO）开关，新 Worker 初始化时同步 */
  private aoFlag = true;
  /** 当前帧 ensure 半径（由主循环按"已加载+1 圈"平滑扩张，避免进入游戏瞬间突跳大范围） */
  public ensureRadius = RENDER_DIST;

  /** 运行时调整渲染距离（2~32），下一帧 ensure 立即按新半径加载/卸载 */
  setRenderDist(r: number): void {
    const v = Math.max(2, Math.min(32, Math.round(r)));
    if (v === this.rd) return;
    this.rd = v;
    this.lastEnsureCX = Number.NaN; // 强制重新 ensure
    this.lastEnsureCZ = Number.NaN;
  }

  /** 平滑光照开关：通知所有 Worker 并重网格化全部已加载区块（与 MC 切换时重载一致） */
  setSmoothLighting(on: boolean): void {
    this.aoFlag = on;
    for (const w of this.workers) w.postMessage({ type: 'config', ao: on });
    for (const key of [...this.world.chunks.keys()]) {
      const [cx, cz] = key.split(',').map(Number);
      this.queueMesh(cx, cz);
    }
  }

  private genQueue: { cx: number; cz: number; d2: number }[] = [];
  private genSet = new Set<string>();
  private lastEnsureCX = Number.NaN;
  private lastEnsureCZ = Number.NaN;

  constructor(
    private scene: THREE.Scene,
    private world: World,
    private worldGen: WorldGen,
    atlas: AtlasResult,
    defs: (BlockDef | null)[],
    /** 存档覆盖：返回玩家修改过的区块数据则跳过地形生成 */
    private provide:
      | ((cx: number, cz: number) => Uint8Array | null)
      | null = null,
    /** 维度：决定 Worker 生成地形用主世界还是下界分支 */
    private dim: Dimension = 'overworld',
  ) {
    this.opaqueMat = new THREE.MeshBasicMaterial({
      map: atlas.texture,
      vertexColors: true,
      alphaTest: 0.5, // 植物/玻璃镂空
    });
    patchAtlasUv(this.opaqueMat, this.dayUniform);

    this.waterMat = new THREE.MeshBasicMaterial({
      map: atlas.texture,
      vertexColors: true,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    });
    patchAtlasUv(this.waterMat, this.dayUniform);

    this.workerDefs = defs;
    // Worker 池懒创建：构造不立即 spawn，等首个 update() 再建池。
    // 多维度场景下只有当前维度的 update() 会被驱动，因此非当前维度
    // 的 ChunkManager 不占用任何 Worker，避免新世界启动瞬间起十几个 Worker 卡死。
  }

  /** 首次 update() 时创建 Worker 池（幂等） */
  private ensureWorkers(): void {
    if (this.workers.length > 0) return;
    // 用全部硬件核（不 -1 保留主线程），gen 任务重 CPU 大量平行可分给多核
    const count = Math.max(
      2,
      Math.min(8, navigator.hardwareConcurrency || 4),
    );
    for (let i = 0; i < count; i++) {
      const w = this.spawnWorker();
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  /** 创建区块 Worker；异常时回收其在飞任务并更换新 Worker（防管道卡死） */
  private spawnWorker(): Worker {
    const w = new Worker(new URL('./mesher-worker.ts', import.meta.url), {
      type: 'module',
    });
    w.postMessage({
      type: 'init',
      defs: this.workerDefs,
      seed: this.worldGen.seed,
      ao: this.aoFlag,
      dim: this.dim,
    });
    w.onmessage = (e: MessageEvent<JobOut>) => {
      this.results.push(e.data);
      if (!this.idle.includes(w)) this.idle.push(w);
    };
    w.onerror = (e) => {
      this.workerErrors++;
      console.error(
        '[mc] 区块 Worker 异常，重新排队任务并更换 Worker',
        e.message,
      );
      for (const [key, info] of [...this.inFlight]) {
        if (info.worker === w) {
          this.inFlight.delete(key);
          const [cx, cz] = key.split(',').map(Number);
          this.waiting.set(key, { cx, cz, version: info.version });
        }
      }
      for (const [key, info] of [...this.genInFlight]) {
        if (info.worker === w) {
          this.genInFlight.delete(key);
          this.requeueGen(key);
        }
      }
      this.workers = this.workers.filter((x) => x !== w);
      this.idle = this.idle.filter((x) => x !== w);
      w.terminate();
      const nw = this.spawnWorker();
      this.workers.push(nw);
      this.idle.push(nw);
    };
    return w;
  }

  /** 把生成任务放回队首（失败/超时/Worker 异常时） */
  private requeueGen(key: string): void {
    if (this.world.chunks.has(key) || this.genSet.has(key)) return;
    const [cx, cz] = key.split(',').map(Number);
    this.genSet.add(key);
    this.genQueue.unshift({ cx, cz, d2: 0 });
  }

  /** 方块编辑后：重建本区块 + 边界相邻区块 */
  markEdited(cx: number, cz: number, lx: number, lz: number): void {
    this.queueMesh(cx, cz);
    if (lx === 0) this.queueMesh(cx - 1, cz);
    if (lx === 15) this.queueMesh(cx + 1, cz);
    if (lz === 0) this.queueMesh(cx, cz - 1);
    if (lz === 15) this.queueMesh(cx, cz + 1);
  }

  /** 方块光照变化后：光传播可达 15 格，重网格化 3×3 邻域 */
  markEditedArea(cx: number, cz: number): void {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        this.queueMesh(cx + dx, cz + dz);
      }
    }
  }

  private queueMesh(cx: number, cz: number): void {
    if (!this.world.hasChunk(cx, cz)) return;
    const key = chunkKey(cx, cz);
    const v = (this.versions.get(key) ?? 0) + 1;
    this.versions.set(key, v);
    if (this.inFlight.has(key)) return; // 结果回来时按最新 version 重派
    // 加载阶段：邻区很可能尚未生成，现在网格化既浪费（随后邻区落地又要因边界
    // 补全而重网格化）。挂起待世界稳定后由 flushDeferred 统一重排。
    if (this.deferNeighbors) {
      this.deferred.add(key);
      return;
    }
    this.waiting.set(key, { cx, cz, version: v });
  }

  /**
   * 加载阶段开启后，queueMesh 只记录不派发（邻区还没生成，网格化会被反复推翻）。
   * 关闭时把所有挂起区块按最新 version 一次性重排——此时邻区已齐，
   * 每区块只网格化一次。游戏中编辑方块时本标志为 false，走即时重网格化。
   */
  private deferNeighbors = false;
  private deferred = new Set<string>();

  setDeferNeighbors(on: boolean): void {
    if (this.deferNeighbors === on) return;
    this.deferNeighbors = on;
    if (on) return;
    for (const key of this.deferred) {
      const [cx, cz] = key.split(',').map(Number);
      if (!this.world.hasChunk(cx, cz)) continue;
      const version = this.versions.get(key) ?? 0;
      if (!this.inFlight.has(key)) this.waiting.set(key, { cx, cz, version });
    }
    this.deferred.clear();
  }

  /** 组装 18×128×18 带邻边方块数据（热路径：整数键查表，无字符串分配） */
  private buildPadded(cx: number, cz: number): ArrayBuffer {
    const out = new Uint8Array(PAD_X * H * PAD_Z);
    for (let lz = -1; lz <= 16; lz++) {
      for (let lx = -1; lx <= 16; lx++) {
        const wx = cx * 16 + lx;
        const wz = cz * 16 + lz;
        const ccx = Math.floor(wx / 16);
        const ccz = Math.floor(wz / 16);
        const chunk = this.world.chunkAt(ccx, ccz);
        if (!chunk) continue;
        let s = wx - ccx * 16 + 16 * (wz - ccz * 16);
        let d = lx + 1 + PAD_X * (lz + 1);
        for (let y = 0; y < H; y++) {
          out[d] = chunk[s];
          s += 256; // 16×16
          d += PAD_X * PAD_Z;
        }
      }
    }
    return out.buffer;
  }

  /** 组装 18×128×18 带邻边光照数据；3×3 邻域无光时返回 null（零开销快路径） */
  private buildPaddedLight(cx: number, cz: number): ArrayBuffer | null {
    if (!this.world.hasLightNear(cx, cz)) return null;
    const out = new Uint8Array(PAD_X * H * PAD_Z);
    for (let lz = -1; lz <= 16; lz++) {
      for (let lx = -1; lx <= 16; lx++) {
        const wx = cx * 16 + lx;
        const wz = cz * 16 + lz;
        const ccx = Math.floor(wx / 16);
        const ccz = Math.floor(wz / 16);
        const chunk = this.world.lightAt(ccx, ccz);
        if (!chunk) continue;
        let s = wx - ccx * 16 + 16 * (wz - ccz * 16);
        let d = lx + 1 + PAD_X * (lz + 1);
        for (let y = 0; y < H; y++) {
          out[d] = chunk[s];
          s += 256;
          d += PAD_X * PAD_Z;
        }
      }
    }
    return out.buffer;
  }

  /**
   * 确保玩家周围区块已生成 / 已排队网格化；卸载远处区块。
   * lookaheadVX/VZ：玩家当前帧速度方向（任意标量，向量归一化到三档：-1/0/+1），
   * 用于沿行进方向伸 1 圈（玩家即将踏进去的 chunk 已经预热），反方向缩 1 圈
   * （玩家不再去的方向提前卸载，避免远端 lazy 永久挂载）。
   * ensureRadius：覆盖到 ±ensureRadius 圈；玩家跑步疲恐/hpa 场景可传小值
   * （如 3），让远处块真正"懒"——未到不排队、未生成、未内存占用。
   */
  private ensure(
    px: number,
    pz: number,
    lookaheadVX = 0,
    lookaheadVZ = 0,
    ensureRadius?: number,
  ): void {
    const pcx = Math.floor(px / 16);
    const pcz = Math.floor(pz / 16);
    const R = ensureRadius ?? this.rd;
    if (
      pcx === this.lastEnsureCX &&
      pcz === this.lastEnsureCZ &&
      R === this.lastEnsureR &&
      Math.sign(lookaheadVX) === this.lastLookDX &&
      Math.sign(lookaheadVZ) === this.lastLookDZ
    ) {
      return;
    }
    this.lastEnsureCX = pcx;
    this.lastEnsureCZ = pcz;
    this.lastEnsureR = R;
    this.lastLookDX = Math.sign(lookaheadVX);
    this.lastLookDZ = Math.sign(lookaheadVZ);

    // 归一化方向到 {-1, 0, +1}
    const sx = Math.sign(lookaheadVX);
    const sz = Math.sign(lookaheadVZ);
    // 沿行进方向 +1 圈，反方向 -1 圈（最低 1）
    const headroom = R + 1;
    const tail = Math.max(1, R - 1);
    // 用每轴独立的 min/max 替换单一正方形扫描，沿 sx 方向用 headroom，其他用 R
    const dx0 = sx < 0 ? -headroom : sx > 0 ? tail : -R;
    const dx1 = sx < 0 ? -tail : sx > 0 ? headroom : R;
    const dz0 = sz < 0 ? -headroom : sz > 0 ? tail : -R;
    const dz1 = sz < 0 ? -tail : sz > 0 ? headroom : R;

    let queued = 0;
    for (let dz = dz0; dz <= dz1; dz++) {
      for (let dx = dx0; dx <= dx1; dx++) {
        const d2 = dx * dx + dz * dz;
        // 圆角视距（沿行进方向稍宽容，逆方向稍苛刻）
        const r2 = (dx1 - dx0) * (dx1 - dx0) + (dz1 - dz0) * (dz1 - dz0);
        const limit2 = r2 + R;
        if (d2 > limit2) continue;
        const cx = pcx + dx;
        const cz = pcz + dz;
        const key = chunkKey(cx, cz);
        if (!this.world.hasChunk(cx, cz)) {
          if (!this.genSet.has(key) && !this.genInFlight.has(key)) {
            this.genSet.add(key);
            this.genQueue.push({ cx, cz, d2 });
            queued++;
          }
        } else if (!this.meshes.has(key) && !this.inFlight.has(key)) {
          this.queueMesh(cx, cz);
        }
      }
    }
    if (queued > 0) this.genQueue.sort((a, b) => a.d2 - b.d2);

    // 卸载视距外（无方向性，玩家离开方向立即释放）
    // 仅 +1 缓冲（不再 +2），地形差一格无视觉影响但显著降低内存峰值。
    // 用整数键迭代（forEachChunkFast），避免每帧对全部区块做字符串 split/parse。
    const lim = R + 1;
    const toUnload: number[] = [];
    this.world.forEachChunkFast((cx, cz) => {
      if (Math.abs(cx - pcx) > lim || Math.abs(cz - pcz) > lim) {
        toUnload.push(cx, cz);
      }
    });
    for (let i = 0; i + 1 < toUnload.length; i += 2) {
      const cx = toUnload[i];
      const cz = toUnload[i + 1];
      const key = chunkKey(cx, cz);
      this.world.deleteChunk(cx, cz);
      this.genSet.delete(key);
      this.waiting.delete(key);
      this.versions.delete(key); // 防版本表无限增长
      this.disposeMeshes(key);
      this.onChunkUnloaded?.(cx, cz);
    }
  }

  private lastLookDX = 0;
  private lastLookDZ = 0;
  private lastEnsureR = -1;

  private disposeMeshes(key: string): void {
    const m = this.meshes.get(key);
    if (m) {
      for (const mesh of [m.opaque, m.translucent]) {
        if (mesh) {
          this.scene.remove(mesh);
          mesh.geometry.dispose();
        }
      }
      this.meshes.delete(key);
    }
  }

  private makeMesh(
    g: PackedGeometry,
    cx: number,
    cz: number,
    mat: THREE.Material,
  ): THREE.Mesh {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2));
    geo.setAttribute('aTile', new THREE.BufferAttribute(g.tiles, 1));
    geo.setAttribute('aLight', new THREE.BufferAttribute(g.lights, 1));
    geo.setAttribute('color', new THREE.BufferAttribute(g.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(g.indices, 1));
    // 手动包围球：恒定值，避免 computeBoundingSphere 遍历
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(8, H / 2, 8), 75);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx * 16, 0, cz * 16);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }

  /** 生成结果落地：写入世界并触发本区块 + 四邻重网格化 */
  private settleGen(cx: number, cz: number, data: Uint8Array): void {
    this.world.setChunk(cx, cz, data);
    this.queueMesh(cx, cz);
    this.queueMesh(cx - 1, cz);
    this.queueMesh(cx + 1, cz);
    this.queueMesh(cx, cz - 1);
    this.queueMesh(cx, cz + 1);
    // 地图探索：新区块落地即采样记录
    this.onChunkExplored?.(cx, cz);
  }

  /** 区块首次落地（生成/读档）时的回调（地图探索记录用） */
  onChunkExplored: ((cx: number, cz: number) => void) | null = null;

  /** 区块卸载（视距外删除）时的回调（清理附着在该区块的状态，如熔炉，防无限增长） */
  onChunkUnloaded: ((cx: number, cz: number) => void) | null = null;

  /**
   * 每帧驱动。applyBudget：最多上传多少网格；
   * wantProgress 为 true 时才统计加载进度（游戏中跳过该循环）。
   * lookaheadVX/VZ 是玩家当前帧速度方向（±1 单位 / m/s），用于沿行进方向
   * 提前 1 圈排程、逆方向收紧 1 圈，确保玩家眼前的视野始终有"预热"区。
   * ensureRadius 默认 = RD（与 RENDER_DIST 对齐）；玩家希望"懒加载"场景下
   * 调成更小值（如 3）让 ensure 只排 ±ensureRadius 圈；玩家实际到时再扩。
   */
  update(
    px: number,
    pz: number,
    applyBudget: number,
    wantProgress = false,
    lookaheadVX = 0,
    lookaheadVZ = 0,
    ensureRadius?: number,
    /** 时间预算 ms：超过则停止本帧 apply，让位给 rAF/UI 刷新；<=0 不限 */
    budgetMs = 0,
  ): number {
    this.ensureWorkers();
    this.ensure(px, pz, lookaheadVX, lookaheadVZ, ensureRadius);
    const now = performance.now();

    // 派发顺序（关键：网格优先于生成）：
    // 玩家看得见的网格（已生成待网格化）永远比看不见的远处地形生成更紧迫。
    // 若先派生成，rd 大/快速移动时 genQueue 永远满、占满全部 Worker，
    // 网格任务被饿死 → 区块数据生成了但没网格，玩家眼前出现"区块不渲染"的空洞。
    // 故本帧流程：回收卡死 → 应用结果 → 先派网格 → 剩余 Worker 才派生成。

    // 1) 回收卡死任务：在飞超过 10s 视为丢失，重新排队（Worker 静默异常的兜底）
    for (const [key, info] of [...this.inFlight]) {
      if (now - info.since > 10_000) {
        this.inFlight.delete(key);
        const [cx, cz] = key.split(',').map(Number);
        if (this.world.hasChunk(cx, cz)) {
          this.waiting.set(key, { cx, cz, version: info.version });
        }
      }
    }
    for (const [key, info] of [...this.genInFlight]) {
      if (now - info.since > 10_000) {
        this.genInFlight.delete(key);
        this.requeueGen(key);
      }
    }

    // 2) 应用结果：生成 + 网格 共用 applyBudget，但村庄/要塞/torch 重区每块
    // setChunk 触发 lighting BFS 与 8K 邻区扫描，4 workers 同帧回包在 playing 阶段
    // 会瞬间堆积成 50ms+ 卡顿。playing 阶段收紧为同帧 ≤6 块（避免帧 spike）；
    // loading 阶段再叠 budgetMs 时间预算（>0 时每块 check now，超则停），
    // 把长任务拆碎让 rAF/setProgress/按钮能 fire，UI 视图不卡。
    const budgetStart = budgetMs > 0 ? performance.now() : 0;
    let applied = 0;
    let i = 0;
    while (
      i < this.results.length &&
      applied < applyBudget &&
      (budgetMs <= 0 || performance.now() - budgetStart < budgetMs)
    ) {
      const r = this.results[i];
      if (r.type === 'gen') {
        this.results.splice(i, 1);
        const key = chunkKey(r.cx, r.cz);
        this.genInFlight.delete(key);
        if (r.data.byteLength === 0) {
          this.requeueGen(key); // 生成失败，重试
        } else if (!this.world.hasChunk(r.cx, r.cz)) {
          this.settleGen(r.cx, r.cz, new Uint8Array(r.data));
          applied++;
        }
        continue;
      }
      this.results.splice(i, 1);
      const key = chunkKey(r.cx, r.cz);
      this.inFlight.delete(key);
      if (!this.world.hasChunk(r.cx, r.cz)) continue;
      if (this.versions.get(key) !== r.version) {
        this.queueMesh(r.cx, r.cz); // 飞行期间数据又变了，重建
        continue;
      }
      this.disposeMeshes(key);
      const entry: ChunkMeshes = { opaque: null, translucent: null };
      if (r.opaque) {
        entry.opaque = this.makeMesh(r.opaque, r.cx, r.cz, this.opaqueMat);
        this.scene.add(entry.opaque);
      }
      if (r.translucent) {
        entry.translucent = this.makeMesh(
          r.translucent,
          r.cx,
          r.cz,
          this.waterMat,
        );
        this.scene.add(entry.translucent);
      }
      this.meshes.set(key, entry);
      applied++;
    }

    // 3) 派发网格任务给空闲 Worker（按距玩家优先级）
    if (this.idle.length > 0 && this.waiting.size > 0) {
      const pcx = Math.floor(px / 16);
      const pcz = Math.floor(pz / 16);
      const sorted = [...this.waiting.values()].sort(
        (a, b) =>
          (a.cx - pcx) ** 2 +
          (a.cz - pcz) ** 2 -
          ((b.cx - pcx) ** 2 + (b.cz - pcz) ** 2),
      );
      for (const job of sorted) {
        if (this.idle.length === 0) break;
        const key = chunkKey(job.cx, job.cz);
        if (this.versions.get(key) !== job.version) {
          this.waiting.delete(key); // 已有更新版本排队
          continue;
        }
        if (!this.world.hasChunk(job.cx, job.cz)) {
          this.waiting.delete(key);
          continue;
        }
        const w = this.idle.pop()!;
        this.waiting.delete(key);
        this.inFlight.set(key, { version: job.version, worker: w, since: now });
        const data = this.buildPadded(job.cx, job.cz);
        const light = this.buildPaddedLight(job.cx, job.cz);
        w.postMessage(
          {
            type: 'mesh',
            cx: job.cx,
            cz: job.cz,
            version: job.version,
            data,
            light,
          },
          light ? [data, light] : [data],
        );
      }
    }

    // 3.5) 地形生成：仅用网格派发后剩余的 Worker。
    // 网格已先抢走它需要的 Worker，这里用剩下的派发生成——保证可见网格永不被饿死。
    while (this.idle.length > 0 && this.genQueue.length > 0) {
      const job = this.genQueue.shift()!;
      const key = chunkKey(job.cx, job.cz);
      this.genSet.delete(key);
      if (this.world.hasChunk(job.cx, job.cz) || this.genInFlight.has(key))
        continue;
      const saved = this.provide?.(job.cx, job.cz) ?? null;
      if (saved) {
        this.settleGen(job.cx, job.cz, saved);
        continue;
      }
      const w = this.idle.pop()!;
      this.genInFlight.set(key, { worker: w, since: now });
      w.postMessage({ type: 'gen', cx: job.cx, cz: job.cz });
    }

    // 4) 加载进度（仅启动阶段统计）。节流:每 ~100ms 才重扫一遍槽位,
    // 否则加载期每帧 289 槽 × Map 查询纯属浪费,中间帧返回缓存值。
    if (!wantProgress) return 1;
    if (now - this.lastProgressAt < 100) return this.lastProgress;
    this.lastProgressAt = now;
    const pcx = Math.floor(px / 16);
    const pcz = Math.floor(pz / 16);
    const R = this.rd;
    let total = 0,
      done = 0;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > R * R + R) continue;
        const key = chunkKey(pcx + dx, pcz + dz);
        if (this.deferNeighbors) {
          // 挂起阶段：进度只追踪地形生成（网格化被延迟，否则会永远到不了 100%）
          total += 1;
          if (this.world.chunks.has(key)) done += 1;
        } else {
          total += 2;
          if (this.world.chunks.has(key)) done += 1;
          if (this.meshes.has(key)) done += 1;
        }
      }
    }
    this.lastProgress = total === 0 ? 1 : done / total;
    return this.lastProgress;
  }

  private lastProgressAt = 0;
  private lastProgress = 0;

  get loadedCount(): number {
    return this.world.chunks.size;
  }

  /**
   * 当前已加载区块相对玩家的"半径"——以 spawn 中心为原点，
   * 量最大曼哈顿距离 R 表示 [pcx-R..pcx+R, pcz-R..pcz+R] 全覆盖。
   * 用 player 当前位置作中心：返回 R 表示 ±R 圈所有 chunk 都在 chunks Map 里。
   * 主循环用此值平滑扩张 ensure 半径。
   */
  loadedSpan(px: number, pz: number): number {
    const pcx = Math.floor(px / 16);
    const pcz = Math.floor(pz / 16);
    // 上限用 rd 防止 RD slider 误调大时扫到天边
    const max = Math.max(this.rd + 2, 4);
    let r = 0;
    while (r < max) {
      const next = r + 1;
      let missing = false;
      for (let dz = -next; dz <= next && !missing; dz++) {
        for (let dx = -next; dx <= next; dx++) {
          if (Math.abs(dx) !== next && Math.abs(dz) !== next) continue; // 只查新一圈外缘
          if (!this.world.hasChunk(pcx + dx, pcz + dz)) {
            missing = true;
            break;
          }
        }
      }
      if (missing) break;
      r = next;
    }
    return r;
  }

  get meshedCount(): number {
    return this.meshes.size;
  }

  /** 主线程检查某 chunk 是否已落地（已存在于世界数据中） */
  worldHasChunk(cx: number, cz: number): boolean {
    return this.world.hasChunk(cx, cz);
  }

  /** 一次性把 chunks Map 转成整数键的 Set（用 packKey），调用方 .has 命中 */
  getWorldSnapshot(): { has(cx: number, cz: number): boolean } {
    const set = new Set<number>();
    for (const key of this.world.chunks.keys()) {
      const [cx, cz] = key.split(',').map(Number);
      set.add(packKeyInternal(cx, cz));
    }
    return {
      has(cx: number, cz: number): boolean {
        return set.has(packKeyInternal(cx, cz));
      },
    };
  }
}

/** 整型键打包 —— 与 World.packKey 算式一致，避免暴露内部 */
function packKeyInternal(cx: number, cz: number): number {
  return ((cx + 32768) << 16) | (cz + 32768);
}
