import { BlockRegistry, AIR } from '../core/block-registry';
import { CHUNK_X, CHUNK_Y, CHUNK_Z } from './chunk-const';
import { addLight, onBlockLightChanged, seedLights } from './lighting';

// ============================================================
// 世界存储：Map<"cx,cz", Uint8Array>，方块编辑即标记脏区块
// 光照：与方块平行的逐区块 0~15 方块光（荧石等光源 BFS 泛洪）
// 热路径：getBlock / isSolid 不分配字符串 key —— 用 packKey 把 (cx,cz)
// 打成 32-bit 整数作为 Map key；公共 API 仍走字符串 key 便于外部交互
// ============================================================

export function chunkKey(cx: number, cz: number): string {
  return cx + ',' + cz;
}

// 紧凑整数键：把 cx 放高 16 位、cz 放低 16 位（每个坐标范围 ±2^15 足够）
function packKey(cx: number, cz: number): number {
  return ((cx + 32768) << 16) | (cz + 32768);
}

export interface BlockEdit {
  cx: number;
  cz: number;
  lx: number;
  lz: number;
  y: number;
}

const VOLUME = CHUNK_X * CHUNK_Y * CHUNK_Z;
const lidx = (lx: number, y: number, lz: number): number =>
  lx + CHUNK_X * (lz + CHUNK_Z * y);

export class World {
  readonly chunks = new Map<string, Uint8Array>();
  /** 方块光（0~15），与 chunks 同键同布局 */
  readonly light = new Map<string, Uint8Array>();
  /** 每区块非零光照格计数（快速判断 3×3 邻域是否有光） */
  private lightCount = new Map<string, number>();
  /** 热路径：整数键 → Uint8Array，避免 getBlock 每次分配字符串 */
  private chunksFast = new Map<number, Uint8Array>();
  private lightFast = new Map<number, Uint8Array>();

  constructor(public readonly reg: BlockRegistry) {}

  hasChunk(cx: number, cz: number): boolean {
    return this.chunksFast.has(packKey(cx, cz));
  }

  /** 按预解算的 (cx,cz) 取 chunk 数组，未加载返回 null —— 热路径走此分支 */
  chunkAt(cx: number, cz: number): Uint8Array | null {
    return this.chunksFast.get(packKey(cx, cz)) ?? null;
  }

  /** 按预解算 (cx,cz) 取光照数组（热路径，无字符串分配） */
  lightAt(cx: number, cz: number): Uint8Array | null {
    return this.lightFast.get(packKey(cx, cz)) ?? null;
  }

  /** 整数键迭代（卸载扫描用）：对每个已加载区块回调 (cx, cz)。
   *  遍历 chunksFast 整数键，避免 ensure 每帧 split/parse 字符串键。 */
  forEachChunkFast(cb: (cx: number, cz: number) => void): void {
    for (const fkey of this.chunksFast.keys()) {
      cb(((fkey >> 16) & 0xffff) - 32768, (fkey & 0xffff) - 32768);
    }
  }

