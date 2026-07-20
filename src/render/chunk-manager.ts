import * as THREE from 'three';
import type { BlockDef } from '../core/model-loader';
import type { World } from '../world/world';
import { chunkKey } from '../world/world';
import type { WorldGen } from '../world/worldgen';
import type { AtlasResult } from '../core/atlas';
import type { MeshJobOut, PackedGeometry } from './mesher-worker';

// ============================================================
// 区块管理：
//  - 主线程按预算生成地形（加载界面有进度）
//  - Worker 池并行网格化，优先级 = 距玩家距离
//  - 每帧限量上传 GPU，编辑只重建本区块（边界加邻区块）
// ============================================================

export const RENDER_DIST = 8;

const PAD_X = 18;
const PAD_Z = 18;
const H = 128;

interface WaitingJob { cx: number; cz: number; version: number }
interface ChunkMeshes { opaque: THREE.Mesh | null; translucent: THREE.Mesh | null }

/** 注入图集 UV 重映射 shader：uv 为“格内局部坐标”，aTile 为图集格号 */
const MAP_FRAG = /* glsl */ `
#ifdef USE_MAP
  float tileCol = mod(vTile, 8.0);
  float tileRow = floor(vTile * 0.125);
  vec2 fuv = fract(vMapUv);
  vec2 atlasUv = vec2(
    (tileCol * 16.0 + 0.5 + fuv.x * 15.0) / 128.0,
    ((tileRow + 1.0) * 16.0 - 0.5 - fuv.y * 15.0) / 128.0
  );
  diffuseColor *= texture2D(map, atlasUv);
#endif
`;

function patchAtlasUv(mat: THREE.MeshBasicMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aTile;\nvarying float vTile;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvTile = aTile;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vTile;')
      .replace('#include <map_fragment>', MAP_FRAG);
  };
}

