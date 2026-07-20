import {
  drawBlockIcon,
  drawToolIcon,
  type HotSlot,
  type Hotbar,
} from './hotbar';
import { emptyHotSlot, type SurvivalInvCallbacks } from './survival-inventory';
import { armorById } from '../item/armor';
import {
  availableEnchants,
  ENCHANTS,
  type EnchantId,
  type EnchMap,
} from '../item/enchant';

// ============================================================
// 附魔台界面（右键附魔台方块打开）
//  - 左格放装备（工具/盔甲），右格放青金石；点击 3 个选项之一附魔
//  - 每个选项 = 随机 1~2 条附魔 + 目标等级，消耗 = 等级(经验) + 等级(青金石)
//  - 关闭时装备/青金石留在原格（MC 一致），光标物品退回背包
// ============================================================

const STACK_MAX = 64;
const MAIN_SIZE = 27;

interface EnchOffer {
  /** 附魔id → 目标等级（覆盖式） */
  adds: EnchMap;
  /** 消耗经验等级 */
  cost: number;
  /** 消耗青金石数 */
  lapis: number;
}

interface SlotRef {
  area: 'item' | 'lapis' | 'main' | 'hot';
  i: number;
  el: HTMLDivElement;
}

export interface EnchantCallbacks extends SurvivalInvCallbacks {
  /** 当前玩家经验等级 */
  getXpLevel: () => number;
  /** 消耗经验等级（附魔成功时调用） */
  spendXp: (levels: number) => void;
  /** 附魔成功音效/提示 */
  onEnchanted: () => void;
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

export class EnchantUI {
  isOpen = false;
  private el = document.getElementById('inv5')!;
  private cursorEl = document.getElementById('inv5-cursor')!;
  private cursorCanvas = this.cursorEl.querySelector('canvas')!;
  private cursorCount = this.cursorEl.querySelector<HTMLSpanElement>('.count')!;
  private optionsEl = document.getElementById('inv5-options')!;

  private item: HotSlot = emptyHotSlot();
  private lapis: HotSlot = emptyHotSlot();
  private cursor: HotSlot = emptyHotSlot();
  private refs: SlotRef[] = [];
  private offers: (EnchOffer | null)[] = [null, null, null];

  constructor(
    private atlasCanvas: HTMLCanvasElement,
    private hotbar: Hotbar,
    private main: HotSlot[],
    private cb: EnchantCallbacks,
  ) {
    this.buildGrid('inv5-item', 'item', 1);
    this.buildGrid('inv5-lapis', 'lapis', 1);
    this.buildGrid('inv5-main', 'main', MAIN_SIZE);
    this.buildGrid('inv5-hotbar', 'hot', 9);

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
    switch (ref.area) {
      case 'item': return this.item;
      case 'lapis': return this.lapis;
      case 'main': return this.main[ref.i];
      case 'hot': return this.hotbar.slotAt(ref.i);
    }
  }
  private setSlot(ref: SlotRef, s: HotSlot): void {
    switch (ref.area) {
      case 'item': this.item = s; break;
      case 'lapis': this.lapis = s; break;
      case 'main': this.main[ref.i] = s; break;
      case 'hot': this.hotbar.setSlotAt(ref.i, s); break;
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
    el.querySelector<HTMLSpanElement>('.count')!.textContent = n > 1 ? String(n) : '';
  }

  /** 装备当前可附魔（是工具/盔甲且有可用附魔） */
  private enchantableKinds(): ReturnType<typeof availableEnchants> {
    const t = this.item.tool;
    if (!t) return [];
    const isArmor = armorById(t.def.id) !== null;
    return availableEnchants(t.def.id, t.def.kind, isArmor);
  }

  /** 重算 3 个附魔选项（MC：放入装备时生成，消耗后刷新） */
  private rollOffers(): void {
    const kinds = this.enchantableKinds();
    if (kinds.length === 0) {
      this.offers = [null, null, null];
      return;
    }
    const cur: EnchMap = this.item.tool?.ench ?? {};
    this.offers = [1, 2, 3].map((tier) => {
      // 从可用附魔里随机选 1~2 条，等级随档位上升
      const n = tier >= 2 && Math.random() < 0.5 ? 2 : 1;
      const pool = [...kinds];
      const adds: EnchMap = {};
      for (let k = 0; k < n && pool.length > 0; k++) {
        const idx = Math.floor(Math.random() * pool.length);
        const e = pool.splice(idx, 1)[0];
        const base = cur[e.id] ?? 0;
        const lvl = Math.min(e.max, base + tier);
        if (lvl > base) adds[e.id] = lvl;
      }
      if (Object.keys(adds).length === 0) return null;
      const top = Math.max(...Object.values(adds));
      return { adds, cost: top, lapis: top };
    });
  }

  private renderAll(): void {
    for (const ref of this.refs) this.drawSlot(ref.el, this.getSlot(ref));
    // 选项按钮
    this.optionsEl.innerHTML = '';
    const xpLevel = this.cb.getXpLevel();
    const lapisCount = this.lapis.tool?.def.id === 'lapis_lazuli' ? this.lapis.tool.count : 0;
    this.offers.forEach((offer) => {
      const btn = document.createElement('button');
      btn.className = 'inv5-offer';
      if (!offer) {
        btn.disabled = true;
        btn.innerHTML = '<span class="offer-name">—</span>';
      } else {
        const names = Object.entries(offer.adds)
          .map(([id, lvl]) => `${ENCHANTS[id as EnchantId].name} ${'ⅠⅡⅢⅣⅤ'[(lvl as number) - 1] ?? lvl}`)
          .join(' + ');
        const afford = xpLevel >= offer.cost && lapisCount >= offer.lapis;
        btn.disabled = !afford;
        btn.innerHTML =
          `<span class="offer-name">${names}</span>` +
          `<span class="offer-cost">${offer.cost} 级 · ${offer.lapis} 青金石</span>`;
        btn.addEventListener('click', () => this.applyOffer(offer));
      }
      this.optionsEl.appendChild(btn);
    });
    // 光标
    const ctx = this.cursorCanvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, 44, 44);
    ctx.imageSmoothingEnabled = false;
    this.drawIcon(this.cursorCanvas, this.cursor);
    this.cursorCount.textContent = stackCount(this.cursor) > 1 ? String(stackCount(this.cursor)) : '';
    this.cursorEl.style.display = isEmpty(this.cursor) ? 'none' : 'block';
  }

