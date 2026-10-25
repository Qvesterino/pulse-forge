/**
 * DYMKA DSP core (ADR 0062) — the breath-driven wind instrument.
 *
 * The DRIVER is a per-note breath value (0..1): it sets the amplitude,
 * the brightness (a one-pole LP on the source — more pressure = brighter,
 * like a real reed), the reed-noise level (bandpassed LCG turbulence) and
 * a slight pitch lift (the overblow lean above 0.5 breath). MPE pressure
 * IS the breath — a live `breath` event updates running voices in place
 * (no re-attack); MPE timbre is a live vibrato-depth override (the jaw).
 *
 * LEGATO: with the toggle on, a new note while one sounds GLIDES the same
 * voice to the new pitch (the acid/808 slide precedent) instead of
 * re-attacking — monophonic lead behavior.
 *
 * Deterministic: the reed noise draws from a per-note LCG seeded at
 * noteOn — live and offline render identically given the same events (the
 * `processorOptions.events` seed). Bounded: 6 voices, oldest-steal,
 * preallocated per-voice state, zero allocation in the render path.
 */

export interface DymkaEvent {
  type: "noteOn" | "noteOff" | "panic" | "breath" | "jaw";
  /** Absolute context time in seconds. */
  when: number;
  pitch?: number;
  velocity?: number;
  /** Live override 0..1 (breath: the driver; jaw: vibrato depth scale). */
  value?: number;
}

export interface DymkaInitOptions {
  sampleRate: number;
  events?: DymkaEvent[];
}

const MAX_VOICES = 6;

interface Voice {
  active: boolean;
  gate: boolean;
  basePitch: number;
  vel: number;
  age: number;
  /** Glide-current and target frequency base (Hz). */
  f0: number;
  targetF0: number;
  /** Source phase and vibrato phase. */
  phase: number;
  vibPhase: number;
  /** Envelope: 0 attack, 1 sustain, 2 release, 3 off. */
  stage: 0 | 1 | 2 | 3;
  env: number;
  gain: number;
  /** The live breath value (the driver). */
  breath: number;
  /** Live vibrato-depth scale (−1 = use the param). */
  jaw: number;
  /** Brightness LP state + reed-noise bandpass state + reed LP. */
  lpState: number;
  reedX1: number;
  reedX2: number;
  reedY1: number;
  reedY2: number;
  /** Formant biquads × [x1, x2, y1, y2] and coefficients. */
  fState: Float32Array;
  fCoef: Float32Array;
  lcg: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** RBJ peaking biquad coefficients. */
function peakCoeffs(out: Float32Array, slot: number, freq: number, q: number, gainDb: number, sr: number): void {
  const A = Math.pow(10, gainDb / 40);
  const w = (2 * Math.PI * clamp(freq, 40, sr * 0.45)) / sr;
  const cw = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha / A;
  out[slot] = (1 + alpha * A) / a0;
  out[slot + 1] = (-2 * cw) / a0;
  out[slot + 2] = (1 - alpha * A) / a0;
  out[slot + 3] = (-2 * cw) / a0;
  out[slot + 4] = (1 - alpha / A) / a0;
}

export class DymkaProcessor {
  private sampleRate: number;
  private params: Record<string, number> = {};
  private events: DymkaEvent[] = [];
  private voices: Voice[] = [];
  private voiceCounter = 0;
  private blockEvents: DymkaEvent[] = [];
  private outPeak = 0;

