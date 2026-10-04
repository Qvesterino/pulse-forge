/**
 * UN-SUNO U0 — GOLDEN SYNTH: deterministic synthetic tracks with EXACT
 * ground truth, the measuring stick for every transcription wave (U1 chords,
 * U2 bass, U3 drums) and the live tempo/key floor for the existing F1
 * estimators.
 *
 * Why a dedicated synth instead of `renderProject`: the golden set must be
 * bit-deterministic across machines and runs (AGENTS invariant #4), runnable
 * inside vitest (jsdom has no WebAudio), and carry ground truth that is exact
 * by construction — notes WE placed, not notes we hope the engine made.
 * The synth voice models (sweep kick, noise snare, HP-noise hats, sine bass
 * with a 2nd harmonic, triad pads) are deliberately simple but band-correct,
 * so a transcription that passes here says something about the DSP recipe.
 * Real-material validation stays an owner ear-pass (docs/UN-SUNO-PLAN.md §5).
 *
 * PURE: same seed + track → bit-identical Float32Array. No imports from src —
 * this file is the fixture, the metrics (`src/reference/unsuno-metrics.ts`)
 * and estimators are the code under test.
 */

export const GOLDEN_SAMPLE_RATE = 44100;
export const STEPS_PER_BAR = 16;
/** Deterministic PRNG (mulberry32) — noise floor + optional humanize. */
export const GOLDEN_SEED = 20261004;

export type GoldenChordQuality = "maj" | "min" | "dom7" | "min7" | "maj7" | "sus4";

export interface GoldenBassNote {
  /** Absolute step index in the song (step = 1/16 note). */
  step: number;
  /** MIDI pitch (bass register, 28–52 in the golden set). */
  pitch: number;
  durationSteps: number;
}

export interface GoldenChord {
  bar: number;
  /** 0..11, C = 0. */
  rootPc: number;
  quality: GoldenChordQuality;
}

export interface GoldenTrack {
  id: string;
  bpm: number;
  bars: number;
  /** Ground-truth key: tonic pitch class + mode. */
  key: { tonicPc: number; mode: "major" | "minor" };
  /** Per-bar 16-step velocity rows (0 = silent, >0 = velocity). */
  drums: { kick: number[][]; snare: number[][]; hat: number[][] };
  bass: GoldenBassNote[];
  chords: GoldenChord[];
}

export interface GoldenRenderOptions {
  /** Per-note start jitter, ms (default 0 — grid-exact). */
  humanizeMs?: number;
  /** PRNG seed for noise floor/humanize (default GOLDEN_SEED). */
  seed?: number;
}

const DRUM_LEVELS = { kick: 0.9, snare: 0.62, hat: 0.3 } as const;
const BASS_LEVEL = 0.5;
const CHORD_LEVEL = 0.22;
const NOISE_FLOOR = 0.005;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// ---- voices (each writes additively into the buffer at startSample) ----

function addKick(out: Float32Array, start: number, sr: number, velocity: number, rng: () => number): void {
  const length = Math.min(Math.round(sr * 0.28), out.length - start);
  const click = Math.round(sr * 0.003);
  let phase = 0;
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    // Pitch drop 110 → 48 Hz over ~60 ms, exponential amplitude decay.
    const freq = 48 + 62 * Math.exp(-t / 0.022);
    phase += (2 * Math.PI * freq) / sr;
    let sample = Math.sin(phase) * Math.exp(-t / 0.09);
    if (i < click) sample += (rng() * 2 - 1) * 0.4 * (1 - i / click);
    out[start + i] += sample * velocity * DRUM_LEVELS.kick;
  }
}

function addSnare(out: Float32Array, start: number, sr: number, velocity: number, rng: () => number): void {
  const length = Math.min(Math.round(sr * 0.18), out.length - start);
  let last = 0;
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    const noise = rng() * 2 - 1;
    const body = Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t / 0.045);
    // One-pole high-pass on the noise keeps the snare in its band.
    last = noise - last * 0.4;
    out[start + i] += (last * Math.exp(-t / 0.06) + body * 0.55) * velocity * DRUM_LEVELS.snare;
  }
}

