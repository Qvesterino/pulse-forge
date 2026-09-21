import { calculateAutocorrelation, parabolicPeak } from "../dsp/autocorrelation";

export interface ReferenceTempoCandidate {
  bpm: number;
  /** Normalized periodicity score 0..1. */
  score: number;
  lag: number;
}

/**
 * Gaussian prior favouring musically common tempi. Centered at 120 BPM with
 * a spread of 55 BPM so the prior decays by ~e^-2 around 65 and 175 BPM
 * and is negligible past ±100 BPM. Deterministic — no RNG, no time.
 */
export function tempoPrior(bpm: number, center = 120, spread = 55): number {
  const z = (bpm - center) / spread;
  return Math.exp(-0.5 * z * z);
}

/** Weight of {@link tempoPrior} blended into the raw periodicity score. */
const PRIOR_WEIGHT = 0.15;

/**
 * Deterministic tempo candidate generation from an onset envelope using
 * harmonically enhanced autocorrelation. Picks local maxima, refines each
 * via parabolic interpolation, applies a tempo prior, sorts by score, and
 * merges candidates within 1.5% of each other (keeping the strongest).
 *
 * Ported verbatim from audiokey-analyzer/src/analysis/tempoCandidates.ts
 * (Apache-2.0 / project-owned, see docs/REFERENCE-MAP-ROADMAP.md §B).
 */
export function estimateTempoCandidates(
  envelope: Float32Array,
  frameRate: number,
  tempoMin: number,
  tempoMax: number,
  maxCandidates = 6,
): ReferenceTempoCandidate[] {
  if (envelope.length < 8) return [];

  const minLag = Math.max(2, Math.floor((frameRate * 60) / tempoMax));
  const maxLag = Math.min(
    envelope.length - 2,
    Math.ceil((frameRate * 60) / Math.max(1, tempoMin)),
  );
  if (maxLag <= minLag) return [];

  const acf = calculateAutocorrelation(envelope, 1, Math.min(envelope.length - 2, maxLag * 3));

  // Harmonic (comb) enhancement: reinforce lags whose 2x and 3x multiples also correlate.
  const enhanced = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let v = acf[lag];
    const l2 = lag * 2;
    const l3 = lag * 3;
    if (l2 < acf.length) v += 0.5 * acf[l2];
    if (l3 < acf.length) v += 0.25 * acf[l3];
    enhanced[lag] = v;
  }

  let maxVal = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (enhanced[lag] > maxVal) maxVal = enhanced[lag];
  }
  if (maxVal <= 0) return [];

  // Local maxima only (strict > on the left, >= on the right so plateau peaks keep the right edge).
  const peaks: ReferenceTempoCandidate[] = [];
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (enhanced[lag] > enhanced[lag - 1] && enhanced[lag] >= enhanced[lag + 1]) {
      const refined = parabolicPeak(enhanced, lag);
      const bpm = (frameRate * 60) / refined;
      if (bpm < tempoMin || bpm > tempoMax) continue;
      const base = enhanced[lag] / maxVal;
      const score = base * (1 - PRIOR_WEIGHT) + base * PRIOR_WEIGHT * tempoPrior(bpm);
      peaks.push({ bpm, score, lag: refined });
    }
  }

  // Deterministic ordering: score desc, then bpm asc as a stable tiebreaker.
  peaks.sort((a, b) => b.score - a.score || a.bpm - b.bpm);

  // Merge candidates within 1.5% of each other (keep strongest — first wins because sorted).
  const merged: ReferenceTempoCandidate[] = [];
  for (const p of peaks) {
    if (merged.some((m) => Math.abs(m.bpm - p.bpm) / m.bpm < 0.015)) continue;
    merged.push(p);
    if (merged.length >= maxCandidates) break;
  }
  return merged;
}

/**
 * Refine a BPM estimate by direct comb grid search of the onset envelope.
 * Default span is ±3% with 60 steps (≈0.1% resolution).
 */
export function refineTempo(
  envelope: Float32Array,
  frameRate: number,
  bpm: number,
  spanPercent = 0.03,
  steps = 60,
): number {
  let best = bpm;
  let bestScore = -Infinity;
  const lo = bpm * (1 - spanPercent);
  const hi = bpm * (1 + spanPercent);
  for (let i = 0; i <= steps; i++) {
    const test = lo + ((hi - lo) * i) / steps;
    const lag = (frameRate * 60) / test;
    const score = combScore(envelope, lag);
    if (score > bestScore + 1e-12) {
      bestScore = score;
      best = test;
    }
  }
  return best;
}

/**
 * Sum of envelope autocorrelation at a fractional lag and its 1..4 multiples,
 * each weighted 1/multiplier. Used by {@link refineTempo} as the grid-search
 * score. Exported for tests.
 */
export function combScore(envelope: Float32Array, lag: number): number {
  let total = 0;
  for (let mult = 1; mult <= 4; mult++) {
    const l = lag * mult;
    if (l >= envelope.length - 1) break;
    const weight = 1 / mult;
    let sum = 0;
    let count = 0;
    for (let i = 0; i + l < envelope.length; i++) {
      const pos = i + l;
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const v = envelope[i0] * (1 - frac) + envelope[i0 + 1] * frac;
      sum += envelope[i] * v;
      count++;
    }
    if (count > 0) total += (weight * sum) / count;
  }
  return total;
}
