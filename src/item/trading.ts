// ============================================================
// 村民交易系统（MC 简化版）：右键村民打开交易界面
//  - 每个村民随机固定一组交易项（种子化，同一村民不变）
//  - 交易 = 付出材料(及数量) → 获得产物(及数量)
//  - 绿宝石为通用货币：农产品/原料换绿宝石，绿宝石换成品
// ============================================================

/** 产物/材料引用：t=工具材料(TOOLS) / f=食物(FOODS) / b=方块(blocks) */
export interface ItemRef {
  kind: 't' | 'f' | 'b';
  id: string;
}

export interface Trade {
  /** 付出材料 + 数量 */
  give: ItemRef & { n: number };
  /** 获得产物 + 数量 */
  get: ItemRef & { n: number };
}

// 交易池：MC 农民/屠夫/铁匠风格，价格对齐原版数量级
const POOL: Trade[] = [
  // 农产品 → 绿宝石
  { give: { kind: 't', id: 'wheat_item', n: 20 }, get: { kind: 't', id: 'emerald', n: 1 } },
  { give: { kind: 't', id: 'coal', n: 16 }, get: { kind: 't', id: 'emerald', n: 1 } },
  { give: { kind: 'f', id: 'porkchop', n: 14 }, get: { kind: 't', id: 'emerald', n: 1 } },
  { give: { kind: 't', id: 'leather', n: 10 }, get: { kind: 't', id: 'emerald', n: 1 } },
  { give: { kind: 'f', id: 'rotten_flesh', n: 32 }, get: { kind: 't', id: 'emerald', n: 1 } },
  { give: { kind: 't', id: 'feather', n: 16 }, get: { kind: 't', id: 'emerald', n: 1 } },
  // 绿宝石 → 成品
  { give: { kind: 't', id: 'emerald', n: 1 }, get: { kind: 'f', id: 'bread', n: 6 } },
  { give: { kind: 't', id: 'emerald', n: 3 }, get: { kind: 't', id: 'iron_ingot', n: 1 } },
  { give: { kind: 't', id: 'emerald', n: 7 }, get: { kind: 't', id: 'diamond', n: 1 } },
  { give: { kind: 't', id: 'emerald', n: 4 }, get: { kind: 't', id: 'arrow', n: 16 } },
  { give: { kind: 't', id: 'emerald', n: 1 }, get: { kind: 'b', id: 'torch', n: 8 } },
  { give: { kind: 't', id: 'emerald', n: 1 }, get: { kind: 'f', id: 'cooked_beef', n: 4 } },
];

/** 确定性伪随机（与村民身份绑定，同一村民交易表固定） */
function hash32(n: number): number {
  let a = n | 0;
  a = Math.imul(a ^ (a >>> 16), 0x45d9f3b);
  a = Math.imul(a ^ (a >>> 16), 0x45d9f3b);
  return (a ^ (a >>> 16)) >>> 0;
}

/**
 * 生成某村民的交易表：以 uid 为种子选 3~5 项（保证含至少 1 项绿宝石出售项）。
 */
export function tradesFor(uid: number): Trade[] {
  const out: Trade[] = [];
  let h = hash32(uid);
  const count = 3 + (h % 3); // 3~5 项
  const used = new Set<number>();
  for (let i = 0; i < count; i++) {
    h = hash32(h + i * 7);
    const idx = h % POOL.length;
    if (used.has(idx)) continue;
    used.add(idx);
    out.push(POOL[idx]);
  }
  // 保证至少一项绿宝石出售项（让玩家能花绿宝石）
  if (!out.some((t) => t.give.id === 'emerald')) out.push(POOL[6]);
  return out;
}
