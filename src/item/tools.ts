import * as THREE from 'three';

// ============================================================
// 工具/材料物品：16×16 程序生成像素图标（与食物同风格）
//  - stick 为可堆叠材料（64）；工具不可堆叠
//  - 挖掘规则：对应工具才有速度加成（MC：木 2×、石 4×）
//  - HARVEST_TIER：石质矿物需镐达到层级才掉落（木 1 / 石 2）
// ============================================================

export interface ToolDef {
  id: string;
  name: string;
  sprite: HTMLCanvasElement;
  texture: THREE.Texture;
  /** 挖掘速度倍率（徒手 1，木 2，石 4） */
  speed: number;
  /** 工具类型；material 无挖掘加成 */
  kind: 'pickaxe' | 'axe' | 'shovel' | 'sword' | 'hoe' | 'material';
  /** 层级：0 手/材料，1 木，2 石，3 铁，4 钻（用于矿物采集判定） */
  tier: number;
  /** 是否可 64 堆叠（木棍/材料 true，工具 false） */
  stackable: boolean;
  /** 最大耐久（MC：木 59、石 131、铁 250、钻 1561；材料 0 无耐久） */
  maxDurability: number;
  /** 近战攻击伤害（心 ×2 = 半心单位）；缺省为 1（等同徒手） */
  melee?: number;
}

function makeTool(
  id: string,
  name: string,
  speed: number,
  kind: ToolDef['kind'],
  tier: number,
  stackable: boolean,
  maxDurability: number,
  paint: (ctx: CanvasRenderingContext2D) => void,
  melee?: number,
): ToolDef {
  const sprite = document.createElement('canvas');
  sprite.width = 16;
  sprite.height = 16;
  const ctx = sprite.getContext('2d')!;
  ctx.clearRect(0, 0, 16, 16);
  paint(ctx);
  const texture = new THREE.CanvasTexture(sprite);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { id, name, sprite, texture, speed, kind, tier, stackable, maxDurability, melee };
}

/** 斜柄：从 (5,4) 到 (10,13) 的对角 2px 木柄 */
function paintHandle(ctx: CanvasRenderingContext2D, c1: string, c2: string): void {
  for (let i = 0; i < 9; i++) {
    ctx.fillStyle = i % 2 === 0 ? c1 : c2;
    ctx.fillRect(5 + i, 4 + i, 2, 2);
  }
}

/** 镐头：顶部横向微弯条 + 两端下垂 */
function paintPickHead(ctx: CanvasRenderingContext2D, main: string, dark: string): void {
  ctx.fillStyle = main;
  ctx.fillRect(2, 1, 11, 2);
  ctx.fillRect(1, 2, 2, 3);
  ctx.fillRect(12, 2, 2, 3);
  ctx.fillStyle = dark;
  ctx.fillRect(2, 3, 11, 1);
  ctx.fillRect(1, 5, 2, 1);
  ctx.fillRect(12, 5, 2, 1);
}

/** 斧头：左上 5×5 主体 + 浅色刃口 */
function paintAxeHead(ctx: CanvasRenderingContext2D, main: string, dark: string): void {
  ctx.fillStyle = main;
  ctx.fillRect(2, 1, 6, 5);
  ctx.fillRect(2, 6, 3, 2);
  ctx.fillStyle = dark;
  ctx.fillRect(2, 1, 1, 5);
  ctx.fillRect(2, 6, 1, 2);
  ctx.fillRect(7, 4, 1, 2);
}

/** 锹头：顶部方形铲面 + 中央高光 */
function paintShovelHead(ctx: CanvasRenderingContext2D, main: string, dark: string): void {
  ctx.fillStyle = main;
  ctx.fillRect(4, 1, 5, 5);
  ctx.fillStyle = dark;
  ctx.fillRect(4, 5, 5, 1);
  ctx.fillRect(4, 1, 1, 5);
  ctx.fillStyle = '#ffffff44';
  ctx.fillRect(5, 2, 2, 2);
}