  // ---------------- 交互 ----------------

  private applyOffer(offer: EnchOffer): void {
    const t = this.item.tool;
    if (!t) return;
    const lapisCount = this.lapis.tool?.def.id === 'lapis_lazuli' ? this.lapis.tool.count : 0;
    if (this.cb.getXpLevel() < offer.cost || lapisCount < offer.lapis) return;
    // 消耗经验 + 青金石
    this.cb.spendXp(offer.cost);
    this.lapis.tool!.count -= offer.lapis;
    if (this.lapis.tool!.count <= 0) this.lapis = emptyHotSlot();
    // 写入附魔
    this.item.tool = { ...t, ench: { ...(t.ench ?? {}), ...offer.adds } };
    this.cb.onEnchanted();
    this.rollOffers();
    this.renderAll();
  }

  private onSlotClick(ref: SlotRef, button: number): void {
    if (button === 0) this.leftClick(ref);
    else if (button === 2) this.rightClick(ref);
    if (ref.area === 'item') this.rollOffers(); // 换装后重算选项
    this.renderAll();
  }

  private leftClick(ref: SlotRef): void {
    const s = this.getSlot(ref);
    // 装备格只收工具/盔甲；青金石格只收青金石
    if (ref.area === 'item' && !isEmpty(this.cursor) && !this.cursor.tool) return;
    if (ref.area === 'lapis' && !isEmpty(this.cursor) && this.cursor.tool?.def.id !== 'lapis_lazuli') return;
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
      if (s.tool && this.cursor.tool) {
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
      if (s.tool) {
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
      if (this.cursor.tool) {
        this.setSlot(ref, { block: null, food: null, tool: { def: this.cursor.tool.def, count: 1 } });
        this.decCursor(1);
      }
      return;
    }
    if (sameStack(s, this.cursor) && stackCount(s) < STACK_MAX) {
      if (s.tool) s.tool.count++;
      this.setSlot(ref, s);
      this.decCursor(1);
    }
  }

  private decCursor(n: number): void {
    if (this.cursor.tool) this.cursor.tool.count -= n;
    if (stackCount(this.cursor) <= 0) this.cursor = emptyHotSlot();
  }

  // ---------------- 开关 ----------------

  open(): void {
    this.isOpen = true;
    this.el.classList.remove('hidden');
    document.exitPointerLock();
    this.rollOffers();
    this.renderAll();
  }

  close(): void {
    this.isOpen = false;
    this.el.classList.add('hidden');
    this.cursorEl.style.display = 'none';
    // 装备/青金石退回背包
    if (!isEmpty(this.item)) { this.returnSlot(this.item); this.item = emptyHotSlot(); }
    if (!isEmpty(this.lapis)) { this.returnSlot(this.lapis); this.lapis = emptyHotSlot(); }
    if (!isEmpty(this.cursor)) { this.returnSlot(this.cursor); this.cursor = emptyHotSlot(); }
  }

  private returnSlot(s: HotSlot): void {
    const areas: ('main' | 'hot')[] = ['main', 'hot'];
    for (const area of areas) {
      const n = area === 'main' ? MAIN_SIZE : 9;
      for (let i = 0; i < n; i++) {
        const cur = area === 'main' ? this.main[i] : this.hotbar.slotAt(i);
        if (sameStack(cur, s) && stackCount(cur) < STACK_MAX) {
          const put = Math.min(STACK_MAX - stackCount(cur), stackCount(s));
          if (cur.tool && s.tool) {
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
