// ============================================================
// F3 调试面板
// ============================================================

export class DebugPanel {
  visible = false;
  private el = document.getElementById('debug')!;
  private acc = 0;
  private fps = 0;
  private frames = 0;
  private fpsTime = 0;

  constructor() {
    this.el.classList.add('hidden');
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.classList.toggle('hidden', !this.visible);
  }

  tickFrame(dt: number): void {
    this.frames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.fps = Math.round(this.frames / this.fpsTime);
      this.frames = 0;
      this.fpsTime = 0;
    }
  }

  update(dt: number, text: () => string): void {
    if (!this.visible) return;
    this.acc += dt;
    if (this.acc < 0.15) return;
    this.acc = 0;
    this.el.textContent = `FPS: ${this.fps}\n${text()}`;
  }
}