  setChunk(cx: number, cz: number, data: Uint8Array): void {
    const key = chunkKey(cx, cz);
    const fkey = packKey(cx, cz);
    this.chunks.set(key, data);
    this.chunksFast.set(fkey, data);
    this.light.set(key, new Uint8Array(VOLUME));
    this.lightFast.set(fkey, this.light.get(key)!);
    this.lightCount.set(key, 0);

    // 1) 区块内光源播种（自然地形无光源；读档的修改区块可能含荧石）
    // 收集到扁平数组后单次批量 BFS（seedLights），重叠泛洪只走一遍，
    // 远比逐光源 addLight 高效——村庄/要塞区数百火把时是加载期主要提速点。
    const sources: number[] = [];
    for (let y = 0; y < CHUNK_Y; y++) {
      for (let lz = 0; lz < CHUNK_Z; lz++) {
        for (let lx = 0; lx < CHUNK_X; lx++) {
          const id = data[lidx(lx, y, lz)];
          const lum = id > 0 ? (this.reg.byId[id]?.luminance ?? 0) : 0;
          if (lum > 0)
            sources.push(cx * CHUNK_X + lx, y, cz * CHUNK_Z + lz, lum);
        }
      }
    }
    if (sources.length > 0) seedLights(this, sources);

    // 2) 邻区边缘光回流：邻区边缘格光 ≥2 则向本区块泛洪
    // 优化：先看邻区 lightCount，0 → 完全无光 → 8K 扫描跳过；非 0 才逐格扫边
    // 村庄/要塞/torch 重区每次都触发 = 4 chunks × 4 edges × 8K cells × map ops
    // = 主线程一帧 50ms+ 的卡顿主因之一；快速 0-count 检测是最便宜的过滤。
    const faces: readonly [number, number, number, number][] = [
      // [邻区 dx, 邻区 dz, 邻区边缘 lx/lz, 本区块边缘 lx/lz]
      [-1, 0, CHUNK_X - 1, 0],
      [1, 0, 0, CHUNK_X - 1],
      [0, -1, CHUNK_Z - 1, 0],
      [0, 1, 0, CHUNK_Z - 1],
    ];
    for (const [dx, dz, nEdge, myEdge] of faces) {
      const nSkey = chunkKey(cx + dx, cz + dz);
      // lightCount 为 0 表示邻区整块无任何光源（典型多数情况）→ 跳过 8K 扫描
      if ((this.lightCount.get(nSkey) ?? 0) === 0) continue;
      const nLight = this.lightFast.get(packKey(cx + dx, cz + dz));
      if (!nLight) continue;
      const alongX = dx !== 0; // 邻区在 x 方向：遍历其 lx=nEdge 的面
      for (let y = 0; y < CHUNK_Y; y++) {
        for (let t = 0; t < 16; t++) {
          const nl = alongX
            ? nLight[lidx(nEdge, y, t)]
            : nLight[lidx(t, y, nEdge)];
          if (nl < 2) continue;
          const wx = cx * CHUNK_X + (alongX ? myEdge : t);
          const wz = cz * CHUNK_Z + (alongX ? t : myEdge);
          if (!this.reg.isSolid(this.getBlock(wx, y, wz))) {
            addLight(this, wx, y, wz, nl - 1);
          }
        }
      }
    }
  }

  deleteChunk(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    const fkey = packKey(cx, cz);
    this.chunks.delete(key);
    this.light.delete(key);
    this.chunksFast.delete(fkey);
    this.lightFast.delete(fkey);
    this.lightCount.delete(key);
  }

  /**
   * 读取方块。y<0 视为基岩（碰撞兜底），y 超高或区块未加载视为空气。
   */
  getBlock(wx: number, y: number, wz: number): number {
    if (y < 0) return this.reg.id('bedrock');
    if (y >= CHUNK_Y) return AIR;
    let cx: number, cz: number;
    if (wx >= 0) cx = (wx / CHUNK_X) | 0;
    else cx = -((-wx / CHUNK_X) | 0) - (wx % CHUNK_X ? 1 : 0);
    if (wz >= 0) cz = (wz / CHUNK_Z) | 0;
    else cz = -((-wz / CHUNK_Z) | 0) - (wz % CHUNK_Z ? 1 : 0);
    const chunk = this.chunksFast.get(packKey(cx, cz));
    if (!chunk) return AIR;
    const lx = wx - cx * CHUNK_X;
    const lz = wz - cz * CHUNK_Z;
    return chunk[lx + CHUNK_X * (lz + CHUNK_Z * y)];
  }