function addHat(out: Float32Array, start: number, sr: number, velocity: number, rng: () => number): void {
  const length = Math.min(Math.round(sr * 0.05), out.length - start);
  let last = 0;
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    const noise = rng() * 2 - 1;
    last = noise - last * 0.85; // aggressive HP — metallic tick
    out[start + i] += last * Math.exp(-t / 0.012) * velocity * DRUM_LEVELS.hat;
  }
}

function addBassNote(out: Float32Array, start: number, lengthSamples: number, midi: number, sr: number): void {
  const length = Math.min(lengthSamples, out.length - start);
  const f0 = midiToHz(midi);
  const attack = Math.round(sr * 0.004);
  const release = Math.round(sr * 0.03);
  for (let i = 0; i < length; i++) {
    let env = 1;
    if (i < attack) env = i / attack;
    else if (i > length - release) env = Math.max(0, (length - i) / release);
    else env = 0.85 + 0.15 * Math.exp(-i / sr / 0.08);
    const phase = (2 * Math.PI * f0 * i) / sr;
    // Fundamental + audible 2nd harmonic — keeps YIN/pyin and Goertzel chroma honest.
    const sample = Math.sin(phase) + 0.4 * Math.sin(2 * phase);
    out[start + i] += sample * env * BASS_LEVEL * 0.5;
  }
}

const CHORD_INTERVALS: Record<GoldenChordQuality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dom7: [0, 4, 7, 10],
  min7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  sus4: [0, 5, 7],
};

function addChordPad(out: Float32Array, start: number, lengthSamples: number, midiNotes: number[], sr: number): void {
  const length = Math.min(lengthSamples, out.length - start);
  const attack = Math.round(sr * 0.015);
  const release = Math.round(sr * 0.05);
  for (const midi of midiNotes) {
    const f0 = midiToHz(midi);
    for (let i = 0; i < length; i++) {
      let env = 1;
      if (i < attack) env = i / attack;
      else if (i > length - release) env = Math.max(0, (length - i) / release);
      out[start + i] += Math.sin((2 * Math.PI * f0 * i) / sr) * env * CHORD_LEVEL;
    }
  }
}

/** Where a step lands, in samples (before humanize). */
export function stepToSample(step: number, bpm: number, sr: number): number {
  return Math.round(((step * 60) / bpm / 4) * sr);
}

/** Render a golden track to mono PCM. Deterministic. */
export function renderGoldenTrack(track: GoldenTrack, options: GoldenRenderOptions = {}): Float32Array {
  const sr = GOLDEN_SAMPLE_RATE;
  const humanizeMs = options.humanizeMs ?? 0;
  const rng = mulberry32(options.seed ?? GOLDEN_SEED);
  const totalSteps = track.bars * STEPS_PER_BAR;
  const length = Math.ceil(stepToSample(totalSteps, track.bpm, sr)) + Math.round(sr * 0.5);
  const out = new Float32Array(length);

  const stepSample = (step: number) => stepToSample(step, track.bpm, sr);
  const jitter = () => (humanizeMs > 0 ? (((rng() * 2 - 1) * humanizeMs) / 1000) * sr : 0);

  for (let bar = 0; bar < track.bars; bar++) {
    const barStart = bar * STEPS_PER_BAR;
    for (let s = 0; s < STEPS_PER_BAR; s++) {
      const kick = track.drums.kick[bar]?.[s] ?? 0;
      if (kick > 0) addKick(out, Math.max(0, stepSample(barStart + s) + jitter()), sr, kick, rng);
      const snare = track.drums.snare[bar]?.[s] ?? 0;
      if (snare > 0) addSnare(out, Math.max(0, stepSample(barStart + s) + jitter()), sr, snare, rng);
      const hat = track.drums.hat[bar]?.[s] ?? 0;
      if (hat > 0) addHat(out, Math.max(0, stepSample(barStart + s) + jitter()), sr, hat, rng);
    }
  }

  for (const note of track.bass) {
    const start = Math.max(0, stepSample(note.step) + jitter());
    addBassNote(out, start, Math.round(stepToSample(note.durationSteps, track.bpm, sr)), note.pitch, sr);
  }

  const stepsPerChordBar = STEPS_PER_BAR;
  for (const chord of track.chords) {
    const start = Math.max(0, stepSample(chord.bar * stepsPerChordBar) + jitter());
    const lengthSamples = Math.round(stepToSample(stepsPerChordBar, track.bpm, sr));
    // Voicing: root in C4 octave (48 + pc), triad above — inside the Goertzel band.
    const voicing = CHORD_INTERVALS[chord.quality].map((interval) => 48 + ((chord.rootPc + interval) % 12));
    addChordPad(out, start, lengthSamples, voicing, sr);
  }

  // Noise floor + peak normalize to 0.95 (same scale for every track).
  for (let i = 0; i < out.length; i++) out[i] += (rng() * 2 - 1) * NOISE_FLOOR;
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) {
    const gain = 0.95 / peak;
    for (let i = 0; i < out.length; i++) out[i] *= gain;
  }
  return out;
}

