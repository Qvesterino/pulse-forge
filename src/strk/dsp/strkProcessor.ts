/**
 * ŠTRK DSP core (ADR 0060) — the snare designer. Four layers: SNAP (click
 * transient), BODY (pitched osc with a fast pitch drop), WIRES (bandpassed
 * noise), SNAPPY (wire coupling to the body envelope).
 *
 * Deterministic: wire noise draws from a per-note LCG seeded at noteOn
 * (pitch + counter) — live and offline identical given the same events
 * (the offline `processorOptions.events` seed). Bounded: 8 voices
 * (oldest-steal), preallocated per-voice state, zero allocation in the
 * render path.
 */

export interface StrkEvent {
  type: "noteOn" | "noteOff" | "panic";
  /** Absolute context time in seconds. */
  when: number;
  pitch?: number;
  velocity?: number;
}

export interface StrkInitOptions {
  sampleRate: number;
  events?: StrkEvent[];
}

const MAX_VOICES = 8;

interface Voice {
  active: boolean;
  /** Envelope: 0 attack (instant), 1 decay, 3 off. One-shots never sustain. */
  stage: 0 | 1 | 3;
  vel: number;
  age: number;
  basePitch: number;
  /** Snap transient samples remaining. */
  snapAge: number;
  /** Body osc phase, pitch-envelope samples remaining, pitch-drop state. */
  bodyPhase: number;
  bodyPitchEnv: number;
  /** Wire noise bandpass state + envelope. */
  wireEnv: number;
  bpX1: number;
  bpX2: number;
  bpY1: number;
  bpY2: number;
  lcg: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export class StrkProcessor {
  private sampleRate: number;
  private params: Record<string, number> = {};
  private events: StrkEvent[] = [];
  private voices: Voice[] = [];
  private voiceCounter = 0;
  private blockEvents: StrkEvent[] = [];
  private outPeak = 0;

  constructor(options: StrkInitOptions) {
    this.sampleRate = options.sampleRate > 0 ? options.sampleRate : 48000;
    for (let i = 0; i < MAX_VOICES; i++) {
      this.voices.push({
        active: false,
        stage: 3,
        vel: 0.8,
        age: 0,
        basePitch: 60,
        snapAge: 0,
        bodyPhase: 0,
        bodyPitchEnv: 0,
        wireEnv: 0,
        bpX1: 0,
        bpX2: 0,
        bpY1: 0,
        bpY2: 0,
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

  postEvent(event: StrkEvent): void {
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
    voice.stage = 0;
    voice.vel = clamp(velocity, 0, 1);
    voice.age = ++this.voiceCounter;
    voice.basePitch = pitch;
    voice.snapAge = 0;
    voice.bodyPhase = 0;
    voice.bodyPitchEnv = 1;
    voice.wireEnv = 0;
    voice.bpX1 = 0;
    voice.bpX2 = 0;
    voice.bpY1 = 0;
    voice.bpY2 = 0;
    voice.lcg = (0x9e3779b9 ^ Math.imul(pitch + 1, 2654435761) ^ Math.imul(this.voiceCounter, 40503)) >>> 0;
  }

  applyEvent(event: StrkEvent): void {
    switch (event.type) {
      case "noteOn":
        this.noteOn(event.pitch ?? 60, event.velocity ?? 0.8);
        break;
      case "noteOff":
        // GATE mode release: the noteOff cuts the decay (per-voice handled
        // through the gate param below — one-shot is the default).
        break;
      case "panic":
        for (const voice of this.voices) {
          voice.active = false;
          voice.stage = 3;
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
    const snapLevel = clamp(this.params.snapLevel ?? 0.5, 0, 1);
    const snapDecaySec = clamp(this.params.snapDecay ?? 0.006, 0.001, 0.05);
    const snapDecaySamples = Math.max(8, snapDecaySec * sr);
    const bodyLevel = clamp(this.params.bodyLevel ?? 0.5, 0, 1);
    const bodyDecaySec = clamp(this.params.bodyDecay ?? 0.12, 0.02, 1.2);
    const bodyTone = clamp(this.params.bodyTone ?? 0, 0, 1);
    const wireLevel = clamp(this.params.wireLevel ?? 0.6, 0, 1);
    const wireTone = clamp(this.params.wireTone ?? 3500, 1500, 8000);
    const wireDecaySec = clamp(this.params.wireDecay ?? 0.18, 0.02, 1.0);
    const snappy = clamp(this.params.snappy ?? 0.6, 0, 1);
    const drive = clamp(this.params.drive ?? 0.2, 0, 1);
    const level = clamp(this.params.level ?? 0.8, 0, 1.5) * 0.7;
    const bodyBaseHz = 190 * Math.pow(2, tune / 12);

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
        let sample = 0;

        // SNAP: a full-amplitude transient with a hard exponential fall.
        if (voice.snapAge >= 0) {
          const t = voice.snapAge / snapDecaySamples;
          if (t < 1) {
            sample += Math.sin((2 * Math.PI * 1400 * voice.snapAge) / sr) * Math.exp(-t * 5) * snapLevel;
            voice.snapAge += 1;
          } else {
            voice.snapAge = -1;
          }
        }

        // BODY: pitched osc with a fast pitch drop (the head's thump).
        if (voice.bodyPitchEnv > 0.001) {
          voice.bodyPhase += (bodyBaseHz * voice.bodyPitchEnv) / sr;
          if (voice.bodyPhase >= 1) voice.bodyPhase -= 1;
          const bodyOsc =
            bodyTone >= 0.5 ? Math.sin(2 * Math.PI * voice.bodyPhase) : (voice.bodyPhase < 0.5 ? 1 : -1) * 0.7;
          sample += bodyOsc * voice.bodyPitchEnv * bodyLevel;
          voice.bodyPitchEnv *= Math.exp(-1 / (bodyDecaySec * sr * 0.12));
        }

        // WIRES: bandpassed noise, excited by the hit and sustained while
        // the body moves — SNAPPY couples the wire envelope to the body env.
        const excite = snappy * voice.bodyPitchEnv;
        if (voice.wireEnv < excite) voice.wireEnv = excite;
        if (voice.wireEnv > 0.001) {
          const draw = this.lcgDraw(voice) * 2 - 1;
          const w = (2 * Math.PI * wireTone) / sr;
          const alpha = Math.sin(w) / 2.2;
          const den = 1 + alpha;
          const b0 = alpha / den;
          const a2 = (1 - alpha) / den;
          const y = b0 * draw + b0 * voice.bpX2 - a2 * voice.bpY2;
          voice.bpX2 = draw;
          voice.bpY2 = y * 0.999; // slight loop damping — the wires settle
          const wireDecay = Math.exp(-1 / (wireDecaySec * sr * 0.3));
          voice.wireEnv *= wireDecay;
          sample += y * 3 * voice.wireEnv * wireLevel;
        } else if (voice.bodyPitchEnv <= 0.001 && voice.snapAge < 0) {
          voice.active = false;
          continue;
        }

        if (drive > 0) sample = Math.tanh(sample * (1 + drive * 3)) / Math.tanh(1 + drive * 3);
        mix += sample * voice.vel * level;
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
