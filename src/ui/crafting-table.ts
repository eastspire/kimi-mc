import type { BlockRegistry } from '../core/block-registry';
import { toolById } from '../item/tools';
import { matchRecipe } from '../item/recipes';
import { FOODS } from '../item/foods';
import {
  drawBlockIcon,
  drawToolIcon,
  type HotSlot,
  type Hotbar,
} from './hotbar';
import {
  emptyHotSlot,
  type SurvivalInvCallbacks,
} from './survival-inventory';

// ============================================================
// 合成台 3×3 合成界面（右键工作台方块打开）
//  - 与生存背包共享同一 27 格主栏数组 + 快捷栏，数据实时互通
//  - 交互规则与背包一致：左键整堆/合并/交换，右键取半/放一个
//  - 配方统一走 recipes.ts（3×3 网格，支持平移与镜像）
// ============================================================

const STACK_MAX = 64;
const MAIN_SIZE = 27;
const CRAFT_W = 3;
const CRAFT_SIZE = 9;

interface SlotRef {
  area: 'craft' | 'result' | 'main' | 'hot';
  i: number;
  el: HTMLDivElement;
}

function sameStack(a: HotSlot, b: HotSlot): boolean {
  if (a.block && b.block) return a.block.def === b.block.def;
  if (a.food && b.food) return a.food.def === b.food.def;
  if (a.tool && b.tool) return a.tool.def === b.tool.def && a.tool.def.stackable;
  return false;
}

function stackCount(s: HotSlot): number {
  return s.block?.count ?? s.food?.count ?? s.tool?.count ?? 0;
}

function isEmpty(s: HotSlot): boolean {
  return !s.block && !s.food && !s.tool;
}

function addToSlot(s: HotSlot, n: number): void {
  if (s.block) s.block.count += n;
  else if (s.food) s.food.count += n;
  else if (s.tool) s.tool.count += n;
}

export class CraftingTable {
  isOpen = false;
  private el = document.getElementById('inv3')!;
  private cursorEl = document.getElementById('inv3-cursor')!;
  private cursorCanvas = this.cursorEl.querySelector('canvas')!;
  private cursorCount = this.cursorEl.querySelector<HTMLSpanElement>('.count')!;

  private craft: HotSlot[] = Array.from({ length: CRAFT_SIZE }, emptyHotSlot);
  private cursor: HotSlot = emptyHotSlot();
  private refs: SlotRef[] = [];

  constructor(
    private registry: BlockRegistry,
    private atlasCanvas: HTMLCanvasElement,
    private hotbar: Hotbar,
    /** 与生存背包共享的 27 格主栏 */
    private main: HotSlot[],
    private cb: SurvivalInvCallbacks,
  ) {
    this.buildGrid('inv3-craft', 'craft', CRAFT_SIZE);
    this.buildGrid('inv3-result', 'result', 1);
    this.buildGrid('inv3-main', 'main', MAIN_SIZE);
    this.buildGrid('inv3-hotbar', 'hot', 9);

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

  // ---------------- 数据访问 ----------------

  private getSlot(ref: SlotRef): HotSlot {
    switch (ref.area) {
      case 'craft':
        return this.craft[ref.i];
      case 'main':
        return this.main[ref.i];
      case 'hot':
        return this.hotbar.slotAt(ref.i);
      case 'result':
        return emptyHotSlot();
    }
  }

  private setSlot(ref: SlotRef, s: HotSlot): void {
    switch (ref.area) {
      case 'craft':
        this.craft[ref.i] = s;
        break;
      case 'main':
        this.main[ref.i] = s;
        break;
      case 'hot':
        this.hotbar.setSlotAt(ref.i, s);
        break;
      case 'result':
        break;
    }
  }

  private craftResult(): HotSlot | null {
    const names = this.craft.map((s) =>
      s.block ? s.block.def.name : s.tool ? `t:${s.tool.def.id}` : null,
    );
    const out = matchRecipe(names, CRAFT_W, CRAFT_W);
    if (!out) return null;
    if (out.block) {
      const def = this.registry.byName.get(out.block);
      if (def)
        return { block: { def, count: out.count }, food: null, tool: null };
    }
    if (out.tool) {
      const td = toolById(out.tool);
      if (td)
        return { block: null, food: null, tool: { def: td, count: out.count } };
    }
    if (out.food) {
      const fd = FOODS[out.food as keyof typeof FOODS];
      if (fd)
        return { block: null, food: { def: fd, count: out.count }, tool: null };
    }
    return null;
  }

  // ---------------- 渲染 ----------------

  private drawIcon(canvas: HTMLCanvasElement, s: HotSlot): void {
    if (s.block) drawBlockIcon(canvas, s.block.def, this.atlasCanvas);
    else if (s.food) {
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(s.food.def.sprite, 0, 0, 16, 16, 4, 4, 36, 36);
    } else if (s.tool) {
      drawToolIcon(canvas, s.tool);
    }
  }

  private drawSlot(el: HTMLDivElement, s: HotSlot): void {
    const canvas = el.querySelector('canvas')!;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, 44, 44);
    ctx.imageSmoothingEnabled = false;
    this.drawIcon(canvas, s);
    const n = stackCount(s);
    el.querySelector<HTMLSpanElement>('.count')!.textContent =
      n > 1 ? String(n) : '';
  }

