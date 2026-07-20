import type { World } from '../world/world';

// ============================================================
// DDA 体素射线（Amanatides & Woo），最远距离可配
// ============================================================

export interface RayHit {
  x: number; y: number; z: number;      // 命中的方块格
  nx: number; ny: number; nz: number;   // 命中面法线
  block: number;
  dist: number;
}

export function raycastVoxel(
  world: World,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
): RayHit | null {
  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;

  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;

  const distX = stepX > 0 ? x + 1 - ox : ox - x;
  const distY = stepY > 0 ? y + 1 - oy : oy - y;
  const distZ = stepZ > 0 ? z + 1 - oz : oz - z;

  let tMaxX = tDeltaX * distX;
  let tMaxY = tDeltaY * distY;
  let tMaxZ = tDeltaZ * distZ;

  let nx = 0, ny = 0, nz = 0;
  let t = 0;

  for (let i = 0; i < 256; i++) {
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX; t = tMaxX; tMaxX += tDeltaX;
      nx = -stepX; ny = 0; nz = 0;
    } else if (tMaxY < tMaxZ) {
      y += stepY; t = tMaxY; tMaxY += tDeltaY;
      nx = 0; ny = -stepY; nz = 0;
    } else {
      z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ;
      nx = 0; ny = 0; nz = -stepZ;
    }
    if (t > maxDist) return null;

    const block = world.getBlock(x, y, z);
    if (block !== 0) {
      const def = world.reg.def(block);
      if (def && def.selectable) {
        return { x, y, z, nx, ny, nz, block, dist: t };
      }
    }
  }
  return null;
}
