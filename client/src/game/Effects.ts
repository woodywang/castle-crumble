import Phaser from 'phaser';

/**
 * 视觉 + 音效反馈：爆炸粒子、碎石飞溅、冰冻光环、屏幕震动、WebAudio 合成占位音效。
 * 所有音效都是程序合成的（免资源），后期可替换为真实音频。
 */
export class Effects {
  private sparks: Phaser.GameObjects.Particles.ParticleEmitter;
  private smoke: Phaser.GameObjects.Particles.ParticleEmitter;
  private grit: Phaser.GameObjects.Particles.ParticleEmitter;
  private frost: Phaser.GameObjects.Particles.ParticleEmitter;
  private audio: AudioContext | null = null;

  constructor(private scene: Phaser.Scene) {
    this.sparks = scene.add.particles(0, 0, 'spark', {
      speed: { min: 120, max: 520 }, angle: { min: 0, max: 360 },
      lifespan: { min: 250, max: 650 }, scale: { start: 1.1, end: 0 },
      gravityY: 500, tint: [0xfff1a8, 0xffb347, 0xff6b35, 0xffffff], blendMode: 'ADD', emitting: false,
    }).setDepth(50);
    this.smoke = scene.add.particles(0, 0, 'smoke', {
      speed: { min: 30, max: 120 }, angle: { min: 200, max: 340 },
      lifespan: { min: 500, max: 1100 }, scale: { start: 1, end: 3 }, alpha: { start: 0.6, end: 0 },
      tint: [0x555555, 0x888888, 0x333333], emitting: false,
    }).setDepth(49);
    this.grit = scene.add.particles(0, 0, 'grit', {
      speed: { min: 80, max: 380 }, angle: { min: 200, max: 340 },
      lifespan: { min: 400, max: 900 }, scale: { start: 1, end: 0.2 }, rotate: { start: 0, end: 360 },
      gravityY: 900, emitting: false,
    }).setDepth(48);
    this.frost = scene.add.particles(0, 0, 'spark', {
      speed: { min: 40, max: 200 }, angle: { min: 0, max: 360 },
      lifespan: { min: 500, max: 1000 }, scale: { start: 0.8, end: 0 }, alpha: { start: 1, end: 0 },
      tint: [0xbfefff, 0xffffff, 0x7fd4ff], blendMode: 'ADD', emitting: false,
    }).setDepth(50);
  }

  /** 首次用户交互后解锁 AudioContext（浏览器策略） */
  unlockAudio() {
    if (this.audio) return;
    try { this.audio = new AudioContext(); } catch { this.audio = null; }
  }

  explosion(x: number, y: number, radius: number) {
    const k = radius / 120;
    this.sparks.explode(Math.round(40 * k), x, y);
    this.smoke.explode(Math.round(14 * k), x, y);
    this.grit.explode(Math.round(18 * k), x, y);
    // 冲击波圆环
    const ring = this.scene.add.circle(x, y, 10, 0xffffff, 0).setStrokeStyle(6, 0xfff1a8, 1).setDepth(51);
    this.scene.tweens.add({ targets: ring, radius: radius, alpha: 0, duration: 320, ease: 'Cubic.Out', onUpdate: () => ring.setRadius(ring.radius), onComplete: () => ring.destroy() });
    const flash = this.scene.add.circle(x, y, radius * 0.5, 0xffffff, 0.8).setDepth(51);
    this.scene.tweens.add({ targets: flash, scale: 1.6, alpha: 0, duration: 200, onComplete: () => flash.destroy() });
    this.scene.cameras.main.shake(180 + 120 * k, 0.006 + 0.006 * k);
    this.sfxBoom(0.6 + 0.4 * k);
  }

  freeze(x: number, y: number, radius: number) {
    this.frost.explode(60, x, y);
    const ring = this.scene.add.circle(x, y, radius, 0x9be7ff, 0.35).setStrokeStyle(4, 0xffffff, 0.9).setDepth(51);
    this.scene.tweens.add({ targets: ring, alpha: 0, scale: 1.1, duration: 700, onComplete: () => ring.destroy() });
    this.scene.cameras.main.flash(150, 180, 230, 255);
    this.sfxFreeze();
  }