  constructor(options: DymkaInitOptions) {
    this.sampleRate = options.sampleRate > 0 ? options.sampleRate : 48000;
    for (let i = 0; i < MAX_VOICES; i++) {
      this.voices.push({
        active: false,
        gate: false,
        basePitch: 60,
        vel: 0.8,
        age: 0,
        f0: 261.63,
        targetF0: 261.63,
        phase: 0,
        vibPhase: 0,
        stage: 3,
        env: 0,
        gain: 0,
        breath: 0.7,
        jaw: -1,
        lpState: 0,
        reedX1: 0,
        reedX2: 0,
        reedY1: 0,
        reedY2: 0,
        fState: new Float32Array(8),
        fCoef: new Float32Array(10),
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

  postEvent(event: DymkaEvent): void {
    if (!Number.isFinite(event.when)) return;
    this.events.push(event);
    for (let i = this.events.length - 1; i > 0 && this.events[i - 1]!.when > event.when; i--) {
      const tmp = this.events[i - 1]!;
      this.events[i - 1] = this.events[i]!;
      this.events[i] = tmp;
    }
  }

  private computeFormants(voice: Voice): void {
    const scale = clamp(this.params.bodyTone ?? 1, 0.5, 2);
    const f1 = (this.params.formant1 ?? 700) * scale;
    const f2 = (this.params.formant2 ?? 1800) * scale;
    peakCoeffs(voice.fCoef, 0, f1, 3.5, 6, this.sampleRate);
    peakCoeffs(voice.fCoef, 5, f2, 4.5, 4, this.sampleRate);
  }

  private noteOn(pitch: number, velocity: number): void {
    if (!Number.isFinite(pitch)) return;
    // LEGATO: a sounding voice glides instead of re-attacking (the
    // monophonic lead behavior — the acid/808 slide precedent).
    const legato = (this.params.legato ?? 0) >= 0.5;
    if (legato) {
      const sounding = this.voices.find((v) => v.active && v.gate);
      if (sounding) {
        sounding.targetF0 = midiToHz(pitch);
        sounding.basePitch = pitch;
        sounding.vel = clamp(velocity, 0, 1);
        return;
      }
    }
    let voice = this.voices.find((candidate) => !candidate.active);
    if (!voice) voice = this.voices.reduce((oldest, c) => (c.age < oldest.age ? c : oldest));
    voice.active = true;
    voice.gate = true;
    voice.basePitch = pitch;
    voice.targetF0 = midiToHz(pitch);
    voice.f0 = voice.targetF0;
    voice.vel = clamp(velocity, 0, 1);
    voice.age = ++this.voiceCounter;
    voice.stage = 0;
    voice.env = 0;
    voice.gain = 0;
    voice.phase = 0;
    voice.vibPhase = 0;
    voice.breath = clamp((this.params.breath ?? 0.7) * voice.vel, 0, 1);
    voice.jaw = -1;
    voice.lpState = 0;
    voice.reedX1 = 0;
    voice.reedX2 = 0;
    voice.reedY1 = 0;
    voice.reedY2 = 0;
    voice.lcg = (0x9e3779b9 ^ Math.imul(pitch + 1, 2654435761) ^ Math.imul(this.voiceCounter, 40503)) >>> 0;
    this.computeFormants(voice);
  }

  private noteOff(pitch: number): void {
    for (const voice of this.voices) {
      if (voice.active && voice.gate && voice.basePitch === pitch) {
        voice.gate = false;
        if (voice.stage === 0 || voice.stage === 1) voice.stage = 2;
      }
    }
  }

  applyEvent(event: DymkaEvent): void {
    switch (event.type) {
      case "noteOn":
        this.noteOn(event.pitch ?? 60, event.velocity ?? 0.8);
        break;
      case "noteOff":
        if (Number.isFinite(event.pitch)) this.noteOff(event.pitch as number);
        break;
      case "breath": {
        // MPE pressure IS the breath: amplitude + brightness + reed noise
        // + pitch lift all follow, LIVE, on the running voice.
        const value = Number.isFinite(event.value) ? clamp(event.value as number, 0, 1) : null;
        if (value === null) break;
        for (const voice of this.voices) {
          if (voice.active && voice.gate) voice.breath = value;
        }
        break;
      }
      case "jaw": {
        // MPE timbre → vibrato depth scale (the jaw).
        const value = Number.isFinite(event.value) ? clamp(event.value as number, 0, 1) : null;
        if (value === null) break;
        for (const voice of this.voices) {
          if (voice.active && voice.gate) voice.jaw = value;
        }
        break;
      }
      case "panic":
        for (const voice of this.voices) {
          voice.active = false;
          voice.gate = false;
          voice.stage = 3;
          voice.env = 0;
          voice.gain = 0;
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

    const wave = Math.round(clamp(this.params.wave ?? 0, 0, 1));
    const attack = clamp(this.params.attack ?? 0.04, 0.005, 1.5);
    const release = clamp(this.params.release ?? 0.2, 0.03, 3);
    const level = clamp(this.params.level ?? 0.8, 0, 1.5) * 0.7;
    const brightBase = clamp(this.params.brightBase ?? 0.45, 0.1, 1);
    const reedLevel = clamp(this.params.reedLevel ?? 0.35, 0, 1);
    const reedTone = clamp(this.params.reedTone ?? 2800, 1000, 6000);
    const pitchLift = clamp(this.params.pitchLift ?? 12, 0, 50);
    const vibRate = clamp(this.params.vibRate ?? 5, 0.5, 8);
    const vibDepth = clamp(this.params.vibDepth ?? 12, 0, 50);
    const legato = (this.params.legato ?? 0) >= 0.5;
    const glideCoeff = legato ? Math.min(1, 1 / (0.05 * sr)) : 1;

    // Reed-noise bandpass coefficients (RBJ bandpass, constant peak).
    const rw = (2 * Math.PI * reedTone) / sr;
    const ralpha = Math.sin(rw) / (2 * 2.5);
    const rden = 1 + ralpha;
    const rb0 = ralpha / rden;
    const ra2 = (1 - ralpha) / rden;

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

        // Envelope.
        if (voice.stage === 0) {
          voice.env += 1 / (attack * sr);
          if (voice.env >= 1) {
            voice.env = 1;
            voice.stage = 1;
          }
        } else if (voice.stage === 2) {
          voice.env -= 1 / (release * sr);
          if (voice.env <= 0) {
            voice.env = 0;
            voice.stage = 3;
            voice.active = false;
            continue;
          }
        }
        const gainTarget = voice.gate || voice.stage !== 2 ? 1 : 0;
        voice.gain += (gainTarget - voice.gain) * Math.min(1, 1 / (0.004 * sr));
        if (!voice.gate && voice.gain < 1e-3 && voice.env <= 0.001) {
          voice.active = false;
          continue;
        }

        // Glide (legato).
        if (voice.f0 !== voice.targetF0) {
          voice.f0 += (voice.targetF0 - voice.f0) * glideCoeff;
          if (Math.abs(voice.f0 - voice.targetF0) < 0.01) voice.f0 = voice.targetF0;
        }

        // Vibrato (jaw-scaled live).
        voice.vibPhase += vibRate / sr;
        if (voice.vibPhase >= 1) voice.vibPhase -= 1;
        const depthScale = voice.jaw >= 0 ? voice.jaw : 1;
        const vibCents = Math.sin(2 * Math.PI * voice.vibPhase) * vibDepth * depthScale;

        // Pitch lift: the overblow lean above half breath.
        const liftCents = Math.max(0, voice.breath - 0.5) * 2 * pitchLift;
        const f0 = voice.f0 * Math.pow(2, (vibCents + liftCents) / 1200);

        // Source oscillator (saw = reed/brass column; square = clarinet).
        voice.phase += f0 / sr;
        if (voice.phase >= 1) voice.phase -= 1;
        const osc = wave === 1 ? (voice.phase < 0.5 ? 1 : -1) * 0.8 : voice.phase * 2 - 1;

        // Reed noise: bandpassed LCG turbulence, following the breath
        // (offset + proportional — quiet playing still has some hiss).
        const noise = (this.lcgDraw(voice) * 2 - 1) * (0.1 + 0.9 * voice.breath) * reedLevel;
        const ny =
          rb0 * noise + rb0 * voice.reedX2 - ra2 * voice.reedY2;
        voice.reedX2 = voice.reedX1;
        voice.reedX1 = noise;
        voice.reedY2 = voice.reedY1;
        voice.reedY1 = ny;

        const source = osc + ny * 0.6;

        // Brightness: the breath opens the LP (a real reed brightens under
        // pressure) — brightBase at zero breath, near-open at full.
        const brightCoef = 0.03 + (brightBase * 0.35 + voice.breath * 0.55) * 0.9;
        voice.lpState += Math.min(0.9, brightCoef) * (source - voice.lpState);
        let sample = voice.lpState;

        // Bore formants (2 peaking biquads in series).
        const st = voice.fState;
        const cf = voice.fCoef;
        for (let b = 0; b < 2; b++) {
          const c = b * 5;
          const s = b * 4;
          const y =
            cf[c]! * sample + cf[c + 1]! * st[s]! + cf[c + 2]! * st[s + 1]! - cf[c + 3]! * st[s + 2]! - cf[c + 4]! * st[s + 3]!;
          st[s + 1] = st[s]!;
          st[s] = sample;
          st[s + 3] = st[s + 2]!;
          st[s + 2] = y;
          sample = y;
        }

        // Amplitude: env × gain × the breath driver (the breath IS the
        // loudness — velocity only seeded it). The soft knee bounds the
        // serial formant pair's resonance peaks (measured: a dense stack at
        // F2 = 3.5 kHz peaked at 7.4× before this).
        let voiceOut = sample * voice.env * voice.gain * voice.breath * voice.vel * level;
        if (voiceOut > 0.85 || voiceOut < -0.85) {
          const sign = voiceOut < 0 ? -1 : 1;
          voiceOut = sign * (0.85 + Math.tanh(Math.abs(voiceOut) - 0.85) * 0.15);
        }
        mix += voiceOut;
      }

      // Bus bound: N voices × a knee-limited voice can still sum past 1 —
      // tanh the bus (transparent under ~0.7 where normal playing sits).
      const bus = Math.tanh(mix);
      left[frame] = bus;
      right[frame] = bus;
      const magnitude = Math.abs(bus);
      if (magnitude > peak) peak = magnitude;
    }
    this.outPeak = peak;
  }

  /** Peak of the last processed block (metering + tests). */
  get lastPeak(): number {
    return this.outPeak;
  }
}
