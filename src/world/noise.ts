// ============================================================
// 轻量确定性噪声：值噪声 + fBm（自实现，避免依赖 simplex-noise）
// ============================================================

/** 整型格点哈希 → [0,1) */
function ihash(x: number, y: number, z: number, seed: number): number {
  let h = seed | 0;
  h = Math.imul(h ^ Math.imul(x | 0, 374761393), 668265263);
  h = Math.imul(h ^ Math.imul(y | 0, 2246822519), 3266489917);
  h = Math.imul(h ^ Math.imul(z | 0, 3266489917), 1103515245);
  h ^= h >>> 15;
  h = Math.imul(h, 2654435761);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class Noise2D {
  constructor(private seed: number) {}

  /** 值噪声，输出约 [-1,1] */
  get(x: number, y: number): number {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smooth(x - x0), fy = smooth(y - y0);
    const s = this.seed;
    const v00 = ihash(x0, y0, 0, s);
    const v10 = ihash(x0 + 1, y0, 0, s);
    const v01 = ihash(x0, y0 + 1, 0, s);
    const v11 = ihash(x0 + 1, y0 + 1, 0, s);
    return lerp(lerp(v00, v10, fx), lerp(v01, v11, fx), fy) * 2 - 1;
  }

  fbm(x: number, y: number, octaves: number): number {
    let sum = 0, amp = 0.5, norm = 0, fx = x, fy = y;
    for (let i = 0; i < octaves; i++) {
      sum += this.get(fx, fy) * amp;
      norm += amp;
      amp *= 0.5;
      fx *= 2; fy *= 2;
    }
    return sum / norm;
  }
}

export class Noise3D {
  constructor(private seed: number) {}

  get(x: number, y: number, z: number): number {
    const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
    const fx = smooth(x - x0), fy = smooth(y - y0), fz = smooth(z - z0);
    const s = this.seed;
    const c000 = ihash(x0, y0, z0, s);
    const c100 = ihash(x0 + 1, y0, z0, s);
    const c010 = ihash(x0, y0 + 1, z0, s);
    const c110 = ihash(x0 + 1, y0 + 1, z0, s);
    const c001 = ihash(x0, y0, z0 + 1, s);
    const c101 = ihash(x0 + 1, y0, z0 + 1, s);
    const c011 = ihash(x0, y0 + 1, z0 + 1, s);
    const c111 = ihash(x0 + 1, y0 + 1, z0 + 1, s);
    return (
      lerp(
        lerp(lerp(c000, c100, fx), lerp(c010, c110, fx), fy),
        lerp(lerp(c001, c101, fx), lerp(c011, c111, fx), fy),
        fz,
      ) * 2 - 1
    );
  }

  fbm(x: number, y: number, z: number, octaves: number): number {
    let sum = 0, amp = 0.5, norm = 0;
    let fx = x, fy = y, fz = z;
    for (let i = 0; i < octaves; i++) {
      sum += this.get(fx, fy, fz) * amp;
      norm += amp;
      amp *= 0.5;
      fx *= 2; fy *= 2; fz *= 2;
    }
    return sum / norm;
  }
}

/** 按坐标确定性哈希（种树/矿石撒点用） */
export function hash2i(x: number, z: number, salt: number): number {
  return ihash(x, z, 0, salt);
}

export function hash3i(x: number, y: number, z: number, salt: number): number {
  return ihash(x, y, z, salt);
}
