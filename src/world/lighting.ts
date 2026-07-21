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

// 预编译的遮挡查表：id → 是否挡光（避免每次迭代 getBlock→byId→读字段三层解引用）
let occlTable: Uint8Array | null = null;
let occlReg: WorldView['reg'] | null = null;
function occludesFast(w: WorldView, id: number): boolean {
  if (id <= 0) return false;
  if (occlReg !== w.reg) {
    occlReg = w.reg;
    occlTable = new Uint8Array(w.reg.byId.length);
    for (let i = 0; i < w.reg.byId.length; i++) {
      occlTable[i] = w.reg.byId[i]?.occludes ? 1 : 0;
    }
  }
  return id < occlTable!.length ? occlTable![id] === 1 : false;
}

function occludes(w: WorldView, x: number, y: number, z: number): boolean {
  return occludesFast(w, w.getBlock(x, y, z));
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
    const nCap = cap * 2; // 用乘法而非 <<1，避免 cap > 2^30 时符号溢出
    const nx = new Float64Array(nCap);
    const ny = new Int16Array(nCap);
    const nz = new Float64Array(nCap);
    const nl = new Uint8Array(nCap);
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
  bfs(w, q);
}

/**
 * 区块落地批量播种：把该区块全部光源一次性入队，单次 BFS 泛洪。
 * 相比逐光源调 addLight：重叠泛洪区域只走一遍（强光源自然压制弱光源），
 * 且每格迭代用查表 occlusion，省掉 N 次函数调用 + 重复 byId 解引用。
 * 村庄/要塞区数百火把时，主线程耗时可降一个数量级。
 */
export function seedLights(
  w: WorldView,
  sources: ArrayLike<number>,
): void {
  const q = SHARED_Q;
  q.reset();
  // sources 为扁平 [x,y,z,level, ...]
  for (let i = 0; i + 3 < sources.length; i += 4) {
    const x = sources[i], y = sources[i + 1], z = sources[i + 2], l = sources[i + 3];
    if (l <= 0) continue;
    w.setLight(x, y, z, l);
    q.push(x, y, z, l);
  }
  bfs(w, q);
}

/** BFS 主循环（addLight 与 seedLights 共用）：逐格查表 occlusion + 衰减扩散 */
function bfs(w: WorldView, q: LightQueue): void {
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
      if (occludesFast(w, w.getBlock(nx, ny, nz))) continue;
      if (w.getLight(nx, ny, nz) >= next) continue;
      // setLight 返回 false = 未加载/越界：不写入也不入队。
      // 关键：阻止泛洪越过加载边界在虚空里无限扩散（会把共享队列撑爆 OOM）。
      if (!w.setLight(nx, ny, nz, next)) continue;
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
