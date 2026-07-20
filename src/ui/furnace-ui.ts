import { smeltResult, fuelTime, SMELT_TIME, type SmeltOut } from '../item/smelting';
import {
  drawBlockIcon,
  drawToolIcon,
  serializeSlot,
  type HotSlot,
  type Hotbar,
  type SavedHotSlot,
} from './hotbar';
import { emptyHotSlot, type SurvivalInvCallbacks } from './survival-inventory';

// ============================================================
// 熔炉界面 + 熔炉状态机（右键熔炉方块打开）
//  - 输入/燃料/输出三格 + 火焰与箭头进度条；27 主栏/快捷栏共享
//  - 关闭时熔炉内物品留在熔炉（MC 一致），光标物品退回背包
//  - 燃烧/烧炼按秒推进：煤 80s、原木/木板 15s、木棍 5s；单份 10s
// ============================================================

const STACK_MAX = 64;
const MAIN_SIZE = 27;

export interface FurnaceState {
  x: number;
  y: number;
  z: number;
  input: HotSlot;
  fuel: HotSlot;
  output: HotSlot;
  /** 剩余燃烧秒 */
  burn: number;
  /** 本次燃料总秒（火焰条比例用） */
  burnMax: number;
  /** 当前物品已烧秒 */
  cook: number;
}

/** 存档形态 */
export interface SavedFurnace {
  p: [number, number, number];
  i: SavedHotSlot | null;
  f: SavedHotSlot | null;
  o: SavedHotSlot | null;
  burn: number;
  burnMax: number;
  cook: number;
}

export function newFurnace(x: number, y: number, z: number): FurnaceState {
  return {
    x,
    y,
    z,
    input: emptyHotSlot(),
    fuel: emptyHotSlot(),
    output: emptyHotSlot(),
    burn: 0,
    burnMax: 1,
    cook: 0,
  };
}

