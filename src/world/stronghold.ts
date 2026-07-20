import { CHUNK_X, CHUNK_Y, CHUNK_Z } from './chunk-const';
import { hash2i } from './noise';
import type { WorldGen } from './worldgen';

// ============================================================
// 要塞结构生成（跨区块无缝，埋于地下）：
//  - 世界划成大区域，每区域哈希确定性决定是否有要塞及中心
//  - 要塞 = 石砖走廊 + 末地传送门房间（12 格框架围一圈，内部末地传送门）
//  - 全部判定为纯函数，任意区块独立重建结果一致
//  - 末地传送门房间中央即"跳入即传送"的末地门（写为 end_portal 方块）
// ============================================================

interface Piece {
  x: number;
  y: number;
  z: number;
  id: number;
}

const REGION = 160; // 要塞区域边长（比村庄稀疏）
const RADIUS = 40; // 要塞影响半径
/** 要塞主体深度（地表下） */
const DEPTH = 24;

function reghash(rx: number, rz: number, salt: number): number {
  return hash2i(rx, rz, salt);
}

/** 要塞中心（世界坐标）。返回 null 表示该区域无要塞。 */
function strongholdCenter(
  gen: WorldGen,
  rx: number,
  rz: number,
): { x: number; z: number } | null {
  const salt = gen.structSalt;
  if (reghash(rx, rz, salt ^ 0xa1) > 0.22) return null; // 较稀疏
  const ox = Math.floor(reghash(rx, rz, salt ^ 0xa2) * (REGION - 40)) + 20;
  const oz = Math.floor(reghash(rx, rz, salt ^ 0xa3) * (REGION - 40)) + 20;
  return { x: rx * REGION + ox, z: rz * REGION + oz };
}

