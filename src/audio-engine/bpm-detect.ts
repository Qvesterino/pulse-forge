/**
 * Loop tempo detection — the "Fit to project BPM" engine input.
 *
 * Pipeline (all pure math, deterministic, no AudioContext needed):
 *  1. Onset detection via the shared transient detector (energy flux).
 *  2. Onsets become an impulse train at 200 fps; unbiased autocorrelation
 *     over lags for 60–240 BPM finds the dominant period.
 *  3. Parabolic interpolation refines the lag below frame resolution.
 *  4. The tempo folds into 70–180 BPM (half-time / double-time material —
 *     8th-note hats, 2-bar kick patterns — lands on the musical tempo).
 *  5. Inter-onset intervals consistent with the folded period (k·T) refine
 *     the estimate with sample-accurate timing; rejected if it disagrees
 *     with the autocorrelation by more than 5%.
 *
 * `confidence` is the autocorrelation peak over its mean — roughly ≥ 1.2
 * means a steady pulse, near 1.0 means no clear tempo.
 */
import { detectTransients } from "./transients";

export interface LoopBpm {
  /** Rounded to 0.1 BPM. */
  bpm: number;
  /** Autocorrelation peak / mean. ≥ ~1.2 indicates a usable pulse. */
  confidence: number;
}

const MIN_BPM = 60;
const MAX_BPM = 240;
/** Musical tempo range — detections outside are folded by ×2 / ÷2. */
const PREFERRED_LOW = 70;
const PREFERRED_HIGH = 180;
const CONFIDENCE_GATE = 1.15;
const FPS = 200;

export function detectLoopBpm(data: Float32Array, sampleRate: number): LoopBpm | null {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || data.length < sampleRate * 1.5) return null;
  const duration = data.length / sampleRate;
  const onsets = detectTransients(data, sampleRate);
  if (onsets.length < 4) return null;

  // Impulse train, one bin per 5 ms frame, then max-blurred by ±2 frames.
  // Onset times are quantized to the transient detector's hop grid (~6 ms),
  // so a raw 0/1 train only correlates when lags align EXACTLY — the ±1 frame
  // drift between quantization and the true period gutted sub-multiple peaks
  // (a 0.3 s pulse train read as 2.6× stronger at 0.9 s than at 0.3 s). The
  // blur tolerances the alignment without blurring distinct tempos apart.
  const n = Math.ceil(duration * FPS) + 1;
  const raw = new Float32Array(n);
  for (const t of onsets) {
    const idx = Math.round(t * FPS);
    if (idx >= 0 && idx < n) raw[idx] = 1;
  }
  const train = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (raw[i] === 0) continue;
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) train[j] = 1;
  }

  // Unbiased autocorrelation across the tempo range. Dividing by the overlap
  // length keeps long lags (few overlapping frames) comparable to short ones.
  const minLag = Math.max(1, Math.round((FPS * 60) / MAX_BPM));
  const maxLag = Math.min(n - 2, Math.round((FPS * 60) / MIN_BPM));
  if (maxLag <= minLag) return null;
  let bestLag = -1;
  let bestVal = 0;
  let sum = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < n; i++) acc += train[i] * train[i + lag];
    const unbiased = acc / (n - lag);
    sum += unbiased;
    if (unbiased > bestVal) {
      bestVal = unbiased;
      bestLag = lag;
    }
  }
  if (bestLag < 0 || bestVal <= 0) return null;
  const confidence = bestVal / (sum / (maxLag - minLag + 1));
  if (confidence < CONFIDENCE_GATE) return null;

  // Harmonic walk-down: the unbiased ACF slightly favors longer lags, so a
  // peak that is an integer multiple (×2, ×3) of an equally strong shorter
  // period is a sub-harmonic (e.g. 3 IOIs of 8th-note hats read as a dotted
  // beat). Prefer the shorter period when it explains the train just as well.
  const acfAt = (lag: number): number => {
    lag = Math.round(lag);
    if (lag < 1 || lag > n - 2) return 0;
    let acc = 0;
    for (let i = 0; i + lag < n; i++) acc += train[i] * train[i + lag];
    return acc / (n - lag);
  };
  let chosenLag = bestLag;
  for (const k of [3, 2]) {
    const cand = bestLag / k;
    if (cand < 2) break;
    if (acfAt(cand) >= 0.85 * bestVal) {
      chosenLag = Math.round(cand);
      break;
    }
  }

  // Parabolic vertex around the chosen ACF peak — sub-frame lag precision.
  const y1 = acfAt(chosenLag - 1);
  const y2 = acfAt(chosenLag);
  const y3 = acfAt(chosenLag + 1);
  const denom = y1 - 2 * y2 + y3;
  const delta = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y1 - y3)) / denom)) : 0;
  let bpm = (60 * FPS) / (chosenLag + delta);

  // Fold half-time / double-time detections onto the musical range. The 2%
  // hysteresis keeps a true ~70 BPM groove sitting a hair under the boundary
  // from being doubled into a non-musical ~140.
  while (bpm < PREFERRED_LOW * 0.98) bpm *= 2;
  while (bpm > PREFERRED_HIGH * 1.02) bpm /= 2;

  // Interval refinement: consecutive onsets spaced k·T (k = 1..8, ±15%) vote
  // with their exact sample-accurate spacing; the median wins if it agrees
  // with the autocorrelation estimate.
  const T = 60 / bpm;
  const votes: number[] = [];
  for (let i = 1; i < onsets.length; i++) {
    const d = onsets[i] - onsets[i - 1];
    const k = Math.round(d / T);
    if (k >= 1 && k <= 8 && Math.abs(d - k * T) <= 0.15 * T) votes.push(d / k);
  }
  if (votes.length >= 2) {
    votes.sort((a, b) => a - b);
    const refined = 60 / votes[Math.floor(votes.length / 2)];
    if (Math.abs(refined - bpm) <= bpm * 0.05) bpm = refined;
  }

  return { bpm: Math.round(bpm * 10) / 10, confidence: Math.round(confidence * 100) / 100 };
}

/** Rate that turns a loop detected at `loopBpm` into project tempo (clamped to the engine's 0.25–4 stretch range). */
export function fitRate(loopBpm: number, projectBpm: number): number {
  // Guard against malformed inputs (NaN/Infinity propagate through the
  // arithmetic and would silently poison the playbackRate AudioParam — a
  // browser-side throw that takes the whole context down with it). An
  // identity stretch (1.0) is the safest possible default: no time-stretch,
  // no resampling artifacts, no audible surprise.
  if (!Number.isFinite(loopBpm) || !Number.isFinite(projectBpm) || projectBpm === 0) {
    return 1;
  }
  const rate = loopBpm / projectBpm;
  return Math.round(Math.min(4, Math.max(0.25, rate)) * 100) / 100;
}
