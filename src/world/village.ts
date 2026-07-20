import { CHUNK_X, CHUNK_Y, CHUNK_Z } from './chunk-const';
import type { WorldGen } from './worldgen';
import { hash2i } from './noise';

// Biome 数值镜像（与 worldgen 的 const enum 顺序一致：Plains=0, Desert=1），
// 避免对 worldgen 的值 import 造成运行时循环依赖
const BIOME_PLAINS = 0;
const BIOME_DESERT = 1;

// ============================================================
// 村庄结构生成（跨区块无缝）：
//  - 世界划成 REGION 格大区域，每区域用哈希确定性决定是否有村庄及其中心
//  - 区块生成时收集自身覆盖到的建筑（含邻区外溢），逐块重建到本区块
//  - 全部判定为纯函数（仅依赖坐标+种子），任意区块独立重建结果一致
// ============================================================

/** 一个待放置方块（世界坐标） */
interface Piece {
  x: number;
  y: number;
  z: number;
  id: number;
}

const REGION = 96; // 村庄区域边长（格）
const BUILD_RADIUS = 40; // 村庄建筑影响半径（外溢扫描范围）

/** 方块放置器：只写入本区块范围内的方块 */
type PutFn = (wx: number, y: number, wz: number, id: number) => void;

/** 区域哈希 → [0,1) */
function reghash(rx: number, rz: number, salt: number): number {
  return hash2i(rx, rz, salt);
}

/** 村庄中心（世界坐标）。返回 null 表示该区域无村庄。 */
function villageCenter(
  gen: WorldGen,
  rx: number,
  rz: number,
): { x: number; z: number } | null {
  const salt = gen.structSalt;
  // 约 1/3 区域有村庄
  if (reghash(rx, rz, salt ^ 0x1) > 0.33) return null;
  // 中心在区域内确定性偏移
  const ox = Math.floor(reghash(rx, rz, salt ^ 0x2) * (REGION - 24)) + 12;
  const oz = Math.floor(reghash(rx, rz, salt ^ 0x3) * (REGION - 24)) + 12;
  const cx = rx * REGION + ox;
  const cz = rz * REGION + oz;
  // 仅平原/沙漠生成（中心点生物群系判定）
  const biome = gen.biomeAt(cx, cz);
  if (biome !== BIOME_PLAINS && biome !== BIOME_DESERT) return null;
  return { x: cx, z: cz };
}

/** 求距 (wx,wz) 最近的村庄中心（含邻区域），无则 null。 */
export function nearestVillage(
  gen: WorldGen,
  wx: number,
  wz: number,
): { x: number; z: number } | null {
  const rx = Math.floor(wx / REGION);
  const rz = Math.floor(wz / REGION);
  let best: { x: number; z: number } | null = null;
  let bestD = Infinity;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const c = villageCenter(gen, rx + dx, rz + dz);
      if (!c) continue;
      const d = (c.x - wx) ** 2 + (c.z - wz) ** 2;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
  }
  return best;
}

/** 建筑地块：一栋小屋的 footprint（世界坐标） */
interface House {
  x0: number;
  z0: number;
  w: number; // 沿 x
  d: number; // 沿 z
  baseY: number;
}

/** 求某村庄覆盖的所有小屋（确定性布局：环绕中心的 3~6 栋） */
function villageHouses(gen: WorldGen, cx: number, cz: number): House[] {
  const salt = gen.structSalt;
  const n = 3 + Math.floor(reghash(cx, cz, salt ^ 0x10) * 4); // 3~6 栋
  const houses: House[] = [];
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 + reghash(cx, cz, salt ^ (0x20 + i)) * 1.2;
    const dist = 8 + Math.floor(reghash(cx + i, cz, salt ^ (0x30 + i)) * 14);
    const hx = cx + Math.round(Math.cos(ang) * dist);
    const hz = cz + Math.round(Math.sin(ang) * dist);
    const w = 5 + Math.floor(reghash(hx, hz, salt ^ (0x40 + i)) * 3); // 5~7
    const d = 5 + Math.floor(reghash(hx, hz, salt ^ (0x50 + i)) * 3); // 5~7
    const baseY = gen.heightAt(hx, hz) + 1;
    houses.push({ x0: hx - (w >> 1), z0: hz - (d >> 1), w, d, baseY });
  }
  return houses;
}

