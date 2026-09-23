/**
 * AUDIO REFERENCE — tempo + key estimation (pure, testable, no workers).
 *
 * Tempo: the transient detector (log-flux onsets, shared with recording) is
 * collapsed into a 20 ms impulse envelope; autocorrelation over the 70–180
 * BPM lag range picks the pulse, then the estimate folds into that range
 * (half/double tempo is the classic ambiguity).
 *
 * Key: Goertzel probes over 12 pitch classes × 4 octaves (C2..B5) build a
 * chroma vector; Krumhansl major/minor profiles are correlated over all 12
 * rotations. A single-pitch input resolves the ROOT confidently but the
 * mode is ambiguous by design (both profiles fit a bare chroma).
 *
 * Both estimators return null when the signal is too short/sparse to say
 * anything honest — callers keep their patch without the field.
 */
import { detectTransients } from "../audio-workers/onset-detector";

export interface TempoEstimate {
  bpm: number;
  /** Share of autocorrelation mass at the peak (0..1] — rough. */
  confidence: number;
}

export interface KeyEstimate {
  key: string;
  /** Margin between the best and second-best rotation correlation. */
  confidence: number;
}

const MIN_BPM = 70;
const MAX_BPM = 180;
const ENVELOPE_BIN_SEC = 0.02;

export function estimateTempo(pcm: Float32Array, sampleRate: number): TempoEstimate | null {
  try {
    const onsets = detectTransients(pcm, sampleRate, 1);
    if (onsets.length < 8) return null;
    const duration = pcm.length / sampleRate;
    if (duration < 4) return null;

    const binCount = Math.ceil(duration / ENVELOPE_BIN_SEC);
    const envelope = new Float64Array(binCount);
    for (const onset of onsets) {
      const bin = Math.floor(onset / ENVELOPE_BIN_SEC);
      if (bin >= 0 && bin < binCount) envelope[bin] = 1;
    }

    let bestBpm = 0;
    let bestScore = -1;
    let totalScore = 0;
    for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 1) {
      const lag = Math.round(60 / bpm / ENVELOPE_BIN_SEC);
      if (lag < 2 || lag * 2 >= binCount) continue;
      let score = 0;
      for (let index = 0; index + lag < binCount; index++) score += envelope[index] * envelope[index + lag];
      totalScore += score;
      if (score > bestScore) {
        bestScore = score;
        bestBpm = bpm;
      }
    }
    if (bestBpm === 0 || bestScore <= 0) return null;

    // fold half/double tempo into the range
    let bpm = bestBpm;
    while (bpm < MIN_BPM) bpm *= 2;
    while (bpm > MAX_BPM) bpm /= 2;
    return { bpm: Math.round(bpm), confidence: totalScore > 0 ? bestScore / totalScore : 0 };
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
