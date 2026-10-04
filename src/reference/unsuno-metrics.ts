/**
 * UN-SUNO TRANSCRIPTION METRICS — the pure scoring contract between the
 * golden ground truth (tests/unsuno/golden-synth.ts) and every transcription
 * wave (U1 chords, U2 bass, U3 drums — docs/UN-SUNO-PLAN.md).
 *
 * These functions ARE the KPI definitions; a change here is a KPI change and
 * needs a docs note. All matching is tolerant-but-honest: a detected event
 * matches at most one truth event (greedy nearest), and every score degrades
 * gracefully to 0 on empty inputs instead of NaN.
 */

export interface StepMatchReport {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

/** F1 over step slots (0..steps-1). A detected step matches a truth step
 * within `tolerance` slots (greedy nearest, each slot consumed once). */
export function stepF1(
  detectedSteps: readonly number[],
  truthSteps: readonly number[],
  options: { tolerance?: number } = {},
): StepMatchReport {
  const tolerance = Math.max(0, options.tolerance ?? 1);
  const used = new Array<boolean>(detectedSteps.length).fill(false);
  let tp = 0;
  for (const truth of truthSteps) {
    let best = -1;
    let bestDist = tolerance + 1;
    for (let i = 0; i < detectedSteps.length; i++) {
      if (used[i]) continue;
      const dist = Math.abs(detectedSteps[i] - truth);
      if (dist <= tolerance && dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    if (best >= 0) {
      used[best] = true;
      tp += 1;
    }
  }
  const fp = detectedSteps.length - tp;
  const fn = truthSteps.length - tp;
  const precision = detectedSteps.length > 0 ? tp / detectedSteps.length : 0;
  const recall = truthSteps.length > 0 ? tp / truthSteps.length : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, fn, precision, recall, f1 };
}

export interface OnsetMatchReport {
  matched: number;
  detectedCount: number;
  truthCount: number;
  precision: number;
  recall: number;
  f1: number;
  /** Median |Δt| over matched pairs, seconds (null when nothing matched). */
  medianErrorSec: number | null;
}

/** Time-domain onset matching (seconds) — the U2 bass / U3 drum-time metric. */
export function onsetMatch(
  detectedSec: readonly number[],
  truthSec: readonly number[],
  windowSec: number,
): OnsetMatchReport {
  const used = new Array<boolean>(detectedSec.length).fill(false);
  const errors: number[] = [];
  for (const truth of truthSec) {
    let best = -1;
    let bestDist = windowSec;
    for (let i = 0; i < detectedSec.length; i++) {
      if (used[i]) continue;
      const dist = Math.abs(detectedSec[i] - truth);
      if (dist <= windowSec && dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    if (best >= 0) {
      used[best] = true;
      errors.push(bestDist);
    }
  }
  const matched = errors.length;
  const precision = detectedSec.length > 0 ? matched / detectedSec.length : 0;
  const recall = truthSec.length > 0 ? matched / truthSec.length : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  errors.sort((a, b) => a - b);
  const median = errors.length > 0 ? errors[Math.floor(errors.length / 2)] : null;
  return {
    matched,
    detectedCount: detectedSec.length,
    truthCount: truthSec.length,
    precision,
    recall,
    f1,
    medianErrorSec: median,
  };
}

export interface DetectedNote {
  /** Note onset, seconds. */
  startSec: number;
  /** Detected MIDI pitch (may be fractional). */
  midi: number;
}

export interface TruthNote {
  startSec: number;
  midi: number;
}

export interface BassNoteReport {
  /** Onset f1 (window = half a 16th step by convention). */
  onset: OnsetMatchReport;
  /** Share of matched onsets with |Δmidi| ≤ 1. */
  pitchAccuracy: number;
  /** Share of matched onsets with equal pitch class (octave-blind view). */
  pitchClassAccuracy: number;
  matchedPitched: number;
}

/** U2 bass KPI pair: onset recall + pitch accuracy on matched notes. */
export function bassNoteMetrics(
  detected: readonly DetectedNote[],
  truth: readonly TruthNote[],
  windowSec: number,
): BassNoteReport {
  const used = new Array<boolean>(detected.length).fill(false);
  const errors: number[] = [];
  let withinSemitone = 0;
  let withinPitchClass = 0;
  for (const note of truth) {
    let best = -1;
    let bestDist = windowSec;
    for (let i = 0; i < detected.length; i++) {
      if (used[i]) continue;
      const dist = Math.abs(detected[i].startSec - note.startSec);
      if (dist <= windowSec && dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    if (best >= 0) {
      used[best] = true;
      errors.push(bestDist);
      const delta = Math.abs(detected[best].midi - note.midi);
      if (delta <= 1) withinSemitone += 1;
      if (Math.round(delta) % 12 === 0) withinPitchClass += 1;
    }
  }
  const precision = detected.length > 0 ? errors.length / detected.length : 0;
  const recall = truth.length > 0 ? errors.length / truth.length : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  errors.sort((a, b) => a - b);
  return {
    onset: {
      matched: errors.length,
      detectedCount: detected.length,
      truthCount: truth.length,
      precision,
      recall,
      f1,
      medianErrorSec: errors.length > 0 ? errors[Math.floor(errors.length / 2)] : null,
    },
    pitchAccuracy: errors.length > 0 ? withinSemitone / errors.length : 0,
    pitchClassAccuracy: errors.length > 0 ? withinPitchClass / errors.length : 0,
    matchedPitched: withinSemitone,
  };
}

export interface DetectedChord {
  bar: number;
  rootPc: number;
  quality?: string;
}

export interface TruthChord {
  bar: number;
  rootPc: number;
  quality: string;
}

export interface ChordBarReport {
  /** Bars where root AND quality both match. */
  exactCorrect: number;
  /** Bars where at least the root matches (the honest partial view). */
  rootCorrect: number;
  total: number;
  exactAccuracy: number;
  rootAccuracy: number;
}

/** U1 chord KPI: per-bar accuracy, exact (root+quality) and root-only. */
export function chordBarAccuracy(detected: readonly DetectedChord[], truth: readonly TruthChord[]): ChordBarReport {
  let exactCorrect = 0;
  let rootCorrect = 0;
  for (const chord of truth) {
    const hit = detected.find((candidate) => candidate.bar === chord.bar && candidate.rootPc === chord.rootPc);
    if (!hit) continue;
    rootCorrect += 1;
    if (hit.quality === chord.quality) exactCorrect += 1;
  }
  return {
    exactCorrect,
    rootCorrect,
    total: truth.length,
    exactAccuracy: truth.length > 0 ? exactCorrect / truth.length : 0,
    rootAccuracy: truth.length > 0 ? rootCorrect / truth.length : 0,
  };
}

/** Tempo error after folding the detected BPM by half/double — the honest
 * "is the pulse right" number for an estimator that folds. */
export function tempoFoldError(detectedBpm: number | null, truthBpm: number): number | null {
  if (detectedBpm === null || detectedBpm <= 0 || truthBpm <= 0) return null;
  let best = Math.abs(detectedBpm - truthBpm);
  for (const fold of [detectedBpm * 2, detectedBpm / 2, detectedBpm * 4, detectedBpm / 4]) {
    best = Math.min(best, Math.abs(fold - truthBpm));
  }
  return best;
}

export interface KeyMatchReport {
  /** tonic + mode both right. */
  exact: boolean;
  /** tonic right, mode possibly wrong (KK profiles on thin chroma). */
  tonicOnly: boolean;
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

/** Compare an estimator's key string ("A Natural Minor" | "C Major" | …)
 * against golden truth. Unknown formats count as a miss, never throw. */
export function keyMatch(
  detectedKey: string | null,
  truth: { tonicPc: number; mode: "major" | "minor" },
): KeyMatchReport {
  const miss = { exact: false, tonicOnly: false };
  if (!detectedKey) return miss;
  const parts = detectedKey.trim().split(/\s+/);
  if (parts.length < 2) return miss;
  const tonicIndex = NOTE_NAMES.indexOf(parts[0] as (typeof NOTE_NAMES)[number]);
  if (tonicIndex < 0) return miss;
  const mode = detectedKey.toLowerCase().includes("minor") ? "minor" : "major";
  const tonicOnly = tonicIndex === truth.tonicPc;
  return { exact: tonicOnly && mode === truth.mode, tonicOnly };
}
