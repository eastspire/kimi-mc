import type { HotSlot } from '../ui/hotbar';

// ============================================================
// 烧炼规则（MC 数值：单份烧炼 10s；煤 80s、原木/木板 15s、木棍 5s）
//  - 槽位键：b:方块名 / f:食物id / t:材料id
//  - 燃料同时是可放置方块或材料物品
// ============================================================

export interface SmeltOut {
  kind: 'block' | 'food' | 'tool';
  id: string;
}

/** 烧炼配方表：输入 → 产物 */
export const SMELT: Record<string, SmeltOut> = {
  'b:iron_ore': { kind: 'tool', id: 'iron_ingot' },
  'b:gold_ore': { kind: 'tool', id: 'gold_ingot' },
  'b:sand': { kind: 'block', id: 'glass' },
  'b:cobblestone': { kind: 'block', id: 'stone' },
  'f:porkchop': { kind: 'food', id: 'cooked_porkchop' },
  'f:mutton': { kind: 'food', id: 'cooked_mutton' },
  'f:beef': { kind: 'food', id: 'cooked_beef' },
  'f:chicken': { kind: 'food', id: 'cooked_chicken' },
};

/** 燃料热值（秒） */
export const FUEL_TIME: Record<string, number> = {
  't:coal': 80,
  'b:oak_log': 15,
  'b:oak_planks': 15,
  't:stick': 5,
};

/** 单份烧炼耗时（秒，MC 200 tick） */
export const SMELT_TIME = 10;

/** 槽位 → 烧炼/燃料键；空槽 null */
export function slotKey(s: HotSlot): string | null {
  if (s.block) return `b:${s.block.def.name}`;
  if (s.food) return `f:${s.food.def.id}`;
  if (s.tool) return `t:${s.tool.def.id}`;
  return null;
}

export function smeltResult(s: HotSlot): SmeltOut | null {
  const k = slotKey(s);
  return k ? (SMELT[k] ?? null) : null;
}

export function fuelTime(s: HotSlot): number {
  const k = slotKey(s);
  return k ? (FUEL_TIME[k] ?? 0) : 0;
}