/** 求距 (wx,wz) 最近的要塞中心（含邻区域） */
export function nearestStronghold(
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
      const c = strongholdCenter(gen, rx + dx, rz + dz);
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

/**
 * 求最近要塞的末地传送门房间中心（用于末影之眼定位 / 末地传送点）。
 * 返回世界坐标（传送门框架中心）与房间基准高度。
 */
export function strongholdPortal(
  gen: WorldGen,
  wx: number,
  wz: number,
): { x: number; y: number; z: number } | null {
  const c = nearestStronghold(gen, wx, wz);
  if (!c) return null;
  const baseY = Math.max(12, gen.heightAt(c.x, c.z) - DEPTH);
  return { x: c.x, y: baseY + 1, z: c.z };
}

/** 生成一座要塞的全部方块（写入 out，世界坐标） */
function buildStronghold(gen: WorldGen, cx: number, cz: number, out: Piece[]): void {
  const idStoneBricks = gen.idStoneBricks;
  const idFrame = gen.idEndPortalFrame;
  const idFrameEye = gen.idEndPortalFrameEye;
  const idEndPortal = gen.idEndPortal;
  const idTorch = gen.idTorch;
  const baseY = Math.max(12, gen.heightAt(cx, cz) - DEPTH);

  // 传送门房间：9×9 地板、5 格高，中央 3×3 末地门，外围一圈框架
  // 房间范围 x∈[cx-4,cx+4], z∈[cz-4,cz+4]，y∈[baseY, baseY+4]
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      const wx = cx + dx;
      const wz = cz + dz;
      // 地板 + 天花
      out.push({ x: wx, y: baseY - 1, z: wz, id: idStoneBricks });
      out.push({ x: wx, y: baseY + 4, z: wz, id: idStoneBricks });
      // 房间内部（除传送门区）清空
      const inner = Math.abs(dx) <= 3 && Math.abs(dz) <= 3;
      if (inner) {
        for (let dy = 0; dy <= 3; dy++) {
          out.push({ x: wx, y: baseY + dy, z: wz, id: 0 });
        }
      }
      // 房间围墙（外圈）
      if (Math.abs(dx) === 4 || Math.abs(dz) === 4) {
        for (let dy = 0; dy <= 4; dy++) {
          out.push({ x: wx, y: baseY + dy, z: wz, id: idStoneBricks });
        }
      }
    }
  }
  // 中央末地传送门：3×3 池（末地门方块），四周 12 格框架环
  // 框架环位于 y=baseY，门体位于同层的 3×3 内
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const wx = cx + dx;
      const wz = cz + dz;
      const edge = Math.max(Math.abs(dx), Math.abs(dz)) === 2;
      if (edge) {
        // 框架：确定性部分嵌眼（已激活）
        const eye = reghash(wx, wz, gen.structSalt ^ 0xb1) < 0.5;
        out.push({ x: wx, y: baseY, z: wz, id: eye ? idFrameEye : idFrame });
      } else {
        // 中央 3×3：末地传送门方块（跳入即传送）
        out.push({ x: wx, y: baseY, z: wz, id: idEndPortal });
      }
    }
  }
  // 房间四角火把
  for (const [ox, oz] of [
    [-3, -3],
    [3, -3],
    [-3, 3],
    [3, 3],
  ] as const) {
    out.push({ x: cx + ox, y: baseY + 2, z: cz + oz, id: idTorch });
  }

  // 简单走廊：从房间四边各延伸一条石砖甬道（装饰/探索）
  const corridors: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (const [dxd, dzd] of corridors) {
    if (reghash(cx + dxd, cz + dzd, gen.structSalt ^ 0xc1) < 0.4) continue;
    for (let i = 5; i <= 14; i++) {
      const wx = cx + dxd * i;
      const wz = cz + dzd * i;
      // 3 宽 3 高甬道
      for (let wdt = -1; wdt <= 1; wdt++) {
        const px2 = wx + (dzd !== 0 ? wdt : 0);
        const pz2 = wz + (dxd !== 0 ? wdt : 0);
        out.push({ x: px2, y: baseY - 1, z: pz2, id: idStoneBricks });
        out.push({ x: px2, y: baseY + 3, z: pz2, id: idStoneBricks });
        for (let dy = 0; dy <= 2; dy++) {
          out.push({ x: px2, y: baseY + dy, z: pz2, id: 0 });
        }
      }
    }
  }
}

/**
 * 把覆盖本区块的要塞写入区块数据（覆盖式，含清空房间内部）。
 */
export function applyStronghold(
  gen: WorldGen,
  cx: number,
  cz: number,
  data: Uint8Array,
): void {
  const idx = (x: number, y: number, z: number): number =>
    x + CHUNK_X * (z + CHUNK_Z * y);
  const bx = cx * CHUNK_X;
  const bz = cz * CHUNK_Z;

  const r0x = Math.floor((bx - RADIUS) / REGION);
  const r1x = Math.floor((bx + CHUNK_X + RADIUS) / REGION);
  const r0z = Math.floor((bz - RADIUS) / REGION);
  const r1z = Math.floor((bz + CHUNK_Z + RADIUS) / REGION);

  const pieces: Piece[] = [];
  for (let rz = r0z; rz <= r1z; rz++) {
    for (let rx = r0x; rx <= r1x; rx++) {
      const center = strongholdCenter(gen, rx, rz);
      if (!center) continue;
      if (
        Math.abs(center.x - (bx + CHUNK_X / 2)) > RADIUS + CHUNK_X ||
        Math.abs(center.z - (bz + CHUNK_Z / 2)) > RADIUS + CHUNK_Z
      )
        continue;
      pieces.length = 0;
      buildStronghold(gen, center.x, center.z, pieces);
      for (const p of pieces) {
        const lx = p.x - bx;
        const lz = p.z - bz;
        if (lx < 0 || lx >= CHUNK_X || lz < 0 || lz >= CHUNK_Z) continue;
        if (p.y < 1 || p.y >= CHUNK_Y) continue;
        data[idx(lx, p.y, lz)] = p.id;
      }
    }
  }
}
