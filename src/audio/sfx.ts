// ============================================================
// 音效：WebAudio 全合成（无外部音频文件），首次用户手势后启用
// ============================================================

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

  /** 必须在用户手势回调中调用 */
  init(): void {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
  }

  private noiseBuffer(dur: number): AudioBuffer | null {
    if (!this.ctx) return null;
    const buf = this.ctx.createBuffer(1, Math.ceil(this.ctx.sampleRate * dur), this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** 破坏“咔嚓”：噪声爆发 + 低频敲击 */
  playBreak(): void {
    if (!this.ctx || !this.master) return;
    try {
      const t = this.ctx.currentTime;
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer(0.09);
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 900;
      bp.Q.value = 1.2;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.9, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      noise.connect(bp).connect(g).connect(this.master);
      noise.start(t);

      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(160, t);
      osc.frequency.exponentialRampToValueAtTime(70, t + 0.08);
      const g2 = this.ctx.createGain();
      g2.gain.setValueAtTime(0.5, t);
      g2.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      osc.connect(g2).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.1);
    } catch { /* 忽略音频错误 */ }
  }

  /** 放置“嗒” */
  playPlace(): void {
    if (!this.ctx || !this.master) return;
    try {
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(240, t);
      osc.frequency.exponentialRampToValueAtTime(140, t + 0.06);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1200;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.35, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
      osc.connect(lp).connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.08);
    } catch { /* 忽略 */ }
  }

  /** 脚步声（轻噪声） */
  playStep(): void {
    if (!this.ctx || !this.master) return;
    try {
      const t = this.ctx.currentTime;
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer(0.05);
      noise.playbackRate.value = 0.8 + Math.random() * 0.4;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 480;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.16, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      noise.connect(lp).connect(g).connect(this.master);
      noise.start(t);
    } catch { /* 忽略 */ }
  }
}