/** 剑：从 (4,12) 柄到 (12,4) 的斜刃 + 护手 */
function paintSword(ctx: CanvasRenderingContext2D, blade: string, dark: string): void {
  // 斜刃（对角线 2px 宽）
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = i % 2 ? blade : dark;
    ctx.fillRect(6 + i, 8 - i, 2, 2);
  }
  // 护手（横向）
  ctx.fillStyle = dark;
  ctx.fillRect(4, 9, 5, 2);
  // 柄
  ctx.fillStyle = '#8a5a2b';
  ctx.fillRect(3, 11, 3, 3);
  ctx.fillStyle = '#6e4423';
  ctx.fillRect(3, 13, 3, 1);
}

/** 锄头：柄 + 顶部横向弯钩 */
function paintHoe(ctx: CanvasRenderingContext2D, main: string, dark: string): void {
  ctx.fillStyle = main;
  ctx.fillRect(2, 1, 7, 2);
  ctx.fillRect(2, 3, 2, 3);
  ctx.fillStyle = dark;
  ctx.fillRect(2, 5, 2, 1);
  ctx.fillRect(8, 1, 1, 2);
}

function paintStick(ctx: CanvasRenderingContext2D): void {
  for (let i = 0; i < 11; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#a0723d' : '#8a5a2b';
    ctx.fillRect(3 + i, 12 - i, 2, 2);
  }
}

/** 矿锭：横向圆角金属条 + 高光/暗影 */
function paintIngot(main: string, light: string, dark: string) {
  return (ctx: CanvasRenderingContext2D): void => {
    ctx.fillStyle = main;
    ctx.fillRect(3, 6, 10, 4);
    ctx.fillRect(4, 5, 8, 1);
    ctx.fillRect(4, 10, 8, 1);
    ctx.fillStyle = light;
    ctx.fillRect(4, 6, 8, 1);
    ctx.fillStyle = dark;
    ctx.fillRect(4, 9, 8, 1);
  };
}

/** 煤：黑色碎块 */
function paintCoal(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(4, 4, 8, 8);
  ctx.fillRect(3, 6, 10, 4);
  ctx.fillStyle = '#2e2e2e';
  ctx.fillRect(5, 5, 3, 2);
  ctx.fillRect(9, 8, 2, 2);
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(4, 10, 8, 2);
}

/** 皮革：棕色揉皱皮块 */
function paintLeather(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#8a5a2b';
  ctx.fillRect(4, 4, 8, 8);
  ctx.fillRect(3, 5, 10, 6);
  ctx.fillStyle = '#a0723d';
  ctx.fillRect(5, 5, 3, 2);
  ctx.fillRect(9, 8, 2, 2);
  ctx.fillStyle = '#6e4423';
  ctx.fillRect(4, 10, 8, 1);
  ctx.fillRect(7, 7, 1, 3);
}

/** 羽毛：白色斜羽 + 深色羽轴 */
function paintFeather(ctx: CanvasRenderingContext2D): void {
  for (let i = 0; i < 10; i++) {
    ctx.fillStyle = i < 3 ? '#d0d0d0' : '#f0f0f0';
    ctx.fillRect(4 + i, 11 - i, 2, 2);
  }
  ctx.fillStyle = '#9a9a9a';
  for (let i = 0; i < 10; i++) ctx.fillRect(4 + i, 12 - i, 1, 1);
}

/** 鸡蛋：米白椭圆 */
function paintEgg(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#e8dcc0';
  ctx.fillRect(5, 4, 6, 9);
  ctx.fillRect(4, 6, 8, 5);
  ctx.fillStyle = '#f8f0dc';
  ctx.fillRect(6, 5, 2, 2);
  ctx.fillStyle = '#c8b898';
  ctx.fillRect(5, 12, 6, 1);
}

/** 骨头：白色骨棒，两端骨节 */
function paintBone(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#e8e8e0';
  ctx.fillRect(6, 7, 4, 2);
  ctx.fillRect(5, 6, 6, 4);
  ctx.fillStyle = '#f8f8f0';
  ctx.fillRect(3, 4, 3, 3);
  ctx.fillRect(3, 9, 3, 3);
  ctx.fillRect(10, 4, 3, 3);
  ctx.fillRect(10, 9, 3, 3);
  ctx.fillStyle = '#c8c8c0';
  ctx.fillRect(4, 5, 1, 1);
  ctx.fillRect(11, 10, 1, 1);
  ctx.fillRect(6, 9, 4, 1);
}

