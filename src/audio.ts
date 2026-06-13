// audio.ts — every sound is synthesized with WebAudio; no audio files.

const MUTE_KEY = 'glassglide.muted';
const MUSIC_VOL = 0.022;
const CHORD_INTERVAL_MS = 7000;

// Ambient pad chords per day-cycle mood (midi note numbers).
const MOODS: number[][][] = [
  // dusk — wistful minor
  [[45, 52, 60, 64], [41, 48, 57, 60], [43, 50, 59, 62], [38, 50, 57, 65]],
  // neon night — darker, suspended
  [[45, 52, 58, 65], [43, 50, 58, 62], [40, 47, 55, 62], [46, 53, 60, 67]],
  // dawn — open major
  [[48, 55, 64, 67], [45, 52, 60, 69], [41, 48, 57, 64], [43, 50, 59, 67]],
];

function midiToFreq(m: number): number {
  return 440 * 2 ** ((m - 69) / 12);
}

class GameAudio {
  // Mute lives in a JS variable and is persisted to localStorage.
  muted = localStorage.getItem(MUTE_KEY) === '1';
  private ctx: AudioContext | null = null;
  private musicGain: GainNode | null = null;
  private musicTimer: number | null = null;
  private mood = 0;
  private chordIdx = 0;

  /** Call from a user gesture — browsers block audio until then. */
  unlock(): void {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    if (this.musicGain && this.ctx) {
      this.musicGain.gain.setTargetAtTime(this.muted ? 0 : MUSIC_VOL, this.ctx.currentTime, 0.1);
    }
    return this.muted;
  }

  /** Suspend everything (music included) while the tab is backgrounded. */
  setSuspended(hidden: boolean): void {
    if (!this.ctx) return;
    if (hidden) void this.ctx.suspend();
    else void this.ctx.resume();
  }

  // ---- generative ambient pad ----

  startMusic(): void {
    if (!this.ctx || this.musicTimer !== null) return;
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = this.muted ? 0 : MUSIC_VOL;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900; // keep the pad soft and far away
    this.musicGain.connect(lp).connect(this.ctx.destination);
    this.playChord();
    this.musicTimer = window.setInterval(() => this.playChord(), CHORD_INTERVAL_MS);
  }

  /** Shifts the pad's chord set; called when the day-cycle palette changes. */
  setMood(i: number): void {
    this.mood = ((i % MOODS.length) + MOODS.length) % MOODS.length;
  }

  private playChord(): void {
    const ac = this.ctx;
    // Skipping while suspended avoids a burst of stacked chords on resume.
    if (!ac || !this.musicGain || ac.state !== 'running') return;
    const chords = MOODS[this.mood];
    const chord = chords[this.chordIdx++ % chords.length];
    const t = ac.currentTime;
    for (const midi of chord) {
      for (const det of [-4, 4]) {
        const o = ac.createOscillator();
        o.type = 'sine';
        o.frequency.value = midiToFreq(midi);
        o.detune.value = det;
        const g = ac.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.4, t + 2.8);
        g.gain.setValueAtTime(0.4, t + 6.0);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 9.0);
        o.connect(g).connect(this.musicGain);
        o.start(t);
        o.stop(t + 9.1);
      }
    }
  }

  // ---- sound effects ----

  private out(): AudioContext | null {
    return this.muted || !this.ctx || this.ctx.state !== 'running' ? null : this.ctx;
  }

  private tone(
    freqA: number,
    freqB: number,
    dur: number,
    type: OscillatorType,
    vol: number,
    when = 0,
  ): void {
    const ac = this.out();
    if (!ac) return;
    const t = ac.currentTime + when;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqA, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqB), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(ac.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, freq: number, type: BiquadFilterType, vol: number): void {
    const ac = this.out();
    if (!ac) return;
    const t = ac.currentTime;
    const len = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = ac.createBufferSource();
    src.buffer = buf;
    const f = ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ac.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(ac.destination);
    src.start(t);
  }

  /** Short rising blip. */
  flap(): void {
    this.tone(440, 920, 0.11, 'triangle', 0.22);
  }

  /** Two-note chime. */
  score(): void {
    this.tone(880, 880, 0.09, 'sine', 0.18);
    this.tone(1318.5, 1318.5, 0.14, 'sine', 0.16, 0.07);
  }

  /** Tiny crystalline glint for a near-miss. */
  sparkle(): void {
    this.tone(1760, 2350, 0.09, 'sine', 0.1);
    this.tone(2637, 3520, 0.12, 'sine', 0.07, 0.05);
  }

  /** Descending shimmer for the slow-mo lens pickup. */
  lens(): void {
    this.tone(620, 220, 0.5, 'sine', 0.16);
    this.tone(1240, 440, 0.5, 'sine', 0.07);
  }

  /** Soft rising swell when the shield wraps on. */
  shieldUp(): void {
    this.tone(330, 660, 0.25, 'sine', 0.14);
    this.tone(660, 1320, 0.25, 'sine', 0.06, 0.05);
  }

  /** Bubble burst when the shield absorbs a hit. */
  shieldPop(): void {
    this.noise(0.12, 1400, 'highpass', 0.3);
    this.tone(520, 180, 0.18, 'triangle', 0.18);
  }

  /** Glass shatter: filtered noise burst plus a few high "shard" pings. */
  shatter(): void {
    const ac = this.out();
    if (!ac) return;
    const t = ac.currentTime;
    const len = Math.floor(ac.sampleRate * 0.45);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = ac.createBufferSource();
    src.buffer = buf;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(3200, t);
    bp.frequency.exponentialRampToValueAtTime(900, t + 0.4);
    bp.Q.value = 0.8;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    src.connect(bp).connect(g).connect(ac.destination);
    src.start(t);
    for (let i = 0; i < 4; i++) {
      this.tone(2200 + Math.random() * 1800, 1400, 0.08, 'sine', 0.08, 0.05 + i * 0.05);
    }
  }
}

export const audio = new GameAudio();
