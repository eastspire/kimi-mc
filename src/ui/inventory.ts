import type { BlockDef } from '../core/model-loader';
import { drawBlockIcon } from './hotbar';

// ============================================================
// 创造模式物品栏：E 开关
//  - 网格展示全部可放置方块（等轴测图标 + 悬停显示名称）
//  - 点击方块 → 放入当前快捷栏槽位并关闭
//  - 打开时解锁鼠标，关闭后回锁；E / ESC 均可关闭
// ============================================================

export interface InventoryCallbacks {
  onPick: (def: BlockDef) => void;
  onClose: () => void;
}

export class Inventory {
  isOpen = false;
  private el = document.getElementById('inv')!;
  private nameEl = document.getElementById('inv-name')!;

  constructor(
    defs: BlockDef[],
    atlasCanvas: HTMLCanvasElement,
    private cb: InventoryCallbacks,
  ) {
    const grid = document.getElementById('inv-grid')!;
    for (const def of defs) {
      const slot = document.createElement('div');
      slot.className = 'hotbar-slot';
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 44;
      slot.appendChild(canvas);
      drawBlockIcon(canvas, def, atlasCanvas);
      slot.addEventListener('mouseenter', () => {
        this.nameEl.textContent = def.display;
      });
      slot.addEventListener('mouseleave', () => {
        this.nameEl.innerHTML = '&nbsp;';
      });
      slot.addEventListener('click', () => {
        this.close();
        this.cb.onPick(def);
      });
      grid.appendChild(slot);
    }

    // 打开状态下 E / ESC 关闭（此时指针未锁定，Controls 不处理按键）
    document.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      if (e.code === 'KeyE' || e.code === 'Escape') {
        e.preventDefault();
        this.close();
        this.cb.onClose();
      }
    });
  }

  open(): void {
    this.isOpen = true;
    this.el.classList.remove('hidden');
    document.exitPointerLock();
  }

  close(): void {
    this.isOpen = false;
    this.el.classList.add('hidden');
  }
}
