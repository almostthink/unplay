/**
 * Procedural audio for the racer. The engine and tyre screech are continuous
 * voices whose pitch and gain track the car every frame; everything else is a
 * short synthesised one-shot. No audio files ship with the build.
 */

class RaceAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;

  // Continuous voices
  private engineOsc: OscillatorNode | null = null;
  private engineSub: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private skidSrc: AudioBufferSourceNode | null = null;
  private skidGain: GainNode | null = null;
  private skidFilter: BiquadFilterNode | null = null;

  private musicTimer = 0;
  private musicStep = 0;
  private suspended = false;
  private engineRunning = false;

  soundOn = true;
  musicOn = true;

  /** Must run inside a user gesture; browsers block audio otherwise. */
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
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);

      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = 0.34;
      this.sfxBus.connect(this.master);

      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = 0;
      this.musicBus.connect(this.master);

      if (this.musicOn) this.startMusic();
    } catch {
      this.ctx = null;
    }
  }

  setSuspended(v: boolean): void {
    this.suspended = v;
    if (!this.ctx) return;
    if (v) void this.ctx.suspend();
    else void this.ctx.resume();
  }

  setSound(on: boolean): void {
    this.soundOn = on;
    if (this.sfxBus && this.ctx) {
      this.sfxBus.gain.setTargetAtTime(on ? 0.34 : 0, this.ctx.currentTime, 0.05);
    }
  }

  setMusic(on: boolean): void {
    this.musicOn = on;
    if (!this.ctx || !this.musicBus) return;
    if (on) {
      this.startMusic();
      this.musicBus.gain.setTargetAtTime(0.06, this.ctx.currentTime, 0.5);
    } else {
      this.musicBus.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
      this.stopMusic();
    }
  }

  // ------------------------------------------------------- engine + skid

  startEngine(): void {
    if (!this.ctx || !this.sfxBus || this.engineRunning) return;
    const now = this.ctx.currentTime;

    this.engineFilter = this.ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 900;
    this.engineFilter.Q.value = 3;

    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0;

    this.engineOsc = this.ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 60;

    this.engineSub = this.ctx.createOscillator();
    this.engineSub.type = 'square';
    this.engineSub.frequency.value = 30;
    this.engineSub.detune.value = 12;

    this.engineOsc.connect(this.engineFilter);
    this.engineSub.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.sfxBus);
    this.engineOsc.start(now);
    this.engineSub.start(now);
    this.engineGain.gain.setTargetAtTime(0.28, now, 0.25);

    // Tyre screech: looping noise through a band-pass, gain driven by drift.
    const len = Math.floor(this.ctx.sampleRate * 1.5);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.skidFilter = this.ctx.createBiquadFilter();
    this.skidFilter.type = 'bandpass';
    this.skidFilter.frequency.value = 2400;
    this.skidFilter.Q.value = 2.2;

    this.skidGain = this.ctx.createGain();
    this.skidGain.gain.value = 0;

    this.skidSrc = this.ctx.createBufferSource();
    this.skidSrc.buffer = buf;
    this.skidSrc.loop = true;
    this.skidSrc.connect(this.skidFilter);
    this.skidFilter.connect(this.skidGain);
    this.skidGain.connect(this.sfxBus);
    this.skidSrc.start(now);

    this.engineRunning = true;
  }

  stopEngine(): void {
    if (!this.ctx || !this.engineRunning) return;
    const now = this.ctx.currentTime;
    this.engineGain?.gain.setTargetAtTime(0, now, 0.12);
    this.skidGain?.gain.setTargetAtTime(0, now, 0.08);
    const osc = this.engineOsc;
    const sub = this.engineSub;
    const skid = this.skidSrc;
    window.setTimeout(() => {
      try {
        osc?.stop();
        sub?.stop();
        skid?.stop();
      } catch {
        /* already stopped */
      }
    }, 400);
    this.engineOsc = null;
    this.engineSub = null;
    this.skidSrc = null;
    this.engineRunning = false;
  }

  /**
   * Drives the continuous voices. `rpm` is 0..1, `skid` is 0..1, `nitro` adds
   * a brighter filter sweep while the boost is held.
   */
  updateEngine(rpm: number, skid: number, nitro: boolean): void {
    if (!this.ctx || !this.engineRunning) return;
    const now = this.ctx.currentTime;
    const base = 58 + rpm * 190;
    this.engineOsc?.frequency.setTargetAtTime(base, now, 0.05);
    this.engineSub?.frequency.setTargetAtTime(base * 0.5, now, 0.05);
    this.engineFilter?.frequency.setTargetAtTime(
      620 + rpm * 1500 + (nitro ? 900 : 0),
      now,
      0.08,
    );
    this.engineGain?.gain.setTargetAtTime(0.2 + rpm * 0.16, now, 0.1);
    this.skidGain?.gain.setTargetAtTime(skid * 0.22, now, 0.06);
    this.skidFilter?.frequency.setTargetAtTime(1800 + skid * 1600, now, 0.1);
  }

  // ------------------------------------------------------------ one-shots

  private tone(
    freq: number,
    dur: number,
    wave: OscillatorType = 'sine',
    gain = 0.4,
    slideTo?: number,
  ): void {
    if (!this.ctx || !this.sfxBus || !this.soundOn || this.suspended) return;
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
    env.connect(this.sfxBus);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  private noise(dur: number, gain: number, freq: number): void {
    if (!this.ctx || !this.sfxBus || !this.soundOn || this.suspended) return;
    const now = this.ctx.currentTime;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = freq;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(gain, now);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(filter);
    filter.connect(env);
    env.connect(this.sfxBus);
    src.start(now);
  }

  crash(): void {
    this.noise(0.45, 0.6, 1400);
    this.tone(140, 0.3, 'sawtooth', 0.35, 70);
  }

  coin(): void {
    this.tone(1180, 0.05, 'square', 0.16);
    window.setTimeout(() => this.tone(1580, 0.09, 'square', 0.13), 40);
  }

  checkpoint(): void {
    [660, 880, 1320].forEach((f, i) =>
      window.setTimeout(() => this.tone(f, 0.18, 'triangle', 0.3), i * 70),
    );
  }

  nitroStart(): void {
    this.noise(0.5, 0.35, 5000);
    this.tone(220, 0.4, 'sawtooth', 0.22, 900);
  }

  countdown(final: boolean): void {
    this.tone(final ? 900 : 520, final ? 0.35 : 0.16, 'triangle', 0.4);
  }

  levelUp(): void {
    [523, 659, 784, 1046].forEach((f, i) =>
      window.setTimeout(() => this.tone(f, 0.26, 'triangle', 0.33), i * 85),
    );
  }

  reward(): void {
    [392, 523, 659, 784].forEach((f, i) =>
      window.setTimeout(() => this.tone(f, 0.28, 'sine', 0.28), i * 70),
    );
  }

  ui(): void {
    this.tone(660, 0.05, 'sine', 0.25);
  }

  error(): void {
    this.tone(190, 0.13, 'sawtooth', 0.25, 130);
  }

  // ---------------------------------------------------------------- music

  private static readonly BASS = [55, 55, 73.42, 65.41];
  private static readonly LEAD = [0, 7, 10, 12, 10, 7, 5, 3];

  private startMusic(): void {
    if (!this.ctx || !this.musicBus || this.musicTimer) return;
    this.musicBus.gain.setTargetAtTime(0.06, this.ctx.currentTime, 1);
    this.musicTimer = window.setInterval(() => this.musicTick(), 250);
  }

  private stopMusic(): void {
    if (!this.musicTimer) return;
    window.clearInterval(this.musicTimer);
    this.musicTimer = 0;
  }

  /** A slow synthwave pulse: bass on the beat, a sparse lead over it. */
  private musicTick(): void {
    if (!this.ctx || !this.musicBus || !this.musicOn || this.suspended) return;
    const step = this.musicStep++;
    const now = this.ctx.currentTime;
    const bar = Math.floor(step / 8) % RaceAudio.BASS.length;

    if (step % 2 === 0) {
      const bass = this.ctx.createOscillator();
      const env = this.ctx.createGain();
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 420;
      bass.type = 'sawtooth';
      bass.frequency.value = RaceAudio.BASS[bar];
      env.gain.setValueAtTime(0, now);
      env.gain.linearRampToValueAtTime(1.1, now + 0.02);
      env.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
      bass.connect(filter);
      filter.connect(env);
      env.connect(this.musicBus);
      bass.start(now);
      bass.stop(now + 0.5);
    }

    if (step % 4 === 1) {
      const semi = RaceAudio.LEAD[(step >> 2) % RaceAudio.LEAD.length];
      const lead = this.ctx.createOscillator();
      const env = this.ctx.createGain();
      lead.type = 'triangle';
      lead.frequency.value = RaceAudio.BASS[bar] * 4 * Math.pow(2, semi / 12);
      env.gain.setValueAtTime(0, now);
      env.gain.linearRampToValueAtTime(0.5, now + 0.03);
      env.gain.exponentialRampToValueAtTime(0.0001, now + 0.8);
      lead.connect(env);
      env.connect(this.musicBus);
      lead.start(now);
      lead.stop(now + 0.85);
    }
  }
}

export const sfx = new RaceAudio();
