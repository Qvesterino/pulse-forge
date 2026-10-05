/**
 * U2 — BASS TRANSCRIPTION (docs/UN-SUNO-PLAN.md).
 *
 * Pure DSP: a rendered signal + a bar grid in → bass notes out
 * ({ startSec, durationSec, midi, velocity, confidence }).
 *
 * Recipe ported from D:\beat_modifier `pipelines/extraction.py`
 * (low-band isolation → monophonic pitch tracking → note segmentation),
 * rebuilt on the Reference Map's own primitives:
 *
 * - ISOLATION: cascaded RBJ low-pass at 300 Hz, then decimate ×8. Bass
 *   content ≤ 300 Hz survives untouched (decimated Nyquist ≈ 2.7 kHz), and
 *   everything downstream runs 8× cheaper — the whole YIN pass over a 15 s
 *   track costs a few tens of millions of ops instead of billions.
 * - TRACKING: the shared pitch-tracker worker primitive with
 *   { fminHz: 30, fmaxHz: 250 } — covers 808 sub-bass (F#1 = 46 Hz) through
 *   high bass register; hop 20 ms.
 * - SEGMENTATION: voiced frames (clarity gate) grouped while pitch stays
 *   within a semitone; runs shorter than ~1/3 of a 16th step are noise.
 *   Pitch of a note = MEDIAN over its frames — the kick decaying into a
 *   note's first frames loses the vote.
 * - VELOCITY from the note's mean clarity, normalized against the loudest
 *   note; scale-snap is OPT-IN and off by default (transcription, not
 *   correction).
 *
 * Honesty: no voiced content → empty + coverage 0, never invented notes.
 */

import { trackPitch, type PitchFrame } from "../../audio-workers/pitch-tracker";

export interface TranscribedBassNote {
  startSec: number;
  durationSec: number;
  /** Quantized MIDI (integer) — the tracker's continuous value medianed and rounded. */
  midi: number;
  /** 1..127, from mean clarity relative to the loudest note. */
  velocity: number;
  /** Mean YIN clarity across the note's frames, 0..1. */
  confidence: number;
}

export interface BassDetection {
  notes: TranscribedBassNote[];
  /** Seconds of audio actually analyzed (after the analysis cap). */
  analyzedSec: number;
  /** Share of analyzed time covered by detected notes, 0..1. */
  coverage: number;
}

export interface BassChordContext {
  /** Per-bar chord roots (pitch classes), index = bar in the SAME detected
   * tempo grid the bass runs on. Bars without a detected chord carry -1. */
  barRoots: number[];
  /** Seconds per bar of that grid. */
  barSec: number;
}

export interface BassDetectionOptions {
  /** Grid source — normally the estimateTempo result; sets the minimum note
   * length (~1/3 of a 16th step). */
  bpm: number;
  /** Analysis cap in seconds (default 120, mirrors the chord lane). */
  maxSeconds?: number;
  /** Opt-in scale snap (default OFF — transcription, never correction). */
  snapToScale?: { tonicPc: number; mode: "major" | "minor" };
  /**
   * CHORD-TONE PRIOR — the kick is louder than the bass and lives in the
   * same band; raw YIN tracks the kick's pitch sweep and reads phantom
   * notes. The U1 chord lane (36/36 on the golden set) supplies the bar's
   * harmonic frame: frames whose pitch class is NOT a chord tone
   * (root/third/fifth/seventh) are treated as unvoiced. Without context
   * (no chords detected) the prior is silent — the layer stays honest
   * about being unreliable, which is why callers pass it whenever they can.
   */
  chordContext?: BassChordContext;
}

/** RBJ cookbook low-pass (Butterworth Q). Cascade 2× for 24 dB/oct — a single
 * 2nd-order section lets enough kick click through to confuse YIN. */
