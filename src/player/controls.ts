// ============================================================
// 输入控制：指针锁定、鼠标视角、键盘、滚轮快捷栏
// ============================================================

export interface ControlEvents {
  onToggleFly: () => void;
  onHotbar: (index: number) => void;
  onDebugToggle: () => void;
  onAttack: (down: boolean) => void;
  onUse: (down: boolean) => void;
  onSneak: (sneaking: boolean) => void;
  /** 双击 W 触发冲刺（不用 Ctrl+W，避免浏览器关页冲突） */
  onSprint: () => void;
}

const MOUSE_SENS = 0.0022;

export class Controls {
  yaw = 0;
  pitch = 0;
  locked = false;
  readonly keys = new Set<string>();
  private lastSpaceDown = 0;
  private lastWDown = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private events: ControlEvents,
  ) {
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.keys.clear();
      this.onLockChange?.(this.locked);
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * MOUSE_SENS;
      this.pitch -= e.movementY * MOUSE_SENS;
      const lim = Math.PI / 2 - 0.001;
      this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) this.events.onAttack(true);
      else if (e.button === 2) this.events.onUse(true);
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.events.onAttack(false);
      else if (e.button === 2) this.events.onUse(false);
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('wheel', (e) => {
      if (!this.locked) return;
      this.onWheel?.(e.deltaY > 0 ? 1 : -1);
    });
    document.addEventListener('keydown', (e) => {
      if (e.code === 'F3') {
        e.preventDefault();
        if (this.locked) this.events.onDebugToggle();
        return;
      }
      if (!this.locked || e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'Space') {
        const now = performance.now();
        if (now - this.lastSpaceDown < 260) this.events.onToggleFly();
        this.lastSpaceDown = now;
      }
      if (e.code === 'KeyW') {
        const now = performance.now();
        if (now - this.lastWDown < 260) this.events.onSprint();
        this.lastWDown = now;
      }
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.events.onSneak(true);
      if (e.code.startsWith('Digit')) {
        const n = Number(e.code.slice(5));
        if (n >= 1 && n <= 9) this.events.onHotbar(n - 1);
      }
    });
    document.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.events.onSneak(false);
    });
  }

  onLockChange: ((locked: boolean) => void) | null = null;
  onWheel: ((dir: number) => void) | null = null;

  lock(): void {
    try {
      // 非用户手势场景（如自动化）会拒绝，吞掉避免未处理 rejection
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => { /* 忽略：用户下次点击会再次尝试 */ });
    } catch { /* 忽略 */ }
  }

  get forward(): { x: number; z: number } {
    return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) };
  }
}