  private renderAll(): void {
    const result = this.craftResult();
    for (const ref of this.refs) {
      if (ref.area === 'result') this.drawSlot(ref.el, result ?? emptyHotSlot());
      else this.drawSlot(ref.el, this.getSlot(ref));
    }
    const ctx = this.cursorCanvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, 44, 44);
    ctx.imageSmoothingEnabled = false;
    this.drawIcon(this.cursorCanvas, this.cursor);
    this.cursorCount.textContent =
      stackCount(this.cursor) > 1 ? String(stackCount(this.cursor)) : '';
    this.cursorEl.style.display = isEmpty(this.cursor) ? 'none' : 'block';
  }

  // ---------------- 交互 ----------------

  private onSlotClick(ref: SlotRef, button: number): void {
    if (ref.area === 'result') this.takeResult();
    else if (button === 0) this.leftClick(ref);
    else if (button === 2) this.rightClick(ref);
    this.renderAll();
  }

  private leftClick(ref: SlotRef): void {
    const s = this.getSlot(ref);
    if (isEmpty(this.cursor)) {
      if (isEmpty(s)) return;
      this.cursor = s;
      this.setSlot(ref, emptyHotSlot());
      return;
    }
    if (isEmpty(s)) {
      this.setSlot(ref, this.cursor);
      this.cursor = emptyHotSlot();
      return;
    }
    if (sameStack(s, this.cursor)) {
      const put = Math.min(STACK_MAX - stackCount(s), stackCount(this.cursor));
      if (s.block && this.cursor.block) {
        s.block.count += put;
        this.cursor.block.count -= put;
      } else if (s.food && this.cursor.food) {
        s.food.count += put;
        this.cursor.food.count -= put;
      } else if (s.tool && this.cursor.tool) {
        s.tool.count += put;
        this.cursor.tool.count -= put;
      }
      this.setSlot(ref, s);
      if (stackCount(this.cursor) <= 0) this.cursor = emptyHotSlot();
      return;
    }
    this.setSlot(ref, this.cursor);
    this.cursor = s;
  }

  private rightClick(ref: SlotRef): void {
    const s = this.getSlot(ref);
    if (isEmpty(this.cursor)) {
      if (isEmpty(s)) return;
      if (s.tool && !s.tool.def.stackable) {
        this.cursor = s;
        this.setSlot(ref, emptyHotSlot());
        return;
      }
      const n = stackCount(s);
      const take = Math.ceil(n / 2);
      if (s.block) {
        this.cursor = { block: { def: s.block.def, count: take }, food: null, tool: null };
        s.block.count = n - take;
      } else if (s.food) {
        this.cursor = { block: null, food: { def: s.food.def, count: take }, tool: null };
        s.food.count = n - take;
      } else if (s.tool) {
        this.cursor = { block: null, food: null, tool: { def: s.tool.def, count: take } };
        s.tool.count = n - take;
      }
      this.setSlot(ref, stackCount(s) <= 0 ? emptyHotSlot() : s);
      return;
    }
    if (this.cursor.tool && !this.cursor.tool.def.stackable) {
      this.leftClick(ref);
      return;
    }
    if (isEmpty(s)) {
      const one: HotSlot = this.cursor.block
        ? { block: { def: this.cursor.block.def, count: 1 }, food: null, tool: null }
        : this.cursor.food
          ? { block: null, food: { def: this.cursor.food.def, count: 1 }, tool: null }
          : { block: null, food: null, tool: { def: this.cursor.tool!.def, count: 1 } };
      this.setSlot(ref, one);
      this.decCursor(1);
      return;
    }
    if (sameStack(s, this.cursor) && stackCount(s) < STACK_MAX) {
      if (s.block) s.block.count++;
      else if (s.food) s.food.count++;
      else if (s.tool) s.tool.count++;
      this.setSlot(ref, s);
      this.decCursor(1);
    }
  }

  private decCursor(n: number): void {
    if (this.cursor.block) this.cursor.block.count -= n;
    else if (this.cursor.food) this.cursor.food.count -= n;
    else if (this.cursor.tool) this.cursor.tool.count -= n;
    if (stackCount(this.cursor) <= 0) this.cursor = emptyHotSlot();
  }

  private takeResult(): void {
    const result = this.craftResult();
    if (!result) return;
    const n = stackCount(result);
    if (!isEmpty(this.cursor)) {
      if (!sameStack(this.cursor, result)) return;
      if (stackCount(this.cursor) + n > STACK_MAX) return;
    }
    for (let i = 0; i < CRAFT_SIZE; i++) {
      const c = this.craft[i];
      if (c.block) {
        c.block.count--;
        if (c.block.count <= 0) this.craft[i] = emptyHotSlot();
      } else if (c.tool) {
        c.tool.count--;
        if (c.tool.count <= 0) this.craft[i] = emptyHotSlot();
      }
    }
    if (isEmpty(this.cursor)) this.cursor = result;
    else addToSlot(this.cursor, n);
  }

  // ---------------- 开关 ----------------

  open(): void {
    this.isOpen = true;
    this.el.classList.remove('hidden');
    document.exitPointerLock();
    this.renderAll();
  }

  close(): void {
    this.isOpen = false;
    this.el.classList.add('hidden');
    this.cursorEl.style.display = 'none';
    if (!isEmpty(this.cursor)) {
      this.returnSlot(this.cursor);
      this.cursor = emptyHotSlot();
    }
    for (let i = 0; i < CRAFT_SIZE; i++) {
      if (!isEmpty(this.craft[i])) {
        this.returnSlot(this.craft[i]);
        this.craft[i] = emptyHotSlot();
      }
    }
    this.renderAll();
  }

  private returnSlot(s: HotSlot): void {
    const areas: SlotRef['area'][] = ['main', 'hot'];
    for (const area of areas) {
      const n = area === 'main' ? MAIN_SIZE : 9;
      for (let i = 0; i < n; i++) {
        const cur = area === 'main' ? this.main[i] : this.hotbar.slotAt(i);
        if (sameStack(cur, s) && stackCount(cur) < STACK_MAX) {
          const put = Math.min(STACK_MAX - stackCount(cur), stackCount(s));
          if (cur.block && s.block) {
            cur.block.count += put;
            s.block.count -= put;
          } else if (cur.food && s.food) {
            cur.food.count += put;
            s.food.count -= put;
          } else if (cur.tool && s.tool) {
            cur.tool.count += put;
            s.tool.count -= put;
          }
          if (area === 'main') this.main[i] = cur;
          else this.hotbar.setSlotAt(i, cur);
          if (stackCount(s) <= 0) return;
        }
      }
    }
    for (const area of areas) {
      const n = area === 'main' ? MAIN_SIZE : 9;
      for (let i = 0; i < n; i++) {
        const cur = area === 'main' ? this.main[i] : this.hotbar.slotAt(i);
        if (isEmpty(cur)) {
          if (area === 'main') this.main[i] = s;
          else this.hotbar.setSlotAt(i, s);
          return;
        }
      }
    }
    this.cb.onDropSlot(s);
  }
}
