/**
 * CHORÁL DSP core (ADR 0054) — a harmony-following timbre instrument.
 *
 * One keyboard note spawns up to four GRAIN STREAMS (the T9 architecture:
 * bounded pools of Hann-windowed grains resampling a monophonic source).
 * The played note keeps its own stream; the harmony stack adds tones that
 * agree with the song — OCTAVES ±12, FIFTHS +7/−5, TRIAD +third/+7 where
 * the third is chosen from the harmonyContext chord/scale mask at the
 * note's bar (chromatic context → major third; never silence).
 *
 * The HOST resolves doc.key / arrangement.chords into 12-bit masks (the
 * harmonyContext contract — this core carries no scale tables) and pushes
 * them through `setHarmonyContext`; the offline renderer seeds the SAME
 * shape through `processorOptions.harmony` alongside the event queue, so
 * live and offline render the same voices (invariant #3).
 *
 * Determinism: every random decision (grain position jitter) draws from a
 * per-stream LCG seeded at noteOn from pitch + interval + a stream counter
 * — never the wall clock. Bounded: MAX_STREAMS × GRAINS_MAX, zero
 * allocation in the render path, a per-sample spawn cap.
 */

export interface ChoralEvent {
  type: "noteOn" | "noteOff" | "panic";
  /** Absolute context time in seconds. */
  when: number;
  pitch?: number;
  velocity?: number;
}

export interface ChoralHarmonyContext {
  keyRootPc?: number;
  scaleMask?: number;
  chords?: { startBar: number; lengthBars: number; rootPc?: number; chordMask?: number }[];
}

export interface ChoralInitOptions {
  sampleRate: number;
  /** Events replayed at their absolute times (the offline seed). */
  events?: ChoralEvent[];
  harmony?: ChoralHarmonyContext;
  /** The uploaded source (monophonic, pitched) and its recorded root. */
  pcm?: Float32Array | null;
  pcmRootHz?: number;
}

const MAX_STREAMS = 32;
const GRAINS_MAX = 6;
const GRAIN_FIELDS = 3; // [startPos, age, dur]
const CHROMATIC = 0xfff;
/** Equal-power pan per harmony tone — the stack opens around the center. */
const STACK_PAN = [0.3, -0.35, 0.4, -0.25];

