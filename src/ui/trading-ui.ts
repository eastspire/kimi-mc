import {
  drawBlockIcon,
  drawToolIcon,
  type HotSlot,
  type Hotbar,
} from './hotbar';
import { emptyHotSlot } from './survival-inventory';
import type { BlockRegistry } from '../core/block-registry';
import { TOOLS } from '../item/tools';
import { foodById } from '../item/foods';
import { tradesFor, type ItemRef } from '../item/trading';

// ============================================================
// 村民交易界面（右键村民打开）
//  - 上方列出该村民的固定交易项（give → get），点击兑换
//  - 材料从背包主栏+快捷栏扣除；产物优先入快捷栏，满了入背包，再满丢弃
//  - 背包网格复用生存背包的拖拽逻辑（只读展示 + 光标跟随）
// ============================================================

const MAIN_SIZE = 27;
const STACK_MAX = 64;

interface SlotRef {
  area: 'main' | 'hot';
  i: number;
  el: HTMLDivElement;
}

function stackCount(s: HotSlot): number {
  return s.block?.count ?? s.food?.count ?? s.tool?.count ?? 0;
}
function isEmpty(s: HotSlot): boolean {
  return !s.block && !s.food && !s.tool;
}
function sameStack(a: HotSlot, b: HotSlot): boolean {
  if (a.block && b.block) return a.block.def === b.block.def;
  if (a.food && b.food) return a.food.def === b.food.def;
  if (a.tool && b.tool) return a.tool.def === b.tool.def && a.tool.def.stackable;
  return false;
}
function cloneSlot(s: HotSlot): HotSlot {
  return {
    block: s.block ? { def: s.block.def, count: s.block.count } : null,
    food: s.food ? { def: s.food.def, count: s.food.count } : null,
    tool: s.tool ? { def: s.tool.def, count: s.tool.count, dur: s.tool.dur, ench: s.tool.ench } : null,
  };
}

export interface TradeCallbacks {
  onClose: () => void;
  /** 交易成功音效 */
  onTrade: () => void;
  /** 背包放不下时掉落在玩家脚下 */
  onDropSlot: (slot: HotSlot) => void;
}

export class TradingUI {
  isOpen = false;
  private el = document.getElementById('inv6')!;
  private cursorEl = document.getElementById('inv6-cursor')!;
  private cursorCanvas = this.cursorEl.querySelector('canvas')!;
  private cursorCount = this.cursorEl.querySelector<HTMLSpanElement>('.count')!;
  private tradesEl = document.getElementById('inv6-trades')!;
  private uid = 0;
  private cursor: HotSlot = emptyHotSlot();
  private refs: SlotRef[] = [];