// ---- the golden set itself ----

const row = (...steps: number[]): number[] => {
  const r = new Array<number>(STEPS_PER_BAR).fill(0);
  for (const s of steps) r[s] = 1;
  return r;
};

function bars(count: number, make: (bar: number) => number[]): number[][] {
  return Array.from({ length: count }, (_, bar) => make(bar));
}

/** i–VI–III–VII-style progressions per genre, voiced as absolute pitch classes. */
function HOUSE(): GoldenTrack {
  const bars8 = 8;
  // A minor: Am F C G → roots A F C G = 9, 5, 0, 7
  const progression = [9, 5, 0, 7];
  return {
    id: "house-126-am",
    bpm: 126,
    bars: bars8,
    key: { tonicPc: 9, mode: "minor" },
    drums: {
      kick: bars(bars8, () => row(0, 4, 8, 12)),
      snare: bars(bars8, () => row(4, 12)),
      hat: bars(bars8, () => row(2, 6, 10, 14)),
    },
    bass: Array.from({ length: bars8 }, (_, bar) => {
      const root = 33 + ((progression[Math.floor(bar / 2) % 4] - 9 + 12) % 12); // A1 register anchor
      return [
        { step: bar * STEPS_PER_BAR + 0, pitch: root, durationSteps: 2 },
        { step: bar * STEPS_PER_BAR + 6, pitch: root, durationSteps: 2 },
        { step: bar * STEPS_PER_BAR + 10, pitch: root + 12, durationSteps: 2 },
        { step: bar * STEPS_PER_BAR + 14, pitch: root, durationSteps: 2 },
      ];
    }).flat(),
    chords: Array.from({ length: bars8 }, (_, bar) => {
      const slot = Math.floor(bar / 2) % 4;
      return {
        bar,
        rootPc: progression[slot],
        quality: (slot === 0 ? "min" : "maj") as "min" | "maj",
      };
    }),
  };
}

function TECHNO(): GoldenTrack {
  const bars8 = 8;
  // E minor drone: Em — root E = 4
  return {
    id: "techno-130-em",
    bpm: 130,
    bars: bars8,
    key: { tonicPc: 4, mode: "minor" },
    drums: {
      kick: bars(bars8, () => row(0, 4, 8, 12)),
      snare: bars(bars8, (bar) => (bar % 4 === 3 ? row(14) : row())),
      hat: bars(bars8, () => row(2, 6, 10, 14)),
    },
    bass: Array.from({ length: bars8 }, (_, bar) => {
      const root = 28; // E1
      // Acid-style 16th octave bounce on the root.
      return Array.from({ length: 8 }, (_, i) => ({
        step: bar * STEPS_PER_BAR + i * 2,
        pitch: root + (i % 2 === 1 ? 12 : 0),
        durationSteps: 1,
      }));
    }).flat(),
    chords: Array.from({ length: bars8 }, (_, bar) => ({ bar, rootPc: 4, quality: "min" as const })),
  };
}

