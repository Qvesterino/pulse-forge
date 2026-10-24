/**
 * CINK DSP core (ADR 0060) — the hi-hat designer. Six square partials at
 * deliberately irregular ratio multipliers (the 808-style metal stack) →
 * highpass → DRIVE/LEVEL. A fast CHIRP (pitch envelope on the multiplier
 * base) is the stick's attack; DECAY spans closed (50 ms) to open (1.2 s).
 *
 * Deterministic: partial phase offsets draw from a per-note LCG seeded at
 * noteOn — live and offline identical given the same events. Bounded: 8
 * voices (oldest-steal), preallocated per-voice state, zero allocation.
 */

export interface CinkEvent {
  type: "noteOn" | "noteOff" | "panic";
  /** Absolute context time in seconds. */
  when: number;
  pitch?: number;
  velocity?: number;
}

export interface CinkInitOptions {
  sampleRate: number;
  events?: CinkEvent[];
}

const MAX_VOICES = 8;
/** The 808-style irregular metal-stack multipliers. */
const PARTIAL_RATIOS = [2, 3, 4.16, 5.43, 6.79, 8.21];

interface Voice {
  active: boolean;
  vel: number;
  age: number;
  basePitch: number;
  /** Partial phases (6) and the chirp envelope. */
  phase: Float32Array;
  chirpEnv: number;
  decayEnv: number;
  /** One-pole highpass state. */
  hpState: number;
  lcg: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export class CinkProcessor {
  private sampleRate: number;
  private params: Record<string, number> = {};
  private events: CinkEvent[] = [];
  private voices: Voice[] = [];
  private voiceCounter = 0;
  private blockEvents: CinkEvent[] = [];
  private outPeak = 0;

  constructor(options: CinkInitOptions) {
    this.sampleRate = options.sampleRate > 0 ? options.sampleRate : 48000;
    for (let i = 0; i < MAX_VOICES; i++) {
      this.voices.push({
        active: false,
        vel: 0.8,
        age: 0,
        basePitch: 60,
        phase: new Float32Array(PARTIAL_RATIOS.length),
        chirpEnv: 0,
        decayEnv: 0,
        hpState: 0,
        lcg: 1,
      });
    }
    if (options.events) for (const event of options.events) this.postEvent(event);
  }

  applyParams(values: Record<string, number>): void {
    for (const [key, value] of Object.entries(values)) {
      if (Number.isFinite(value)) this.params[key] = value;
    }
  }

  setParam(name: string, value: number): void {
    if (Number.isFinite(value)) this.params[name] = value;
  }

  postEvent(event: CinkEvent): void {
    if (!Number.isFinite(event.when)) return;
    this.events.push(event);
    for (let i = this.events.length - 1; i > 0 && this.events[i - 1]!.when > event.when; i--) {
      const tmp = this.events[i - 1]!;
      this.events[i - 1] = this.events[i]!;
      this.events[i] = tmp;
    }
  }

  private noteOn(pitch: number, velocity: number): void {
    if (!Number.isFinite(pitch)) return;
    let voice = this.voices.find((candidate) => !candidate.active);
    if (!voice) voice = this.voices.reduce((oldest, c) => (c.age < oldest.age ? c : oldest));
    voice.active = true;
    voice.vel = clamp(velocity, 0, 1);
    voice.age = ++this.voiceCounter;
    voice.basePitch = pitch;
    voice.chirpEnv = 1;
    voice.decayEnv = 1;
    voice.hpState = 0;
    voice.lcg = (0x9e3779b9 ^ Math.imul(pitch + 1, 2654435761) ^ Math.imul(this.voiceCounter, 40503)) >>> 0;
    for (let p = 0; p < PARTIAL_RATIOS.length; p++) {
      voice.phase[p] = this.lcgDraw(voice) * 0.02; // tiny phase scatter only
    }
  }

  applyEvent(event: CinkEvent): void {
    switch (event.type) {
      case "noteOn":
        this.noteOn(event.pitch ?? 60, event.velocity ?? 0.8);
        break;
      case "noteOff":
      case "panic":
        for (const voice of this.voices) {
          voice.active = false;
          voice.decayEnv = 0;
        }
        break;
    }
  }

  private lcgDraw(voice: Voice): number {
    let state = voice.lcg;
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    voice.lcg = state;
    return state / 0x100000000;
  }

  process(left: Float32Array, right: Float32Array, currentFrame: number): void {
    const sr = this.sampleRate;
    const frames = left.length;
    const blockStartSec = currentFrame / sr;
    const blockEndSec = (currentFrame + frames) / sr;

    const blockEvents = this.blockEvents;
    blockEvents.length = 0;
    while (this.events.length > 0 && this.events[0]!.when < blockEndSec) {
      const next = this.events.shift()!;
      if (next.when >= blockStartSec) blockEvents.push(next);
      else this.applyEvent(next);
    }
    let eventCursor = 0;

    const tune = clamp(this.params.tune ?? 0, -12, 12);
    const baseHz = 40 * Math.pow(2, tune / 12); // × partials → 80–330 Hz base
    const decaySec = clamp(this.params.decay ?? 0.4, 0.05, 1.2);
    const chirpTime = clamp(this.params.chirpTime ?? 0.03, 0.005, 0.15);
    const chirpAmount = clamp(this.params.chirp ?? 0.3, 0, 1);
    const hpFreq = clamp(this.params.hpTone ?? 7000, 3000, 12000);
    const hpCoef = Math.exp((-2 * Math.PI * hpFreq) / sr);
    const metalSpread = clamp(this.params.metalSpread ?? 0.15, 0, 1);
    const pulseMix = clamp(this.params.pulseMix ?? 0.5, 0, 1);
    const drive = clamp(this.params.drive ?? 0.25, 0, 1);
    const level = clamp(this.params.level ?? 0.8, 0, 1.5) * 0.5;
    const decayCoef = Math.exp(-1 / (decaySec * sr * 0.3));
    const chirpCoef = Math.exp(-1 / (chirpTime * sr * 0.3));

    left.fill(0);
    right.fill(0);
    let peak = 0;

    for (let frame = 0; frame < frames; frame++) {
      const frameTime = (currentFrame + frame) / sr;
      while (eventCursor < blockEvents.length && blockEvents[eventCursor]!.when <= frameTime) {
        this.applyEvent(blockEvents[eventCursor]!);
        eventCursor += 1;
      }

      let mix = 0;
      for (const voice of this.voices) {
        if (!voice.active) continue;
        if (voice.decayEnv < 0.001) {
          voice.active = false;
          continue;
        }

        const chirp = 1 + chirpAmount * voice.chirpEnv * 2.5;
        let partialSum = 0;
        for (let p = 0; p < PARTIAL_RATIOS.length; p++) {
          const spread = 1 + (p % 2 === 0 ? 1 : -1) * metalSpread * 0.02;
          voice.phase[p]! += (baseHz * PARTIAL_RATIOS[p]! * chirp * spread) / sr;
          if (voice.phase[p]! >= 1) voice.phase[p]! -= Math.floor(voice.phase[p]!);
          const square = voice.phase[p]! < 0.5 ? 1 : -1;
          const sine = Math.sin(2 * Math.PI * voice.phase[p]!);
          partialSum += square * pulseMix + sine * (1 - pulseMix);
        }
        partialSum /= PARTIAL_RATIOS.length;

        voice.chirpEnv *= chirpCoef;
        voice.decayEnv *= decayCoef;

        // Highpass: y = x − lp(x).
        voice.hpState += (1 - hpCoef) * (partialSum * voice.decayEnv * voice.vel - voice.hpState);
        let sample = partialSum * voice.decayEnv * voice.vel - voice.hpState;

        if (drive > 0) sample = Math.tanh(sample * (1 + drive * 4)) / Math.tanh(1 + drive * 4);
        mix += sample * level;
      }

      left[frame] = mix;
      right[frame] = mix;
      const magnitude = Math.abs(mix);
      if (magnitude > peak) peak = magnitude;
    }
    this.outPeak = peak;
  }

  /** Peak of the last processed block (metering + tests). */
  get lastPeak(): number {
    return this.outPeak;
  }
}