  /** 读取方块光（未加载/越界视为 0） */
  getLight(wx: number, y: number, wz: number): number {
    if (y < 0 || y >= CHUNK_Y) return 0;
    let cx: number, cz: number;
    if (wx >= 0) cx = (wx / CHUNK_X) | 0;
    else cx = -((-wx / CHUNK_X) | 0) - (wx % CHUNK_X ? 1 : 0);
    if (wz >= 0) cz = (wz / CHUNK_Z) | 0;
    else cz = -((-wz / CHUNK_Z) | 0) - (wz % CHUNK_Z ? 1 : 0);
    const arr = this.lightFast.get(packKey(cx, cz));
    if (!arr) return 0;
    return arr[lidx(wx - cx * CHUNK_X, y, wz - cz * CHUNK_Z)];
  }

  /** 写入方块光并维护非零计数（仅已加载区块；光照是否阻挡由调用方判断） */
  setLight(wx: number, y: number, wz: number, v: number): boolean {
    if (y < 0 || y >= CHUNK_Y) return false;
    let cx: number, cz: number;
    if (wx >= 0) cx = (wx / CHUNK_X) | 0;
    else cx = -((-wx / CHUNK_X) | 0) - (wx % CHUNK_X ? 1 : 0);
    if (wz >= 0) cz = (wz / CHUNK_Z) | 0;
    else cz = -((-wz / CHUNK_Z) | 0) - (wz % CHUNK_Z ? 1 : 0);
    const fkey = packKey(cx, cz);
    const arr = this.lightFast.get(fkey);
    if (!arr) return false; // 光不写入未加载区块
    const i = lidx(wx - cx * CHUNK_X, y, wz - cz * CHUNK_Z);
    const old = arr[i];
    if (old === v) return true;
    arr[i] = v;
    const skey = chunkKey(cx, cz);
    if (old === 0 && v > 0)
      this.lightCount.set(skey, (this.lightCount.get(skey) ?? 0) + 1);
    else if (old > 0 && v === 0)
      this.lightCount.set(skey, (this.lightCount.get(skey) ?? 0) - 1);
    return true;
  }

  /** 该区块（含光照）是否有非零光 */
  hasLight(cx: number, cz: number): boolean {
    return (this.lightCount.get(chunkKey(cx, cz)) ?? 0) > 0;
  }

  /** 3×3 邻域内是否存在任何光照（决定编辑后是否需要 3×3 重网格化） */
  hasLightNear(cx: number, cz: number): boolean {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (this.hasLight(cx + dx, cz + dz)) return true;
      }
    }
    return false;
  }

  setBlock(wx: number, y: number, wz: number, id: number): BlockEdit | null {
    if (y < 0 || y >= CHUNK_Y) return null;
    let cx: number, cz: number;
    if (wx >= 0) cx = (wx / CHUNK_X) | 0;
    else cx = -((-wx / CHUNK_X) | 0) - (wx % CHUNK_X ? 1 : 0);
    if (wz >= 0) cz = (wz / CHUNK_Z) | 0;
    else cz = -((-wz / CHUNK_Z) | 0) - (wz % CHUNK_Z ? 1 : 0);
    const chunk = this.chunksFast.get(packKey(cx, cz));
    if (!chunk) return null;
    const lx = wx - cx * CHUNK_X;
    const lz = wz - cz * CHUNK_Z;
    const oldId = chunk[lidx(lx, y, lz)];
    chunk[lidx(lx, y, lz)] = id;
    // 光照增量更新：旧光清除泛洪 + 新光源/邻域回流（同步完成，紧随其后的重网格化即可读到新光）
    if (oldId !== id) onBlockLightChanged(this, wx, y, wz, oldId, id);
    return { cx, cz, lx, lz, y };
  }

  isSolid(wx: number, y: number, wz: number): boolean {
    return this.reg.isSolid(this.getBlock(wx, y, wz));
  }

  /** 从高处向下找第一个可站立位置（出生点用） */
  findSpawnY(wx: number, wz: number): number {
    for (let y = CHUNK_Y - 1; y > 0; y--) {
      if (this.isSolid(wx, y, wz)) return y + 1;
    }
    return 70;
  }
}
