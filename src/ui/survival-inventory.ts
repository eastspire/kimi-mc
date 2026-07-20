import type { BlockRegistry } from '../core/block-registry';
import type { FoodDef } from '../item/foods';
import { FOODS } from '../item/foods';
import type { ToolDef } from '../item/tools';
import { toolById } from '../item/tools';
import { armorById, type ArmorDef, type ArmorSlot } from '../item/armor';
import { matchRecipe } from '../item/recipes';
import {
  drawBlockIcon,
  drawToolIcon,
  type HotSlot,
  type Hotbar,
  type SavedHotSlot,
  type ToolStack,
} from './hotbar';

// ============================================================
// 生存背包 + 2×2 合成（E 开关）
//  - 27 主栏（可与合成台共享同一数组）+ 9 快捷栏 + 2×2 合成格 + 结果格
//  - 左键整堆拿/放/合并/交换；右键取一半/放一个（MC 规则）
//  - 配方统一走 recipes.ts（裁剪包围盒匹配，支持平移/镜像）
//  - 关闭时合成格与光标上的物品自动退回背包，退不下则掉落在玩家脚下
// ============================================================

const STACK_MAX = 64;
const MAIN_SIZE = 27;
const CRAFT_W = 2;
const CRAFT_SIZE = 4;

interface SlotRef {
  area: 'craft' | 'result' | 'main' | 'hot' | 'armor';
  i: number;
  el: HTMLDivElement;
}

const ARMOR_ORDER: ArmorSlot[] = ['helmet', 'chestplate', 'leggings', 'boots'];

export function emptyHotSlot(): HotSlot {
  return { block: null, food: null, tool: null };
}