function lowPassCoefficients(
  sampleRate: number,
  hz: number,
): { b0: number; b1: number; b2: number; a1: number; a2: number } {
  const w0 = (2 * Math.PI * hz) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cos) / 2 / a0,
    b1: (1 - cos) / a0,
    b2: (1 - cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

export function applyLowPass(data: Float32Array, sampleRate: number, hz: number): Float32Array {
  const c = lowPassCoefficients(sampleRate, hz);
  const out = new Float32Array(data.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x0 = data[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    out[i] = y0;
  }
  // Second cascade section (same coefficients, fresh state) → 24 dB/oct.
  let x1b = 0;
  let x2b = 0;
  let y1b = 0;
  let y2b = 0;
  for (let i = 0; i < data.length; i++) {
    const x0 = out[i];
    const y0 = c.b0 * x0 + c.b1 * x1b + c.b2 * x2b - c.a1 * y1b - c.a2 * y2b;
    x2b = x1b;
    x1b = x0;
    y2b = y1b;
    y1b = y0;
    out[i] = y0;
  }
  return out;
}

const DECIMATION = 8;
const LOW_PASS_HZ = 300;
/**
 * 30 Hz (the beat_modifier recipe) let YIN pick SUBHARMONIC octaves on
 * kick+bass mixes (a C2 bass read as C1 = 32.7 Hz, clarity intact). 40 Hz
 * sits below the lowest real bass we target (F#1 = 46 Hz, the 808 register)
 * while locking sub-sub ghosts out of the lag range.
 */
const FMIN_HZ = 40;
const FMAX_HZ = 250;
/** 10 ms frames: notes short as one 16th sit right at the minimum-note
 * boundary, and every frame a kick mask eats is a frame the note loses. */
const HOP_MS = 10;
/** Voiced frame clarity gate. The voice gate (0.5) is TOO HIGH for bass in
 * a mix: the kick's tail intermodulates with the bass fundamental and drags
 * YIN clarity of real bass frames to 0.50–0.65 (measured), while pure-kick
 * tails sit higher — the chord-tone prior is what separates those, not
 * clarity. 0.45 keeps broadband noise out without eating the bass. */
const BASS_CLARITY_GATE = 0.45;
/** Consecutive same-pitch frames group into one note; a frame more than this
 * many semitones away breaks the run. */
const PITCH_RUN_TOLERANCE_SEMITONES = 1;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function snapPitch(midi: number, tonicPc: number, mode: "major" | "minor"): number {
  const scale = mode === "major" ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
  const rounded = Math.round(midi);
  const pc = ((rounded % 12) + 12) % 12;
  const offset = (((pc - tonicPc) % 12) + 12) % 12;
  if (scale.includes(offset)) return rounded;
  let nearest = scale[0];
  let bestDist = 12;
  for (const degree of scale) {
    const dist = Math.min(Math.abs(offset - degree), 12 - Math.abs(offset - degree));
    if (dist < bestDist) {
      bestDist = dist;
      nearest = degree;
    }
  }
  // Take the SHORTEST shift: nearest-offset can wrap past an octave either
  // way (C#→C is -1, not +11) — never jump more than half an octave.
  const raw = nearest - offset;
  const shift = raw > 6 ? raw - 12 : raw < -6 ? raw + 12 : raw;
  return rounded + shift;
}

/**
 * U2.5 kick-tail mask. One-pole low-pass at 120 Hz → per-YIN-frame energy;
 * a frame is masked while the energy decays from a transient spike (2.5× the
 * track median, falling). Sustained bass never spikes, so clean material
 * keeps an empty mask. Returns 0/1 per 20 ms frame slot.
 */
function kickTailMask(small: Float32Array, smallRate: number, frameSec: number): Uint8Array {
  // One-pole LP 120 Hz on the decimated signal.
  const coeff = Math.exp((-2 * Math.PI * 120) / smallRate);
  const frameCount = Math.max(1, Math.ceil(small.length / (smallRate * frameSec)));
  const energy = new Float64Array(frameCount);
  let lp = 0;
  for (let i = 0; i < small.length; i++) {
    lp = small[i] + coeff * (lp - small[i]);
    const frame = Math.min(frameCount - 1, Math.floor(i / (smallRate * frameSec)));
    energy[frame] += lp * lp;
  }
  let maxEnergy = 0;
  for (let f = 0; f < frameCount; f++) {
    energy[f] = Math.sqrt(energy[f] / Math.max(1, smallRate * frameSec));
    if (energy[f] > maxEnergy) maxEnergy = energy[f];
  }
  if (maxEnergy <= 0) return new Uint8Array(frameCount);

  // Track median for the spike test.
  const sorted = [...energy].sort((a, b) => a - b);
  const med = sorted[Math.floor(frameCount / 2)] || 0;

  const mask = new Uint8Array(frameCount);
  let release = -1; // frame index where the current mask ends
  for (let f = 0; f < frameCount; f++) {
    const value = energy[f];
    // Three-way spike signature: above 1.6x the track median (the sustained
    // bass itself lifts the median, so a measured kick spike sits at only
    // ~2.4x), a steep rising edge (sustained-bass energy wobbles ±20 %, a
    // kick lands at 2.3x), and — the decisive one — RAPID DECAY ahead: the
    // energy 180 ms later is well under half the spike. A bass onset
    // SUSTAINS (~90 % of its peak 180 ms in), so clean material never gets
    // masked; a kick tail does decay, and that tail is what YIN was tracking.
    const future = energy[Math.min(frameCount - 1, f + 18)];
    const onset = value > med * 1.6 && (f === 0 || value > energy[f - 1] * 1.45) && future * 1.8 < value && release < f;
    if (onset) {
      // decay threshold: 30% of the spike, at most ~2.5 half-lives of a
      // typical synthesized kick — cap keeps a pathological signal from
      // masking everything.
      const threshold = value * 0.3;
      let end = f + 1;
      while (end < frameCount && energy[end] > threshold && end - f < Math.round(0.25 / frameSec)) end++;
      release = end;
    }
    if (release > f) mask[f] = 1;
  }
  return mask;
}

export function detectBassNotes(
  pcm: Float32Array,
  sampleRate: number,
  options: BassDetectionOptions,
): BassDetection | null {
  if (!Number.isFinite(options.bpm) || options.bpm <= 0 || sampleRate <= 0) return null;
  const maxSeconds = options.maxSeconds ?? 120;
  const analyzedSamples = Math.min(pcm.length, Math.floor(maxSeconds * sampleRate));
  const analyzedSec = analyzedSamples / sampleRate;
  if (analyzedSec < 1) return null;

  // Isolate + decimate: one 24 dB/oct low-pass, then every DECIMATION-th sample.
  const isolated = applyLowPass(pcm.subarray(0, analyzedSamples), sampleRate, LOW_PASS_HZ);
  const small = new Float32Array(Math.floor(analyzedSamples / DECIMATION));
  for (let i = 0; i < small.length; i++) small[i] = isolated[i * DECIMATION];
  const smallRate = sampleRate / DECIMATION;
  if (small.length < 2048) return null;

  const frames = trackPitch(small, smallRate, { fminHz: FMIN_HZ, fmaxHz: FMAX_HZ, hopMs: HOP_MS });
  if (frames.length === 0) return null;

  // Chord-tone prior: octave-agnostic pitch-class check against the bar's
  // root/third/fifth/(seventh). Frames outside the frame are unvoiced — the
  // kick sweeps through arbitrary pitch classes, the bass stays home.
  const context = options.chordContext;
  const chordAllows = (timeSec: number, midi: number): boolean => {
    if (!context || context.barRoots.length === 0) return true;
    const bar = Math.floor(timeSec / context.barSec);
    const rootPc = context.barRoots[Math.min(bar, context.barRoots.length - 1)];
    if (rootPc === undefined || rootPc < 0) return true;
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    const offset = (((pc - rootPc) % 12) + 12) % 12;
    return offset === 0 || offset === 3 || offset === 4 || offset === 7 || offset === 10;
  };

  const stepSec = 60 / options.bpm / 4;
  const minNoteSec = Math.max((HOP_MS / 1000) * 4, stepSec * 0.25);
  const frameSec = HOP_MS / 1000;

  // U2.5 — KICK-TAIL MASK. The kick's decaying tail out-claries the bass
  // fundamental in YIN (measured: tail frames score 0.7+ clarity while real
  // bass under a fresh kick sits at 0.5-0.65), and when the sweep's terminal
  // pitch lands on a chord tone the prior lets those frames through. So
  // detect low-band transients and keep frames UNVOICED while the ≤120 Hz
  // energy decays from a spike. A sustained bass never triggers it (its
  // energy is flat — no 2.5x median spikes), and the same-pitch gap merge
  // re-joins notes that a mask split.
  const masked = kickTailMask(small, smallRate, frameSec);

  interface Run {
    frames: PitchFrame[];
  }
  const runs: Run[] = [];
  let current: PitchFrame[] = [];
  let flush = (): void => {
    if (current.length > 0) runs.push({ frames: current });
    current = [];
  };
  for (const frame of frames) {
    if (frame.clarity < BASS_CLARITY_GATE || frame.midi <= 0 || !chordAllows(frame.timeSec, frame.midi)) {
      flush();
      continue;
    }
    if (masked[Math.round(frame.timeSec / frameSec)] === 1) {
      flush();
      continue;
    }
    if (current.length > 0) {
      const anchor = median(current.map((f) => f.midi));
      if (Math.abs(frame.midi - anchor) > PITCH_RUN_TOLERANCE_SEMITONES) {
        flush();
      }
    }
    current.push(frame);
  }
  flush();

  const raw: { startSec: number; durationSec: number; midi: number; clarity: number }[] = [];
  for (const run of runs) {
    if (run.frames.length * frameSec < minNoteSec) continue;
    let startSec = run.frames[0].timeSec;
    // Re-anchor: a run whose preceding frame slot was masked begins AT the
    // mask — the note was sounding under the kick tail, the tracker just
    // could not see it. Without this, every kick-coincident note starts late.
    const firstSlot = Math.round(startSec / frameSec);
    if (firstSlot > 0 && masked[firstSlot - 1] === 1) {
      let slot = firstSlot - 1;
      // Cap the slide: a mask longer than ~200 ms is not one note's start.
      const earliest = Math.max(0, firstSlot - Math.round(0.2 / frameSec));
      while (slot > 0 && masked[slot] === 1 && slot > earliest) slot--;
      startSec = slot * frameSec;
    }
    const durationSec = run.frames[run.frames.length - 1].timeSec - startSec + frameSec;
    const midiValue = median(run.frames.map((f) => f.midi));
    const midi = Math.round(midiValue);
    const clarity = run.frames.reduce((sum, f) => sum + f.clarity, 0) / run.frames.length;
    raw.push({ startSec, durationSec, midi, clarity });
  }
  if (raw.length === 0) {
    return { notes: [], analyzedSec, coverage: 0 };
  }

  // Merge tiny gaps between same-pitch neighbours (AM inside one note).
  const merged: typeof raw = [];
  for (const note of raw) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      note.midi === prev.midi &&
      // Re-anchored notes may overlap their predecessor — glue only true gaps.
      note.startSec >= prev.startSec + prev.durationSec &&
      note.startSec - (prev.startSec + prev.durationSec) < stepSec * 0.5
    ) {
      prev.durationSec = note.startSec + note.durationSec - prev.startSec;
      continue;
    }
    merged.push({ ...note });
  }

  // Velocity: mean clarity relative to the loudest note, 1..127.
  const maxClarity = Math.max(...merged.map((n) => n.clarity));
  const notes: TranscribedBassNote[] = merged.map((note) => {
    const midi = options.snapToScale
      ? snapPitch(note.midi, options.snapToScale.tonicPc, options.snapToScale.mode)
      : note.midi;
    return {
      startSec: note.startSec,
      durationSec: note.durationSec,
      midi,
      velocity: Math.max(1, Math.min(127, Math.round((40 + 80 * (note.clarity / Math.max(maxClarity, 1e-9))) * 1))),
      confidence: note.clarity,
    };
  });

  const coveredSec = notes.reduce((sum, n) => sum + n.durationSec, 0);
  return { notes, analyzedSec, coverage: Math.min(1, coveredSec / analyzedSec) };
}