/** 箭：深木杆 + 灰箭头 + 白尾羽 */
function paintArrow(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#8a5a2b';
  for (let i = 0; i < 9; i++) ctx.fillRect(3 + i, 12 - i, 1, 1);
  ctx.fillStyle = '#9a9a9a';
  ctx.fillRect(11, 2, 2, 2);
  ctx.fillRect(12, 3, 1, 1);
  ctx.fillRect(10, 3, 1, 1);
  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(2, 12, 2, 1);
  ctx.fillRect(2, 13, 1, 2);
  ctx.fillRect(3, 13, 1, 1);
}

/** 火药：灰黑粉末堆 */
function paintGunpowder(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#4a4a4a';
  ctx.fillRect(4, 8, 8, 4);
  ctx.fillRect(5, 6, 6, 2);
  ctx.fillRect(6, 5, 4, 1);
  ctx.fillStyle = '#6a6a6a';
  ctx.fillRect(5, 8, 2, 2);
  ctx.fillRect(9, 7, 2, 2);
  ctx.fillRect(7, 6, 1, 1);
  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(4, 11, 8, 1);
  ctx.fillRect(10, 10, 2, 1);
}

const WOOD_MAIN = '#b08a4a';
const WOOD_DARK = '#8a6a34';
const STONE_MAIN = '#8f8f8f';
const STONE_DARK = '#6a6a6a';
const HANDLE_1 = '#8a5a2b';
const HANDLE_2 = '#6e4423';

