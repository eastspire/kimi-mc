import type { BlockDef, ElementDef, FaceName } from '../core/model-loader';

// ============================================================
// 区块网格化（Worker 内运行）：
//  - 隐藏面剔除（cullface / 同类型互剔）
//  - 全立方体走贪心合并（相同 方块+AO+光照+贴图 的矩形合并）
//  - 非全立方体（十字植物等）走逐元素慢路径
//  - 方向性面明暗 + 逐顶点环境光遮蔽（AO）烘焙进顶点色
//  - 方块光（荧石等）按面邻格 + AO 同位四角平均，写入 aLight 属性
//  - 水面在上方非水时下沉 1/8 格
// 输入：18×128×18 带一圈邻区边的方块数据 + 同布局方块光（可为 null）
// ============================================================

const PX = 18; // x/z 各外扩 1
const PZ = 18;
const PH = 128;

const pidx = (x: number, y: number, z: number): number =>
  x + 1 + PX * (z + 1 + PZ * y);

const AO_CURVE = [0.55, 0.7, 0.85, 1.0];
const WATER_DROP = 2 / 16; // 水面下沉

/** 水位 0..8 → 顶面高度（方块内 0..1）。0=水源满格下沉 1/8，1..7 逐级降低，8=下落柱满格 */
function waterTopFor(level: number): number {
  if (level <= 0) return 1 - WATER_DROP; // 水源：满格略降，避免相邻水面 z-fight
  if (level >= 8) return 1; // 下落水柱：满格
  return (8 - level) / 9; // 扩散水：1 级≈0.78 … 7 级≈0.11
}

export interface MeshArrays {
  positions: number[];
  uvs: number[];
  tiles: number[];
  colors: number[];
  lights: number[]; // 逐顶点方块光 0~15
  indices: number[];
}

export interface ChunkMeshOutput {
  opaque: MeshArrays | null;
  translucent: MeshArrays | null;
}

function newArrays(): MeshArrays {
  return {
    positions: [],
    uvs: [],
    tiles: [],
    colors: [],
    lights: [],
    indices: [],
  };
}

interface DirSpec {
  name: FaceName;
  axis: 0 | 1 | 2;
  sign: 1 | -1;
  shade: number;
  t1: 0 | 1 | 2; // AO 切向轴 1
  t2: 0 | 1 | 2; // AO 切向轴 2
  cs: readonly (readonly [number, number])[]; // 4 角符号，顺序与顶点一致
}

const DIRS: readonly DirSpec[] = [
  {
    name: 'down',
    axis: 1,
    sign: -1,
    shade: 0.5,
    t1: 0,
    t2: 2,
    cs: [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ],
  },
  {
    name: 'up',
    axis: 1,
    sign: 1,
    shade: 1.0,
    t1: 0,
    t2: 2,
    cs: [
      [-1, -1],
      [-1, 1],
      [1, 1],
      [1, -1],
    ],
  },
  {
    name: 'north',
    axis: 2,
    sign: -1,
    shade: 0.8,
    t1: 0,
    t2: 1,
    cs: [
      [1, -1],
      [-1, -1],
      [-1, 1],
      [1, 1],
    ],
  },
  {
    name: 'south',
    axis: 2,
    sign: 1,
    shade: 0.8,
    t1: 0,
    t2: 1,
    cs: [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ],
  },
  {
    name: 'west',
    axis: 0,
    sign: -1,
    shade: 0.6,
    t1: 2,
    t2: 1,
    cs: [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ],
  },
  {
    name: 'east',
    axis: 0,
    sign: 1,
    shade: 0.6,
    t1: 2,
    t2: 1,
    cs: [
      [1, -1],
      [-1, -1],
      [-1, 1],
      [1, 1],
    ],
  },
];

