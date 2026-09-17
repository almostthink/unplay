/**
 * Procedural audio. Every sound is synthesised with WebAudio, so the bundle
 * carries zero audio assets and the game starts instantly on a cold cache.
 */

type Wave = OscillatorType;

class AudioEngine {
  private ctx: AudioContext | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private musicTimer = 0;
  private musicStep = 0;
  private suspended = false;

  soundOn = true;
  musicOn = true;

  /** Must be called from a user gesture; browsers block audio otherwise. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const Ctor: typeof AudioContext =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = 0.32;
      this.sfxGain.connect(this.ctx.destination);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0;
      this.musicGain.connect(this.ctx.destination);
      if (this.musicOn) this.startMusic();
    } catch {
      this.ctx = null;
    }
  }

  /** Silences everything while an ad or a background tab holds the screen. */
  setSuspended(v: boolean): void {
    this.suspended = v;
    if (!this.ctx) return;
    if (v) void this.ctx.suspend();
    else void this.ctx.resume();
  }

  setSound(on: boolean): void {
    this.soundOn = on;
  }

  setMusic(on: boolean): void {
    this.musicOn = on;
    if (!this.ctx || !this.musicGain) return;
    if (on) {
      this.startMusic();
      this.musicGain.gain.setTargetAtTime(0.055, this.ctx.currentTime, 0.4);
    } else {
      this.musicGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
      this.stopMusic();
    }
  }

  private tone(
    freq: number,
    dur: number,
    wave: Wave = 'sine',
    gain = 1,
    slideTo?: number,
  ): void {
    if (!this.ctx || !this.sfxGain || !this.soundOn || this.suspended) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(freq, now);
    if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(slideTo, now + dur);
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(gain, now + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(env);
    env.connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  private noise(dur: number, gain = 0.4): void {
    if (!this.ctx || !this.sfxGain || !this.soundOn || this.suspended) return;
    const now = this.ctx.currentTime;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(gain, now);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(env);
    env.connect(this.sfxGain);
    src.start(now);
  }

  // ------------------------------------------------------------- one-shots

  tap(): void {
    this.tone(520, 0.07, 'triangle', 0.5);
  }

  pick(): void {
    this.tone(360, 0.08, 'sine', 0.45, 520);
  }

  drop(): void {
    this.tone(280, 0.09, 'sine', 0.4, 200);
  }

  /** Pitch climbs with the tier so high merges sound like an achievement. */
  merge(tier: number): void {
    const base = 300 * Math.pow(1.1, tier);
    this.tone(base, 0.12, 'triangle', 0.5, base * 1.6);
    window.setTimeout(() => this.tone(base * 1.5, 0.16, 'sine', 0.35, base * 2), 60);
    if (tier >= 6) window.setTimeout(() => this.sparkle(), 120);
  }

  spawn(): void {
    this.tone(640, 0.09, 'triangle', 0.4, 880);
  }

  coin(): void {
    this.tone(880, 0.06, 'square', 0.22);
    window.setTimeout(() => this.tone(1320, 0.1, 'square', 0.18), 45);
  }

  sparkle(): void {
    [1046, 1318, 1568, 2093].forEach((f, i) =>
      window.setTimeout(() => this.tone(f, 0.16, 'sine', 0.2), i * 55),
    );
  }

  levelUp(): void {
    [523, 659, 784, 1046, 1318].forEach((f, i) =>
      window.setTimeout(() => this.tone(f, 0.28, 'triangle', 0.35), i * 90),
    );
  }

  reward(): void {
    [392, 523, 659, 784].forEach((f, i) =>
      window.setTimeout(() => this.tone(f, 0.3, 'sine', 0.3), i * 75),
    );
    this.noise(0.4, 0.12);
  }

  error(): void {
    this.tone(200, 0.13, 'sawtooth', 0.28, 140);
  }

  ui(): void {
    this.tone(700, 0.05, 'sine', 0.3);
  }

  // ---------------------------------------------------------------- music

  private static readonly SCALE = [0, 3, 5, 7, 10, 12, 15, 12, 10, 7, 5, 3];
  private static readonly ROOTS = [130.81, 155.56, 174.61, 146.83];

  private startMusic(): void {
    if (!this.ctx || !this.musicGain || this.musicTimer) return;
    this.musicGain.gain.setTargetAtTime(0.055, this.ctx.currentTime, 1.2);
    this.musicTimer = window.setInterval(() => this.musicTick(), 420);
  }

  private stopMusic(): void {
    if (this.musicTimer) {
      window.clearInterval(this.musicTimer);
      this.musicTimer = 0;
    }
  }

  private musicTick(): void {
    if (!this.ctx || !this.musicGain || !this.musicOn || this.suspended) return;
    const step = this.musicStep++;
    const root = AudioEngine.ROOTS[Math.floor(step / 12) % AudioEngine.ROOTS.length];
    const semi = AudioEngine.SCALE[step % AudioEngine.SCALE.length];
    const freq = root * Math.pow(2, semi / 12) * 2;
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(0.9, now + 0.05);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 1.1);
    osc.connect(env);
    env.connect(this.musicGain);
    osc.start(now);
    osc.stop(now + 1.2);

    // A soft bass note on the downbeat keeps the loop from feeling thin.
    if (step % 12 === 0) {
      const bass = this.ctx.createOscillator();
      const benv = this.ctx.createGain();
      bass.type = 'sine';
      bass.frequency.value = root / 2;
      benv.gain.setValueAtTime(0, now);
      benv.gain.linearRampToValueAtTime(1.4, now + 0.1);
      benv.gain.exponentialRampToValueAtTime(0.0001, now + 2.4);
      bass.connect(benv);
      benv.connect(this.musicGain);
      bass.start(now);
      bass.stop(now + 2.5);
    }
  }
}

export const sfx = new AudioEngine();
