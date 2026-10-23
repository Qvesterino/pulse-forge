/**
 * LADIČ DSP core (ADR 0055) — a 6-operator phase-modulation synthesizer.
 *
 * Six sine operators, each with RATIO/DETUNE/LEVEL + ADSR; eight curated
 * algorithms route modulator outputs into carrier phases (operators are
 * evaluated highest-index-first so modulators are always fresh). Global
 * FEEDBACK applies to the algorithm's feedback operator through a
 * one-sample delay (the DX op feedback). Phase deviation = modulator level
 * × 4π — level 1 is the full bright DX range.
 *
 * Deterministic by construction: no RNG anywhere, so live and offline
 * render identically given the same events (the offline
 * `processorOptions.events` seed — Chromium does not pump worklet message
 * queues during offline renders). Bounded: 12 voices (oldest-steal),
 * per-voice preallocated per-op state, zero allocation in the render path.
 */

export interface LadicEvent {
  type: "noteOn" | "noteOff" | "panic";
  /** Absolute context time in seconds. */
  when: number;
  pitch?: number;
  velocity?: number;
}

export interface LadicInitOptions {
  sampleRate: number;
  /** Events replayed at their absolute times (the offline seed). */
  events?: LadicEvent[];
}

const MAX_VOICES = 12;
/** Phase deviation at modulator level 1 (radians) — the DX index range. */
const INDEX_SCALE = Math.PI * 4;
/** Sine-only operators (ADR 0055 scope line). */
const OPS = 6;

/**
 * Routing tables. `modIn[op]` lists the operators whose OUTPUTS phase-
 * modulate `op`; `carriers` are summed into the voice output. Operators
 * are evaluated 5→0 every sample, so a modulator's output is always its
 * CURRENT sample — no one-block latency inside a chain.
 */
interface LadicAlgorithm {
  modIn: number[][];
  carriers: number[];
}

const ALGORITHMS: LadicAlgorithm[] = [
  // 0: all six carriers, no modulation (additive stack).
  { modIn: [[], [], [], [], [], []], carriers: [0, 1, 2, 3, 4, 5] },
  // 1: three carrier←modulator pairs (the EP workhorse).
  { modIn: [[1], [], [3], [], [5], []], carriers: [0, 2, 4] },
  // 2: 1←(2+3), 4←5, 6 solo carrier.
  { modIn: [[1, 2], [], [], [4], [], []], carriers: [0, 3, 5] },
  // 3: two 3-chains: 0←1←2, 3←4←5.
  { modIn: [[1], [2], [], [4], [5], []], carriers: [0, 3] },
  // 4: the full 6-chain: 0←1←2←3←4←5.
  { modIn: [[1], [2], [3], [4], [5], []], carriers: [0] },
  // 5: one carrier, five modulators.
  { modIn: [[1, 2, 3, 4, 5], [], [], [], [], []], carriers: [0] },
  // 6: TRIO+FB: 0←1, 2←3, 4←5 with feedback expected on op 6.
  { modIn: [[1], [], [3], [], [5], []], carriers: [0, 2, 4] },
  // 7: three carriers; carrier 1 receives ALL three modulators (a denser
  // trio than algorithm 1 — its mods feed only their own carriers).
  { modIn: [[1, 3, 5], [], [3], [], [5], []], carriers: [0, 2, 4] },
];

/** The algorithm's feedback operator: the highest non-carrier, else op 6. */
function feedbackOpOf(algorithm: LadicAlgorithm): number {
  for (let op = OPS - 1; op >= 0; op--) {
    if (!algorithm.carriers.includes(op)) return op;
  }
  return OPS - 1;
}

interface OpState {
  phase: number;
  /** ADSR: 0 attack, 1 decay, 2 sustain, 3 release/off. */
  stage: 0 | 1 | 2 | 3;
  env: number;
  /** One-sample feedback delay (only the feedback op uses it). */
  fbPrev: number;
}