interface Stream {
  active: boolean;
  /** Sounded pitch (MIDI) — base note + harmony interval (post-detune). */
  pitch: number;
  /** The keyboard note that owns this stream (release matching). */
  basePitch: number;
  /** Harmony tone index (0 = the played note itself). */
  stackIndex: number;
  vel: number;
  /** Envelope: 0 attack, 1 sustain, 2 release, 3 off. */
  stage: 0 | 1 | 2 | 3;
  env: number;
  /** Grain pool: [startPos, age, dur] per grain. */
  state: Float32Array;
  count: number;
  spawnPhase: number;
  lcg: number;
  /** Absolute frame of noteOn (drives the TRIAD chord-bar resolution). */
  startFrame: number;
  /** Grain playback rate — captured at noteOn (post-detune pitch). */
  rate: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export class ChoralProcessor {
  private sampleRate: number;
  private params: Record<string, number> = {};
  /** The monophonic pitched source and its recorded root. */
  private pcm: Float32Array | null = null;
  private pcmRootHz = 261.63;

  private scaleMask = CHROMATIC;
  private chords: { startBar: number; lengthBars: number; mask: number }[] = [];

  private events: ChoralEvent[] = [];
  private streams: Stream[] = [];
  private streamCounter = 0;
  private outPeak = 0;
  private blockEvents: ChoralEvent[] = [];

  constructor(options: ChoralInitOptions) {
    this.sampleRate = options.sampleRate > 0 ? options.sampleRate : 48000;
    if (options.pcm && options.pcm.length > 0) this.pcm = options.pcm;
    if (Number.isFinite(options.pcmRootHz) && (options.pcmRootHz as number) > 0) {
      this.pcmRootHz = options.pcmRootHz as number;
    }
    if (options.harmony) this.setHarmonyContext(options.harmony);
    for (let i = 0; i < MAX_STREAMS; i++) {
      this.streams.push({
        active: false,
        pitch: 60,
        basePitch: 60,
        stackIndex: 0,
        vel: 0.8,
        stage: 3,
        env: 0,
        state: new Float32Array(GRAINS_MAX * GRAIN_FIELDS),
        count: 0,
        spawnPhase: 0,
        lcg: 1,
        startFrame: 0,
        rate: 1,
      });
    }
    if (options.events) for (const event of options.events) this.postEvent(event);
  }

  /** The harmonyContext contract (same shape as the TSAR/REZONANS bridge). */
  setHarmonyContext(init: ChoralHarmonyContext | undefined): void {
    if (!init || typeof init !== "object") return;
    if (Number.isFinite(init.scaleMask) && (init.scaleMask as number) >= 0) {
      this.scaleMask = (init.scaleMask as number) & CHROMATIC;
    }
    if (Array.isArray(init.chords)) {
      this.chords = init.chords
        .slice(0, 256)
        .filter(
          (chord) =>
            chord &&
            Number.isFinite(chord.startBar) &&
            Number.isFinite(chord.lengthBars) &&
            chord.lengthBars > 0 &&
            Number.isFinite(chord.chordMask),
        )
        .map((chord) => ({
          startBar: chord.startBar,
          lengthBars: chord.lengthBars,
          mask: (chord.chordMask as number) & CHROMATIC,
        }))
        .sort((a, b) => a.startBar - b.startBar);
    }
  }

  setSample(pcm: Float32Array | null, rootHz?: number): void {
    this.pcm = pcm && pcm.length > 0 ? pcm : null;
    if (Number.isFinite(rootHz) && (rootHz as number) > 0) this.pcmRootHz = rootHz as number;
  }

  applyParams(values: Record<string, number>): void {
    for (const [key, value] of Object.entries(values)) {
      if (Number.isFinite(value)) this.params[key] = value;
    }
  }

  setParam(name: string, value: number): void {
    if (Number.isFinite(value)) this.params[name] = value;
  }

  postEvent(event: ChoralEvent): void {
    if (!Number.isFinite(event.when)) return;
    this.events.push(event);
    for (let i = this.events.length - 1; i > 0 && this.events[i - 1]!.when > event.when; i--) {
      const tmp = this.events[i - 1]!;
      this.events[i - 1] = this.events[i]!;
      this.events[i] = tmp;
    }
  }

  /**
   * Harmony intervals above the played note. TRIAD's third is CONTEXTUAL —
   * chosen against the SCALE mask: +4 when the scale agrees, else +3 — so a
   * C-major song turns a C into C-E-G and hands a D the F (a minor third),
   * while the same key over A gives C-E. The chord lane refines voicing in
   * a follow-up wave; thirds from a three-tone chord mask kept failing for
   * notes whose third is not a chord tone (D over a C triad — measured).
   */
  private stackIntervals(basePitch: number): number[] {
    const mode = Math.round(clamp(this.params.stackMode ?? 0, 0, 3));
    if (mode === 0) return [0];
    if (mode === 1) return [0, -12, 12];
    if (mode === 2) return [0, 7, -5];
    let third = 4;
    if (!(this.scaleMask & (1 << ((Math.round(basePitch) + 4) % 12)))) {
      third = this.scaleMask & (1 << ((Math.round(basePitch) + 3) % 12)) ? 3 : 4;
    }
    return [0, third, 7];
  }

  private noteOn(pitch: number, velocity: number, startFrame: number): void {
    if (!Number.isFinite(pitch)) return;
    const intervals = this.stackIntervals(pitch);
    const stackLevel = clamp(this.params.stackLevel ?? 0.6, 0, 1);
    const detune = clamp(this.params.stackDetune ?? 8, 0, 30);
    for (let index = 0; index < intervals.length; index++) {
      const interval = intervals[index]!;
      // A free stream: the first OFF one, else steal the oldest sounding.
      let stream = this.streams.find((candidate) => !candidate.active);
      if (!stream) {
        stream = this.streams.reduce((oldest, c) => (c.startFrame < oldest.startFrame ? c : oldest));
      }
      const detuneCents = index === 0 ? 0 : (((this.streamCounter % 3) - 1) * detune) / 100;
      stream.active = true;
      stream.basePitch = pitch;
      stream.stackIndex = index;
      stream.vel = clamp(velocity, 0, 1) * (index === 0 ? 1 : stackLevel);
      stream.stage = 0;
      stream.env = 0;
      stream.count = 0;
      stream.spawnPhase = index === 0 ? 0 : (index * 0.37) % 1; // de-phase the stack
      stream.startFrame = startFrame;
      stream.pitch = pitch + interval + detuneCents;
      stream.rate = midiToHz(stream.pitch) / this.pcmRootHz;
      stream.lcg = (0x9e3779b9 ^ Math.imul(Math.round(stream.pitch) + 1, 2654435761) ^ Math.imul(this.streamCounter, 40503)) >>> 0;
      this.streamCounter += 1;
    }
  }

  private noteOff(pitch: number): void {
    for (const stream of this.streams) {
      if (stream.active && stream.basePitch === pitch && stream.stage !== 2) stream.stage = 2;
    }
  }

  applyEvent(event: ChoralEvent): void {
    switch (event.type) {
      case "noteOn":
        this.noteOn(event.pitch ?? 60, event.velocity ?? 0.8, (event.when * this.sampleRate) | 0);
        break;
      case "noteOff":
        if (Number.isFinite(event.pitch)) this.noteOff(event.pitch as number);
        break;
      case "panic":
        for (const stream of this.streams) {
          stream.active = false;
          stream.stage = 3;
          stream.env = 0;
          stream.count = 0;
        }
        break;
    }
  }

  private lcgDraw(stream: Stream): number {
    let state = stream.lcg;
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    stream.lcg = state;
    return state / 0x100000000;
  }

  /** Grain playback at ONE sample for one stream; retires finished grains. */
  private streamSample(stream: Stream, sr: number): number {
    const pcm = this.pcm;
    if (!pcm || pcm.length === 0) return 0;
    const density = clamp(this.params.grainDensity ?? 24, 8, 48);
    const sizeMs = clamp(this.params.grainSize ?? 80, 20, 200);
    const jitter = clamp(this.params.grainJitter ?? 0.15, 0, 1);
    const durSamples = Math.max(128, Math.min(sr * 0.4, (sizeMs / 1000) * sr));
    const len = pcm.length;
    const state = stream.state;

    // Sustained replay: the grain read head CYCLES the source (wrapped), so
    // any note length is sustained — not a one-shot.
    let spawnPhase = stream.spawnPhase + density / sr;
    let spawned = 0;
    while (spawnPhase >= 1 && spawned < 2) {
      spawnPhase -= 1;
      spawned += 1;
      if (stream.count >= GRAINS_MAX) continue;
      const jitterOffset = jitter * (this.lcgDraw(stream) * 2 - 1) * 0.25;
      let startPos = jitterOffset;
      startPos -= Math.floor(startPos);
      if (startPos < 0) startPos += 1;
      const base = stream.count * GRAIN_FIELDS;
      state[base] = startPos;
      state[base + 1] = 0;
      state[base + 2] = durSamples;
      stream.count += 1;
    }
    stream.spawnPhase = spawnPhase;

    let sum = 0;
    for (let g = stream.count - 1; g >= 0; g--) {
      const base = g * GRAIN_FIELDS;
      const age = state[base + 1]! + 1;
      const dur = state[base + 2]!;
      if (age >= dur) {
        const last = (stream.count - 1) * GRAIN_FIELDS;
        state[base] = state[last]!;
        state[base + 1] = state[last + 1]!;
        state[base + 2] = state[last + 2]!;
        stream.count -= 1;
        continue;
      }
      state[base + 1] = age;
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * age) / dur);
      const readPos = (state[base]! + (age * stream.rate) / len) * (len - 1);
      let p = readPos % len;
      if (p < 0) p += len;
      const i0 = Math.floor(p);
      const frac = p - i0;
      sum += (pcm[i0]! * (1 - frac) + pcm[(i0 + 1) % len]! * frac) * window;
    }

