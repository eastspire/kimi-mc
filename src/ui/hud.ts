// ============================================================
// HUD：准星（CSS）、暂停提示、选中物品名淡入淡出
//      生存模式生命体征条（心/饥饿，像素图标程序生成）、受伤红闪
// ============================================================

type IconSet = [string, string, string]; // [满, 半, 空]

/** 7×7 像素心形 */
const HEART_SHAPE = [
  '.XX.XX.',
  'XXXXXXX',
  'XXXXXXX',
  '.XXXXX.',
  '..XXX..',
  '...X...',
];

/** 7×7 像素鸡腿（X=肉，B=骨） */
const FOOD_SHAPE = [
  '..XXX..',
  '.XXXXX.',
  '.XXXXXB',
  '.XXXBX.',
  '..XB...',
  '..B....',
];

/** 7×7 像素胸甲（护甲条图标） */
const ARMOR_SHAPE = [
  '.XXXXX.',
  'XXXXXXX',
  'XX.X.XX',
  'X..X..X',
  'X.XXX.X',
  'X.XXX.X',
  '.XXXXX.',
];

function makeIcon(
  shape: string[],
  color: string,
  boneColor: string | null,
  fill: 'full' | 'half' | 'empty',
): string {
  const c = document.createElement('canvas');
  c.width = 7;
  c.height = 7;
  const ctx = c.getContext('2d')!;
  const gray = '#4a4a4a';
  for (let y = 0; y < shape.length; y++) {
    const row = shape[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.') continue;
      let col: string;
      const dim = fill === 'empty' || (fill === 'half' && x >= 4);
      if (dim) col = gray;
      else if (ch === 'B' && boneColor) col = boneColor;
      else col = color;
      ctx.fillStyle = col;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return c.toDataURL();
}

function buildIcons(): { heart: IconSet; food: IconSet; armor: IconSet } {
  return {
    heart: [
      makeIcon(HEART_SHAPE, '#e52521', null, 'full'),
      makeIcon(HEART_SHAPE, '#e52521', null, 'half'),
      makeIcon(HEART_SHAPE, '#e52521', null, 'empty'),
    ],
    food: [
      makeIcon(FOOD_SHAPE, '#b5651d', '#e8e0d0', 'full'),
      makeIcon(FOOD_SHAPE, '#b5651d', '#e8e0d0', 'half'),
      makeIcon(FOOD_SHAPE, '#b5651d', '#e8e0d0', 'empty'),
    ],
    armor: [
      makeIcon(ARMOR_SHAPE, '#b8b8c0', null, 'full'),
      makeIcon(ARMOR_SHAPE, '#b8b8c0', null, 'half'),
      makeIcon(ARMOR_SHAPE, '#b8b8c0', null, 'empty'),
    ],
  };
}

export class Hud {
  private itemNameEl = document.getElementById('item-name')!;
  private pauseHintEl = document.getElementById('pause-menu')!;
  private heartsEl = document.getElementById('hearts')!;
  private hungerEl = document.getElementById('hunger')!;
  private armorEl = document.getElementById('armor')!;
  private hurtEl = document.getElementById('hurt-overlay')!;
  private nameTimer = 0;
  private hurtTimer = 0;
  private readonly icons = buildIcons();
  private readonly heartSlots: HTMLSpanElement[] = [];
  private readonly foodSlots: HTMLSpanElement[] = [];
  private readonly armorSlots: HTMLSpanElement[] = [];
  private vitalsVisible = false;
  private lastHp = -1;
  private lastHunger = -1;
  private lastArmor = -1;

  constructor() {
    for (let i = 0; i < 10; i++) {
      const h = document.createElement('span');
      h.className = 'vital-icon';
      this.heartsEl.appendChild(h);
      this.heartSlots.push(h);
      const f = document.createElement('span');
      f.className = 'vital-icon';
      this.hungerEl.appendChild(f);
      this.foodSlots.push(f);
      const a = document.createElement('span');
      a.className = 'vital-icon';
      this.armorEl.appendChild(a);
      this.armorSlots.push(a);
    }
  }

  private renderRow(
    slots: HTMLSpanElement[],
    icons: IconSet,
    value: number,
  ): void {
    for (let i = 0; i < 10; i++) {
      const state = value >= (i + 1) * 2 ? 0 : value > i * 2 ? 1 : 2;
      const url = icons[state];
      if (slots[i].dataset.s !== String(state)) {
        slots[i].dataset.s = String(state);
        slots[i].style.backgroundImage = `url(${url})`;
      }
    }
  }

  /** 生存模式生命体征；visible=false 时隐藏（创造模式）。仅在变化时重绘 */
  setVitals(hp: number, hunger: number, visible: boolean): void {
    if (visible !== this.vitalsVisible) {
      this.vitalsVisible = visible;
      this.heartsEl.classList.toggle('hidden', !visible);
      this.hungerEl.classList.toggle('hidden', !visible);
      this.armorEl.classList.toggle('hidden', !visible);
      this.lastHp = -1;
      this.lastHunger = -1;
      this.lastArmor = -1;
      for (const s of this.heartSlots) delete s.dataset.s;
      for (const s of this.foodSlots) delete s.dataset.s;
      for (const s of this.armorSlots) delete s.dataset.s;
    }
    if (!visible) return;
    if (hp !== this.lastHp) {
      this.lastHp = hp;
      this.renderRow(this.heartSlots, this.icons.heart, hp);
    }
    if (hunger !== this.lastHunger) {
      this.lastHunger = hunger;
      this.renderRow(this.foodSlots, this.icons.food, hunger);
    }
  }

  /** 护甲条（0~20，与心同刻度）；仅在变化时重绘。生存且 >0 才显示内容 */
  setArmor(armor: number): void {
    if (!this.vitalsVisible) return;
    if (armor === this.lastArmor) return;
    this.lastArmor = armor;
    this.renderRow(this.armorSlots, this.icons.armor, armor);
    this.armorEl.style.opacity = armor > 0 ? '1' : '0';
  }

  /** 受伤全屏红闪 */
  hurtFlash(): void {
    this.hurtTimer = 0.35;
  }

  private xpBarEl = document.getElementById('xp-bar')!;
  private xpFillEl = document.getElementById('xp-fill')!;
  private xpLevelEl = document.getElementById('xp-level')!;
  private xpVisible = false;
  private lastXpKey = '';

  /** 经验条 + 等级（生存模式）；仅在变化时更新 */
  setXp(level: number, frac: number, visible: boolean): void {
    if (visible !== this.xpVisible) {
      this.xpVisible = visible;
      this.xpBarEl.classList.toggle('hidden', !visible);
      this.xpLevelEl.classList.toggle('hidden', !visible);
      this.lastXpKey = '';
    }
    if (!visible) return;
    const key = `${level}|${Math.round(frac * 100)}`;
    if (key === this.lastXpKey) return;
    this.lastXpKey = key;
    this.xpFillEl.style.width = `${Math.round(frac * 100)}%`;
    this.xpLevelEl.textContent = level > 0 ? String(level) : '';
  }

  showItemName(name: string): void {
    this.itemNameEl.textContent = name;
    this.itemNameEl.classList.add('show');
    this.nameTimer = 1.6;
  }

  setPauseHint(visible: boolean): void {
    this.pauseHintEl.classList.toggle('hidden', !visible);
  }

  setCrosshair(visible: boolean): void {
    document.getElementById('crosshair')!.style.opacity = visible ? '1' : '0';
  }

  update(dt: number): void {
    if (this.nameTimer > 0) {
      this.nameTimer -= dt;
      if (this.nameTimer <= 0) this.itemNameEl.classList.remove('show');
    }
    if (this.hurtTimer > 0) {
      this.hurtTimer -= dt;
      this.hurtEl.style.opacity = String(
        Math.max(0, this.hurtTimer / 0.35) * 0.45,
      );
    }
  }
}
