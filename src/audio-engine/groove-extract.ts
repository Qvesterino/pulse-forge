/**
 * Groove extraction — "steal the groove" from an imported loop.
 *
 * Detects onsets in the loop, folds them onto a 16th-step grid and produces:
 *  - `timing[]`: per-step microtiming shift in the project's −1..1 range
 *    (−1/+1 = ±MAX_MICRO_TIMING, i.e. ±30% of a step) — the loop's swing
 *    and push/pull feel, ready for `stepMeta[pad][step].microtiming`.
 *  - `accent[]`: per-step relative loudness 0..1 — the loop's velocity
 *    dynamics, ready to scale existing pattern velocities.
 *  - `swing`: fitted classic swing amount 0..1 (odd-16th delay), for display.
 *
 * The loop is folded: a 2-bar loop maps onto the grid twice — accents and
 * shifts accumulate by taking the STRONGEST onset per step.
 *
 * Pure math on top of the shared transient detector — deterministic, no
 * AudioContext required.
 */
import { detectTransients } from "./transients";

export interface StealGrooveMap {
  /** Per-step microtiming, −1..1 (project range: ±MAX_MICRO_TIMING of a step). */
  timing: number[];
  /** Per-step accent 0..1 (0 = no onset near this step in the loop). */
  accent: number[];
  /** Fitted classic swing 0..1 (odd-16th delay) — informational. */
  swing: number;
}

/** Onset peak search window either side of the reported transient (seconds). */
const PEAK_WINDOW_SEC = 0.035;
/** Deviation (in steps) that maps to |timing| = 1. Matches the classic swing ceiling. */
const TIMING_FULL_SCALE_STEPS = 0.34;

export function extractGroove(data: Float32Array, sampleRate: number, bpm: number, steps = 16): StealGrooveMap | null {
  // Guard order: a non-finite or non-positive sampleRate silently bypasses
  // the data.length < sampleRate*0.5 check (NaN comparisons are always
  // false), which would feed garbage sample-rate math into the stepSec
  // normaliser and produce NaN timing values that propagate into
  // stepMeta.microtiming. Reject before any arithmetic.
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return null;
  if (!Number.isFinite(bpm) || bpm <= 0 || data.length < sampleRate * 0.5) return null;
  const onsets = detectTransients(data, sampleRate);
  if (onsets.length < 4) return null;

  const duration = data.length / sampleRate;
  const stepSec = 60 / bpm / 4;
  const barSec = stepSec * steps;
  if (barSec <= 0 || duration < barSec * 0.4) return null;

  // Refine each onset to the local |sample| peak. The flux detector reports
  // onsets when the energy RISE begins — a few ms before the actual attack —
  // which would otherwise bleed a systematic ~30 ms early bias into every
  // timing value. The sample peak is exact.
  const refined = onsets.map((t) => {
    const from = Math.max(0, Math.floor((t - PEAK_WINDOW_SEC) * sampleRate));
    const to = Math.min(data.length, Math.ceil((t + PEAK_WINDOW_SEC) * sampleRate));
    let best = from;
    let bestV = 0;
    for (let i = from; i < to; i++) {
      const v = Math.abs(data[i]);
      if (v > bestV) {
        bestV = v;
        best = i;
      }
    }
    return { time: best / sampleRate, strength: bestV };
  });
  // Audit 12 D4: a spread over ~65k+ onsets exceeds the JS argument limit
  // (RangeError) — loop instead. Latent for hour-long material only.
  let maxStrength = 1e-9;
  for (const r of refined) maxStrength = Math.max(maxStrength, r.strength);

  // Bar phase: the strongest onset anchors step 0 (a loop's downbeat is its
  // loudest attack far more often than its literal first sample).
  let anchor = 0;
  for (let i = 0; i < refined.length; i++) if (refined[i].strength > refined[anchor].strength) anchor = i;
  const barStart = refined[anchor].time;

  const timing = new Array<number>(steps).fill(0);
  const accent = new Array<number>(steps).fill(0);
  const oddDeviations: number[] = [];
  for (const { time, strength } of refined) {
    const pos = (((time - barStart) % barSec) + barSec) % barSec;
    const stepFloat = pos / stepSec;
    const k = ((Math.round(stepFloat) % steps) + steps) % steps;
    const deviation = stepFloat - Math.round(stepFloat); // −0.5..0.5 steps
    const level = strength / maxStrength;
    // Strongest onset wins the slot; timing follows the strongest claimant.
    if (level >= accent[k]) {
      accent[k] = level;
      timing[k] = Math.max(-1, Math.min(1, deviation / TIMING_FULL_SCALE_STEPS));
    }
    // 8th-note offbeats (slots ≡ 2 mod 4) are where classic swing lives.
    if (k % 4 === 2 && level > 0.25) oddDeviations.push(Math.max(0, deviation));
  }

  // Classic swing fit: mean late shift of odd-16th onsets, where a full
  // triplet delay (⅓ step) equals swing 1.
  let swing = 0;
  if (oddDeviations.length > 0) {
    swing = Math.min(1, oddDeviations.reduce((a, b) => a + b, 0) / oddDeviations.length / (1 / 3));
  }

  // Dead steps (no loop onset) contribute nothing: accent 0, timing 0.
  return { timing, accent, swing: Math.round(swing * 100) / 100 };
}
