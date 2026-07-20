// ============================================================
// 统一合成配方：形状相关、位置可平移（MC 规则，支持镜像）
//  - 输入：合成格内容（行优先，方块名数组，空格 null）+ 网格宽高
//  - 实现：裁剪最小包围盒后与配方 pattern 比较（正/镜像）
//  - 输出：方块名或工具 id + 数量
// ============================================================

export interface RecipeOut {
  /** 产物方块名（与 tool 二选一） */
  block?: string;
  /** 产物工具 id（TOOLS 键） */
  tool?: string;
  count: number;
}

interface Recipe {
  /** 行优先 pattern，每个元素为一方块名（长度 = w*h，无空格） */
  pat: string[];
  w: number;
  h: number;
  out: RecipeOut;
}

const R = (w: number, h: number, pat: string[], out: RecipeOut): Recipe => ({
  w,
  h,
  pat,
  out,
});

const P = 'oak_planks';
const C = 'cobblestone';
const L = 'oak_log';
const S = 't:stick';
const I = 't:iron_ingot';

const RECIPES: Recipe[] = [
  // ---- 2×2 可合成 ----
  R(1, 1, [L], { block: 'oak_planks', count: 4 }),
  R(2, 2, [P, P, P, P], { block: 'crafting_table', count: 1 }),
  R(1, 2, [P, P], { tool: 'stick', count: 4 }),
  // ---- 3×3 功能方块 ----
  R(3, 3, [C, C, C, C, '', C, C, C, C], { block: 'furnace', count: 1 }),
  // 床：3 羊毛 + 3 木板（MC 原版配方）
  R(3, 2, ['white_wool', 'white_wool', 'white_wool', P, P, P], {
    block: 'bed',
    count: 1,
  }),
  // ---- 3×3 工具（原料可为方块名或 t:材料id） ----
  R(3, 3, [P, P, P, '', S, '', '', S, ''], {
    tool: 'wooden_pickaxe',
    count: 1,
  }),
  R(3, 3, [C, C, C, '', S, '', '', S, ''], {
    tool: 'stone_pickaxe',
    count: 1,
  }),
  R(3, 3, [I, I, I, '', S, '', '', S, ''], {
    tool: 'iron_pickaxe',
    count: 1,
  }),
  R(2, 3, [P, P, P, S, '', S], { tool: 'wooden_axe', count: 1 }),
  R(2, 3, [C, C, C, S, '', S], { tool: 'stone_axe', count: 1 }),
  R(2, 3, [I, I, I, S, '', S], { tool: 'iron_axe', count: 1 }),
  // 弓：3 木棍 + 3 羽毛（权宜替代线——暂无蜘蛛；摆法同 MC 弓）
  R(3, 3, ['', S, 't:feather', S, '', 't:feather', '', S, 't:feather'], {
    tool: 'bow',
    count: 1,
  }),
];

/** 原料格内容：方块名；'' 表示该位置必须为空 */
function cropGrid(
  grid: (string | null)[],
  w: number,
  h: number,
): { cells: (string | null)[]; w: number; h: number } | null {
  let minX = w,
    minY = h,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (grid[y * w + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  if (maxX < 0) return null; // 全空
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const cells: (string | null)[] = [];
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) cells.push(grid[(minY + y) * w + minX + x]);
  return { cells, w: cw, h: ch };
}

function matchPat(cells: (string | null)[], pat: string[]): boolean {
  for (let i = 0; i < pat.length; i++) {
    const want = pat[i] || null;
    if (cells[i] !== want) return false;
  }
  return true;
}

/**
 * 匹配配方。grid 为行优先方块名数组（null 空格），w/h 为网格尺寸。
 * 裁剪包围盒后与每个配方比较正向与镜像，返回首个命中的产物。
 */
export function matchRecipe(
  grid: (string | null)[],
  w: number,
  h: number,
): RecipeOut | null {
  const crop = cropGrid(grid, w, h);
  if (!crop) return null;
  for (const r of RECIPES) {
    if (r.w !== crop.w || r.h !== crop.h) continue;
    if (matchPat(crop.cells, r.pat)) return r.out;
    // 水平镜像（MC 斧头左右手通用）
    const mir: (string | null)[] = [];
    for (let y = 0; y < crop.h; y++)
      for (let x = 0; x < crop.w; x++)
        mir.push(crop.cells[y * crop.w + (crop.w - 1 - x)]);
    if (matchPat(mir, r.pat)) return r.out;
  }
  return null;
}