export class ChunkManager {
  readonly opaqueMat: THREE.MeshBasicMaterial;
  readonly waterMat: THREE.MeshBasicMaterial;

  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private waiting = new Map<string, WaitingJob>();
  private inFlight = new Map<string, { version: number; worker: Worker; since: number }>();
  private versions = new Map<string, number>();
  private results: MeshJobOut[] = [];
  private meshes = new Map<string, ChunkMeshes>();
  private workerDefs: (BlockDef | null)[];
  /** Worker 异常计数（诊断用） */
  workerErrors = 0;

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
    private provide: ((cx: number, cz: number) => Uint8Array | null) | null = null,
  ) {
    this.opaqueMat = new THREE.MeshBasicMaterial({
      map: atlas.texture,
      vertexColors: true,
      alphaTest: 0.5, // 植物/玻璃镂空
    });
    patchAtlasUv(this.opaqueMat);

    this.waterMat = new THREE.MeshBasicMaterial({
      map: atlas.texture,
      vertexColors: true,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    });
    patchAtlasUv(this.waterMat);

    this.workerDefs = defs;
    const count = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < count; i++) {
      const w = this.spawnWorker();
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  /** 创建网格化 Worker；异常时回收其在飞任务并更换新 Worker（防管道卡死） */
  private spawnWorker(): Worker {
    const w = new Worker(new URL('./mesher-worker.ts', import.meta.url), { type: 'module' });
    w.postMessage({ type: 'init', defs: this.workerDefs });
    w.onmessage = (e: MessageEvent<MeshJobOut>) => {
      const m = e.data;
      this.inFlight.delete(chunkKey(m.cx, m.cz));
      this.results.push(m);
      if (!this.idle.includes(w)) this.idle.push(w);
    };
    w.onerror = (e) => {
      this.workerErrors++;
      console.error('[mc] 网格化 Worker 异常，重新排队任务并更换 Worker', e.message);
      for (const [key, info] of [...this.inFlight]) {
        if (info.worker === w) {
          this.inFlight.delete(key);
          const [cx, cz] = key.split(',').map(Number);
          this.waiting.set(key, { cx, cz, version: info.version });
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

  /** 方块编辑后：重建本区块 + 边界相邻区块 */
  markEdited(cx: number, cz: number, lx: number, lz: number): void {
    this.queueMesh(cx, cz);
    if (lx === 0) this.queueMesh(cx - 1, cz);
    if (lx === 15) this.queueMesh(cx + 1, cz);
    if (lz === 0) this.queueMesh(cx, cz - 1);
    if (lz === 15) this.queueMesh(cx, cz + 1);
  }

  private queueMesh(cx: number, cz: number): void {
    if (!this.world.hasChunk(cx, cz)) return;
    const key = chunkKey(cx, cz);
    const v = (this.versions.get(key) ?? 0) + 1;
    this.versions.set(key, v);
    if (this.inFlight.has(key)) return; // 结果回来时按最新 version 重派
    this.waiting.set(key, { cx, cz, version: v });
  }

  /** 组装 18×128×18 带邻边数据（逐列拷贝，未加载邻区留 0=空气） */
  private buildPadded(cx: number, cz: number): ArrayBuffer {
    const out = new Uint8Array(PAD_X * H * PAD_Z);
    for (let lz = -1; lz <= 16; lz++) {
      for (let lx = -1; lx <= 16; lx++) {
        const wx = cx * 16 + lx;
        const wz = cz * 16 + lz;
        const ccx = Math.floor(wx / 16);
        const ccz = Math.floor(wz / 16);
        const chunk = this.world.chunks.get(chunkKey(ccx, ccz));
        if (!chunk) continue;
        let src = (wx - ccx * 16) + 16 * (wz - ccz * 16);
        let dst = lx + 1 + PAD_X * (lz + 1);
        for (let y = 0; y < H; y++) {
          out[dst] = chunk[src];
          src += 256;          // 16×16
          dst += PAD_X * PAD_Z;
        }
      }
    }
    return out.buffer;
  }

  /** 确保玩家周围区块已生成 / 已排队网格化；卸载远处区块 */
  private ensure(px: number, pz: number): void {
    const pcx = Math.floor(px / 16);
    const pcz = Math.floor(pz / 16);
    if (pcx === this.lastEnsureCX && pcz === this.lastEnsureCZ) return;
    this.lastEnsureCX = pcx;
    this.lastEnsureCZ = pcz;

    const R = RENDER_DIST;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > R * R + R) continue; // 圆角视距
        const cx = pcx + dx;
        const cz = pcz + dz;
        const key = chunkKey(cx, cz);
        if (!this.world.hasChunk(cx, cz)) {
          if (!this.genSet.has(key)) {
            this.genSet.add(key);
            this.genQueue.push({ cx, cz, d2 });
          }
        } else if (!this.meshes.has(key) && !this.inFlight.has(key)) {
          this.queueMesh(cx, cz);
        }
      }
    }
    this.genQueue.sort((a, b) => a.d2 - b.d2);

    // 卸载视距外（+2 缓冲）
    const lim = R + 2;
    for (const key of [...this.world.chunks.keys()]) {
      const [cx, cz] = key.split(',').map(Number);
      if (Math.abs(cx - pcx) > lim || Math.abs(cz - pcz) > lim) {
        this.world.deleteChunk(cx, cz);
        this.genSet.delete(key);
        this.waiting.delete(key);
        this.disposeMeshes(key);
      }
    }
  }

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

  private makeMesh(g: PackedGeometry, cx: number, cz: number, mat: THREE.Material): THREE.Mesh {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2));
    geo.setAttribute('aTile', new THREE.BufferAttribute(g.tiles, 1));
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

  /**
   * 每帧驱动。genBudget：本帧最多生成多少区块；applyBudget：最多上传多少网格。
   * 返回加载进度 [0,1]（仅启动阶段使用）。
   */
  update(px: number, pz: number, genBudget: number, applyBudget: number): number {
    this.ensure(px, pz);

    // 1) 地形生成（主线程，限帧预算）
    let n = 0;
    while (n < genBudget && this.genQueue.length > 0) {
      const job = this.genQueue.shift()!;
      const key = chunkKey(job.cx, job.cz);
      this.genSet.delete(key);
      if (!this.world.hasChunk(job.cx, job.cz)) {
        // 优先使用存档中修改过的区块，否则按种子重新生成
        const data = this.provide?.(job.cx, job.cz) ?? this.worldGen.generateChunk(job.cx, job.cz);
        this.world.setChunk(job.cx, job.cz, data);
        this.queueMesh(job.cx, job.cz);
        // 邻区块边界会因此变化，重网格化
        this.queueMesh(job.cx - 1, job.cz);
        this.queueMesh(job.cx + 1, job.cz);
        this.queueMesh(job.cx, job.cz - 1);
        this.queueMesh(job.cx, job.cz + 1);
      }
      n++;
    }

    // 1.5) 回收卡死任务：在飞超过 10s 视为丢失，重新排队（Worker 静默异常的兜底）
    const now = performance.now();
    for (const [key, info] of [...this.inFlight]) {
      if (now - info.since > 10_000) {
        this.inFlight.delete(key);
        const [cx, cz] = key.split(',').map(Number);
        if (this.world.hasChunk(cx, cz)) {
          this.waiting.set(key, { cx, cz, version: info.version });
        }
      }
    }

    // 2) 派发网格任务给空闲 Worker（按距玩家优先级）
    if (this.idle.length > 0 && this.waiting.size > 0) {
      const pcx = Math.floor(px / 16);
      const pcz = Math.floor(pz / 16);
      const sorted = [...this.waiting.values()].sort(
        (a, b) => (a.cx - pcx) ** 2 + (a.cz - pcz) ** 2 - ((b.cx - pcx) ** 2 + (b.cz - pcz) ** 2),
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
        w.postMessage({ type: 'mesh', cx: job.cx, cz: job.cz, version: job.version, data }, [data]);
      }
    }

    // 3) 应用结果（限帧预算，防卡顿）
    let applied = 0;
    while (applied < applyBudget && this.results.length > 0) {
      const r = this.results.shift()!;
      const key = chunkKey(r.cx, r.cz);
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
        entry.translucent = this.makeMesh(r.translucent, r.cx, r.cz, this.waterMat);
        this.scene.add(entry.translucent);
      }
      this.meshes.set(key, entry);
      applied++;
    }

    // 4) 加载进度（需要的目标区块中，已生成+已出网格的比例）
    const pcx = Math.floor(px / 16);
    const pcz = Math.floor(pz / 16);
    const R = RENDER_DIST;
    let total = 0, done = 0;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > R * R + R) continue;
        total += 2;
        const key = chunkKey(pcx + dx, pcz + dz);
        if (this.world.chunks.has(key)) done += 1;
        if (this.meshes.has(key)) done += 1;
      }
    }
    return total === 0 ? 1 : done / total;
  }

  get loadedCount(): number {
    return this.world.chunks.size;
  }

  get meshedCount(): number {
    return this.meshes.size;
  }
}
