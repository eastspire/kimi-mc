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

  /** 生物受伤“啪”：短噪声 + 快速下扫正弦 */
  playHurt(): void {
    if (!this.ctx || !this.master) return;
    try {
      const t = this.ctx.currentTime;
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer(0.07);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 700;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.5, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      noise.connect(lp).connect(g).connect(this.master);
      noise.start(t);

      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(220, t);
      osc.frequency.exponentialRampToValueAtTime(90, t + 0.09);
      const g2 = this.ctx.createGain();
      g2.gain.setValueAtTime(0.4, t);
      g2.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      osc.connect(g2).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.11);
    } catch { /* 忽略 */ }
  }

  /** 进食“咔嚓”（单次，主循环按 0.4s 节奏连播） */
  playEat(): void {
    if (!this.ctx || !this.master) return;
    try {
      const t = this.ctx.currentTime;
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer(0.06);
      noise.playbackRate.value = 0.7 + Math.random() * 0.5;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 480;
      bp.Q.value = 1.4;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.4, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
      noise.connect(bp).connect(g).connect(this.master);
      noise.start(t);
    } catch { /* 忽略 */ }
  }

  /** 拾取“啵”：快速上行短啁啾 */
  playPickup(): void {
    if (!this.ctx || !this.master) return;
    try {
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(340, t);
      osc.frequency.exponentialRampToValueAtTime(720, t + 0.06);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.3, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.09);
    } catch { /* 忽略 */ }
  }

  /** 经验“叮”：明亮短音（MC 拾取经验） */
  playXp(): void {
    if (!this.ctx || !this.master) return;
    try {
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.exponentialRampToValueAtTime(1320, t + 0.05);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.12, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.08);
    } catch { /* 忽略 */ }
  }

  /** 爆炸“轰”：长噪声低通信噪 + 低频冲击（MC 苦力怕/TNT） */
  playExplosion(): void {
    if (!this.ctx || !this.master) return;
    try {
      const t = this.ctx.currentTime;
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer(0.7);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(900, t);
      lp.frequency.exponentialRampToValueAtTime(120, t + 0.6);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(1.0, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
      noise.connect(lp).connect(g).connect(this.master);
      noise.start(t);

      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(90, t);
      osc.frequency.exponentialRampToValueAtTime(35, t + 0.5);
      const g2 = this.ctx.createGain();
      g2.gain.setValueAtTime(0.9, t);
      g2.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
      osc.connect(g2).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.6);
    } catch { /* 忽略 */ }
  }

  /** 射箭“嗖”：高频短噪声下扫 */
  playShoot(): void {
    if (!this.ctx || !this.master) return;
    try {
      const t = this.ctx.currentTime;
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer(0.12);
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(2400, t);
      bp.frequency.exponentialRampToValueAtTime(600, t + 0.1);
      bp.Q.value = 1.6;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.3, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      noise.connect(bp).connect(g).connect(this.master);
      noise.start(t);
    } catch { /* 忽略 */ }
  }

  /** 苦力怕引信“嘶嘶”：白噪声渐强 */
  playFuse(): void {
    if (!this.ctx || !this.master) return;
    try {
      const t = this.ctx.currentTime;
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer(1.4);
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 3000;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.02, t);
      g.gain.linearRampToValueAtTime(0.35, t + 1.3);
      noise.connect(hp).connect(g).connect(this.master);
      noise.start(t);
      noise.stop(t + 1.4);
    } catch { /* 忽略 */ }
  }
}