export const TOOLS: Record<string, ToolDef> = {
  stick: makeTool('stick', '木棍', 1, 'material', 0, true, 0, paintStick),
  wooden_pickaxe: makeTool('wooden_pickaxe', '木镐', 2, 'pickaxe', 1, false, 59, (c) => {
    paintHandle(c, HANDLE_1, HANDLE_2);
    paintPickHead(c, WOOD_MAIN, WOOD_DARK);
  }, 2),
  wooden_axe: makeTool('wooden_axe', '木斧', 2, 'axe', 1, false, 59, (c) => {
    paintHandle(c, HANDLE_1, HANDLE_2);
    paintAxeHead(c, WOOD_MAIN, WOOD_DARK);
  }, 3),
  stone_pickaxe: makeTool('stone_pickaxe', '石镐', 4, 'pickaxe', 2, false, 131, (c) => {
    paintHandle(c, HANDLE_1, HANDLE_2);
    paintPickHead(c, STONE_MAIN, STONE_DARK);
  }, 3),
  stone_axe: makeTool('stone_axe', '石斧', 4, 'axe', 2, false, 131, (c) => {
    paintHandle(c, HANDLE_1, HANDLE_2);
    paintAxeHead(c, STONE_MAIN, STONE_DARK);
  }, 4),
  iron_pickaxe: makeTool('iron_pickaxe', '铁镐', 6, 'pickaxe', 3, false, 250, (c) => {
    paintHandle(c, HANDLE_1, HANDLE_2);
    paintPickHead(c, '#d8d8d8', '#a8a8a8');
  }, 3),
  iron_axe: makeTool('iron_axe', '铁斧', 6, 'axe', 3, false, 250, (c) => {
    paintHandle(c, HANDLE_1, HANDLE_2);
    paintAxeHead(c, '#d8d8d8', '#a8a8a8');
  }, 5),
  // ---- 材料（烧炼产物/燃料，可堆叠） ----
  coal: makeTool('coal', '煤', 1, 'material', 0, true, 0, paintCoal),
  iron_ingot: makeTool('iron_ingot', '铁锭', 1, 'material', 0, true, 0, paintIngot('#d8d8d8', '#ffffff', '#a8a8a8')),
  gold_ingot: makeTool('gold_ingot', '金锭', 1, 'material', 0, true, 0, paintIngot('#f9e14e', '#fdf3a0', '#d4af37')),
  leather: makeTool('leather', '皮革', 1, 'material', 0, true, 0, paintLeather),
  feather: makeTool('feather', '羽毛', 1, 'material', 0, true, 0, paintFeather),
  egg: makeTool('egg', '鸡蛋', 1, 'material', 0, true, 0, paintEgg),
  // ---- 怪物掉落材料（可堆叠） ----
  bone: makeTool('bone', '骨头', 1, 'material', 0, true, 0, paintBone),
  arrow: makeTool('arrow', '箭', 1, 'material', 0, true, 0, paintArrow),
  gunpowder: makeTool('gunpowder', '火药', 1, 'material', 0, true, 0, paintGunpowder),
  // ---- 钻石（可堆叠材料，钻石矿掉落物） ----
  diamond: makeTool('diamond', '钻石', 1, 'material', 0, true, 0, (c) => {
    c.fillStyle = '#7ff5e8';
    c.fillRect(6, 3, 4, 2);
    c.fillStyle = '#4ee8d8';
    c.fillRect(5, 5, 6, 3);
    c.fillStyle = '#2ec8b8';
    c.fillRect(6, 8, 4, 2);
    c.fillRect(7, 10, 2, 2);
    c.fillStyle = '#d8fffa';
    c.fillRect(6, 4, 2, 1);
  }),
  // ---- 钻石工具（MC：速度 8、耐久 1561、层级 4 可采黑曜石） ----
  diamond_pickaxe: makeTool('diamond_pickaxe', '钻石镐', 8, 'pickaxe', 4, false, 1561, (c) => {
    paintHandle(c, HANDLE_1, HANDLE_2);
    paintPickHead(c, '#4ee8d8', '#2ec8b8');
  }, 4),
  diamond_axe: makeTool('diamond_axe', '钻石斧', 8, 'axe', 4, false, 1561, (c) => {
    paintHandle(c, HANDLE_1, HANDLE_2);
    paintAxeHead(c, '#4ee8d8', '#2ec8b8');
  }, 5),
  // ---- 弓（不可堆叠，MC 耐久 385）；kind 归 material（无挖掘加成），按 id 识别 ----
  bow: makeTool('bow', '弓', 1, 'material', 0, false, 385, (c) => {
    c.fillStyle = '#8a5a2b';
    c.fillRect(9, 1, 2, 3);
    c.fillRect(11, 3, 2, 3);
    c.fillRect(12, 6, 2, 4);
    c.fillRect(11, 10, 2, 3);
    c.fillRect(9, 12, 2, 3);
    c.fillStyle = '#6e4423';
    c.fillRect(9, 2, 1, 1);
    c.fillRect(12, 7, 1, 2);
    c.fillRect(9, 13, 1, 1);
    c.fillStyle = '#d8d8d0';
    c.fillRect(7, 2, 1, 12);
  }),
  // ---- 锹（泥土/沙/沙砾/雪/黏土加速；MC melee 木2.5/石3.5/铁4.5/钻5.5） ----
  wooden_shovel: makeTool('wooden_shovel', '木锹', 2, 'shovel', 1, false, 59, (c) => { paintHandle(c, HANDLE_1, HANDLE_2); paintShovelHead(c, WOOD_MAIN, WOOD_DARK); }, 2),
  stone_shovel: makeTool('stone_shovel', '石锹', 4, 'shovel', 2, false, 131, (c) => { paintHandle(c, HANDLE_1, HANDLE_2); paintShovelHead(c, STONE_MAIN, STONE_DARK); }, 3),
  iron_shovel: makeTool('iron_shovel', '铁锹', 6, 'shovel', 3, false, 250, (c) => { paintHandle(c, HANDLE_1, HANDLE_2); paintShovelHead(c, '#d8d8d8', '#a8a8a8'); }, 4),
  diamond_shovel: makeTool('diamond_shovel', '钻石锹', 8, 'shovel', 4, false, 1561, (c) => { paintHandle(c, HANDLE_1, HANDLE_2); paintShovelHead(c, '#4ee8d8', '#2ec8b8'); }, 5),
  // ---- 剑（近战武器；MC 伤害 木4/石5/铁6/钻7 = 2×半心） ----
  wooden_sword: makeTool('wooden_sword', '木剑', 1, 'sword', 1, false, 59, (c) => paintSword(c, WOOD_MAIN, WOOD_DARK), 4),
  stone_sword: makeTool('stone_sword', '石剑', 1, 'sword', 2, false, 131, (c) => paintSword(c, STONE_MAIN, STONE_DARK), 5),
  iron_sword: makeTool('iron_sword', '铁剑', 1, 'sword', 3, false, 250, (c) => paintSword(c, '#e8e8e8', '#b8b8b8'), 6),
  diamond_sword: makeTool('diamond_sword', '钻石剑', 1, 'sword', 4, false, 1561, (c) => paintSword(c, '#6ef5e8', '#3ec8b8'), 7),
  gold_sword: makeTool('gold_sword', '金剑', 1, 'sword', 2, false, 32, (c) => paintSword(c, '#f9e14e', '#d4af37'), 4),
  // ---- 锄（开垦耕地；melee 1，无挖掘加成） ----
  wooden_hoe: makeTool('wooden_hoe', '木锄', 1, 'hoe', 1, false, 59, (c) => { paintHandle(c, HANDLE_1, HANDLE_2); paintHoe(c, WOOD_MAIN, WOOD_DARK); }),
  stone_hoe: makeTool('stone_hoe', '石锄', 1, 'hoe', 2, false, 131, (c) => { paintHandle(c, HANDLE_1, HANDLE_2); paintHoe(c, STONE_MAIN, STONE_DARK); }),
  iron_hoe: makeTool('iron_hoe', '铁锄', 1, 'hoe', 3, false, 250, (c) => { paintHandle(c, HANDLE_1, HANDLE_2); paintHoe(c, '#d8d8d8', '#a8a8a8'); }),
  diamond_hoe: makeTool('diamond_hoe', '钻石锄', 1, 'hoe', 4, false, 1561, (c) => { paintHandle(c, HANDLE_1, HANDLE_2); paintHoe(c, '#4ee8d8', '#2ec8b8'); }),
  // ---- 线（蜘蛛掉落，弓/钓竿材料，可堆叠） ----
  string: makeTool('string', '线', 1, 'material', 0, true, 0, (c) => {
    c.fillStyle = '#e8e8e8';
    for (let i = 0; i < 12; i++) c.fillRect(2 + i, 12 - i, 1, 1);
    c.fillStyle = '#c8c8c8';
    c.fillRect(3, 12, 2, 1); c.fillRect(11, 3, 2, 1); c.fillRect(6, 8, 1, 2);
  }),
  // ---- 青金石/红石/绿宝石（矿石掉落材料，可堆叠） ----
  lapis_lazuli: makeTool('lapis_lazuli', '青金石', 1, 'material', 0, true, 0, (c) => {
    c.fillStyle = '#2a4ac8';
    c.fillRect(4, 6, 8, 6); c.fillRect(5, 5, 6, 1);
    c.fillStyle = '#4a6ae8';
    c.fillRect(5, 7, 3, 2); c.fillRect(9, 9, 2, 2);
    c.fillStyle = '#1a34a8';
    c.fillRect(4, 11, 8, 1);
  }),
  redstone: makeTool('redstone', '红石', 1, 'material', 0, true, 0, (c) => {
    c.fillStyle = '#c82828';
    c.fillRect(4, 8, 8, 4); c.fillRect(5, 6, 6, 2); c.fillRect(6, 5, 4, 1);
    c.fillStyle = '#f04838';
    c.fillRect(5, 8, 2, 2); c.fillRect(9, 7, 2, 2); c.fillRect(7, 6, 1, 1);
    c.fillStyle = '#8a1818';
    c.fillRect(4, 11, 8, 1);
  }),
  emerald: makeTool('emerald', '绿宝石', 1, 'material', 0, true, 0, (c) => {
    c.fillStyle = '#2ac84a';
    c.fillRect(6, 4, 4, 2); c.fillRect(5, 6, 6, 3); c.fillRect(6, 9, 4, 2); c.fillRect(7, 11, 2, 1);
    c.fillStyle = '#6ae88a';
    c.fillRect(6, 5, 2, 1);
  }),
  // ---- 骨粉（骨头合成，催熟作物） ----
  bone_meal: makeTool('bone_meal', '骨粉', 1, 'material', 0, true, 0, (c) => {
    c.fillStyle = '#e8e8e0';
    c.fillRect(4, 5, 8, 7);
    c.fillRect(5, 4, 6, 1);
    c.fillStyle = '#f8f8f0';
    c.fillRect(5, 6, 3, 2); c.fillRect(9, 9, 2, 2);
    c.fillStyle = '#c8c8c0';
    c.fillRect(4, 11, 8, 1); c.fillRect(10, 6, 1, 1);
  }),
  // ---- 小麦（收获物，合成面包） ----
  wheat_item: makeTool('wheat_item', '小麦', 1, 'material', 0, true, 0, (c) => {
    c.fillStyle = '#c8a83a';
    for (let i = 0; i < 9; i++) c.fillRect(7, 13 - i, 2, 1);
    c.fillStyle = '#e8c84a';
    c.fillRect(6, 3, 4, 2); c.fillRect(7, 1, 2, 2); c.fillRect(6, 5, 1, 1); c.fillRect(9, 5, 1, 1);
  }),
  // ---- 小麦种子（打草掉落，种植用） ----
  wheat_seeds: makeTool('wheat_seeds', '小麦种子', 1, 'material', 0, true, 0, (c) => {
    c.fillStyle = '#7a9a3a';
    c.fillRect(5, 10, 2, 2); c.fillRect(9, 9, 2, 2); c.fillRect(7, 12, 2, 2); c.fillRect(10, 12, 1, 1);
    c.fillStyle = '#5d9433';
    c.fillRect(7, 6, 2, 5);
    c.fillRect(5, 7, 2, 1); c.fillRect(9, 8, 2, 1);
  }),
};

