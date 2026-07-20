import type { BlockDef } from '../core/model-loader';
import { TILE_SIZE, ATLAS_COLS } from '../core/atlas';
import type { FoodDef } from '../item/foods';
import type { ToolDef } from '../item/tools';
import type { EnchMap } from '../item/enchant';

// ============================================================
// 快捷栏：9 格 DOM，槽位可为 方块堆叠 / 食物堆叠 / 工具 / 空
// counted=false（创造）：方块无限，放置不消耗，不显示计数
// counted=true （生存）：方块/食物/材料计数，耗尽清空槽位，可序列化存档
// drawBlockIcon 同时供创造模式物品栏复用
// ============================================================

export interface BlockStack {
  def: BlockDef;
  count: number;
}

export interface FoodStack {
  def: FoodDef;
  count: number;
}

export interface ToolStack {
  def: ToolDef;
  count: number;
  /** 剩余耐久；undefined 表示满耐久（maxDurability=0 的材料无此概念） */
  dur?: number;
  /** 附魔表（附魔id→等级）；undefined 表示无附魔 */
  ench?: EnchMap;
}

export interface HotSlot {
  block: BlockStack | null;
  food: FoodStack | null;
  tool?: ToolStack | null;
}

/** 存档用紧凑槽位：{ b: 方块id } / { f: 食物id } / { t: 工具id, d?: 耐久, e?: 附魔 }，n 为数量 */
export type SavedHotSlot =
  | { b: number; n: number }
  | { f: string; n: number }
  | { t: string; n: number; d?: number; e?: EnchMap };

const STACK_MAX = 64;

function tileRegion(tile: number): [number, number] {
  const col = tile % ATLAS_COLS;
  const row = (tile / ATLAS_COLS) | 0;
  return [col * TILE_SIZE, row * TILE_SIZE];
}