    // Overlap compensation (T9 lesson): size·density·Hann mean, sqrt-scaled.
    const overlap = Math.max(1, (durSamples / sr) * density * 0.5);
    return sum / Math.sqrt(overlap);
  }

  /**
   * Render one block. Events apply at their own sample boundary; every
   * active stream advances one grain step per sample (the TSAR loop shape).
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

    const attack = clamp(this.params.attack ?? 0.08, 0.001, 2);
    const release = clamp(this.params.release ?? 0.6, 0.02, 4);
    const level = clamp(this.params.level ?? 0.8, 0, 1.5) * 0.8;

    left.fill(0);
    right.fill(0);
    let peak = 0;

    for (let frame = 0; frame < frames; frame++) {
      const frameTime = (currentFrame + frame) / sr;
      while (eventCursor < blockEvents.length && blockEvents[eventCursor]!.when <= frameTime) {
        this.applyEvent(blockEvents[eventCursor]!);
        eventCursor += 1;
      }

      let mixL = 0;
      let mixR = 0;
      for (const stream of this.streams) {
        if (!stream.active) continue;

        if (stream.stage === 0) {
          stream.env += 1 / (attack * sr);
          if (stream.env >= 1) {
            stream.env = 1;
            stream.stage = 1;
          }
        } else if (stream.stage === 2) {
          stream.env -= 1 / (release * sr);
          if (stream.env <= 0) {
            stream.env = 0;
            stream.stage = 3;
            stream.active = false;
            continue;
          }
        }

        let sample = this.streamSample(stream, sr) * stream.env * stream.vel;
        if (sample > 0.9 || sample < -0.9) {
          const sign = sample < 0 ? -1 : 1;
          sample = sign * (0.9 + Math.tanh(Math.abs(sample) - 0.9) * 0.1);
        }
        const pan = STACK_PAN[stream.stackIndex % STACK_PAN.length] ?? 0;
        mixL += sample * Math.cos(((pan + 1) * Math.PI) / 4);
        mixR += sample * Math.sin(((pan + 1) * Math.PI) / 4);
      }

      left[frame] = mixL * level;
      right[frame] = mixR * level;
      const magnitude = Math.max(Math.abs(left[frame]!), Math.abs(right[frame]!));
      if (magnitude > peak) peak = magnitude;
    }
    this.outPeak = peak;
  }

  /** Peak of the last processed block (metering + tests). */
  get lastPeak(): number {
    return this.outPeak;
  }
}
