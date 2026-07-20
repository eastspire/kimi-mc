// ============================================================
// HUD：准星（CSS）、暂停提示、选中物品名淡入淡出
// ============================================================

export class Hud {
  private itemNameEl = document.getElementById('item-name')!;
  private pauseHintEl = document.getElementById('pause-menu')!;
  private nameTimer = 0;

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
  }
}