/** 等轴测三面图标（顶/左/右），植物画平面 */
export function drawBlockIcon(
  canvas: HTMLCanvasElement,
  def: BlockDef,
  atlasCanvas: HTMLCanvasElement,
): void {
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const src = atlasCanvas;

  if (!def.fullCube) {
    // 十字植物：平铺正面
    const tile =
      def.elements[0]?.faces.south?.tile ??
      def.elements[0]?.faces.north?.tile ??
      0;
    const [sx, sy] = tileRegion(tile);
    ctx.drawImage(src, sx, sy, TILE_SIZE, TILE_SIZE, 6, 2, 32, 32);
    return;
  }

  const top = def.faceTiles.up ?? 0;
  const left = def.faceTiles.west ?? 0;
  const right = def.faceTiles.east ?? 0;

  const drawFace = (
    tile: number,
    m: [number, number, number, number, number, number],
    shade: number,
  ) => {
    const [sx, sy] = tileRegion(tile);
    ctx.setTransform(...m);
    ctx.drawImage(
      src,
      sx,
      sy,
      TILE_SIZE,
      TILE_SIZE,
      0,
      0,
      TILE_SIZE,
      TILE_SIZE,
    );
    if (shade < 1) {
      ctx.fillStyle = `rgba(0,0,0,${1 - shade})`;
      ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
    }
  };

  // 顶面菱形 (0,0)=上顶点
  drawFace(top, [1.25, 0.625, -1.25, 0.625, 22, 2], 1);
  // 左面
  drawFace(left, [1.25, 0.625, 0, 1.25, 2, 12], 0.62);
  // 右面
  drawFace(right, [1.25, -0.625, 0, 1.25, 22, 22], 0.8);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** 工具图标 + MC 风格耐久条（满耐久/无耐久工具不画条）；附魔物品加紫色光晕 */
export function drawToolIcon(canvas: HTMLCanvasElement, ts: ToolStack): void {
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(ts.def.sprite, 0, 0, 16, 16, 4, 4, 36, 36);
  if (ts.ench && Object.keys(ts.ench).length > 0) {
    // 附魔光晕：紫色描边 + 高光（MC 附魔物品紫色流光简化）
    ctx.strokeStyle = 'rgba(180,80,255,0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(4, 4, 36, 36);
    ctx.fillStyle = 'rgba(200,120,255,0.18)';
    ctx.fillRect(4, 4, 36, 36);
  }
  if (ts.def.maxDurability <= 0) return;
  const dur = ts.dur ?? ts.def.maxDurability;
  if (dur >= ts.def.maxDurability) return;
  const ratio = Math.max(0, dur / ts.def.maxDurability);
  const hue = Math.round(ratio * 120); // 红(0)→绿(120)
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(5, 39, 34, 3);
  ctx.fillStyle = `hsl(${hue}, 85%, 45%)`;
  ctx.fillRect(5, 39, Math.max(1, Math.round(34 * ratio)), 3);
}

export class Hotbar {
  selected = 0;
  private slots: HTMLDivElement[] = [];
  private items: HotSlot[];

  constructor(
    blocks: (BlockDef | null)[],
    private atlasCanvas: HTMLCanvasElement,
    private onSelect: (slot: HotSlot, index: number) => void,
    /** true=生存：计数消耗/堆叠上限/计数标签 */
    private counted = false,
  ) {
    this.items = blocks.map((b) => ({ block: b ? { def: b, count: 1 } : null, food: null }));
    const bar = document.getElementById('hotbar')!;
    for (let i = 0; i < 9; i++) {
      const slot = document.createElement('div');
      slot.className = 'hotbar-slot';
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(i + 1);
      slot.appendChild(num);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 44;
      slot.appendChild(canvas);
      const count = document.createElement('span');
      count.className = 'count';
      slot.appendChild(count);
      bar.appendChild(slot);
      this.slots.push(slot);
      this.renderSlot(i);
    }
    this.refresh();
  }

  private renderSlot(i: number): void {
    const s = this.items[i];
    const slot = this.slots[i];
    const canvas = slot.querySelector('canvas')!;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    let label = '';
    if (s.block) {
      drawBlockIcon(canvas, s.block.def, this.atlasCanvas);
      if (this.counted && s.block.count > 1) label = String(s.block.count);
    } else if (s.food) {
      ctx.drawImage(s.food.def.sprite, 0, 0, 16, 16, 4, 4, 36, 36);
      if (this.counted && s.food.count > 1) label = String(s.food.count);
    } else if (s.tool) {
      drawToolIcon(canvas, s.tool);
      if (this.counted && s.tool.count > 1) label = String(s.tool.count);
    }
    slot.querySelector<HTMLSpanElement>('.count')!.textContent = label;
  }

  select(i: number): void {
    if (i < 0 || i >= 9) return;
    if (this.selected === i) return;
    this.selected = i;
    this.refresh();
    this.onSelect(this.items[i], i);
  }

  scroll(dir: number): void {
    this.select((this.selected + dir + 9) % 9);
  }

  get current(): HotSlot {
    return this.items[this.selected];
  }

  /** 背包界面读写槽位（含快捷栏行渲染与手持同步） */
  slotAt(i: number): HotSlot {
    return this.items[i];
  }

  setSlotAt(i: number, s: HotSlot): void {
    if (i < 0 || i >= 9) return;
    this.items[i] = s;
    this.renderSlot(i);
    if (i === this.selected) this.onSelect(s, i);
  }

  /** 首个空槽下标（无空位 -1） */
  private firstFree(): number {
    for (let i = 0; i < 9; i++) {
      const s = this.items[i];
      if (!s.block && !s.food && !s.tool) return i;
    }
    return -1;
  }

  /** 拾取方块：优先叠加同类堆（上限 64），其次首个空槽；无空位返回 false */
  addBlock(def: BlockDef): boolean {
    let free = -1;
    for (let i = 0; i < 9; i++) {
      const s = this.items[i];
      if (s.block && s.block.def === def && (!this.counted || s.block.count < STACK_MAX)) {
        if (this.counted) s.block.count++;
        this.renderSlot(i);
        return true;
      }
      if (!s.block && !s.food && !s.tool && free < 0) free = i;
    }
    if (free < 0) return false;
    this.items[free].block = { def, count: 1 };
    this.renderSlot(free);
    if (free === this.selected) this.onSelect(this.items[free], free);
    return true;
  }

  /** 拾取食物：优先叠加同种堆，其次首个空槽；无空位返回 false */
  addFood(def: FoodDef): boolean {
    let free = -1;
    for (let i = 0; i < 9; i++) {
      const s = this.items[i];
      if (s.food && s.food.def === def && (!this.counted || s.food.count < STACK_MAX)) {
        if (this.counted) s.food.count++;
        this.renderSlot(i);
        return true;
      }
      if (!s.block && !s.food && !s.tool && free < 0) free = i;
    }
    if (free < 0) return false;
    this.items[free].food = { def, count: 1 };
    this.renderSlot(free);
    if (free === this.selected) this.onSelect(this.items[free], free);
    return true;
  }

  /** 拾取工具/材料：可堆叠的（木棍）优先叠同类，工具占整格；无空位返回 false */
  addTool(def: ToolDef, dur?: number, ench?: EnchMap): boolean {
    if (def.stackable) {
      for (let i = 0; i < 9; i++) {
        const s = this.items[i];
        if (s.tool && s.tool.def === def && (!this.counted || s.tool.count < STACK_MAX)) {
          if (this.counted) s.tool.count++;
          this.renderSlot(i);
          return true;
        }
      }
    }
    const free = this.firstFree();
    if (free < 0) return false;
    this.items[free].tool = { def, count: 1, dur, ench };
    this.renderSlot(free);
    if (free === this.selected) this.onSelect(this.items[free], free);
    return true;
  }

  /** 放置消耗当前槽位 1 个方块（创造不消耗） */
  consumeBlock(): void {
    if (!this.counted) return;
    const s = this.items[this.selected];
    if (!s.block) return;
    s.block.count--;
    if (s.block.count <= 0) s.block = null;
    this.renderSlot(this.selected);
    this.onSelect(s, this.selected); // 同步手持（可能变空手）
  }

  /** 进食完成消耗当前槽位 1 个食物 */
  consumeFood(): void {
    const s = this.items[this.selected];
    if (!s.food) return;
    if (this.counted) {
      s.food.count--;
      if (s.food.count <= 0) s.food = null;
      this.renderSlot(this.selected);
      this.onSelect(s, this.selected);
    }
  }

  /** 把方块放入指定槽位（创造物品栏选择）；覆盖该槽位原有内容 */
  assign(i: number, def: BlockDef): void {
    if (i < 0 || i >= 9) return;
    this.items[i] = { block: { def, count: 1 }, food: null };
    this.renderSlot(i);
    if (this.selected === i) this.onSelect(this.items[i], i);
  }

  /** 清空全部槽位（死亡掉落用） */
  clearAll(): void {
    for (let i = 0; i < 9; i++) {
      this.items[i] = { block: null, food: null };
      this.renderSlot(i);
    }
    this.onSelect(this.items[this.selected], this.selected);
  }

  /** 生存存档序列化 */
  serialize(): (SavedHotSlot | null)[] {
    return this.items.map((s) => {
      if (s.block) return { b: s.block.def.id, n: s.block.count };
      if (s.food) return { f: s.food.def.id, n: s.food.count };
      if (s.tool) {
        const out: SavedHotSlot = { t: s.tool.def.id, n: s.tool.count };
        if (s.tool.dur !== undefined) out.d = s.tool.dur;
        if (s.tool.ench && Object.keys(s.tool.ench).length > 0) out.e = s.tool.ench;
        return out;
      }
      return null;
    });
  }

  /** 从存档恢复（解析失败的条目按空槽处理） */
  restore(
    saved: (SavedHotSlot | null)[],
    resolveBlock: (id: number) => BlockDef | null,
    resolveFood: (id: string) => FoodDef | null,
    resolveTool: (id: string) => ToolDef | null,
  ): void {
    for (let i = 0; i < 9; i++) {
      const s = saved[i];
      let slot: HotSlot = { block: null, food: null };
      if (s && 'b' in s) {
        const def = resolveBlock(s.b);
        if (def) slot = { block: { def, count: Math.max(1, s.n | 0) }, food: null };
      } else if (s && 'f' in s) {
        const fd = resolveFood(s.f);
        if (fd) slot = { block: null, food: { def: fd, count: Math.max(1, s.n | 0) } };
      } else if (s && 't' in s) {
        const td = resolveTool(s.t);
        if (td)
          slot = {
            block: null,
            food: null,
            tool: { def: td, count: Math.max(1, s.n | 0), dur: s.d, ench: s.e },
          };
      }
      this.items[i] = slot;
      this.renderSlot(i);
    }
    this.onSelect(this.items[this.selected], this.selected);
  }

  private refresh(): void {
    this.slots.forEach((s, i) =>
      s.classList.toggle('selected', i === this.selected),
    );
  }
}

/** 单个槽位序列化（熔炉等界面存档复用） */
export function serializeSlot(s: HotSlot): SavedHotSlot | null {
  if (s.block) return { b: s.block.def.id, n: s.block.count };
  if (s.food) return { f: s.food.def.id, n: s.food.count };
  if (s.tool) {
    const out: SavedHotSlot = { t: s.tool.def.id, n: s.tool.count };
    if (s.tool.dur !== undefined) out.d = s.tool.dur;
    if (s.tool.ench && Object.keys(s.tool.ench).length > 0) out.e = s.tool.ench;
    return out;
  }
  return null;
}

/** 单个槽位反序列化（解析失败按空槽） */
export function resolveSlot(
  saved: SavedHotSlot | null | undefined,
  resolveBlock: (id: number) => BlockDef | null,
  resolveFood: (id: string) => FoodDef | null,
  resolveTool: (id: string) => ToolDef | null,
): HotSlot {
  const empty: HotSlot = { block: null, food: null, tool: null };
  if (!saved) return empty;
  if ('b' in saved) {
    const def = resolveBlock(saved.b);
    if (def) return { block: { def, count: Math.max(1, saved.n | 0) }, food: null, tool: null };
  } else if ('f' in saved) {
    const fd = resolveFood(saved.f);
    if (fd) return { block: null, food: { def: fd, count: Math.max(1, saved.n | 0) }, tool: null };
  } else {
    const td = resolveTool(saved.t);
    if (td) return { block: null, food: null, tool: { def: td, count: Math.max(1, saved.n | 0), dur: saved.d, ench: saved.e } };
  }
  return empty;
}