/** 面四角在区块局部坐标中的偏移（CCW 外向），按 (axis,sign) 给出 */
function faceCorners(
  dir: DirSpec,
  s: number,
  i: number,
  j: number,
  w: number,
  h: number,
): [number, number, number][] {
  switch (dir.name) {
    case 'up':
      return [
        [i, s + 1, j],
        [i, s + 1, j + h],
        [i + w, s + 1, j + h],
        [i + w, s + 1, j],
      ];
    case 'down':
      return [
        [i, s, j],
        [i + w, s, j],
        [i + w, s, j + h],
        [i, s, j + h],
      ];
    case 'east':
      return [
        [s + 1, j, i + w],
        [s + 1, j, i],
        [s + 1, j + h, i],
        [s + 1, j + h, i + w],
      ];
    case 'west':
      return [
        [s, j, i],
        [s, j, i + w],
        [s, j + h, i + w],
        [s, j + h, i],
      ];
    case 'south':
      return [
        [i, j, s + 1],
        [i + w, j, s + 1],
        [i + w, j + h, s + 1],
        [i, j + h, s + 1],
      ];
    case 'north':
      return [
        [i + w, j, s],
        [i, j, s],
        [i, j + h, s],
        [i + w, j + h, s],
      ];
  }
}

/** 局部 UV（可被贪心合并放大到 w×h，shader 内 fract 重复） */
function faceUVs(dir: DirSpec, w: number, h: number): [number, number][] {
  if (dir.name === 'up')
    return [
      [0, 0],
      [0, h],
      [w, h],
      [w, 0],
    ];
  return [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
}

// 慢路径：单位立方各面角点
const BOX_FACE_CORNERS: Record<FaceName, [number, number, number][]> = {
  down: [
    [0, 0, 0],
    [1, 0, 0],
    [1, 0, 1],
    [0, 0, 1],
  ],
  up: [
    [0, 1, 0],
    [0, 1, 1],
    [1, 1, 1],
    [1, 1, 0],
  ],
  north: [
    [1, 0, 0],
    [0, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
  ],
  south: [
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ],
  west: [
    [0, 0, 0],
    [0, 0, 1],
    [0, 1, 1],
    [0, 1, 0],
  ],
  east: [
    [1, 0, 1],
    [1, 0, 0],
    [1, 1, 0],
    [1, 1, 1],
  ],
};

const FACE_SHADE: Record<FaceName, number> = {
  down: 0.5,
  up: 1.0,
  north: 0.8,
  south: 0.8,
  west: 0.6,
  east: 0.6,
};

/** 面方向单位向量（cullface / AO 法向层偏移用） */
const FACE_NORMAL: Record<FaceName, [number, number, number]> = {
  down: [0, -1, 0],
  up: [0, 1, 0],
  north: [0, 0, -1],
  south: [0, 0, 1],
  west: [-1, 0, 0],
  east: [1, 0, 0],
};

const NO_LIGHT: readonly number[] = [0, 0, 0, 0];

function pushQuad(
  arr: MeshArrays,
  corners: [number, number, number][],
  uvs: [number, number][],
  tile: number,
  shade: number,
  ao: readonly number[],
  lowerTop: boolean,
  lv: readonly number[] = NO_LIGHT,
  /** 顶面绝对高度（方块内 0..1，仅 lowerTop 为 true 时生效）；缺省为旧的水面下沉行为 */
  topHeight?: number,
): void {
  const base = arr.positions.length / 3;
  const maxY = Math.max(
    corners[0][1],
    corners[1][1],
    corners[2][1],
    corners[3][1],
  );
  for (let k = 0; k < 4; k++) {
    let [cx, cy, cz] = corners[k];
    if (lowerTop && corners[k][1] === maxY) {
      // topHeight 为相对块底(0..1)的水面高度；maxY-1 即块底世界 y（up 面 maxY=s+1）
      cy =
        topHeight !== undefined
          ? maxY - 1 + topHeight
          : cy - WATER_DROP;
    }
    arr.positions.push(cx, cy, cz);
    arr.uvs.push(uvs[k][0], uvs[k][1]);
    arr.tiles.push(tile);
    const c = shade * AO_CURVE[ao[k]];
    arr.colors.push(c, c, c);
    arr.lights.push(lv[k]);
  }
  arr.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/**
 * 元素某面的方块局部坐标角点（0..1，含元素旋转）。
 * 慢路径建模与手持物品建模共用。
 */
export function elementFaceCorners(
  el: ElementDef,
  fname: FaceName,
): [number, number, number][] {
  return BOX_FACE_CORNERS[fname].map((u) => {
    let ex = el.from[0] + u[0] * (el.to[0] - el.from[0]);
    const ey = el.from[1] + u[1] * (el.to[1] - el.from[1]);
    let ez = el.from[2] + u[2] * (el.to[2] - el.from[2]);
    if (el.rotation) {
      const rad = (el.rotation.angle * Math.PI) / 180;
      const cos = Math.cos(rad),
        sin = Math.sin(rad);
      const ox = el.rotation.origin[0],
        oz = el.rotation.origin[2];
      const dx = ex - ox,
        dz = ez - oz;
      ex = ox + dx * cos + dz * sin;
      ez = oz - dx * sin + dz * cos;
    }
    return [ex / 16, ey / 16, ez / 16] as [number, number, number];
  });
}

/**
 * 独立构建单个方块的网格（以方块中心为原点，边长 1），
 * 供第一人称手持物 / 掉落物等离屏渲染使用。
 * 与区块网格共用同一套 aTile 着色器材质。
 */
export function buildBlockGeometry(def: BlockDef): MeshArrays | null {
  if (def.elements.length === 0) return null;
  const arr = newArrays();
  for (const el of def.elements) {
    for (const fname of Object.keys(el.faces) as FaceName[]) {
      const face = el.faces[fname]!;
      const corners = elementFaceCorners(el, fname).map(
        (c) => [c[0] - 0.5, c[1] - 0.5, c[2] - 0.5] as [number, number, number],
      );
      const [u0, v0, u1, v1] = face.uv ?? [0, 0, 1, 1];
      const uvs: [number, number][] = [
        [u0, v0],
        [u1, v0],
        [u1, v1],
        [u0, v1],
      ];
      pushQuad(
        arr,
        corners,
        uvs,
        face.tile,
        FACE_SHADE[fname],
        [3, 3, 3, 3],
        false,
      );
    }
  }
  return arr.positions.length > 0 ? arr : null;
}

export function buildChunkMesh(
  data: Uint8Array,
  defs: (BlockDef | null)[],
  aoOn: boolean,
  lightPad: Uint8Array | null,
): ChunkMeshOutput {
  const opaque = newArrays();
  const translucent = newArrays();

  const rawAt = (x: number, y: number, z: number): number => {
    if (y < 0) return -1; // 世界底部视为实体边界
    if (y >= PH) return 0;
    return data[pidx(x, y, z)];
  };
  const defOf = (id: number): BlockDef | null =>
    id > 0 ? (defs[id] ?? null) : null;
  const occludesAt = (x: number, y: number, z: number): boolean => {
    if (y < 0) return true;
    if (y >= PH) return false;
    const d = defOf(data[pidx(x, y, z)]);
    return !!d && d.occludes;
  };
  const lAt = (x: number, y: number, z: number): number => {
    if (y < 0 || y >= PH) return 0;
    return lightPad![pidx(x, y, z)];
  };

  // ---------- 慢路径：非全立方体（十字植物等） ----------
  for (let y = 0; y < PH; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const id = data[pidx(x, y, z)];
        const def = defOf(id);
        if (!def || def.fullCube) continue;
        const arr = def.renderLayer === 'translucent' ? translucent : opaque;
        // 植物等取其所在格光照
        const cl = lightPad ? lightPad[pidx(x, y, z)] : 0;
        const lv = [cl, cl, cl, cl];
        for (const el of def.elements) {
          for (const fname of Object.keys(el.faces) as FaceName[]) {
            const face = el.faces[fname]!;
            if (face.cullface) {
              const n = FACE_NORMAL[face.cullface];
              if (occludesAt(x + n[0], y + n[1], z + n[2])) continue;
            }
            const corners = elementFaceCorners(el, fname).map(
              (c) => [x + c[0], y + c[1], z + c[2]] as [number, number, number],
            );
            const [u0, v0, u1, v1] = face.uv ?? [0, 0, 1, 1];
            const uvs: [number, number][] = [
              [u0, v0],
              [u1, v0],
              [u1, v1],
              [u0, v1],
            ];
            pushQuad(
              arr,
              corners,
              uvs,
              face.tile,
              FACE_SHADE[fname],
              [3, 3, 3, 3],
              false,
              lv,
            );
          }
        }
      }
    }
  }

  // ---------- 快路径：全立方体贪心合并 ----------
  const mask = new Uint32Array(16 * PH);
  // 桶过滤：0 = opaque（solid+cutout），1 = translucent
  for (let bucket = 0; bucket <= 1; bucket++) {
    const arr = bucket === 0 ? opaque : translucent;
    for (const dir of DIRS) {
      const W = dir.axis === 1 ? 16 : 16; // u 维度
      const H = dir.axis === 1 ? 16 : PH; // v 维度
      const S = dir.axis === 1 ? PH : 16; // 切片维度
      const nx = dir.axis === 0 ? dir.sign : 0;
      const ny = dir.axis === 1 ? dir.sign : 0;
      const nz = dir.axis === 2 ? dir.sign : 0;
      const t1x = dir.t1 === 0 ? 1 : 0,
        t1y = dir.t1 === 1 ? 1 : 0,
        t1z = dir.t1 === 2 ? 1 : 0;
      const t2x = dir.t2 === 0 ? 1 : 0,
        t2y = dir.t2 === 1 ? 1 : 0,
        t2z = dir.t2 === 2 ? 1 : 0;

      for (let s = 0; s < S; s++) {
        mask.fill(0, 0, W * H);
        // 构建切片掩码：(tile+1)5b | ao8b<<5 | topFlag1b<<13 | light16b<<14
        for (let v = 0; v < H; v++) {
          for (let u = 0; u < W; u++) {
            let x: number, y: number, z: number;
            if (dir.axis === 0) {
              x = s;
              y = v;
              z = u;
            } else if (dir.axis === 1) {
              x = u;
              y = s;
              z = v;
            } else {
              x = u;
              y = v;
              z = s;
            }
            const id = rawAt(x, y, z);
            const def = defOf(id);
            if (!def || !def.fullCube) continue;
            if ((def.renderLayer === 'translucent' ? 1 : 0) !== bucket)
              continue;
            // 隐藏面剔除
            const rid = rawAt(x + nx, y + ny, z + nz);
            if (rid === -1) continue;
            const rdef = defOf(rid);
            if (rdef) {
              if (def.cullSame && rid === id) continue;
              else if (rdef.occludes) continue;
              // 水-水相邻：仅当邻居水位不高于当前（邻居水面不低于本格）才剔除共享面，
              // 否则保留侧面以呈现水位落差；顶面（up）不受此限，由 waterCode 单独处理
              else if (rdef.fluid && def.fluid) {
                const sameTop =
                  dir.name === 'up' || rdef.waterLevel <= def.waterLevel;
                if (sameTop) continue;
              }
            }
            const tile = def.faceTiles[dir.name];
            if (tile === undefined) continue;
            const doAo = bucket === 0 && aoOn;
            const doLight = bucket === 0 && lightPad !== null;
            let ao = 0b11111111; // 4×2bit = 3,3,3,3（AO 关 → 恒为最亮，合并更充分）
            let lpk = 0; // 4×4bit 逐角光照（面邻格 + AO 同位四角平均）
            if (doAo || doLight) {
              if (doAo) ao = 0;
              const lf = doLight ? lAt(x + nx, y + ny, z + nz) : 0;
              for (let k = 0; k < 4; k++) {
                const s1x = x + nx + dir.cs[k][0] * t1x,
                  s1y = y + ny + dir.cs[k][0] * t1y,
                  s1z = z + nz + dir.cs[k][0] * t1z;
                const s2x = x + nx + dir.cs[k][1] * t2x,
                  s2y = y + ny + dir.cs[k][1] * t2y,
                  s2z = z + nz + dir.cs[k][1] * t2z;
                const ccx = s1x + dir.cs[k][1] * t2x,
                  ccy = s1y + dir.cs[k][1] * t2y,
                  ccz = s1z + dir.cs[k][1] * t2z;
                if (doAo) {
                  const s1 = occludesAt(s1x, s1y, s1z) ? 1 : 0;
                  const s2 = occludesAt(s2x, s2y, s2z) ? 1 : 0;
                  const cc = occludesAt(ccx, ccy, ccz) ? 1 : 0;
                  const a = s1 && s2 ? 0 : 3 - (s1 + s2 + cc);
                  ao |= a << (k * 2);
                }
                if (doLight) {
                  const lk =
                    (lf +
                      lAt(s1x, s1y, s1z) +
                      lAt(s2x, s2y, s2z) +
                      lAt(ccx, ccy, ccz) +
                      2) >>
                    2;
                  lpk |= lk << (k * 4);
                }
              }
            }
            // 水位编码（仅透明桶/水）：上方非水时记录 level+1（1..9），0=非暴露水面。
            // 透明桶不计算 AO/光照（doAo/doLight 仅 bucket 0），故复用光照位段存水位，无位溢出。
            let waterCode = 0;
            if (bucket === 1 && def.fluid && rawAt(x, y + 1, z) !== id) {
              waterCode = def.waterLevel + 1;
            }
            // 掩码布局：(tile+1)5b | ao8b<<5 | light16b<<13；透明桶 light 段存 waterCode
            const hi = bucket === 1 ? waterCode : lpk;
            mask[u + W * v] = (tile + 1) | (ao << 5) | (hi << 13);
          }
        }
        // 贪心扩展矩形
        for (let v = 0; v < H; v++) {
          for (let u = 0; u < W; u++) {
            const val = mask[u + W * v];
            if (val === 0) continue;
            let w = 1;
            while (u + w < W && mask[u + w + W * v] === val) w++;
            let h = 1;
            outer: while (v + h < H) {
              for (let k = 0; k < w; k++) {
                if (mask[u + k + W * (v + h)] !== val) break outer;
              }
              h++;
            }
            for (let dv = 0; dv < h; dv++)
              mask.fill(0, u + W * (v + dv), u + w + W * (v + dv));

            const tile = (val & 31) - 1;
            const aoPacked = (val >> 5) & 0xff;
            const ao = [
              aoPacked & 3,
              (aoPacked >> 2) & 3,
              (aoPacked >> 4) & 3,
              (aoPacked >> 6) & 3,
            ];
            const hi = (val >> 13) & 0xffff;
            // 透明桶：hi 段为水位码；不透明桶：hi 段为逐角光照
            const waterCode = bucket === 1 ? hi : 0;
            const lowerTop = bucket === 1 && waterCode > 0;
            const topH =
              waterCode > 0 ? waterTopFor(waterCode - 1) : undefined;
            const lpk = bucket === 0 ? hi : 0;
            const lv = [
              lpk & 15,
              (lpk >> 4) & 15,
              (lpk >> 8) & 15,
              (lpk >> 12) & 15,
            ];
            pushQuad(
              arr,
              faceCorners(dir, s, u, v, w, h),
              faceUVs(dir, w, h),
              tile,
              dir.shade,
              ao,
              lowerTop,
              lv,
              topH,
            );
          }
        }
      }
    }
  }

  return {
    opaque: opaque.indices.length > 0 ? opaque : null,
    translucent: translucent.indices.length > 0 ? translucent : null,
  };
}