function emptySlot(): HotSlot {
  return emptyHotSlot();
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

/** 槽位物品数量 +n（同类合并已校验）；用于合成结果上光标 */
function addToSlot(s: HotSlot, n: number): void {
  if (s.block) s.block.count += n;
  else if (s.food) s.food.count += n;
  else if (s.tool) s.tool.count += n;
}

export interface SurvivalInvCallbacks {
  /** 关闭（回锁鼠标） */
  onClose: () => void;
  /** 背包放不下时把槽位物品掉落在玩家脚下 */
  onDropSlot: (slot: HotSlot) => void;
  /** 盔甲穿戴变化（更新 HUD 护甲条） */
  onArmorChanged?: () => void;
}

export class SurvivalInventory {
  isOpen = false;
  private el = document.getElementById('inv2')!;
  private cursorEl = document.getElementById('inv2-cursor')!;
  private cursorCanvas = this.cursorEl.querySelector('canvas')!;
  private cursorCount = this.cursorEl.querySelector<HTMLSpanElement>('.count')!;

  private main: HotSlot[];
  private craft: HotSlot[] = Array.from({ length: CRAFT_SIZE }, emptySlot);
  private cursor: HotSlot = emptySlot();
  private refs: SlotRef[] = [];

  constructor(
    private registry: BlockRegistry,
    private atlasCanvas: HTMLCanvasElement,
    private hotbar: Hotbar,
    private cb: SurvivalInvCallbacks,
    sharedMain?: HotSlot[],
    /** 盔甲栏（4 格，存 ToolStack|null，main.ts 持有并据此算护甲） */
    private armor: (ToolStack | null)[] = [null, null, null, null],
  ) {
    this.main = sharedMain ?? Array.from({ length: MAIN_SIZE }, emptySlot);
    this.buildGrid('inv2-armor', 'armor', 4);
    this.buildGrid('inv2-craft', 'craft', CRAFT_SIZE);
    this.buildGrid('inv2-result', 'result', 1);
    this.buildGrid('inv2-main', 'main', MAIN_SIZE);
    this.buildGrid('inv2-hotbar', 'hot', 9);

    // 光标跟随
    document.addEventListener('mousemove', (e) => {
      if (!this.isOpen) return;
      this.cursorEl.style.transform = `translate(${e.clientX - 22}px, ${e.clientY - 22}px)`;
    });
    // 屏蔽右键菜单
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    // E / ESC 关闭
    document.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      if (e.code === 'KeyE' || e.code === 'Escape') {
        e.preventDefault();
        this.close();
        this.cb.onClose();
      }
    });
  }

  private buildGrid(
    domId: string,
    area: SlotRef['area'],
    n: number,
  ): void {
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
      case 'armor': {
        const t = this.armor[ref.i];
        return t ? { block: null, food: null, tool: t } : emptySlot();
      }
      case 'result':
        return emptySlot(); // 结果格只读，由配方决定
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
      case 'armor':
        this.armor[ref.i] = s.tool ?? null;
        this.cb.onArmorChanged?.();
        break;
      case 'result':
        break;
    }
  }

  /** 当前配方产物（方块/工具统一为槽位形态） */
  private craftResult(): HotSlot | null {
    const names = this.craft.map((s) =>
      s.block ? s.block.def.name : s.tool ? `t:${s.tool.def.id}` : null,
    );
    const out = matchRecipe(names, CRAFT_W, CRAFT_W);
    if (!out) return null;
    if (out.block) {
      const def = this.registry.byName.get(out.block);
      if (def) return { block: { def, count: out.count }, food: null, tool: null };
    }
    if (out.tool) {
      const td = toolById(out.tool) ?? armorById(out.tool);
      if (td) return { block: null, food: null, tool: { def: td, count: out.count } };
    }
    if (out.food) {
      const fd = FOODS[out.food as keyof typeof FOODS];
      if (fd) return { block: null, food: { def: fd, count: out.count }, tool: null };
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

  /** 空盔甲格画对应部位的暗色剪影（MC 一致） */
  private drawArmorGhost(el: HTMLDivElement, slot: ArmorSlot): void {
    const canvas = el.querySelector('canvas')!;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, 44, 44);
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#2a2a2a';
    const g = (x: number, y: number, w: number, h: number) =>
      ctx.fillRect(4 + x * 2.25, 4 + y * 2.25, w * 2.25, h * 2.25);
    if (slot === 'helmet') {
      g(3, 3, 10, 5); g(2, 5, 12, 3); g(3, 8, 10, 2);
    } else if (slot === 'chestplate') {
      g(4, 2, 8, 11); g(1, 2, 3, 4); g(12, 2, 3, 4);
    } else if (slot === 'leggings') {
      g(3, 1, 10, 3); g(3, 4, 4, 10); g(9, 4, 4, 10);
    } else {
      g(2, 6, 5, 6); g(9, 6, 5, 6);
    }
    ctx.globalAlpha = 1;
  }

  private renderAll(): void {
    const result = this.craftResult();
    for (const ref of this.refs) {
      if (ref.area === 'result') {
        this.drawSlot(ref.el, result ?? emptySlot());
      } else if (ref.area === 'armor' && !this.armor[ref.i]) {
        this.drawArmorGhost(ref.el, ARMOR_ORDER[ref.i]);
        ref.el.querySelector<HTMLSpanElement>('.count')!.textContent = '';
      } else {
        this.drawSlot(ref.el, this.getSlot(ref));
      }
    }
    // 光标
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
    if (ref.area === 'result') {
      this.takeResult();
    } else if (button === 0) {
      this.leftClick(ref);
    } else if (button === 2) {
      this.rightClick(ref);
    }
    this.renderAll();
  }

  /** 盔甲格只收对应部位的盔甲（cursor 为空则允许取出） */
  private armorFits(ref: SlotRef, cursor: HotSlot): boolean {
    if (isEmpty(cursor)) return true;
    if (!cursor.tool) return false;
    const ad: ArmorDef | null = armorById(cursor.tool.def.id);
    return ad !== null && ad.slot === ARMOR_ORDER[ref.i];
  }

  /** 左键：空手拿整堆 / 同类合并 / 空格放整堆 / 异类交换 */
  private leftClick(ref: SlotRef): void {
    if (ref.area === 'armor' && !this.armorFits(ref, this.cursor)) return;
    const s = this.getSlot(ref);
    if (isEmpty(this.cursor)) {
      if (isEmpty(s)) return;
      this.cursor = s;
      this.setSlot(ref, emptySlot());
      return;
    }
    if (isEmpty(s)) {
      this.setSlot(ref, this.cursor);
      this.cursor = emptySlot();
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
      if (stackCount(this.cursor) <= 0) this.cursor = emptySlot();
      return;
    }
    // 交换
    this.setSlot(ref, this.cursor);
    this.cursor = s;
  }

  /** 右键：空手拿一半 / 同类或空格放一个 */
  private rightClick(ref: SlotRef): void {
    // 盔甲格：整件拿/放，与左键一致（盔甲不可堆叠）
    if (ref.area === 'armor') {
      this.leftClick(ref);
      return;
    }
    const s = this.getSlot(ref);
    if (isEmpty(this.cursor)) {
      if (isEmpty(s)) return;
      // 不可堆叠的工具整把拿起（MC 规则）
      if (s.tool && !s.tool.def.stackable) {
        this.cursor = s;
        this.setSlot(ref, emptySlot());
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
      this.setSlot(ref, stackCount(s) <= 0 ? emptySlot() : s);
      return;
    }
    // 放一个（不可堆叠工具按住右键不拆分，走左键交换逻辑）
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
    if (stackCount(this.cursor) <= 0) this.cursor = emptySlot();
  }

  /** 取合成结果：消耗原料，结果上光标（同类可叠加） */
  private takeResult(): void {
    const result = this.craftResult();
    if (!result) return;
    const n = stackCount(result);
    if (!isEmpty(this.cursor)) {
      if (!sameStack(this.cursor, result)) return;
      if (stackCount(this.cursor) + n > STACK_MAX) return;
    }
    // 消耗每格 1 个原料（方块或材料物品）
    for (let i = 0; i < CRAFT_SIZE; i++) {
      const c = this.craft[i];
      if (c.block) {
        c.block.count--;
        if (c.block.count <= 0) this.craft[i] = emptySlot();
      } else if (c.tool) {
        c.tool.count--;
        if (c.tool.count <= 0) this.craft[i] = emptySlot();
      }
    }
    if (isEmpty(this.cursor)) this.cursor = result;
    else addToSlot(this.cursor, n);
  }

  // ---------------- 开关 / 存档 ----------------

  open(): void {
    this.isOpen = true;
    this.el.classList.remove('hidden');
    document.exitPointerLock();
    this.renderAll();
  }

  /** 关闭：光标与合成格物品退回背包（主栏→快捷栏顺序），退不下掉落 */
  close(): void {
    this.isOpen = false;
    this.el.classList.add('hidden');
    this.cursorEl.style.display = 'none';
    if (!isEmpty(this.cursor)) {
      this.returnSlot(this.cursor);
      this.cursor = emptySlot();
    }
    for (let i = 0; i < CRAFT_SIZE; i++) {
      if (!isEmpty(this.craft[i])) {
        this.returnSlot(this.craft[i]);
        this.craft[i] = emptySlot();
      }
    }
    this.renderAll();
  }

  /** 尝试把槽位放入主栏/快捷栏（先叠同类后空格）；失败则掉落 */
  private returnSlot(s: HotSlot): void {
    const areas: SlotRef['area'][] = ['main', 'hot'];
    // 先尝试同类叠加
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
    // 再找空格
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

  /** 主栏序列化 */
  /** 主栏某材料总数（可堆叠工具类，如箭） */
  countMaterial(id: string): number {
    let n = 0;
    for (const s of this.main)
      if (s.tool && s.tool.def.id === id) n += s.tool.count;
    return n;
  }

  /** 主栏消耗 1 个某材料；成功返回 true 并重绘 */
  consumeMaterial(id: string): boolean {
    for (let i = 0; i < this.main.length; i++) {
      const s = this.main[i];
      if (!s.tool || s.tool.def.id !== id || s.tool.count <= 0) continue;
      s.tool.count--;
      if (s.tool.count <= 0) this.main[i] = emptySlot();
      this.renderAll();
      return true;
    }
    return false;
  }

  /** 盔甲栏序列化（与工具槽位同格式） */
  serializeArmor(): (SavedHotSlot | null)[] {
    return this.armor.map((t) => {
      if (!t) return null;
      const out: SavedHotSlot = { t: t.def.id, n: 1 };
      if (t.dur !== undefined) out.d = t.dur;
      if (t.ench && Object.keys(t.ench).length > 0) out.e = t.ench;
      return out;
    });
  }

  restoreArmor(saved: (SavedHotSlot | null)[] | undefined): void {
    for (let i = 0; i < 4; i++) {
      const s = saved?.[i];
      if (s && 't' in s) {
        const ad = armorById(s.t);
        this.armor[i] = ad ? { def: ad, count: 1, dur: s.d, ench: s.e } : null;
      } else {
        this.armor[i] = null;
      }
    }
  }

  serializeMain(): (SavedHotSlot | null)[] {
    return this.main.map((s) => {
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

  restoreMain(saved: (SavedHotSlot | null)[]): void {
    for (let i = 0; i < MAIN_SIZE; i++) {
      const s = saved[i];
      let slot = emptySlot();
      if (s && 'b' in s) {
        const def = this.registry.def(s.b);
        if (def)
          slot = { block: { def, count: Math.max(1, s.n | 0) }, food: null, tool: null };
      } else if (s && 'f' in s) {
        const fd = (FOODS as Record<string, FoodDef>)[s.f];
        if (fd)
          slot = { block: null, food: { def: fd, count: Math.max(1, s.n | 0) }, tool: null };
      } else if (s && 't' in s) {
        const td: ToolDef | null = toolById(s.t) ?? armorById(s.t);
        if (td)
          slot = { block: null, food: null, tool: { def: td, count: Math.max(1, s.n | 0), dur: s.d, ench: s.e } };
      }
      this.main[i] = slot;
    }
  }
}