function BOOMBAP(): GoldenTrack {
  const bars4 = 4;
  // C minor: Cm Fm Bb Eb → roots 0, 5, 10, 3
  const progression = [0, 5, 10, 3];
  return {
    id: "boombap-90-cm",
    bpm: 90,
    bars: bars4,
    key: { tonicPc: 0, mode: "minor" },
    drums: {
      kick: bars(bars4, () => row(0, 7, 10)),
      snare: bars(bars4, () => row(4, 12)),
      hat: bars(bars4, () => row(0, 2, 4, 6, 8, 10, 12, 14)),
    },
    bass: Array.from({ length: bars4 }, (_, bar) => {
      const root = 36 + progression[bar % 4]; // C2 register
      return [
        { step: bar * STEPS_PER_BAR + 0, pitch: root, durationSteps: 4 },
        { step: bar * STEPS_PER_BAR + 6, pitch: root + 7, durationSteps: 2 },
        { step: bar * STEPS_PER_BAR + 12, pitch: root + 10, durationSteps: 4 },
      ];
    }).flat(),
    chords: Array.from({ length: bars4 }, (_, bar) => {
      const slot = bar % 4;
      return {
        bar,
        rootPc: progression[slot],
        quality: (slot < 2 ? "min7" : "maj7") as "min7" | "maj7",
      };
    }),
  };
}

function TRAP(): GoldenTrack {
  const bars8 = 8;
  // F# minor: F#m D A E → roots 6, 2, 9, 4
  const progression = [6, 2, 9, 4];
  return {
    id: "trap-140-fsm",
    bpm: 140,
    bars: bars8,
    key: { tonicPc: 6, mode: "minor" },
    drums: {
      kick: bars(bars8, (bar) => (bar % 2 === 0 ? row(0, 7, 10) : row(0, 6, 11))),
      snare: bars(bars8, () => row(8)), // half-time backbeat
      hat: bars(bars8, () => Array.from({ length: STEPS_PER_BAR }, () => 1)), // 16th rolls
    },
    bass: Array.from({ length: bars8 }, (_, bar) => {
      const root = 30 + progression[Math.floor(bar / 2) % 4]; // F#1 register
      return [
        { step: bar * STEPS_PER_BAR + 0, pitch: root, durationSteps: 10 },
        { step: bar * STEPS_PER_BAR + 12, pitch: root + 12, durationSteps: 4 },
      ];
    }).flat(),
    chords: Array.from({ length: bars8 }, (_, bar) => {
      const slot = Math.floor(bar / 2) % 4;
      return {
        bar,
        rootPc: progression[slot],
        quality: (slot === 0 ? "min" : "maj") as "min" | "maj",
      };
    }),
  };
}

function DNB(): GoldenTrack {
  const bars8 = 8;
  // G minor: Gm Eb Bb F → roots 7, 3, 10, 5
  const progression = [7, 3, 10, 5];
  return {
    id: "dnb-174-gm",
    bpm: 174,
    bars: bars8,
    key: { tonicPc: 7, mode: "minor" },
    drums: {
      kick: bars(bars8, () => row(0, 10)),
      snare: bars(bars8, () => row(4, 12)),
      hat: bars(bars8, () => row(2, 6, 10, 14)),
    },
    bass: Array.from({ length: bars8 }, (_, bar) => {
      const root = 31 + progression[Math.floor(bar / 2) % 4]; // G1 register
      return [{ step: bar * STEPS_PER_BAR + 0, pitch: root, durationSteps: 14 }];
    }).flat(),
    chords: Array.from({ length: bars8 }, (_, bar) => {
      const slot = Math.floor(bar / 2) % 4;
      return {
        bar,
        rootPc: progression[slot],
        quality: (slot === 0 ? "min" : "maj") as "min" | "maj",
      };
    }),
  };
}

/** The golden set — order is part of the contract (indexes in test reports). */
export function goldenTracks(): GoldenTrack[] {
  return [HOUSE(), TECHNO(), BOOMBAP(), TRAP(), DNB()];
}
