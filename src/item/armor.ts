import * as THREE from 'three';
import type { ToolDef } from './tools';

// ============================================================
// 盔甲：头/胸/腿/脚 四件，皮革/锁链(铁)/金/钻 四套（MC 数值）
//  - 复用 ToolStack 存储（kind 无关，按 id 识别）；maxDurability 为耐久
//  - 护甲值 armor：每件减伤点；MC 全套 皮革7 / 金11 / 铁15 / 钻20
//  - 减伤公式（MC 简化）：damage × (1 - armor×0.04)，满 20 甲减 80%
// ============================================================

export type ArmorSlot = 'helmet' | 'chestplate' | 'leggings' | 'boots';

export interface ArmorDef extends ToolDef {
  slot: ArmorSlot;
  /** 护甲点（MC：皮革 1/2/1/1，金 2/4/2/1，铁 2/5/4/2，钻 3/6/5/2） */
  armor: number;
  /** 材质色（界面/图标描边用） */
  tint: string;
}

/** 头盔：顶部壳 + 前沿 */
function paintHelmet(ctx: CanvasRenderingContext2D, main: string, dark: string): void {
  ctx.fillStyle = main;
  ctx.fillRect(3, 3, 10, 5);
  ctx.fillRect(2, 5, 12, 3);
  ctx.fillStyle = dark;
  ctx.fillRect(3, 8, 10, 2);
  ctx.fillRect(2, 7, 1, 2);
  ctx.fillRect(13, 7, 1, 2);
  ctx.fillStyle = '#ffffff33';
  ctx.fillRect(4, 4, 5, 2);
}

/** 胸甲：躯干 + 双肩 */
function paintChest(ctx: CanvasRenderingContext2D, main: string, dark: string): void {
  ctx.fillStyle = main;
  ctx.fillRect(4, 2, 8, 11);
  ctx.fillRect(1, 2, 3, 4);
  ctx.fillRect(12, 2, 3, 4);
  ctx.fillStyle = dark;
  ctx.fillRect(4, 12, 8, 1);
  ctx.fillRect(7, 2, 2, 2);
  ctx.fillStyle = '#ffffff2e';
  ctx.fillRect(5, 4, 4, 6);
}

/** 护腿：腰带 + 两腿 */
function paintLegs(ctx: CanvasRenderingContext2D, main: string, dark: string): void {
  ctx.fillStyle = main;
  ctx.fillRect(3, 1, 10, 3);
  ctx.fillRect(3, 4, 4, 10);
  ctx.fillRect(9, 4, 4, 10);
  ctx.fillStyle = dark;
  ctx.fillRect(3, 1, 10, 1);
  ctx.fillRect(3, 13, 4, 1);
  ctx.fillRect(9, 13, 4, 1);
  ctx.fillStyle = '#ffffff2a';
  ctx.fillRect(4, 5, 2, 6);
}

/** 靴子：脚背 + 鞋底 */
function paintBoots(ctx: CanvasRenderingContext2D, main: string, dark: string): void {
  ctx.fillStyle = main;
  ctx.fillRect(2, 6, 5, 6);
  ctx.fillRect(9, 6, 5, 6);
  ctx.fillStyle = dark;
  ctx.fillRect(2, 11, 5, 2);
  ctx.fillRect(9, 11, 5, 2);
  ctx.fillStyle = '#ffffff2e';
  ctx.fillRect(3, 7, 3, 2);
  ctx.fillRect(10, 7, 3, 2);
}

const SLOT_PAINT: Record<ArmorSlot, (ctx: CanvasRenderingContext2D, m: string, d: string) => void> = {
  helmet: paintHelmet,
  chestplate: paintChest,
  leggings: paintLegs,
  boots: paintBoots,
};

function makeArmor(
  id: string,
  name: string,
  slot: ArmorSlot,
  armor: number,
  maxDurability: number,
  main: string,
  dark: string,
): ArmorDef {
  const sprite = document.createElement('canvas');
  sprite.width = 16;
  sprite.height = 16;
  const ctx = sprite.getContext('2d')!;
  ctx.clearRect(0, 0, 16, 16);
  SLOT_PAINT[slot](ctx, main, dark);
  const texture = new THREE.CanvasTexture(sprite);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  return {
    id, name, sprite, texture,
    speed: 1, kind: 'material', tier: 0, stackable: false,
    maxDurability, slot, armor, tint: main,
  };
}

// MC 耐久：皮革 55/80/75/65，金 77/112/105/91，铁 165/240/225/195，钻 363/528/495/429
const DUR = {
  leather: [55, 80, 75, 65],
  gold: [77, 112, 105, 91],
  iron: [165, 240, 225, 195],
  diamond: [363, 528, 495, 429],
} as const;

// MC 护甲点：头盔/胸/腿/靴
const PTS = {
  leather: [1, 2, 1, 1],
  gold: [2, 4, 2, 1],
  iron: [2, 5, 4, 2],
  diamond: [3, 6, 5, 2],
} as const;

const SLOTS: ArmorSlot[] = ['helmet', 'chestplate', 'leggings', 'boots'];
const SLOT_CN = { helmet: '头盔', chestplate: '胸甲', leggings: '护腿', boots: '靴子' } as const;

function buildSet(
  key: keyof typeof DUR,
  cn: string,
  main: string,
  dark: string,
): Record<string, ArmorDef> {
  const out: Record<string, ArmorDef> = {};
  SLOTS.forEach((slot, i) => {
    const id = `${key}_${slot}`;
    out[id] = makeArmor(id, `${cn}${SLOT_CN[slot]}`, slot, PTS[key][i], DUR[key][i], main, dark);
  });
  return out;
}

export const ARMORS: Record<string, ArmorDef> = {
  ...buildSet('leather', '皮革', '#a0723d', '#6e4423'),
  ...buildSet('gold', '金', '#f9e14e', '#d4af37'),
  ...buildSet('iron', '铁', '#d8d8d8', '#a8a8a8'),
  ...buildSet('diamond', '钻石', '#4ee8d8', '#2ec8b8'),
};

export function armorById(id: string): ArmorDef | null {
  return ARMORS[id] ?? null;
}

/** MC 减伤：每护甲点 4%，上限 80%（20 甲）。返回实际受到伤害比例。 */
export function armorReduction(totalArmor: number): number {
  return Math.min(0.8, totalArmor * 0.04);
}
