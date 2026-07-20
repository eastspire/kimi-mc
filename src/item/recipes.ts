// ============================================================
// 统一合成配方：形状相关、位置可平移（MC 规则，支持镜像）
//  - 输入：合成格内容（行优先，方块名数组，空格 null）+ 网格宽高
//  - 实现：裁剪最小包围盒后与配方 pattern 比较（正/镜像）
//  - 输出：方块名或工具 id + 数量
// ============================================================

export interface RecipeOut {
  /** 产物方块名（与 tool/food 三选一） */
  block?: string;
  /** 产物工具 id（TOOLS 键） */
  tool?: string;
  /** 产物食物 id（FOODS 键） */
  food?: string;
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
const D = 't:diamond';
const G = 't:gold_ingot';

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
  // ---- 钻石工具（MC 原版摆法） ----
  R(3, 3, ['t:diamond', 't:diamond', 't:diamond', '', S, '', '', S, ''], {
    tool: 'diamond_pickaxe',
    count: 1,
  }),
  R(2, 3, ['t:diamond', 't:diamond', 't:diamond', S, '', S], {
    tool: 'diamond_axe',
    count: 1,
  }),
  // 弓：3 木棍 + 3 线（MC 原版摆法）
  R(3, 3, ['', S, 't:string', S, '', 't:string', '', S, 't:string'], {
    tool: 'bow',
    count: 1,
  }),
  // TNT：5 火药 + 4 沙子（MC 原版棋盘摆法）
  R(
    3,
    3,
    [
      't:gunpowder',
      'sand',
      't:gunpowder',
      'sand',
      't:gunpowder',
      'sand',
      't:gunpowder',
      'sand',
      't:gunpowder',
    ],
    { block: 'tnt', count: 1 },
  ),
  // ---- 锹（1 原料 + 2 棍） ----
  R(1, 3, [P, S, S], { tool: 'wooden_shovel', count: 1 }),
  R(1, 3, [C, S, S], { tool: 'stone_shovel', count: 1 }),
  R(1, 3, [I, S, S], { tool: 'iron_shovel', count: 1 }),
  R(1, 3, [D, S, S], { tool: 'diamond_shovel', count: 1 }),
  // ---- 剑（2 原料 + 1 棍） ----
  R(1, 3, [P, P, S], { tool: 'wooden_sword', count: 1 }),
  R(1, 3, [C, C, S], { tool: 'stone_sword', count: 1 }),
  R(1, 3, [I, I, S], { tool: 'iron_sword', count: 1 }),
  R(1, 3, [D, D, S], { tool: 'diamond_sword', count: 1 }),
  R(1, 3, [G, G, S], { tool: 'gold_sword', count: 1 }),
  // ---- 锄（2 原料 + 2 棍，横排） ----
  R(2, 3, [P, P, S, '', S, ''], { tool: 'wooden_hoe', count: 1 }),
  R(2, 3, [C, C, S, '', S, ''], { tool: 'stone_hoe', count: 1 }),
  R(2, 3, [I, I, S, '', S, ''], { tool: 'iron_hoe', count: 1 }),
  R(2, 3, [D, D, S, '', S, ''], { tool: 'diamond_hoe', count: 1 }),
  // ---- 火把：煤在上 + 棍在下（4 个） ----
  R(1, 2, ['t:coal', S], { block: 'torch', count: 4 }),
  // ---- 骨粉：1 骨头 → 3 骨粉 ----
  R(1, 1, ['t:bone'], { tool: 'bone_meal', count: 3 }),
  // ---- 面包：3 小麦一行 ----
  R(3, 1, ['t:wheat_item', 't:wheat_item', 't:wheat_item'], {
    food: 'bread',
    count: 1,
  }),
  // ---- 苔石：圆石 + 藤蔓权宜（用树叶代替） ----
  R(2, 1, ['cobblestone', 'oak_leaves'], { block: 'mossy_cobble', count: 1 }),
  // ---- 书架：3 木板 + 3 书权宜（用皮革代替书） ----
  R(3, 3, [P, P, P, 't:leather', 't:leather', 't:leather', P, P, P], {
    block: 'bookshelf',
    count: 1,
  }),
  // ---- 盔甲（MC 摆法）：皮革 t:leather / 金 t:gold_ingot / 铁 t:iron_ingot / 钻 t:diamond ----
  ...armorRecipes('t:leather', 'leather'),
  ...armorRecipes('t:gold_ingot', 'gold'),
  ...armorRecipes('t:iron_ingot', 'iron'),
  ...armorRecipes('t:diamond', 'diamond'),
  // ---- 红石元件 ----
  // 红石火把：红石在上 + 棍在下
  R(1, 2, ['t:redstone', S], { block: 'redstone_torch_on', count: 1 }),
  // 拉杆：棍在上 + 圆石在下
  R(1, 2, [S, C], { block: 'lever_off', count: 1 }),
  // 石按钮：单圆石
  R(1, 1, [C], { block: 'stone_button', count: 1 }),
  // 红石灯：萤石居中 + 四红石
  R(3, 3, ['', 't:redstone', '', 't:redstone', 'glowstone', 't:redstone', '', 't:redstone', ''], {
    block: 'redstone_lamp_off',
    count: 1,
  }),
  // 活塞：3 木板 + 圆石铁锭圆石 + 圆石红石圆石（MC 原版）
  R(3, 3, [P, P, P, C, 't:iron_ingot', C, C, 't:redstone', C], {
    block: 'piston',
    count: 1,
  }),
  // 附魔台：书权宜(皮革) + 钻石×2 + 黑曜石×4（MC 原版）
  R(3, 3, ['', 't:leather', '', 't:diamond', 'obsidian', 't:diamond', 'obsidian', 'obsidian', 'obsidian'], {
    block: 'enchanting_table',
    count: 1,
  }),
];

/** 生成一套盔甲的 4 件配方：头盔(5)、胸甲(8)、护腿(7)、靴(4) */
function armorRecipes(mat: string, key: string): Recipe[] {
  return [
    // 头盔：顶行 3 + 两侧（5 件）
    R(3, 2, [mat, mat, mat, mat, '', mat], { tool: `${key}_helmet`, count: 1 }),
    // 胸甲：首行两侧 + 后两行满（8 件）
    R(3, 3, [mat, '', mat, mat, mat, mat, mat, mat, mat], { tool: `${key}_chestplate`, count: 1 }),
    // 护腿：顶行 3 + 两侧各两（7 件）
    R(3, 3, [mat, mat, mat, mat, '', mat, mat, '', mat], { tool: `${key}_leggings`, count: 1 }),
    // 靴子：两侧各两（4 件）
    R(3, 2, [mat, '', mat, mat, '', mat], { tool: `${key}_boots`, count: 1 }),
  ];
}
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