export function serializeFurnace(st: FurnaceState): SavedFurnace {
  return {
    p: [st.x, st.y, st.z],
    i: serializeSlot(st.input),
    f: serializeSlot(st.fuel),
    o: serializeSlot(st.output),
    burn: st.burn,
    burnMax: st.burnMax,
    cook: st.cook,
  };
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

function decSlot(s: HotSlot, n: number): HotSlot {
  if (s.block) s.block.count -= n;
  else if (s.food) s.food.count -= n;
  else if (s.tool) s.tool.count -= n;
  return stackCount(s) <= 0 ? emptyHotSlot() : s;
}

export type SmeltResolver = (out: SmeltOut) => HotSlot | null;

/**
 * 熔炉每帧推进；返回是否有可见状态变化（供 UI 脏标记）。
 * MC 规则：无燃料且未燃烧时点燃一份燃料；燃烧中且产物可入输出格时推进烧炼；
 * 配方无效时烧炼进度清零，燃烧耗尽后进度冻结。
 */
export function tickFurnace(
  st: FurnaceState,
  dt: number,
  resolve: SmeltResolver,
): boolean {
  let changed = false;
  const out = smeltResult(st.input);
  const outSlot = out ? resolve(out) : null;
  const canOutput =
    outSlot !== null &&
    (isEmpty(st.output) ||
      (sameStack(st.output, outSlot) && stackCount(st.output) < STACK_MAX));

  if (st.burn <= 0 && canOutput && fuelTime(st.fuel) > 0) {
    st.burn = st.burnMax = fuelTime(st.fuel);
    st.fuel = decSlot(st.fuel, 1);
    changed = true;
  }
  if (st.burn > 0) {
    st.burn = Math.max(0, st.burn - dt);
    changed = true;
    if (canOutput && outSlot) {
      st.cook += dt;
      if (st.cook >= SMELT_TIME) {
        st.cook = 0;
        st.input = decSlot(st.input, 1);
        if (isEmpty(st.output)) st.output = outSlot;
        else addToSlot(st.output, 1);
      }
    } else if (!outSlot) {
      st.cook = 0; // 配方无效：进度清零
    }
  }
  return changed;
}

interface SlotRef {
  area: 'input' | 'fuel' | 'output' | 'main' | 'hot';
  i: number;
  el: HTMLDivElement;
}

export class FurnaceUI {
  isOpen = false;
  private el = document.getElementById('inv4')!;
  private cursorEl = document.getElementById('inv4-cursor')!;
  private cursorCanvas = this.cursorEl.querySelector('canvas')!;
  private cursorCount = this.cursorEl.querySelector<HTMLSpanElement>('.count')!;
  private fireFill = document.querySelector<HTMLDivElement>('#inv4-fire .fill')!;
  private arrowFill = document.querySelector<HTMLDivElement>('#inv4-arrow .fill')!;

  private st: FurnaceState | null = null;
  private cursor: HotSlot = emptyHotSlot();
  private refs: SlotRef[] = [];
  private dirty = true;

  constructor(
    private atlasCanvas: HTMLCanvasElement,
    private hotbar: Hotbar,
    private main: HotSlot[],
    private cb: SurvivalInvCallbacks,
  ) {
    this.buildGrid('inv4-input', 'input', 1);
    this.buildGrid('inv4-fuel', 'fuel', 1);
    this.buildGrid('inv4-output', 'output', 1);
    this.buildGrid('inv4-main', 'main', MAIN_SIZE);
    this.buildGrid('inv4-hotbar', 'hot', 9);

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

  /** 主循环通知：绑定的熔炉状态被 tick 改变 */
  markDirty(): void {
    this.dirty = true;
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
    if (!this.st) return emptyHotSlot();
    switch (ref.area) {
      case 'input':
        return this.st.input;
      case 'fuel':
        return this.st.fuel;
      case 'output':
        return this.st.output;
      case 'main':
        return this.main[ref.i];
      case 'hot':
        return this.hotbar.slotAt(ref.i);
    }
  }

  private setSlot(ref: SlotRef, s: HotSlot): void {
    if (!this.st) return;
    switch (ref.area) {
      case 'input':
        this.st.input = s;
        break;
      case 'fuel':
        this.st.fuel = s;
        break;
      case 'output':
        this.st.output = s;
        break;
      case 'main':
        this.main[ref.i] = s;
        break;
      case 'hot':
        this.hotbar.setSlotAt(ref.i, s);
        break;
    }
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
    for (const ref of this.refs) this.drawSlot(ref.el, this.getSlot(ref));
    const ctx = this.cursorCanvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, 44, 44);
    ctx.imageSmoothingEnabled = false;
    this.drawIcon(this.cursorCanvas, this.cursor);
    this.cursorCount.textContent =
      stackCount(this.cursor) > 1 ? String(stackCount(this.cursor)) : '';
    this.cursorEl.style.display = isEmpty(this.cursor) ? 'none' : 'block';
  }

  /** 每帧：进度条即时刷新；槽位仅在脏时重绘（控 canvas 开销） */
  update(): void {
    if (!this.isOpen || !this.st) return;
    const st = this.st;
    this.fireFill.style.height = `${Math.round((st.burn / st.burnMax) * 100)}%`;
    this.arrowFill.style.width = `${Math.round(Math.min(1, st.cook / SMELT_TIME) * 100)}%`;
    if (this.dirty) {
      this.dirty = false;
      this.renderAll();
    }
  }

  // ---------------- 交互 ----------------

  private onSlotClick(ref: SlotRef, button: number): void {
    if (ref.area === 'output') this.takeOutput();
    else if (button === 0) this.leftClick(ref);
    else if (button === 2) this.rightClick(ref);
    this.dirty = false;
    this.renderAll();
  }

  /** 输出格只能取：空手拿全部；同类光标且放得下则合并 */
  private takeOutput(): void {
    if (!this.st) return;
    const s = this.st.output;
    if (isEmpty(s)) return;
    const n = stackCount(s);
    if (isEmpty(this.cursor)) {
      this.cursor = s;
      this.st.output = emptyHotSlot();
      return;
    }
    if (sameStack(this.cursor, s) && stackCount(this.cursor) + n <= STACK_MAX) {
      addToSlot(this.cursor, n);
      this.st.output = emptyHotSlot();
    }
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

  // ---------------- 开关 ----------------

  /** 打开并绑定某个位置的熔炉状态 */
  open(st: FurnaceState): void {
    this.st = st;
    this.isOpen = true;
    this.dirty = true;
    this.el.classList.remove('hidden');
    document.exitPointerLock();
    this.renderAll();
  }

  /** 关闭：熔炉内物品留在熔炉（MC），光标物品退回背包 */
  close(): void {
    this.isOpen = false;
    this.st = null;
    this.el.classList.add('hidden');
    this.cursorEl.style.display = 'none';
    if (!isEmpty(this.cursor)) {
      this.returnSlot(this.cursor);
      this.cursor = emptyHotSlot();
    }
  }

  private returnSlot(s: HotSlot): void {
    const areas: ('main' | 'hot')[] = ['main', 'hot'];
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