  constructor(
    private registry: BlockRegistry,
    private atlasCanvas: HTMLCanvasElement,
    private hotbar: Hotbar,
    private main: HotSlot[],
    private cb: TradeCallbacks,
  ) {
    this.buildGrid('inv6-main', 'main', MAIN_SIZE);
    this.buildGrid('inv6-hotbar', 'hot', 9);

    document.addEventListener('mousemove', (e) => {
      if (!this.isOpen) return;
      this.cursorEl.style.transform = `translate(${e.clientX - 22}px, ${e.clientY - 22}px)`;
    });
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      if (e.code === 'KeyE' || e.code === 'Escape') {
        e.preventDefault();
        this.close();
        this.cb.onClose();
      }
    });
  }

  private buildGrid(domId: string, area: SlotRef['area'], n: number): void {
    const grid = document.getElementById(domId)!;
    for (let i = 0; i < n; i++) {
      const slot = document.createElement('div');
      slot.className = 'inv2-slot';
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 44;
      slot.appendChild(canvas);
      const count = document.createElement('span');
      count.className = 'count';
      slot.appendChild(count);
      const ref: SlotRef = { area, i, el: slot };
      slot.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.onSlotClick(ref, e.button);
      });
      grid.appendChild(slot);
      this.refs.push(ref);
    }
  }

  private getSlot(ref: SlotRef): HotSlot {
    return ref.area === 'main' ? this.main[ref.i] : this.hotbar.slotAt(ref.i);
  }

  /** 回写槽位（快捷栏经 setSlotAt 以同步渲染/手持） */
  private setSlot(ref: SlotRef, s: HotSlot): void {
    if (ref.area === 'main') this.main[ref.i] = s;
    else this.hotbar.setSlotAt(ref.i, s);
  }

  /** 打开某村民的交易界面（uid 决定固定交易表） */
  open(uid: number): void {
    this.uid = uid;
    this.isOpen = true;
    this.el.classList.remove('hidden');
    document.exitPointerLock();
    this.renderTrades();
    this.renderAll();
  }

  close(): void {
    this.isOpen = false;
    this.el.classList.add('hidden');
    // 光标物品退回背包，放不下则掉落
    if (!isEmpty(this.cursor)) {
      if (!this.insertSlot(this.cursor)) this.cb.onDropSlot(this.cursor);
      this.cursor = emptyHotSlot();
    }
    this.updateCursor();
  }

  // ---------------- 交易 ----------------

  private itemName(r: ItemRef): string {
    if (r.kind === 't') return TOOLS[r.id]?.name ?? r.id;
    if (r.kind === 'f') return foodById(r.id)?.name ?? r.id;
    return this.registry.byName.get(r.id)?.display ?? r.id;
  }

  /** 玩家是否付得起该交易项的材料 */
  private canAfford(give: ItemRef & { n: number }): boolean {
    return this.countItem(give) >= give.n;
  }

  /** 统计背包（主栏+快捷栏）某材料总数 */
  private countItem(r: ItemRef): number {
    let n = 0;
    const scan = (s: HotSlot): void => {
      if (r.kind === 't' && s.tool && s.tool.def.id === r.id) n += s.tool.count;
      if (r.kind === 'f' && s.food && s.food.def.id === r.id) n += s.food.count;
      if (r.kind === 'b' && s.block && s.block.def.name === r.id) n += s.block.count;
    };
    for (const s of this.main) scan(s);
    for (let i = 0; i < 9; i++) scan(this.hotbar.slotAt(i));
    return n;
  }

  /** 从背包扣除 n 个材料（先主栏后快捷栏） */
  private consumeItem(r: ItemRef, n: number): void {
    let need = n;
    const drain = (s: HotSlot, clear: () => void): void => {
      if (need <= 0) return;
      const match =
        (r.kind === 't' && s.tool && s.tool.def.id === r.id) ||
        (r.kind === 'f' && s.food && s.food.def.id === r.id) ||
        (r.kind === 'b' && s.block && s.block.def.name === r.id);
      if (!match) return;
      const c = stackCount(s);
      const take = Math.min(c, need);
      if (s.block) s.block.count -= take;
      else if (s.food) s.food.count -= take;
      else if (s.tool) s.tool!.count -= take;
      need -= take;
      if (stackCount(s) <= 0) clear();
    };
    for (let i = 0; i < this.main.length && need > 0; i++)
      drain(this.main[i], () => (this.main[i] = emptyHotSlot()));
    for (let i = 0; i < 9 && need > 0; i++) {
      const s = this.hotbar.slotAt(i);
      drain(s, () => this.hotbar.setSlotAt(i, emptyHotSlot()));
    }
  }

  /** 把槽位物品塞入背包（先快捷栏合并，再主栏空位）；成功返回 true */
  private insertSlot(slot: HotSlot): boolean {
    // 先尝试合并同类（快捷栏 → 主栏）
    const merge = (s: HotSlot): boolean => {
      if (!sameStack(s, slot)) return false;
      const c = stackCount(s);
      const room = STACK_MAX - c;
      if (room <= 0) return false;
      const take = Math.min(room, stackCount(slot));
      if (s.block) s.block.count += take;
      else if (s.food) s.food.count += take;
      else if (s.tool) s.tool!.count += take;
      if (slot.block) slot.block.count -= take;
      else if (slot.food) slot.food.count -= take;
      else if (slot.tool) slot.tool!.count -= take;
      return stackCount(slot) <= 0;
    };
    for (let i = 0; i < 9; i++) if (merge(this.hotbar.slotAt(i))) return true;
    for (const s of this.main) if (merge(s)) return true;
    // 空位（主栏 → 快捷栏）
    for (let i = 0; i < this.main.length; i++) {
      if (isEmpty(this.main[i])) {
        this.main[i] = cloneSlot(slot);
        return true;
      }
    }
    for (let i = 0; i < 9; i++) {
      const s = this.hotbar.slotAt(i);
      if (isEmpty(s)) {
        this.hotbar.setSlotAt(i, cloneSlot(slot));
        return true;
      }
    }
    return false;
  }

  /** 产物转为 HotSlot */
  private productSlot(r: ItemRef & { n: number }): HotSlot | null {
    const s = emptyHotSlot();
    if (r.kind === 't') {
      const def = TOOLS[r.id];
      if (!def) return null;
      s.tool = { def, count: r.n };
    } else if (r.kind === 'f') {
      const def = foodById(r.id);
      if (!def) return null;
      s.food = { def, count: r.n };
    } else {
      const def = this.registry.byName.get(r.id);
      if (!def) return null;
      s.block = { def, count: r.n };
    }
    return s;
  }

  private doTrade(give: ItemRef & { n: number }, get: ItemRef & { n: number }): void {
    if (!this.canAfford(give)) return;
    this.consumeItem(give, give.n);
    const prod = this.productSlot(get);
    if (prod) {
      if (!this.insertSlot(prod)) this.cb.onDropSlot(prod);
    }
    this.cb.onTrade();
    this.renderTrades();
    this.renderAll();
  }

  // ---------------- 渲染 ----------------

  private drawRefIcon(canvas: HTMLCanvasElement, r: ItemRef): void {
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, 44, 44);
    ctx.imageSmoothingEnabled = false;
    if (r.kind === 't') {
      const def = TOOLS[r.id];
      if (def) drawToolIcon(canvas, { def, count: 1 });
    } else if (r.kind === 'f') {
      const def = foodById(r.id);
      if (def) ctx.drawImage(def.sprite, 0, 0, 16, 16, 4, 4, 36, 36);
    } else {
      const def = this.registry.byName.get(r.id);
      if (def) drawBlockIcon(canvas, def, this.atlasCanvas);
    }
  }

  private renderTrades(): void {
    this.tradesEl.innerHTML = '';
    for (const t of tradesFor(this.uid)) {
      const row = document.createElement('button');
      row.className = 'inv6-trade' + (this.canAfford(t.give) ? '' : ' cant');
      const mk = (r: ItemRef & { n: number }): HTMLDivElement => {
        const d = document.createElement('div');
        d.className = 't-slot';
        const cv = document.createElement('canvas');
        cv.width = cv.height = 44;
        this.drawRefIcon(cv, r);
        d.appendChild(cv);
        const cnt = document.createElement('span');
        cnt.className = 'count';
        cnt.textContent = r.n > 1 ? String(r.n) : '';
        d.appendChild(cnt);
        d.title = this.itemName(r);
        return d;
      };
      row.appendChild(mk(t.give));
      const arrow = document.createElement('span');
      arrow.className = 't-arrow';
      arrow.textContent = '→';
      row.appendChild(arrow);
      row.appendChild(mk(t.get));
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.doTrade(t.give, t.get);
      });
      this.tradesEl.appendChild(row);
    }
  }

  private drawSlot(el: HTMLDivElement, s: HotSlot): void {
    const canvas = el.querySelector('canvas')!;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, 44, 44);
    ctx.imageSmoothingEnabled = false;
    if (s.block) drawBlockIcon(canvas, s.block.def, this.atlasCanvas);
    else if (s.food)
      ctx.drawImage(s.food.def.sprite, 0, 0, 16, 16, 4, 4, 36, 36);
    else if (s.tool) drawToolIcon(canvas, s.tool);
    const n = stackCount(s);
    el.querySelector<HTMLSpanElement>('.count')!.textContent =
      n > 1 ? String(n) : '';
  }

  private renderAll(): void {
    for (const ref of this.refs) this.drawSlot(ref.el, this.getSlot(ref));
    this.updateCursor();
  }

  private updateCursor(): void {
    this.cursorEl.style.display = isEmpty(this.cursor) ? 'none' : 'block';
    const ctx = this.cursorCanvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, 44, 44);
    ctx.imageSmoothingEnabled = false;
    if (this.cursor.block)
      drawBlockIcon(this.cursorCanvas, this.cursor.block.def, this.atlasCanvas);
    else if (this.cursor.food)
      ctx.drawImage(this.cursor.food.def.sprite, 0, 0, 16, 16, 4, 4, 36, 36);
    else if (this.cursor.tool) drawToolIcon(this.cursorCanvas, this.cursor.tool);
    this.cursorCount.textContent =
      stackCount(this.cursor) > 1 ? String(stackCount(this.cursor)) : '';
  }

  /** 背包格拖拽（与生存背包一致的左键取/放） */
  private onSlotClick(ref: SlotRef, button: number): void {
    const s = this.getSlot(ref);
    if (button === 0) {
      if (isEmpty(this.cursor)) {
        if (isEmpty(s)) return;
        this.cursor = cloneSlot(s);
        this.setSlot(ref, emptyHotSlot());
      } else if (isEmpty(s)) {
        this.setSlot(ref, cloneSlot(this.cursor));
        this.cursor = emptyHotSlot();
      } else if (sameStack(s, this.cursor)) {
        const room = STACK_MAX - stackCount(s);
        const take = Math.min(room, stackCount(this.cursor));
        if (s.block) s.block.count += take;
        else if (s.food) s.food.count += take;
        else if (s.tool) s.tool!.count += take;
        if (this.cursor.block) this.cursor.block.count -= take;
        else if (this.cursor.food) this.cursor.food.count -= take;
        else if (this.cursor.tool) this.cursor.tool!.count -= take;
        if (stackCount(this.cursor) <= 0) this.cursor = emptyHotSlot();
        if (ref.area === 'hot') this.hotbar.setSlotAt(ref.i, s); // 数量变化同步
      } else {
        const tmp = cloneSlot(s);
        this.setSlot(ref, cloneSlot(this.cursor));
        this.cursor = tmp;
      }
      this.renderAll();
      this.renderTrades(); // 数量变化可能影响可负担性
    }
  }
}