interface Voice {
  active: boolean;
  gate: boolean;
  /** Glide-current and target frequency base (Hz at ratio 1). */
  f0: number;
  targetF0: number;
  basePitch: number;
  vel: number;
  age: number;
  ops: OpState[];
  /** Per-sample operator output scratch (algorithm evaluation order). */
  out: Float32Array;
  /** Output one-pole LP state (TONE). */
  lp: number;
  /** Voice cleanup gain (the CHORÁL pattern). */
  gain: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export class LadicProcessor {
  private sampleRate: number;
  private params: Record<string, number> = {};
  private events: LadicEvent[] = [];
  private voices: Voice[] = [];
  private voiceCounter = 0;
  private blockEvents: LadicEvent[] = [];
  private outPeak = 0;

  constructor(options: LadicInitOptions) {
    this.sampleRate = options.sampleRate > 0 ? options.sampleRate : 48000;
    for (let i = 0; i < MAX_VOICES; i++) {
      this.voices.push({
        active: false,
        gate: false,
        f0: 261.63,
        targetF0: 261.63,
        basePitch: 60,
        vel: 0.8,
        age: 0,
        ops: Array.from({ length: OPS }, () => ({ phase: 0, stage: 3 as 0 | 1 | 2 | 3, env: 0, fbPrev: 0 })),
        out: new Float32Array(OPS),
        lp: 0,
        gain: 0,
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

  postEvent(event: LadicEvent): void {
    if (!Number.isFinite(event.when)) return;
    this.events.push(event);
    for (let i = this.events.length - 1; i > 0 && this.events[i - 1]!.when > event.when; i--) {
      const tmp = this.events[i - 1]!;
      this.events[i - 1] = this.events[i]!;
      this.events[i] = tmp;
    }
  }

  /** Per-operator ratio, detune and level, param-name resolved. */
  private opParam(op: number, suffix: "Ratio" | "Detune" | "Level" | "Atk" | "Dec" | "Sus" | "Rel"): number {
    const fallback: Record<string, number> = {
      Ratio: 1,
      Detune: 0,
      Level: 0,
      Atk: 0.005,
      Dec: 0.4,
      Sus: 0.6,
      Rel: 0.3,
    };
    const value = this.params[`op${op + 1}${suffix}`];
    return Number.isFinite(value) ? (value as number) : fallback[suffix];
  }

  private noteOn(pitch: number, velocity: number): void {
    if (!Number.isFinite(pitch)) return;
    let voice = this.voices.find((candidate) => !candidate.active);
    if (!voice) voice = this.voices.reduce((oldest, c) => (c.age < oldest.age ? c : oldest));
    voice.active = true;
    voice.gate = true;
    voice.basePitch = pitch;
    voice.targetF0 = midiToHz(pitch);
    const glide = clamp(this.params.glide ?? 0, 0, 2);
    voice.f0 = glide > 0.001 ? voice.f0 : voice.targetF0;
    voice.vel = clamp(velocity, 0, 1);
    voice.age = ++this.voiceCounter;
    voice.lp = 0;
    voice.gain = 0;
    for (const op of voice.ops) {
      op.phase = 0;
      op.stage = 0;
      op.env = 0;
      op.fbPrev = 0;
    }
  }

  private noteOff(pitch: number): void {
    for (const voice of this.voices) {
      if (voice.active && voice.gate && voice.basePitch === pitch) voice.gate = false;
    }
  }

  applyEvent(event: LadicEvent): void {
    switch (event.type) {
      case "noteOn":
        this.noteOn(event.pitch ?? 60, event.velocity ?? 0.8);
        break;
      case "noteOff":
        if (Number.isFinite(event.pitch)) this.noteOff(event.pitch as number);
        break;
      case "panic":
        for (const voice of this.voices) {
          voice.active = false;
          voice.gate = false;
          voice.gain = 0;
          for (const op of voice.ops) {
            op.stage = 3;
            op.env = 0;
          }
        }
        break;
    }
  }

  /** One ADSR step for one operator; returns the envelope value. */
  private stepEnv(op: OpState, atk: number, dec: number, sus: number, rel: number, gate: boolean, sr: number): number {
    switch (op.stage) {
      case 0:
        if (atk <= 0.0005) {
          op.env = 1;
          op.stage = 1;
        } else {
          op.env += 1 / (atk * sr);
          if (op.env >= 1) {
            op.env = 1;
            op.stage = 1;
          }
        }
        break;
      case 1:
        // Release interrupts the decay (standard ADSR): without this, a
        // slow-decay operator finished its whole decay-to-sustain curve
        // AFTER noteOff before the release could start (measured — the
        // noteOff test stayed voiced for the decay's full length).
        if (!gate) {
          op.stage = 3;
          break;
        }
        op.env += (sus - op.env) / Math.max(1, dec * sr * 0.25);
        if (op.env <= sus + 0.001 || op.env >= 1) {
          op.env = sus;
          op.stage = 2;
        }
        break;
      case 2:
        if (!gate) op.stage = 3;
        break;
      case 3:
        if (op.env > 0) op.env -= 1 / Math.max(1, rel * sr * 0.35);
        break;
    }
    return clamp(op.env, 0, 1);
  }

  /**
   * Render one block. Events apply at their own sample boundary; every
   * active voice evaluates its operators per sample, highest op first.
   */
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

    const algorithmIndex = Math.round(clamp(this.params.algorithm ?? 1, 0, 7));
    const algorithm = ALGORITHMS[algorithmIndex]!;
    const fbOp = feedbackOpOf(algorithm);
    const feedback = clamp(this.params.feedback ?? 0, 0, 1) * Math.PI;
    const glide = clamp(this.params.glide ?? 0, 0, 2);
    const glideCoeff = glide > 0.001 ? Math.min(1, 1 / (glide * sr * 0.35)) : 1;
    const cutoff = clamp(this.params.cutoff ?? 16000, 500, Math.min(sr * 0.45, 16000));
    const lpCoef = 1 - Math.exp((-2 * Math.PI * cutoff) / sr);
    const level = clamp(this.params.level ?? 0.8, 0, 1.5) * 0.22; // 6 ops × carriers ≈ headroom
    const gainCoeff = Math.min(1, 1 / (0.003 * sr)); // ~3 ms voice cleanup ramp

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

        if (voice.f0 !== voice.targetF0) {
          voice.f0 += (voice.targetF0 - voice.f0) * glideCoeff;
          if (Math.abs(voice.f0 - voice.targetF0) < 0.01) voice.f0 = voice.targetF0;
        }

        // Voice death: gate closed, cleanup ramp finished, every envelope out.
        const anyEnv = voice.ops.some((op) => op.env > 0);
        const gainTarget = voice.gate || anyEnv ? 1 : 0;
        voice.gain += (gainTarget - voice.gain) * gainCoeff;
        if (!voice.gate && voice.gain < 1e-3 && !anyEnv) {
          voice.active = false;
          continue;
        }

        const out = voice.out;
        for (let i = OPS - 1; i >= 0; i--) {
          const opState = voice.ops[i]!;
          const env = this.stepEnv(
            opState,
            this.opParam(i, "Atk"),
            this.opParam(i, "Dec"),
            this.opParam(i, "Sus"),
            this.opParam(i, "Rel"),
            voice.gate,
            sr,
          );
          const opLevel = this.opParam(i, "Level") * env;
          if (opLevel <= 0 && algorithm.modIn[i]!.length === 0) {
            out[i] = 0;
            opState.phase += (voice.f0 * this.opParam(i, "Ratio") * Math.pow(2, this.opParam(i, "Detune") / 1200)) / sr;
            if (opState.phase >= 1) opState.phase -= Math.floor(opState.phase);
            continue;
          }
          let modSum = 0;
          for (const modulator of algorithm.modIn[i]!) modSum += out[modulator]!;
          let phase = opState.phase + modSum * INDEX_SCALE;
          if (i === fbOp && feedback > 0) phase += opState.fbPrev * feedback;
          const value = Math.sin(2 * Math.PI * phase);
          if (i === fbOp) opState.fbPrev = value;
          out[i] = value * opLevel;
          opState.phase += (voice.f0 * this.opParam(i, "Ratio") * Math.pow(2, this.opParam(i, "Detune") / 1200)) / sr;
          if (opState.phase >= 1) opState.phase -= Math.floor(opState.phase);
        }

        let voiceSample = 0;
        for (const carrier of algorithm.carriers) voiceSample += out[carrier]!;
        // TONE: one-pole LP at cutoff (OPEN = 16 kHz ≈ transparent).
        voice.lp += lpCoef * (voiceSample - voice.lp);
        mix += voice.lp * voice.gain * voice.vel;
      }

      left[frame] = mix * level;
      right[frame] = mix * level;
      const magnitude = Math.abs(left[frame]!);
      if (magnitude > peak) peak = magnitude;
    }
    this.outPeak = peak;
  }

  /** Peak of the last processed block (metering + tests). */
  get lastPeak(): number {
    return this.outPeak;
  }
}
