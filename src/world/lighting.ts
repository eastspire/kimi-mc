import type { World } from './world';

// ============================================================
// 方块光传播（MC 风格 BFS 泛洪，等级 0~15，每格衰减 1）
//  - addLight：从源点扩散（只写入非遮挡格；源格允许是实体）
//  - removeLight：撤光泛洪，边界处收集残余光源再回补
//  - onBlockLightChanged：单格编辑的标准两阶段更新（先撤后补）
//  - 4 个并行 typed-array 队列 + head/tail 指针，避免每次 BFS 分配 4× push
// ============================================================

interface WorldView {
  reg: World['reg'];
  getBlock(wx: number, y: number, wz: number): number;
  getLight(wx: number, y: number, wz: number): number;
  setLight(wx: number, y: number, wz: number, v: number): boolean;
}

const DIRS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

function occludes(w: WorldView, x: number, y: number, z: number): boolean {
  const id = w.getBlock(x, y, z);
  const d = id > 0 ? w.reg.byId[id] : null;
  return !!d && d.occludes;
}

// 4 路并行的 typed-array BFS 队列（不分配，按需扩容并复用 head/tail）
class LightQueue {
  qx: Float64Array;
  qy: Int16Array;
  qz: Float64Array;
  ql: Uint8Array; // 光级 0~255（实测 0~15）
  head = 0;
  tail = 0;
  constructor(cap: number) {
    this.qx = new Float64Array(cap);
    this.qy = new Int16Array(cap);
    this.qz = new Float64Array(cap);
    this.ql = new Uint8Array(cap);
  }
  push(x: number, y: number, z: number, l: number): void {
    if (this.tail >= this.qx.length) this.grow();
    this.qx[this.tail] = x;
    this.qy[this.tail] = y;
    this.qz[this.tail] = z;
    this.ql[this.tail] = l;
    this.tail++;
  }
  grow(): void {
    if (this.head > 1024) {
      // 已消费大半部分，原地压缩 head：不分配新内存
      const n = this.tail - this.head;
      this.qx.copyWithin(0, this.head, this.tail);
      this.qy.copyWithin(0, this.head, this.tail);
      this.qz.copyWithin(0, this.head, this.tail);
      this.ql.copyWithin(0, this.head, this.tail);
      this.head = 0;
      this.tail = n;
      return;
    }
    const cap = this.qx.length;
    const nx = new Float64Array(cap << 1);
    const ny = new Int16Array(cap << 1);
    const nz = new Float64Array(cap << 1);
    const nl = new Uint8Array(cap << 1);
    const len = this.tail - this.head;
    nx.set(this.qx.subarray(this.head, this.tail));
    ny.set(this.qy.subarray(this.head, this.tail));
    nz.set(this.qz.subarray(this.head, this.tail));
    nl.set(this.ql.subarray(this.head, this.tail));
    this.qx = nx;
    this.qy = ny;
    this.qz = nz;
    this.ql = nl;
    this.head = 0;
    this.tail = len;
  }
  reset(): void {
    this.head = 0;
    this.tail = 0;
  }
}

// 一个全局复用队列（单线程 JS，无需并发保护），避免每次 addLight 分配
const SHARED_Q = new LightQueue(1024);
const SHARED_RQ: number[] = [];

/** 从 (x,y,z) 以 level 泛洪；level 即该格应得光级（源格允许是实体） */
export function addLight(
  w: WorldView,
  x: number,
  y: number,
  z: number,
  level: number,
): void {
  if (level <= 0) return;
  const q = SHARED_Q;
  q.reset();
  w.setLight(x, y, z, level);
  q.push(x, y, z, level);
  while (q.head < q.tail) {
    const cx = q.qx[q.head],
      cy = q.qy[q.head],
      cz = q.qz[q.head],
      cl = q.ql[q.head];
    q.head++;
    const next = cl - 1;
    if (next <= 0) continue;
    for (const [dx, dy, dz] of DIRS) {
      const nx = cx + dx,
        ny = cy + dy,
        nz = cz + dz;
      if (ny < 0 || ny >= 128) continue;
      if (occludes(w, nx, ny, nz)) continue;
      if (w.getLight(nx, ny, nz) >= next) continue;
      w.setLight(nx, ny, nz, next);
      q.push(nx, ny, nz, next);
    }
  }
}

/** 撤销 (x,y,z) 处的 level 及其引发的全部衰减光，再从边界残余光回补 */
export function removeLight(
  w: WorldView,
  x: number,
  y: number,
  z: number,
  level: number,
): void {
  const q = SHARED_Q;
  q.reset();
  SHARED_RQ.length = 0;
  w.setLight(x, y, z, 0);
  q.push(x, y, z, level);
  while (q.head < q.tail) {
    const cx = q.qx[q.head],
      cy = q.qy[q.head],
      cz = q.qz[q.head],
      cl = q.ql[q.head];
    q.head++;
    for (const [dx, dy, dz] of DIRS) {
      const nx = cx + dx,
        ny = cy + dy,
        nz = cz + dz;
      if (ny < 0 || ny >= 128) continue;
      const nl = w.getLight(nx, ny, nz);
      if (nl === 0) continue;
      if (nl < cl) {
        // 由被撤光级联产生：一并清除
        w.setLight(nx, ny, nz, 0);
        q.push(nx, ny, nz, nl);
      } else {
        SHARED_RQ.push(nx, ny, nz, nl); // 独立光源：登记回补
      }
    }
  }
  for (let i = 0; i < SHARED_RQ.length; i += 4) {
    addLight(
      w,
      SHARED_RQ[i],
      SHARED_RQ[i + 1],
      SHARED_RQ[i + 2],
      SHARED_RQ[i + 3],
    );
  }
}

/**
 * 单格方块变化的光照更新：先撤旧光，再补新光源与邻域回流。
 * 同时覆盖：放置/移除光源、遮挡增减（挖墙透光 / 砌墙挡光）。
 */
export function onBlockLightChanged(
  w: WorldView,
  x: number,
  y: number,
  z: number,
  _oldId: number,
  newId: number,
): void {
  // 1) 撤掉该格现有光（含旧光源与旧透光路径）
  const cur = w.getLight(x, y, z);
  if (cur > 0) removeLight(w, x, y, z, cur);

  // 2) 新方块是光源：源格播种
  const newLum = newId > 0 ? (w.reg.byId[newId]?.luminance ?? 0) : 0;
  if (newLum > 0) addLight(w, x, y, z, newLum);

  // 3) 邻域回流：挖开遮挡后，取 6 邻最大光级 -1 重新泛洪
  if (!occludes(w, x, y, z)) {
    let best = 0;
    for (const [dx, dy, dz] of DIRS) {
      const nl = w.getLight(x + dx, y + dy, z + dz);
      if (nl - 1 > best) best = nl - 1;
    }
    if (best > w.getLight(x, y, z)) addLight(w, x, y, z, best);
  }
}
