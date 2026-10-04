/**
 * AUDIO REFERENCE — tempo + key estimation (pure, testable, no workers).
 *
 * Tempo (U0.5 rewrite, docs/UN-SUNO-PLAN.md): multi-band spectral flux
 * (the same DSP the Reference Map's F1 tempo lane uses) builds the onset
 * envelope; candidate generation runs harmonically enhanced autocorrelation
 * with parabolic peak refinement and a common-tempo prior; the winner folds
 * into the 70–180 BPM range (half/double tempo is the classic ambiguity).
 * The old path — the shared transient detector collapsed into a 20 ms
 * impulse envelope — starved the autocorrelation on polyphonic material
 * (it found 2–11 of ~100 events on the U0 golden set and missed by up to
 * 30 BPM); the transient detector itself keeps its other 10 consumers.
 *
 * Key: Goertzel probes over 12 pitch classes × 4 octaves (C2..B5) build a
 * chroma vector from the first 6 s; Krumhansl major/minor profiles are
 * correlated over all 12 rotations. A single-pitch input resolves the ROOT
 * confidently but the mode is ambiguous by design (both profiles fit a bare
 * chroma).
 *
 * Both estimators return null when the signal is too short/sparse to say
 * anything honest — callers keep their patch without the field.
 */
import { computeOnsetEnvelopes, removeBaseline } from "../reference/dsp/spectralFlux";
import { estimateTempoCandidates } from "../reference/analysis/tempoCandidates";

export interface TempoEstimate {
  /** Rounded to 0.1 BPM — exact under the golden harness. */
  bpm: number;
  /** Winner's normalized periodicity score (0..1] — rough. */
  confidence: number;
}

export interface KeyEstimate {
  key: string;
  /** Margin between the best and second-best rotation correlation. */
  confidence: number;
}

const MIN_BPM = 70;
const MAX_BPM = 180;
const FLUX_FFT_SIZE = 2048;
const FLUX_HOP = 256;

export function estimateTempo(pcm: Float32Array, sampleRate: number): TempoEstimate | null {
  try {
    const duration = pcm.length / sampleRate;
    if (duration < 4) return null;
    const envelopes = computeOnsetEnvelopes(pcm, sampleRate, FLUX_FFT_SIZE, FLUX_HOP);
    if (envelopes.frameCount < 16) return null;
    // ~1 s moving-average baseline keeps sustained bass/pads from masking
    // drum flux — the exact failure that starved the old envelope.
    const baseline = removeBaseline(envelopes.combined, Math.max(8, Math.round(envelopes.frameRate)));
    const candidates = estimateTempoCandidates(baseline, envelopes.frameRate, 60, 200, 6);
    const winner = candidates[0];
    if (!winner || winner.bpm <= 0) return null;
    // fold half/double tempo into the range
    let bpm = winner.bpm;
    while (bpm < MIN_BPM) bpm *= 2;
    while (bpm > MAX_BPM) bpm /= 2;
    return { bpm: Math.round(bpm * 10) / 10, confidence: winner.score };
  } catch {
    return null;
  }
}

// Krumhansl-Kessler key profiles (standard values).
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function pearson(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let meanA = 0;
  let meanB = 0;
  for (let index = 0; index < length; index++) {
    meanA += a[index];
    meanB += b[index];
  }
  meanA /= length;
  meanB /= length;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let index = 0; index < length; index++) {
    const da = a[index] - meanA;
    const db = b[index] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const denominator = Math.sqrt(denA * denB);
  return denominator > 0 ? num / denominator : 0;
}

function goertzelMagnitude(data: Float32Array, sampleRate: number, frequency: number): number {
  const k = (2 * Math.PI * frequency) / sampleRate;
  const coeff = 2 * Math.cos(k);
  let s1 = 0;
  let s2 = 0;
  for (let index = 0; index < data.length; index++) {
    const s0 = data[index] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2);
}

export function estimateKey(pcm: Float32Array, sampleRate: number): KeyEstimate | null {
  try {
    const maxSamples = Math.min(pcm.length, 6 * sampleRate);
    if (maxSamples < sampleRate) return null; // under a second — no opinion
    const window = pcm.subarray(0, maxSamples);

    const chroma = new Array<number>(12).fill(0);
    for (let pitchClass = 0; pitchClass < 12; pitchClass++) {
      for (let octave = 0; octave < 4; octave++) {
        // C2 = 65.406 Hz, four octaves up to B5
        const frequency = 65.406 * Math.pow(2, octave + pitchClass / 12);
        chroma[pitchClass] += goertzelMagnitude(window, sampleRate, frequency);
      }
    }
    const total = chroma.reduce((sum, value) => sum + value, 0);
    if (total <= 0) return null;

    let best = { key: "", correlation: -2 };
    let second = -2;
    for (let rotation = 0; rotation < 12; rotation++) {
      const rotated = chroma.map((_, index) => chroma[(index + rotation) % 12]);
      for (const [profile, mode] of [
        [MAJOR_PROFILE, "Major"],
        [MINOR_PROFILE, "Natural Minor"],
      ] as const) {
        const correlation = pearson(rotated, profile);
        if (correlation > best.correlation) {
          second = best.correlation;
          best = { key: `${NOTE_NAMES[rotation]} ${mode}`, correlation };
        } else if (correlation > second) {
          second = correlation;
        }
      }
    }
    if (best.correlation <= 0) return null;
    return {
      key: best.key,
      confidence: Number(Math.max(0, best.correlation - second).toFixed(3)),
    };
  } catch {
    return null;
  }
}
