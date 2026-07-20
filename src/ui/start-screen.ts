// ============================================================
// 开始 / 加载 / 错误 全屏界面
// 流程：选择（种子输入 + 模式选择 + 创建/继续）→ 生成进度 → 点击进入
// ============================================================

import type { GameMode } from '../core/persistence';

export interface ChoiceCallbacks {
  onCreate: (seedText: string, mode: GameMode) => void;
  onContinue: () => void;
}

export class StartScreen {
  private overlay = document.getElementById('overlay')!;
  private progressWrap = document.getElementById('overlay-progress-wrap')!;
  private progressText = document.getElementById('overlay-progress-text')!;
  private bar = document.getElementById('overlay-bar')!;
  private btn = document.getElementById('overlay-btn') as HTMLButtonElement;
  private continueBtn = document.getElementById('continue-btn') as HTMLButtonElement;
  private seedRow = document.getElementById('seed-row')!;
  private seedInput = document.getElementById('seed-input') as HTMLInputElement;
  private modeRow = document.getElementById('mode-row')!;
  private mode: GameMode = 'creative';

  /** 主菜单：种子输入 + 模式选择 + 创建新世界（有存档时额外显示继续按钮） */
  showChoice(hasSave: boolean, cb: ChoiceCallbacks): void {
    this.overlay.classList.remove('hidden');
    this.seedRow.classList.remove('hidden');
    this.modeRow.classList.remove('hidden');
    this.progressWrap.classList.add('hidden');
    this.continueBtn.classList.toggle('hidden', !hasSave);
    this.btn.disabled = false;
    this.btn.textContent = '创建新世界';
    this.btn.onclick = () => cb.onCreate(this.seedInput.value, this.mode);
    this.continueBtn.onclick = () => cb.onContinue();
    for (const b of this.modeRow.querySelectorAll<HTMLButtonElement>('button')) {
      b.classList.toggle('mode-on', b.dataset.mode === this.mode);
      b.onclick = () => {
        this.mode = b.dataset.mode === 'survival' ? 'survival' : 'creative';
        for (const x of this.modeRow.querySelectorAll('button'))
          x.classList.toggle('mode-on', x === b);
      };
    }
    this.seedInput.focus();
  }

  /** 创建按钮文案（两段确认用） */
  setCreateLabel(text: string): void {
    this.btn.textContent = text;
  }

  showGenerating(): void {
    this.seedRow.classList.add('hidden');
    this.modeRow.classList.add('hidden');
    this.continueBtn.classList.add('hidden');
    this.progressWrap.classList.remove('hidden');
    this.btn.disabled = true;
    this.btn.textContent = '正在生成世界…';
  }

  setProgress(text: string, ratio: number): void {
    this.progressText.textContent = text;
    this.bar.style.width = `${Math.round(ratio * 100)}%`;
  }

  setReady(onStart: () => void): void {
    this.progressText.textContent = '世界生成完毕';
    this.bar.style.width = '100%';
    this.btn.disabled = false;
    this.btn.textContent = '点击进入世界';
    this.btn.onclick = () => onStart();
  }

  showError(message: string): void {
    this.overlay.classList.add('error');
    this.overlay.classList.remove('hidden');
    this.seedRow.classList.add('hidden');
    this.modeRow.classList.add('hidden');
    this.continueBtn.classList.add('hidden');
    this.progressWrap.classList.remove('hidden');
    this.progressText.textContent = `加载失败：${message}`;
    this.progressText.style.color = '#ffb0b0';
    this.bar.style.width = '0%';
    this.btn.disabled = true;
    this.btn.textContent = '请检查 models 资源后刷新';
  }

  hide(): void {
    this.overlay.classList.add('hidden');
  }
}
