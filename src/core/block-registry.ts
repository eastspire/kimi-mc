import type { BlockDef } from './model-loader';

// ============================================================
// 方块注册表：id → 定义，名称 → 定义，快捷栏列表
// ============================================================

export const MAX_BLOCKS = 256;
export const AIR = 0;

export class BlockRegistry {
  /** 以 id 为下标的稠密表，空洞填 null（查表等价于空气） */
  readonly byId: (BlockDef | null)[] = new Array<BlockDef | null>(MAX_BLOCKS).fill(null);
  readonly byName = new Map<string, BlockDef>();
  readonly hotbar: BlockDef[] = [];
  /** 水位等级 0..8 → 对应方块 id（无该等级则 -1）；供流体模拟与渲染查表 */
  readonly waterByLevel: number[] = new Array<number>(9).fill(-1);

  constructor(defs: (BlockDef | null)[], hotbarNames: string[]) {
    for (const def of defs) {
      if (!def) continue;
      if (def.id < 0 || def.id >= MAX_BLOCKS) throw new Error(`方块 id 越界：${def.name} (${def.id})`);
      if (this.byId[def.id]) throw new Error(`方块 id 冲突：${def.name} (${def.id})`);
      this.byId[def.id] = def;
      this.byName.set(def.name, def);
      if (def.fluid) this.waterByLevel[def.waterLevel] = def.id;
    }
    if (!this.byId[AIR]) throw new Error('blocks.json 必须定义 id=0 的 air');
    for (const n of hotbarNames) {
      const d = this.byName.get(n);
      if (d && d.selectable) this.hotbar.push(d);
    }
    if (this.hotbar.length === 0) {
      throw new Error('快捷栏为空：blocks.json 的 hotbar 未指向任何可放置方块');
    }
  }

  id(name: string): number {
    const d = this.byName.get(name);
    if (!d) throw new Error(`未知方块：${name}`);
    return d.id;
  }

  def(id: number): BlockDef | null {
    return id > 0 && id < MAX_BLOCKS ? this.byId[id] : null;
  }

  /** 是否为任意水位的水方块 */
  isWater(id: number): boolean {
    const d = this.def(id);
    return !!d && d.fluid;
  }

  /** 取某水位等级的水方块 id；缺失的等级回退到水源 */
  waterId(level: number): number {
    const l = Math.max(0, Math.min(8, level | 0));
    const id = this.waterByLevel[l];
    if (id > 0) return id;
    return this.waterByLevel[0];
  }

  isSolid(id: number): boolean {
    const d = this.def(id);
    return !!d && d.solid;
  }
}