  gravityWell(x: number, y: number, radius: number, durationMs: number) {
    const vortex = this.scene.add.circle(x, y, radius, 0x8e44ad, 0.18).setStrokeStyle(3, 0xd7bde2, 0.8).setDepth(47);
    const core = this.scene.add.circle(x, y, 14, 0x5b2c6f, 1).setDepth(52);
    this.scene.tweens.add({ targets: vortex, angle: 360, scale: { from: 1, to: 0.2 }, duration: durationMs, ease: 'Sine.In', onComplete: () => { vortex.destroy(); core.destroy(); } });
    this.scene.tweens.add({ targets: core, scale: { from: 1, to: 1.6 }, yoyo: true, repeat: -1, duration: 300 });
    this.sfxWell(durationMs);
  }

  /** 撞击：小火花 + 尘土 */
  impact(x: number, y: number, strength: number) {
    this.sparks.explode(Math.round(4 + 10 * strength), x, y);
    this.grit.explode(Math.round(3 + 6 * strength), x, y);
    if (strength > 0.35) this.scene.cameras.main.shake(80, 0.002 * strength);
    this.sfxHit(strength);
  }

  /** 砖块碎裂：按材质颜色喷碎石 */
  shatter(x: number, y: number, color: number) {
    this.grit.setParticleTint(color);
    this.grit.explode(12, x, y);
    this.grit.setParticleTint(0xffffff);
    this.smoke.explode(3, x, y);
    this.sfxCrack();
  }

  swing() { this.sfxSwing(); }
  shoot(power: number) { this.sfxShoot(power); }

  /* ---------------- WebAudio 合成音效（占位） ---------------- */

  private noise(duration: number, gain: number, filterHz: number, type: BiquadFilterType = 'lowpass') {
    const ac = this.audio; if (!ac) return;
    const len = Math.floor(ac.sampleRate * duration);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ac.createBufferSource(); src.buffer = buf;
    const filter = ac.createBiquadFilter(); filter.type = type; filter.frequency.value = filterHz;
    const g = ac.createGain(); g.gain.setValueAtTime(gain, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + duration);
    src.connect(filter).connect(g).connect(ac.destination); src.start();
  }

  private tone(freqFrom: number, freqTo: number, duration: number, gain: number, type: OscillatorType = 'sine') {
    const ac = this.audio; if (!ac) return;
    const o = ac.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(freqFrom, ac.currentTime); o.frequency.exponentialRampToValueAtTime(Math.max(20, freqTo), ac.currentTime + duration);
    const g = ac.createGain(); g.gain.setValueAtTime(gain, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + duration);
    o.connect(g).connect(ac.destination); o.start(); o.stop(ac.currentTime + duration);
  }

  private sfxBoom(k: number) { this.noise(0.5 * k, 0.5, 400); this.tone(120, 30, 0.4 * k, 0.4, 'square'); }
  private sfxHit(s: number) { this.noise(0.08, 0.15 + 0.2 * s, 1800, 'bandpass'); }
  private sfxCrack() { this.noise(0.15, 0.25, 900); this.tone(300, 80, 0.12, 0.12, 'triangle'); }
  private sfxShoot(p: number) { this.noise(0.18, 0.2, 600 + 1200 * p, 'highpass'); this.tone(200 + 300 * p, 60, 0.2, 0.15, 'sawtooth'); }
  private sfxSwing() { this.noise(0.12, 0.15, 2500, 'highpass'); }
  private sfxFreeze() { this.tone(900, 1800, 0.5, 0.12, 'sine'); this.noise(0.4, 0.1, 4000, 'highpass'); }
  private sfxWell(ms: number) { this.tone(60, 240, ms / 1000, 0.15, 'sine'); }
}