/** 生成一栋小屋的全部方块（原木墙角 + 木板墙 + 玻璃 + 尖顶） */
function buildHouse(
  gen: WorldGen,
  h: House,
  out: Piece[],
): void {
  const idLog = gen.idOakLog;
  const idPlanks = gen.idOakPlanks;
  const idGlass = gen.idGlass;
  const idCobble = gen.idCobble;
  const idTorch = gen.idTorch;
  const { x0, z0, w, d, baseY } = h;
  const salt = gen.structSalt;
  const hasGlass = reghash(x0, z0, salt ^ 0x77) < 0.7;

  for (let dx = 0; dx < w; dx++) {
    for (let dz = 0; dz < d; dz++) {
      const wx = x0 + dx;
      const wz = z0 + dz;
      const isWall = dx === 0 || dx === w - 1 || dz === 0 || dz === d - 1;
      // 地基：从地板向下填到地形（防悬空/埋入），并整平建筑基底
      const ground = gen.heightAt(wx, wz);
      for (let y = Math.min(baseY - 1, ground); y <= baseY - 1; y++) {
        out.push({ x: wx, y, z: wz, id: idCobble });
      }
      // 墙体 3 格高
      if (isWall) {
        for (let dy = 0; dy < 3; dy++) {
          const corner =
            (dx === 0 || dx === w - 1) && (dz === 0 || dz === d - 1);
          let id = corner ? idLog : idPlanks;
          // 窗户：墙中段 1 格玻璃（非角）
          if (hasGlass && !corner && dy === 1) {
            const midX = dx === Math.floor(w / 2);
            const midZ = dz === Math.floor(d / 2);
            if (midX || midZ) id = idGlass;
          }
          out.push({ x: wx, y: baseY + dy, z: wz, id });
        }
      } else {
        // 内部清空（空气）
        for (let dy = 0; dy < 3; dy++) {
          out.push({ x: wx, y: baseY + dy, z: wz, id: 0 });
        }
      }
      // 屋顶：顶层向内收的木板尖顶（两层）
      out.push({ x: wx, y: baseY + 3, z: wz, id: idPlanks });
    }
  }
  // 屋顶第二层（内缩一圈）
  for (let dx = 1; dx < w - 1; dx++) {
    for (let dz = 1; dz < d - 1; dz++) {
      out.push({ x: x0 + dx, y: baseY + 4, z: z0 + dz, id: idPlanks });
    }
  }
  // 门：底墙中点掏空 2 格
  const doorX = x0 + Math.floor(w / 2);
  const doorZ = z0;
  out.push({ x: doorX, y: baseY, z: doorZ, id: 0 });
  out.push({ x: doorX, y: baseY + 1, z: doorZ, id: 0 });
  // 屋内一根火把
  out.push({
    x: x0 + Math.floor(w / 2),
    y: baseY + 1,
    z: z0 + Math.floor(d / 2),
    id: idTorch,
  });
}

/** 生成村庄内的农田块（几块耕地 + 小麦） */
function buildFarm(
  gen: WorldGen,
  cx: number,
  cz: number,
  out: Piece[],
): void {
  const salt = gen.structSalt;
  if (reghash(cx, cz, salt ^ 0x90) > 0.6) return;
  const fx = cx + Math.floor(reghash(cx, cz, salt ^ 0x91) * 10) - 5;
  const fz = cz + Math.floor(reghash(cx, cz, salt ^ 0x92) * 10) - 5;
  const baseY = gen.heightAt(fx, fz) + 1;
  const idFarmland = gen.idFarmland;
  const idWheat = gen.idWheat;
  for (let dx = 0; dx < 4; dx++) {
    for (let dz = 0; dz < 3; dz++) {
      const wx = fx + dx;
      const wz = fz + dz;
      out.push({ x: wx, y: baseY - 1, z: wz, id: idFarmland });
      const stage = Math.floor(reghash(wx, wz, salt ^ 0x93) * 8);
      out.push({ x: wx, y: baseY, z: wz, id: idWheat[stage] });
    }
  }
}

/**
 * 把覆盖本区块的村庄建筑写入区块数据。
 * 扫描本区块及外溢范围内的所有区域，对每座村庄重建其覆盖到本区块的方块。
 */
export function applyVillage(
  gen: WorldGen,
  cx: number,
  cz: number,
  data: Uint8Array,
): void {
  const idx = (x: number, y: number, z: number): number =>
    x + CHUNK_X * (z + CHUNK_Z * y);
  const bx = cx * CHUNK_X;
  const bz = cz * CHUNK_Z;

  const put: PutFn = (wx, y, wz, id) => {
    const lx = wx - bx;
    const lz = wz - bz;
    if (lx < 0 || lx >= CHUNK_X || lz < 0 || lz >= CHUNK_Z) return;
    if (y < 1 || y >= CHUNK_Y) return;
    data[idx(lx, y, lz)] = id;
  };

  // 需扫描的区域：本区块坐标 ±BUILD_RADIUS 范围覆盖的所有 REGION
  const r0x = Math.floor((bx - BUILD_RADIUS) / REGION);
  const r1x = Math.floor((bx + CHUNK_X + BUILD_RADIUS) / REGION);
  const r0z = Math.floor((bz - BUILD_RADIUS) / REGION);
  const r1z = Math.floor((bz + CHUNK_Z + BUILD_RADIUS) / REGION);

  const pieces: Piece[] = [];
  for (let rz = r0z; rz <= r1z; rz++) {
    for (let rx = r0x; rx <= r1x; rx++) {
      const center = villageCenter(gen, rx, rz);
      if (!center) continue;
      // 粗剔除：村庄中心离本区块太远则跳过
      if (
        Math.abs(center.x - (bx + CHUNK_X / 2)) > BUILD_RADIUS + CHUNK_X ||
        Math.abs(center.z - (bz + CHUNK_Z / 2)) > BUILD_RADIUS + CHUNK_Z
      )
        continue;
      pieces.length = 0;
      for (const h of villageHouses(gen, center.x, center.z)) {
        buildHouse(gen, h, pieces);
      }
      buildFarm(gen, center.x, center.z, pieces);
      for (const p of pieces) put(p.x, p.y, p.z, p.id);
    }
  }
}
