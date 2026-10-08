/**
 * TSAR DSP CORE — the per-sample hybrid voice engine (docs/TSAR-ROADMAP.md, T1).
 *
 * Typed and pure: no AudioWorklet globals, no AudioContext, no clock reads.
 * The worklet wrapper (`src/tsar-worklet.entry.js`) owns the port and the
 * `currentFrame` plumbing; this class owns the SOUND. That split is what makes
 * every rule below directly testable in vitest (the morph-dynamics pattern)
 * and keeps live and offline on ONE code path.
 *
 * Architecture:
 *  - VOICES: 16 max, oldest-steal. Each voice: Source A + Source B + Sub +
 *    Noise. A source runs SAMPLE (one-shot/looped PCM), WAVETABLE (mipmapped
 *    frames with morph) or GRANULAR (scanned window over PCM).
 *  - ENVELOPES: one ADSR per source (seconds, sustain 0..1). The A envelope
 *    is also the mod matrix's ENV source.
 *  - FILTER: one 2-pole SVF per source per voice (lp/hp/bp/notch) with
 *    cutoff, Q and a bipolar filter-envelope amount in octaves.
 *  - MOD MATRIX: 4 slots, sources ENV/LFO/VEL/PRESS, destinations A MORPH,
 *    A CUTOFF, B MORPH, B CUTOFF, MORPH, AMP, PAN. Per-voice LFO phase is
 *    decorrelated from the voice counter. Amounts bipolar -1..1.
 *  - OUTPUT: morph A↔B balance, tone tilt, tanh drive, stereo width.
 *
 * EVENT MODEL (the offline-parity contract):
 *  - every timed message (noteOn/noteOff/param/pressure/panic/BPM) enters ONE
 *    queue with an absolute time in context seconds;
 *  - `process()` applies each event at its own sample boundary — live the
 *    events arrive ahead of time via port, offline the whole list is seeded
 *    via `processorOptions.events`; the interpreter is THE SAME function.
 *
 * Determinism: no Math.random. Noise is a seeded LCG advanced per sample;
 * LFO phases derive from the voice index. Same events -> same samples.
 */

import { syncedLfoHz } from "../../effects/tempo-sync";

const MAX_VOICES = 16;
const UNISON_MAX = 8;
/** Wavetable frame size (two periods at the lowest tracked f0). */
const FRAME_SIZE = 2048;
/** Fallback table: a 1-harmonic sine, used when a slot has no uploaded table
 *  but its engine is WAVETABLE. Without it a table-less wavetable slot renders
 *  DIGITAL SILENCE (measured: a processorOptions-only offline render produced
 *  peak 0 until the seed fix + this fallback landed). */
const FALLBACK_TABLE = (() => {
  const frame = new Float32Array(FRAME_SIZE);
  for (let i = 0; i < FRAME_SIZE; i++) frame[i] = Math.sin((2 * Math.PI * i) / FRAME_SIZE) * 0.5;
  return frame;
})();
/** Golden-ratio phase spread for decorrelated per-voice LFOs. */
const GOLDEN = 0.6180339887498949;
const DRIFT_GOLDEN = 0.7548776662466927;
/** One-pole smoothing coefficient for click-free voice gain (≈2 ms @ 44.1k). */
const GAIN_RAMP_SEC = 0.002;

export type TsarEngine = 0 | 1 | 2; // sample | wavetable | granular

export interface TsarEvent {
  type: "noteOn" | "noteOff" | "param" | "pressure" | "panic" | "bpm";
  /** Absolute context time in seconds. */
  when: number;
  pitch?: number;
  velocity?: number;
  name?: string;
  value?: number;
}

interface SourceData {
  /** Wavetable frames flattened (frameCount × FRAME_SIZE), or null. */
  table: Float32Array | null;
  frameCount: number;
  /** Sample/granular PCM, or null. */
  pcm: Float32Array | null;
  /** Frequency the PCM was recorded at (pitch reference). */
  pcmRootHz: number;
}

interface Adsr {
  stage: 0 | 1 | 2 | 3; // off | attack | decay | release
  value: number;
}

interface Voice {
  index: number;
  active: boolean;
  gate: boolean;
  pitch: number;
  /** Current (glided) and target frequency. */
  f0: number;
  targetF0: number;
  vel: number;
  pressure: number;
  age: number;
  /** Unison read positions, normalized 0..1 per source copy. */
  posA: Float32Array;
  posB: Float32Array;
  subPhase: number;
  lfoPhase: number;
  driftPhase: number;
  envA: Adsr;
  envB: Adsr;
  /** SVF integrators per source. */
  svfA1: number;
  svfA2: number;
  svfB1: number;
  svfB2: number;
  /** Smoothed voice gain (click-free). */
  gain: number;
}

