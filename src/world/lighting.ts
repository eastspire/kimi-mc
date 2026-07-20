import type { World } from './world';

// ============================================================
// 方块光传播（MC 风格 BFS 泛洪，等级 0~15，每格衰减 1）
//  - addLight：从源点扩散（只写入非遮挡格；源格本身即使是实体也持光）
//  - removeLight：撤光泛洪，边界处收集残余光源再回补
//  - onBlockLightChanged：单格编辑的标准两阶段更新（先撤后补）
// ============================================================

interface WorldView {
  reg: World['reg'];
  getBlock(wx: number, y: number, wz: number): number;
  getLight(wx: number, y: number, wz: number): number;
  setLight(wx: number, y: number, wz: number, v: number): boolean;
}

const DIRS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

function occludes(w: WorldView, x: number, y: number, z: number): boolean {
  const id = w.getBlock(x, y, z);
  const d = id > 0 ? w.reg.byId[id] : null;
  return !!d && d.occludes;
}

/** 从 (x,y,z) 以 level 泛洪；level 即该格应得光级（源格允许是实体） */
export function addLight(w: WorldView, x: number, y: number, z: number, level: number): void {
  if (level <= 0) return;
  // 扁平队列 + 指针，避免 shift 的 O(n²)
  const qx: number[] = [x], qy: number[] = [y], qz: number[] = [z], ql: number[] = [level];
  w.setLight(x, y, z, level);
  let head = 0;
  while (head < ql.length) {
    const cx = qx[head], cy = qy[head], cz = qz[head], cl = ql[head];
    head++;
    const next = cl - 1;
    if (next <= 0) continue;
    for (const [dx, dy, dz] of DIRS) {
      const nx = cx + dx, ny = cy + dy, nz = cz + dz;
      if (occludes(w, nx, ny, nz)) continue;
      if (w.getLight(nx, ny, nz) >= next) continue;
      w.setLight(nx, ny, nz, next);
      qx.push(nx); qy.push(ny); qz.push(nz); ql.push(next);
    }
  }
}

/** 撤销 (x,y,z) 处的 level 及其引发的全部衰减光，再从边界残余光回补 */
export function removeLight(w: WorldView, x: number, y: number, z: number, level: number): void {
  const qx: number[] = [x], qy: number[] = [y], qz: number[] = [z], ql: number[] = [level];
  w.setLight(x, y, z, 0);
  // 边界残余光源（不是由被撤光级联产生的光），最后统一回补
  const rx: number[] = [], ry: number[] = [], rz: number[] = [], rl: number[] = [];
  let head = 0;
  while (head < ql.length) {
    const cx = qx[head], cy = qy[head], cz = qz[head], cl = ql[head];
    head++;
    for (const [dx, dy, dz] of DIRS) {
      const nx = cx + dx, ny = cy + dy, nz = cz + dz;
      const nl = w.getLight(nx, ny, nz);
      if (nl === 0) continue;
      if (nl < cl) {
        // 由被撤光级联产生：一并清除
        w.setLight(nx, ny, nz, 0);
        qx.push(nx); qy.push(ny); qz.push(nz); ql.push(nl);
      } else {
        // 独立光源：登记回补
        rx.push(nx); ry.push(ny); rz.push(nz); rl.push(nl);
      }
    }
  }
  for (let i = 0; i < rl.length; i++) addLight(w, rx[i], ry[i], rz[i], rl[i]);
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