export function toolById(id: string): ToolDef | null {
  return TOOLS[id] ?? null;
}

// ---------------- 挖掘规则 ----------------

/** 方块适用工具：手持对应 kind 的工具才获得速度加成 */
export const BLOCK_TOOL: Record<string, 'pickaxe' | 'axe' | 'shovel' | 'sword'> = {
  stone: 'pickaxe',
  cobblestone: 'pickaxe',
  coal_ore: 'pickaxe',
  iron_ore: 'pickaxe',
  gold_ore: 'pickaxe',
  diamond_ore: 'pickaxe',
  lapis_ore: 'pickaxe',
  redstone_ore: 'pickaxe',
  emerald_ore: 'pickaxe',
  obsidian: 'pickaxe',
  stone_bricks: 'pickaxe',
  bricks: 'pickaxe',
  mossy_cobble: 'pickaxe',
  furnace: 'pickaxe',
  oak_log: 'axe',
  oak_planks: 'axe',
  crafting_table: 'axe',
  bookshelf: 'axe',
  pumpkin: 'axe',
  melon: 'axe',
  dirt: 'shovel',
  grass_block: 'shovel',
  sand: 'shovel',
  gravel: 'shovel',
  clay: 'shovel',
  snow_block: 'shovel',
  farmland: 'shovel',
  oak_leaves: 'sword',
  white_wool: 'sword',
  cactus: 'sword',
  sugarcane: 'sword',
};

/**
 * 需要镐达到最低层级才掉落的方块（MC：石头/煤矿木镐起，铁矿石镐起，金/钻石铁镐起，
 * 黑曜石仅钻石镐）。不在表中的方块徒手即可采集。
 */
export const HARVEST_TIER: Record<string, number> = {
  stone: 1,
  cobblestone: 1,
  coal_ore: 1,
  iron_ore: 2,
  lapis_ore: 2,
  gold_ore: 3,
  diamond_ore: 3,
  redstone_ore: 3,
  emerald_ore: 3,
  obsidian: 4,
  furnace: 1,
};

/** 手持工具对方块名的挖掘速度倍率（不适用/徒手为 1） */
export function miningSpeed(blockName: string, tool: ToolDef | null): number {
  if (!tool) return 1;
  const want = BLOCK_TOOL[blockName];
  if (!want || tool.kind !== want) return 1;
  return tool.speed;
}

/** 手持工具是否能采集该方块（不满足则破坏无掉落、无经验） */
export function canHarvest(blockName: string, tool: ToolDef | null): boolean {
  const need = HARVEST_TIER[blockName];
  if (need === undefined) return true;
  if (!tool || tool.kind !== 'pickaxe') return false;
  return tool.tier >= need;
}
