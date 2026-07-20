// ============================================================
// 附魔：消耗经验等级 + 青金石，给工具/盔甲附加效果（MC 简化版）
//  - 存储：ToolStack.ench = { 附魔id: 等级 }，随槽位序列化
//  - 效率(挖掘加速) / 锋利(近战增伤) / 保护(盔甲额外减伤) / 耐久(降低损耗)
//  - 时运(矿物增产) / 无限(弓不耗箭) 作为高价值选项
// ============================================================

export type EnchantId =
  | 'efficiency'
  | 'sharpness'
  | 'protection'
  | 'unbreaking'
  | 'fortune'
  | 'infinity';

export interface EnchantDef {
  id: EnchantId;
  name: string;
  /** 最高等级 */
  max: number;
  /** 适用：工具/武器/盔甲/弓 */
  applies: (toolId: string, kind: string, isArmor: boolean) => boolean;
}

const isDig = (k: string) => k === 'pickaxe' || k === 'axe' || k === 'shovel';

export const ENCHANTS: Record<EnchantId, EnchantDef> = {
  efficiency: {
    id: 'efficiency', name: '效率', max: 5,
    applies: (_id, kind, isArmor) => !isArmor && isDig(kind),
  },
  sharpness: {
    id: 'sharpness', name: '锋利', max: 5,
    applies: (_id, kind, isArmor) => !isArmor && (kind === 'sword' || kind === 'axe'),
  },
  protection: {
    id: 'protection', name: '保护', max: 4,
    applies: (_id, _kind, isArmor) => isArmor,
  },
  unbreaking: {
    id: 'unbreaking', name: '耐久', max: 3,
    applies: (_id, _kind, _isArmor) => true, // 任何有耐久的
  },
  fortune: {
    id: 'fortune', name: '时运', max: 3,
    applies: (_id, kind, isArmor) => !isArmor && kind === 'pickaxe',
  },
  infinity: {
    id: 'infinity', name: '无限', max: 1,
    applies: (id, _kind, isArmor) => !isArmor && id === 'bow',
  },
};

export type EnchMap = Partial<Record<EnchantId, number>>;

/** 该物品可用的附魔列表 */
export function availableEnchants(toolId: string, kind: string, isArmor: boolean): EnchantDef[] {
  return Object.values(ENCHANTS).filter((e) => e.applies(toolId, kind, isArmor));
}

/** 一次附魔消耗的等级（MC 附魔台 1~3 级三档，这里按等级线性） */
export function enchantCost(level: number): number {
  return level; // 附到 N 级消耗 N 经验等级
}

/** 青金石消耗 = 目标等级 */
export function lapisCost(level: number): number {
  return level;
}

/** 效率：每级 +30% 挖掘速度（MC：1+level²） */
export function efficiencyMult(level: number): number {
  return level > 0 ? 1 + level * level * 0.5 : 1;
}

/** 锋利：每级 +1.25 半心（MC：1+0.5*level，简化线性） */
export function sharpnessBonus(level: number): number {
  return level > 0 ? level * 1.25 : 0;
}

/** 保护：每级额外 4% 减伤（可叠加于护甲），上限合计 80% */
export function protectionBonus(level: number): number {
  return level > 0 ? level * 0.04 : 0;
}

/** 耐久：每级降低损耗概率，level 级时有 1/(level+1) 概率掉耐久（MC） */
export function unbreakingKeep(level: number): number {
  return level > 0 ? level / (level + 1) : 0;
}

/** 时运：矿物掉落数量加成倍率（MC：均值随等级提升） */
export function fortuneMult(level: number): number {
  return level > 0 ? 1 + level * 0.75 : 1;
}