export interface TsarInitOptions {
  sampleRate: number;
  bpm?: number;
  /** Pre-seeded events (offline): applied at their absolute times. */
  events?: TsarEvent[];
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function midiToHz(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

/** Linear-interpolated PCM read; clamps at the end (one-shot semantics). */
function readClamped(pcm: Float32Array, posSamples: number): number {
  const max = pcm.length - 1;
  if (max <= 0) return 0;
  const p = clamp(posSamples, 0, max);
  const i0 = Math.floor(p);
  const frac = p - i0;
  const a = pcm[i0]!;
  const b = pcm[Math.min(max, i0 + 1)]!;
  return a + (b - a) * frac;
}

/** Linear-interpolated PCM read with wrap (looped semantics). */
function readWrapped(pcm: Float32Array, posSamples: number): number {
  const length = pcm.length;
  if (length <= 0) return 0;
  let p = posSamples % length;
  if (p < 0) p += length;
  const i0 = Math.floor(p);
  const frac = p - i0;
  const a = pcm[i0]!;
  const b = pcm[(i0 + 1) % length]!;
  return a + (b - a) * frac;
}

export class TsarProcessor {
  private params: Record<string, number> = {};
  private readonly sampleRate: number;
  private readonly voices: Voice[] = [];
  private voiceCounter = 0;
  private events: TsarEvent[] = [];
  private readonly sources: [SourceData, SourceData] = [
    { table: null, frameCount: 0, pcm: null, pcmRootHz: 261.63 },
    { table: null, frameCount: 0, pcm: null, pcmRootHz: 261.63 },
  ];
  private noiseState = 22222;
  private outPeak = 0;
  /** Preallocated per-block event scratch (no allocation in the render path). */
  private blockEvents: TsarEvent[] = [];
  /** Smoothed polyphony divisor (1 → one voice, N → N voices). */
  private polyGain = 1;

  // ── Arpeggiator (T6) ────────────────────────────────────────────────────
  /** Held notes in press order (the order mode is the press order). */
  private arpHeld: number[] = [];
  /** Arp step phase in normalized [0,1); advanced once per step. */
  private arpPhase = 0;
  /** Current arp step index (walked through the note pool). */
  private arpStep = 0;
  /** Arp gate counter (0..1): a note sounds while it is below the gate. */
  private arpGatePhase = 0;
  /** Arp clock seed for the RANDOM mode (deterministic LCG). */
  private arpSeed = 1234567;
  /** Notes currently owned by the arp (released when the arp stops them). */
  private arpSounding = new Set<number>();

  constructor(options: TsarInitOptions) {
    this.sampleRate = options.sampleRate > 0 ? options.sampleRate : 48000;
    if (options.bpm !== undefined) this.setBpm(options.bpm);
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(this.makeVoice(i));
    if (options.events) for (const event of options.events) this.postEvent(event);
  }

  private makeVoice(index: number): Voice {
    return {
      index,
      active: false,
      gate: false,
      pitch: 60,
      f0: 261.63,
      targetF0: 261.63,
      vel: 0,
      pressure: 0,
      age: 0,
      posA: new Float32Array(UNISON_MAX),
      posB: new Float32Array(UNISON_MAX),
      subPhase: 0,
      lfoPhase: (index * GOLDEN) % 1,
      driftPhase: (index * DRIFT_GOLDEN) % 1,
      envA: { stage: 0, value: 0 },
      envB: { stage: 0, value: 0 },
      svfA1: 0,
      svfA2: 0,
      svfB1: 0,
      svfB2: 0,
      gain: 0,
    };
  }

  /** Set many params at once (defaults + document overrides). */
  applyParams(values: Record<string, number>): void {
    for (const [key, value] of Object.entries(values)) {
      if (Number.isFinite(value)) this.params[key] = value;
    }
  }

  setParam(name: string, value: number): void {
    if (Number.isFinite(value)) this.params[name] = value;
  }

  /** Upload a wavetable for one slot (frames flattened, each FRAME_SIZE). */
  setWavetable(slot: 0 | 1, flatFrames: Float32Array, frameCount: number): void {
    this.sources[slot].table = flatFrames;
    this.sources[slot].frameCount = Math.max(1, frameCount);
  }

  /** Upload sample PCM for one slot. */
  setSample(slot: 0 | 1, pcm: Float32Array, rootHz: number): void {
    this.sources[slot].pcm = pcm;
    this.sources[slot].pcmRootHz = rootHz > 0 ? rootHz : 261.63;
  }

  /** Remove a user sample and restore the built-in wavetable fallback. */
  clearSource(slot: 0 | 1): void {
    this.sources[slot].table = null;
    this.sources[slot].frameCount = 0;
    this.sources[slot].pcm = null;
    this.sources[slot].pcmRootHz = 261.63;
  }

  /** Tempo for the arp clock and tempo-synced LFO. */
  private bpm = 120;

  /** Tempo update from the engine (arp step length derives from it). */
  setBpm(bpm: number): void {
    if (Number.isFinite(bpm) && bpm > 0) this.bpm = clamp(bpm, 20, 300);
  }

  /** True when a slot has anything to read (silence honesty in tests/UI). */
  hasSource(slot: 0 | 1): boolean {
    const source = this.sources[slot];
    const prefix = slot === 0 ? "srcA" : "srcB";
    const usesBuiltInWavetable = Math.round(this.params[`${prefix}Engine`] ?? (slot === 0 ? 1 : 0)) === 1;
    return (source.table !== null && source.frameCount > 0) || source.pcm !== null || usesBuiltInWavetable;
  }

  /** Post a timed event (port message or constructor seed — same contract). */
  postEvent(event: TsarEvent): void {
    if (!Number.isFinite(event.when)) return;
    this.events.push(event);
    for (let i = this.events.length - 1; i > 0 && this.events[i - 1]!.when > event.when; i--) {
      const tmp = this.events[i - 1]!;
      this.events[i - 1] = this.events[i]!;
      this.events[i] = tmp;
    }
  }

  private applyEvent(event: TsarEvent): void {
    switch (event.type) {
      case "noteOn":
        if ((this.params.arpOn ?? 0) >= 0.5) {
          this.arpPress(event.pitch ?? 60, event.velocity ?? 0.8, this.arpVelocity);
        } else {
          this.noteOn(event.pitch ?? 60, event.velocity ?? 0.8);
        }
        break;
      case "noteOff":
        if ((this.params.arpOn ?? 0) >= 0.5) {
          this.arpRelease(event.pitch ?? 60);
        } else {
          this.noteOff(event.pitch ?? 60);
        }
        break;
      case "pressure":
        this.pressure(event.pitch ?? 60, event.value ?? 0);
        break;
      case "param":
        if (event.name) this.setParam(event.name, event.value ?? 0);
        break;
      case "panic":
        this.arpHeld.length = 0;
        this.arpSounding.clear();
        for (const voice of this.voices) {
          voice.active = false;
          voice.gate = false;
          voice.gain = 0;
        }
        break;
      case "bpm":
        this.setBpm(event.value ?? this.bpm);
        break;
    }
  }

  /** Velocity captured at arp press time (the pool carries it). */
  private arpVelocity = 0.8;

  /** Press a key while the arp is on: the note joins the held pool. */
  private arpPress(pitch: number, velocity: number, _captured: number): void {
    void _captured;
    if (!this.arpHeld.includes(pitch)) this.arpHeld.push(pitch);
    this.arpVelocity = velocity;
    // First press: fire a step IMMEDIATELY (a producer expects the arp to
    // start on the key press, not up to a step later). Subsequent notes join
    // the running pattern without restarting it.
    if (this.arpHeld.length === 1 && this.arpSounding.size === 0) {
      this.arpPhase = 1; // force the step on the next sample
      this.arpStep = 0;
    }
  }

  /** Release a key: the note leaves the pool (the arp keeps the rest). */
  private arpRelease(pitch: number): void {
    const index = this.arpHeld.indexOf(pitch);
    if (index >= 0) this.arpHeld.splice(index, 1);
  }

  /**
   * Next arp pitch for the current step. Deterministic: RANDOM uses a seeded
   * LCG advanced per step, so the same event stream yields the same melody.
   */
  private arpNextPitch(): number {
    const mode = Math.round(this.params.arpMode ?? 0);
    const octaves = clamp(Math.round(this.params.arpOctaves ?? 1), 1, 4);
    const pool = this.arpHeld;
    if (pool.length === 0) return 0;
    const stepCount = pool.length * octaves;
    const index = ((this.arpStep % stepCount) + stepCount) % stepCount;
    const octave = Math.floor(index / pool.length);
    let noteIndex = index % pool.length;
    switch (mode) {
      case 1: // DOWN
        noteIndex = pool.length - 1 - noteIndex;
        break;
      case 2: {
        // UPDN: up then down without repeating the turnarounds.
        const cycle = stepCount * 2 - 2;
        const position = stepCount <= 1 ? 0 : ((this.arpStep % cycle) + cycle) % cycle;
        noteIndex = position < stepCount ? position % pool.length : (cycle - position) % pool.length;
        return (
          pool[noteIndex]! +
          12 *
            (position < stepCount ? Math.floor(position / pool.length) : Math.floor((cycle - position) / pool.length))
        );
      }
      case 3: // ORDER (press order)
        return pool[index % pool.length]! + 12 * octave;
      case 4: {
        // RANDOM: seeded LCG over the pool.
        this.arpSeed = (this.arpSeed * 1664525 + 1013904223) >>> 0;
        const pick = this.arpSeed % pool.length;
        return pool[pick]! + 12 * octave;
      }
      default: // UP
        break;
    }
    return pool[noteIndex]! + 12 * octave;
  }

  private noteOn(pitch: number, velocity: number): void {
    let voice = this.voices.find((candidate) => !candidate.active);
    if (!voice) {
      voice = this.voices.reduce((oldest, candidate) => (candidate.age > oldest.age ? candidate : oldest));
    }
    voice.active = true;
    voice.gate = true;
    voice.pitch = pitch;
    voice.targetF0 = midiToHz(pitch);
    // Glide: start from the previous pitch if a glide is configured.
    const glide = this.params.glide ?? 0;
    voice.f0 = glide > 0 ? voice.f0 : voice.targetF0;
    voice.vel = clamp(velocity, 0, 1);
    voice.pressure = 0;
    voice.age = ++this.voiceCounter;
    voice.envA = { stage: 1, value: 0 };
    voice.envB = { stage: 1, value: 0 };
    voice.gain = 0;
    voice.svfA1 = 0;
    voice.svfA2 = 0;
    voice.svfB1 = 0;
    voice.svfB2 = 0;
    voice.lfoPhase = (voice.index * GOLDEN) % 1;
    for (let u = 0; u < UNISON_MAX; u++) {
      voice.posA[u] = ((voice.index * GOLDEN + u * 0.137) % 1) * 0;
      voice.posB[u] = ((voice.index * GOLDEN + 0.5 + u * 0.137) % 1) * 0;
    }
    voice.subPhase = 0;
  }

  private noteOff(pitch: number): void {
    for (const voice of this.voices) {
      if (voice.active && voice.pitch === pitch && voice.gate) {
        voice.gate = false;
        voice.envA.stage = 3;
        voice.envB.stage = 3;
      }
    }
  }

  private pressure(pitch: number, value: number): void {
    for (const voice of this.voices) {
      if (voice.active && voice.pitch === pitch) voice.pressure = clamp(value, 0, 1);
    }
  }

  /** One ADSR sample step (times in seconds). */
  private stepAdsr(env: Adsr, attack: number, decay: number, sustain: number, release: number): number {
    const sr = this.sampleRate;
    switch (env.stage) {
      case 1: {
        env.value += attack > 0 ? 1 / (attack * sr) : 1;
        if (env.value >= 1) {
          env.value = 1;
          env.stage = 2;
        }
        break;
      }
      case 2: {
        const coeff = decay > 0 ? Math.min(1, 1 / (decay * sr * 0.35)) : 1;
        env.value += (sustain - env.value) * coeff;
        if (Math.abs(env.value - sustain) < 1e-4) env.value = sustain;
        break;
      }
      case 3: {
        const coeff = release > 0 ? Math.min(1, 1 / (release * sr * 0.35)) : 1;
        env.value -= env.value * coeff;
        if (env.value <= 1e-4) {
          env.value = 0;
          env.stage = 0;
        }
        break;
      }
      default:
        env.value = 0;
    }
    return env.value;
  }

  private lfoValue(shape: number, phase: number): number {
    switch (shape) {
      case 1:
        return 1 - Math.abs(2 * phase - 1); // triangle
      case 2:
        return phase; // saw
      case 3:
        return phase < 0.5 ? 1 : 0; // square
      default:
        return 0.5 + 0.5 * Math.sin(2 * Math.PI * phase);
    }
  }

  /**
   * Chamberlin semi-implicit SVF, ported from the repo's proven
   * `svfilter-processor.js`:
   *   hp = in − lp − q·bp;  bp += f·hp;  lp += f·bp
   * with the same stability guard — the recursion diverges when f·q exceeds
   * (4 − f²)/2, which happens at HIGH cutoff with LOW resonance. Scaling q
   * into the stable region is the fix the worklet already verified; without
   * it a wide-open cutoff turns into a limit cycle instead of passing the
   * signal through (measured during T1: cutoff 18000 kHz at q 0.8 was
   * unstable — the earlier "formant" SVF form normalized by
   * (1 + q·f + f²) instead and barely filtered at all).
   */
  private runSvf(
    input: number,
    type: number,
    cutoffHz: number,
    qParam: number,
    state: { s1: number; s2: number },
  ): number {
    // qParam is 0.3..12 in the UI; the recursion wants damping 2..0
    // (resonance normalized). Map qParam → damping the way the worklet maps
    // its own res: damping = 2 − 2·res, and res = normalized q.
    const res = clamp((qParam - 0.3) / 11.7, 0, 1);
    const f = 2 * Math.sin((Math.PI * clamp(cutoffHz, 20, this.sampleRate * 0.24)) / this.sampleRate);
    let q = 2 - 2 * res;
    const fqMax = (4 - f * f) * 0.49;
    if (f * q > fqMax) q = fqMax / f;
    const hp = input - state.s2 - q * state.s1;
    state.s1 += f * hp; // bp
    state.s2 += f * state.s1; // lp
    if (state.s1 > 8) state.s1 = 8;
    else if (state.s1 < -8) state.s1 = -8;
    if (state.s2 > 8) state.s2 = 8;
    else if (state.s2 < -8) state.s2 = -8;
    switch (type) {
      case 1:
        return hp;
      case 2:
        return state.s1;
      case 3:
        return input - state.s2 - q * state.s1;
      default:
        return state.s2;
    }
  }

  /** Wavetable read: frame morph (linear blend), linear within a frame. */
  private readWavetable(data: SourceData, phase: number, morph: number): number {
    const table = data.table ?? FALLBACK_TABLE;
    const frameCount = Math.max(1, data.frameCount || 1);
    const frameFloat = clamp(morph, 0, 1) * Math.max(0, frameCount - 1);
    const f0 = Math.floor(frameFloat);
    const f1 = Math.min(frameCount - 1, f0 + 1);
    const fFrac = frameFloat - f0;
    const scaled = phase * FRAME_SIZE;
    const i0 = Math.floor(scaled) % FRAME_SIZE;
    const tFrac = scaled - Math.floor(scaled);
    const i1 = (i0 + 1) % FRAME_SIZE;
    const a = table[f0 * FRAME_SIZE + i0]! * (1 - tFrac) + table[f0 * FRAME_SIZE + i1]! * tFrac;
    const b = table[f1 * FRAME_SIZE + i0]! * (1 - tFrac) + table[f1 * FRAME_SIZE + i1]! * tFrac;
    return a + (b - a) * fFrac;
  }

  /**
   * One source's raw sample for one voice. Reads the slot's selected engine;
   * advances the per-copy positions. Envelope/filter/mix happen in the caller.
   *
   * Position units: SAMPLE engine and GRANULAR keep normalized 0..1 positions
   * scaled to the PCM length on read; WAVETABLE keeps a normalized phase.
   * `pos*` arrays are shared for whichever engine is active on the slot.
   */
  private sourceSample(
    voice: Voice,
    slot: 0 | 1,
    engine: TsarEngine,
    morph: number,
    scan: number,
    detuneCents: number,
    baseHz: number,
  ): number {
    const data = this.sources[slot];
    const prefix = slot === 0 ? "srcA" : "srcB";
    const unison = clamp(Math.round(this.params[`${prefix}Unison`] ?? 1), 1, UNISON_MAX);
    const spread = this.params[`${prefix}Spread`] ?? 0;
    const positions = slot === 0 ? voice.posA : voice.posB;

    let sum = 0;
    for (let u = 0; u < unison; u++) {
      const spreadOffset = unison === 1 ? 0 : ((u / (unison - 1)) * 2 - 1) * spread;
      const f = baseHz * Math.pow(2, (detuneCents + spreadOffset) / 1200);
      let pos = positions[u]!;
      if (engine === 2) {
        // GRANULAR: normalized scan position sweeping slowly; raised-cosine
        // window makes the loop seam click-free. A texture, not a pitch.
        pos += scan / this.sampleRate;
        if (pos >= 1) pos -= 1;
        if (data.pcm) {
          const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * pos);
          sum += readWrapped(data.pcm, pos * (data.pcm.length - 1)) * window;
        }
      } else if (engine === 1) {
        sum += this.readWavetable(data, pos, morph);
        pos += f / this.sampleRate;
        if (pos >= 1) pos -= 1;
      } else if (data.pcm) {
        // SAMPLE: one-shot read at pitch-following rate (f vs recorded root).
        // Normalized position advances by (playback rate / buffer length) per
        // sample, so playing the recorded root reads at exactly 1x.
        const rate = f / data.pcmRootHz;
        sum += readClamped(data.pcm, pos * (data.pcm.length - 1));
        pos += rate / data.pcm.length;
        if (pos > 1) pos = 1; // one-shot clamps at the end
      }
      positions[u] = pos;
    }
    return sum / Math.sqrt(unison);
  }

  /**
   * Render one block. `currentFrame` is the absolute frame of the block start
   * (live: `currentFrame`; offline: 0,128,256,...). Events inside the block
   * are applied at their own sample boundary.
   */
  process(left: Float32Array, right: Float32Array, currentFrame: number): void {
    const sr = this.sampleRate;
    const frames = left.length;
    const blockStartSec = currentFrame / sr;
    const blockEndSec = (currentFrame + frames) / sr;

    // Drain events up to the block end; late ones apply immediately.
    const blockEvents = this.blockEvents;
    blockEvents.length = 0;
    while (this.events.length > 0 && this.events[0]!.when < blockEndSec) {
      const next = this.events.shift()!;
      if (next.when >= blockStartSec) blockEvents.push(next);
      else this.applyEvent(next);
    }
    let eventCursor = 0;

    const lfoRate = syncedLfoHz(this.bpm, this.params.lfoSync ?? 0, this.params.lfoRate ?? 2);
    const lfoShape = Math.round(this.params.lfoShape ?? 0);
    const morphBase = clamp(this.params.morph ?? 0, 0, 1);
    const subLevel = this.params.sub ?? 0;
    const subOct = Math.round(this.params.subOct ?? -1);
    const noiseLevel = this.params.noise ?? 0;
    const noiseColor = clamp(this.params.noiseColor ?? 0.5, 0, 1);
    const tone = this.params.tone ?? 0;
    const drive = this.params.drive ?? 0;
    const width = clamp(this.params.width ?? 0.5, 0, 1);
    const level = this.params.level ?? 0.8;
    const glide = this.params.glide ?? 0;
    const velAmount = this.params.velocity ?? 0.7;
    const drift = clamp(this.params.drift ?? 0, 0, 1);

    const engineA = clamp(Math.round(this.params.srcAEngine ?? 1), 0, 2) as TsarEngine;
    const engineB = clamp(Math.round(this.params.srcBEngine ?? 0), 0, 2) as TsarEngine;
    const levelA = this.params.srcALevel ?? 0.8;
    const levelB = this.params.srcBLevel ?? 0;
    const panA = this.params.srcAPan ?? 0;
    const panB = this.params.srcBPan ?? 0;
    const detuneA = (this.params.srcACoarse ?? 0) * 100 + (this.params.srcAFine ?? 0);
    const detuneB = (this.params.srcBCoarse ?? 0) * 100 + (this.params.srcBFine ?? 0);

    const mods: Array<{ src: number; dst: number; amt: number }> = [];
    for (let i = 1; i <= 4; i++) {
      const src = Math.round(this.params[`mod${i}Src`] ?? -1);
      const dst = Math.round(this.params[`mod${i}Dst`] ?? -1);
      const amt = this.params[`mod${i}Amt`] ?? 0;
      if (src >= 0 && dst >= 0 && amt !== 0) mods.push({ src, dst, amt });
    }

    const svfA = { s1: 0, s2: 0 };
    const svfB = { s1: 0, s2: 0 };
    const glideCoeff = glide > 0 ? Math.min(1, 1 / (glide * sr * 0.35)) : 1;
    const gainCoeff = Math.min(1, 1 / (GAIN_RAMP_SEC * sr));

    // Arp clock pre-derivation: the step length is a subdivision of the beat
    // at the CURRENT bpm (set through `setBpm` by the runtime's syncBpm).
    const arpOn = (this.params.arpOn ?? 0) >= 0.5;
    const arpRate = clamp(Math.round(this.params.arpRate ?? 8), 1, 16);
    const arpGate = clamp(this.params.arpGate ?? 0.5, 0.05, 1);
    const arpSwing = clamp(this.params.arpSwing ?? 0, 0, 0.75);
    const arpStepSec = 60 / this.bpm / (arpRate / 4);
    const arpStepInc = arpStepSec > 0 ? 1 / (arpStepSec * sr) : 0;
    // A note is retriggered when the STEP phase wraps; the gate closes the
    // voice early so a step does not ring into the next one.

    this.outPeak = 0;
    for (let frame = 0; frame < frames; frame++) {
      const frameTime = (currentFrame + frame) / sr;
      while (eventCursor < blockEvents.length && blockEvents[eventCursor]!.when <= frameTime) {
        this.applyEvent(blockEvents[eventCursor]!);
        eventCursor += 1;
      }

      if (arpOn && this.arpHeld.length > 0) {
        this.arpPhase += arpStepInc;
        this.arpGatePhase += arpStepInc;
        if (this.arpPhase >= 1) {
          this.arpPhase -= 1;
          this.arpGatePhase = 0;
          // Every held arp note is stopped before the next step starts; the
          // gate value would normally cut it sooner, this is the bound.
          for (const sounding of [...this.arpSounding]) this.noteOff(sounding);
          this.arpSounding.clear();
          // Swing delays every OTHER step; the phase is nudged forward so the
          // pair of steps keeps the average rate.
          if (arpSwing > 0 && this.arpStep % 2 === 1) this.arpPhase = arpSwing * 0.5;
          const pitch = this.arpNextPitch();
          if (pitch > 0) {
            this.noteOn(pitch, this.arpVelocity);
            this.arpSounding.add(pitch);
          }
          this.arpStep += 1;
        } else if (this.arpGatePhase >= arpGate && this.arpSounding.size > 0) {
          // Gate closed: release the current step's notes early.
          for (const sounding of [...this.arpSounding]) this.noteOff(sounding);
          this.arpSounding.clear();
        }
      } else if (!arpOn && this.arpSounding.size > 0) {
        // Arp switched off: drain the arp-owned notes so they do not hang.
        for (const sounding of [...this.arpSounding]) this.noteOff(sounding);
        this.arpSounding.clear();
      }

      let mixL = 0;
      let mixR = 0;
      let soundingVoices = 0;

      for (const voice of this.voices) {
        if (!voice.active) continue;
        soundingVoices += 1;

        // Glide toward the target frequency.
        if (voice.f0 !== voice.targetF0) {
          voice.f0 += (voice.targetF0 - voice.f0) * glideCoeff;
          if (Math.abs(voice.f0 - voice.targetF0) < 0.01) voice.f0 = voice.targetF0;
        }

        const envA = this.stepAdsr(
          voice.envA,
          this.params.srcAAtk ?? 0.005,
          this.params.srcADec ?? 0.6,
          this.params.srcASus ?? 0.7,
          this.params.srcARel ?? 0.4,
        );
        const envB = this.stepAdsr(
          voice.envB,
          this.params.srcBAtk ?? 0.005,
          this.params.srcBDec ?? 0.6,
          this.params.srcBSus ?? 0.7,
          this.params.srcBRel ?? 0.4,
        );

        voice.lfoPhase += lfoRate / sr;
        if (voice.lfoPhase >= 1) voice.lfoPhase -= 1;
        const lfo = this.lfoValue(lfoShape, voice.lfoPhase);
        voice.driftPhase += (0.12 + (voice.index % 5) * 0.031) / sr;
        if (voice.driftPhase >= 1) voice.driftPhase -= 1;
        const driftCents = Math.sin(2 * Math.PI * voice.driftPhase) * drift * 8;
        const voiceHz = voice.f0 * Math.pow(2, driftCents / 1200);

        let modAMorph = 0;
        let modBMorph = 0;
        let modACutoff = 0;
        let modBCutoff = 0;
        let modMorph = 0;
        let modAmp = 1;
        let modPan = 0;
        for (const mod of mods) {
          const source = mod.src === 0 ? envA : mod.src === 1 ? lfo : mod.src === 2 ? voice.vel : voice.pressure;
          const signal = (source - 0.5) * 2 * mod.amt;
          switch (mod.dst) {
            case 0:
              modAMorph += signal;
              break;
            case 1:
              modACutoff += signal;
              break;
            case 2:
              modBMorph += signal;
              break;
            case 3:
              modBCutoff += signal;
              break;
            case 4:
              modMorph += signal;
              break;
            case 5:
              modAmp *= 1 + signal;
              break;
            case 6:
              modPan += signal;
              break;
          }
        }
        modAmp = clamp(modAmp, 0, 4);

        const velGain = 1 - velAmount + velAmount * voice.vel;

        const rawA =
          this.sourceSample(
            voice,
            0,
            engineA,
            clamp((this.params.srcAMorph ?? 0) + modAMorph, 0, 1),
            this.params.srcAScan ?? 0,
            detuneA,
            voiceHz,
          ) *
          envA *
          levelA;
        const rawB =
          this.sourceSample(
            voice,
            1,
            engineB,
            clamp((this.params.srcBMorph ?? 0) + modBMorph, 0, 1),
            this.params.srcBScan ?? 0,
            detuneB,
            voiceHz,
          ) *
          envB *
          levelB;

        svfA.s1 = voice.svfA1;
        svfA.s2 = voice.svfA2;
        const filteredA = this.runSvf(
          rawA,
          Math.round(this.params.srcAFilter ?? 0),
          (this.params.srcACutoff ?? 18000) * Math.pow(2, ((this.params.srcAFilterEnv ?? 0) * envA + modACutoff) * 4),
          this.params.srcAQ ?? 0.8,
          svfA,
        );
        voice.svfA1 = svfA.s1;
        voice.svfA2 = svfA.s2;
        svfB.s1 = voice.svfB1;
        svfB.s2 = voice.svfB2;
        const filteredB = this.runSvf(
          rawB,
          Math.round(this.params.srcBFilter ?? 0),
          (this.params.srcBCutoff ?? 18000) * Math.pow(2, ((this.params.srcBFilterEnv ?? 0) * envB + modBCutoff) * 4),
          this.params.srcBQ ?? 0.8,
          svfB,
        );
        voice.svfB1 = svfB.s1;
        voice.svfB2 = svfB.s2;

        const morph = clamp(morphBase + modMorph, 0, 1);
        const morphed = filteredA * (1 - morph) + filteredB * morph;

        let sub = 0;
        if (subLevel > 0) {
          voice.subPhase += (voiceHz * Math.pow(2, subOct)) / sr;
          if (voice.subPhase >= 1) voice.subPhase -= 1;
          sub = Math.sin(2 * Math.PI * voice.subPhase) * subLevel * envA;
        }
        let noise = 0;
        if (noiseLevel > 0) {
          this.noiseState = (this.noiseState * 1664525 + 1013904223) >>> 0;
          const white = (this.noiseState / 0xffffffff) * 2 - 1;
          const coeff = 0.02 + noiseColor * 0.6;
          noise = white * coeff * noiseLevel * envA;
        }

        const gainTarget = voice.gate ? 1 : 0;
        voice.gain += (gainTarget - voice.gain) * gainCoeff;
        // Voice death: gate closed, gain ramped out, and every envelope that
        // can still be HEARD has finished. Source B's envelope only matters
        // while B has level — otherwise a long B release keeps a silent voice
        // occupying one of the 16 slots (measured during T1: active count
        // stayed 1 for >1 s after an inaudible B release).
        const bCanSound = levelB > 0;
        if (!voice.gate && voice.gain < 1e-3 && voice.envA.stage === 0 && (!bCanSound || voice.envB.stage === 0)) {
          voice.active = false;
          continue;
        }

        const voiceSample = (morphed + sub + noise) * voice.gain * velGain * modAmp;

        // Pan: source pans + mod pan, equal-power.
        const pan = clamp(panA + panB + modPan, -1, 1);
        const panL = Math.cos(((pan + 1) * Math.PI) / 4);
        const panR = Math.sin(((pan + 1) * Math.PI) / 4);
        // Width narrows the stereo image toward mono.
        const side = 0.5 + 0.5 * width;
        const mid = voiceSample * 0.7071;
        const sideSample = voiceSample * panR * 0.7071 - voiceSample * panL * 0.7071;
        mixL += mid + sideSample * side;
        mixR += mid - sideSample * side;
      }

      const toneGain = Math.pow(10, (tone * 6) / 20);
      let l = mixL * toneGain;
      let r = mixR / Math.max(0.001, toneGain);
      if (drive > 0) {
        const driveGain = 1 + drive * 4;
        const norm = Math.tanh(driveGain);
        l = Math.tanh(l * driveGain) / norm;
        r = Math.tanh(r * driveGain) / norm;
      }
      // Polyphony headroom: 16 simultaneous voices at level 0.8 summed to 2.1
      // (measured during T1). A 1/sqrt(n) normalize keeps a full chord inside
      // the bus without ducking a single note; the divisor is smoothed so a
      // note starting/ending cannot step the whole mix.
      this.polyGain += (Math.max(1, soundingVoices) - this.polyGain) * gainCoeff;
      const poly = 1 / Math.sqrt(this.polyGain);
      l *= level * poly;
      r *= level * poly;
      left[frame] = l;
      right[frame] = r;
      const magnitude = Math.max(Math.abs(l), Math.abs(r));
      if (magnitude > this.outPeak) this.outPeak = magnitude;
    }
  }

  /** Peak of the last processed block (metering + tests). */
  get lastPeak(): number {
    return this.outPeak;
  }

  get activeVoiceCount(): number {
    let count = 0;
    for (const voice of this.voices) if (voice.active) count += 1;
    return count;
  }
}

export { FRAME_SIZE, MAX_VOICES, UNISON_MAX };
