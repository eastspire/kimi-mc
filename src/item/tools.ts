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
  kind: 'pickaxe' | 'axe' | 'material';
  /** 层级：0 手/材料，1 木，2 石，3 铁（用于矿物采集判定） */
  tier: number;
  /** 是否可 64 堆叠（木棍/材料 true，工具 false） */
  stackable: boolean;
  /** 最大耐久（MC：木 59、石 131、铁 250；材料 0 无耐久） */
  maxDurability: number;
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
  return { id, name, sprite, texture, speed, kind, tier, stackable, maxDurability };
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
  }),
  wooden_axe: makeTool('wooden_axe', '木斧', 2, 'axe', 1, false, 59, (c) => {
    paintHandle(c, HANDLE_1, HANDLE_2);
    paintAxeHead(c, WOOD_MAIN, WOOD_DARK);
  }),
  stone_pickaxe: makeTool('stone_pickaxe', '石镐', 4, 'pickaxe', 2, false, 131, (c) => {
    paintHandle(c, HANDLE_1, HANDLE_2);
    paintPickHead(c, STONE_MAIN, STONE_DARK);
  }),
  stone_axe: makeTool('stone_axe', '石斧', 4, 'axe', 2, false, 131, (c) => {
    paintHandle(c, HANDLE_1, HANDLE_2);
    paintAxeHead(c, STONE_MAIN, STONE_DARK);
  }),
  iron_pickaxe: makeTool('iron_pickaxe', '铁镐', 6, 'pickaxe', 3, false, 250, (c) => {
    paintHandle(c, HANDLE_1, HANDLE_2);
    paintPickHead(c, '#d8d8d8', '#a8a8a8');
  }),
  iron_axe: makeTool('iron_axe', '铁斧', 6, 'axe', 3, false, 250, (c) => {
    paintHandle(c, HANDLE_1, HANDLE_2);
    paintAxeHead(c, '#d8d8d8', '#a8a8a8');
  }),
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
  }),
  diamond_axe: makeTool('diamond_axe', '钻石斧', 8, 'axe', 4, false, 1561, (c) => {
    paintHandle(c, HANDLE_1, HANDLE_2);
    paintAxeHead(c, '#4ee8d8', '#2ec8b8');
  }),
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
};

export function toolById(id: string): ToolDef | null {
  return TOOLS[id] ?? null;
}

// ---------------- 挖掘规则 ----------------

/** 方块适用工具：手持对应 kind 的工具才获得速度加成 */
export const BLOCK_TOOL: Record<string, 'pickaxe' | 'axe'> = {
  stone: 'pickaxe',
  cobblestone: 'pickaxe',
  coal_ore: 'pickaxe',
  iron_ore: 'pickaxe',
  gold_ore: 'pickaxe',
  diamond_ore: 'pickaxe',
  obsidian: 'pickaxe',
  oak_log: 'axe',
  oak_planks: 'axe',
  crafting_table: 'axe',
  furnace: 'pickaxe',
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
  gold_ore: 3,
  diamond_ore: 3,
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
