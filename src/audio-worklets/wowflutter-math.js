/**
 * WOW & FLUTTER — shared modulation math.
 *
 * This module exists because the effect has TWO consumers that must never
 * disagree: the AudioWorklet processor, which spends the swing budget, and the
 * panel readout, which has to tell the user what the budget actually delivered.
 * The readout was previously impossible to write honestly: the functions lived
 * inside the processor module, which references AudioWorkletProcessor at class-
 * definition time, so importing it from the UI bundle throws instead of
 * returning a number.
 *
 * So the math lives here, in a plain module with no worklet globals, and the
 * processor imports it. `wfSwingPlan` is not a re-implementation of the
 * processor's allocation — it IS the processor's allocation, extracted. A second
 * copy would be a second set of numbers to keep honest, which is the exact
 * failure mode this file removes.
 */

/** Base delay in seconds. This is the ONLY latency the effect adds, so it is
 *  also the budget for the modulation swing: the read offset is centred as
 *  `base + swing/2 + wobble`, so keeping `swing <= base` guarantees the read
 *  never reaches the write pointer and never goes negative.
 *
 *  10 ms is what makes the CENTS scale reachable. Delivering C cents at rate f
 *  needs a delay amplitude of `r / (2*pi*f)` seconds, and the slowest rate in
 *  range (0.05 Hz) is where that is largest. With a 4 ms base the 60-cent end of
 *  the knob is unreachable below ~1.2 Hz; with 10 ms the full 60 cents is exact
 *  from 0.5 Hz up, and `wfAchievableCents` reports the truth below that. The
 *  price is 10 ms of insert latency, which is ordinary for a musical
 *  time-based effect. */
export const WF_BASE_DELAY_SECONDS = 0.01;
/** Read-offset floor: one sample, so the read is strictly behind the write. */
export const WF_MIN_OFFSET_SAMPLES = 1;
/** Peak pitch wander the drift walk is allowed to contribute, in cents, at
 *  `drift = 1`. Realised below that by measurement — a smoothed random walk
 *  does not reach the nominal amplitude of the sine it is converted from. */
export const WF_DRIFT_MAX_CENTS = 6;
/** Characteristic rate of the drift walk. The one-pole smoother runs at 3 Hz and
 *  the target re-picks every 350 ms, so 3 Hz is the frequency its conversion
 *  has to be expressed at. */
export const WF_DRIFT_RATE_HZ = 3;

/**
 * Convert a pitch deviation in CENTS into the delay-modulation amplitude, in
 * seconds, needed to produce it at a given rate.
 *
 * The output at time t is the input at r(t) = t - D(t). For an input tone of
 * frequency f0 the output phase is 2*pi*f0*r(t), so the instantaneous
 * output/input frequency ratio is exactly dr/dt = 1 - dD/dt. For
 * D(t) = Dmean + A*sin(2*pi*f*t) the derivative peaks at A*2*pi*f, giving
 *
 *     A = r / (2 * pi * f),        r = 1 - 2^(-cents/1200)
 *
 * Note what is NOT here: a factor of D. The familiar `dD/dt / D` is the
 * granular/resampling law, where D counts how many samples are consumed per
 * output sample. A continuously modulated delay line does not work that way —
 * dividing by D produced exactly `1/baseDelay` = 250x too little modulation
 * (measured: a 10-cent depth moved the pitch 0.02 cents), and the halved
 * `wobble` in the caller doubled that error to 500x.
 *
 * `r` is written as `1 - 2^(-cents/1200)` rather than `2^(cents/1200) - 1`
 * because the deviation is subtractive: pitch goes DOWN as the delay grows.
 * The two differ by 3.4% at 60 cents, which is not noise at this scale.
 *
 * Pure and exported so the conversion can be unit-tested directly instead of
 * being inferred from rendered audio.
 */
export function wfCentsToAmplitudeSeconds(cents, rateHz) {
  if (!Number.isFinite(cents) || !Number.isFinite(rateHz)) return 0;
  const rate = Math.max(rateHz, 1e-4);
  const deviation = 1 - Math.pow(2, -Math.abs(cents) / 1200); // frequency ratio - 1
  return deviation / (2 * Math.PI * rate);
}

/** Inverse of the above, clamped to a swing budget. */
export function wfAchievableCents(cents, rateHz, maxAmplitudeSeconds) {
  const wanted = wfCentsToAmplitudeSeconds(cents, rateHz);
  if (!Number.isFinite(wanted) || !Number.isFinite(maxAmplitudeSeconds)) return 0;
  if (wanted <= maxAmplitudeSeconds) return Math.abs(cents);
  const rate = Math.max(rateHz, 1e-4);
  const deviation = maxAmplitudeSeconds * 2 * Math.PI * rate;
  if (!(deviation < 1)) return 0;
  return -1200 * Math.log2(1 - deviation);
}

/** Swing budget in seconds for a given sample rate: the whole ring delay minus
 *  the one-sample read-offset floor, exactly as the processor computes it
 *  (`maxSwingSamples = baseSamples - 1`, in seconds).
 *
 *  Callers that do not know the hardware rate may pass 48000: across
 *  44.1 / 48 / 96 kHz this budget moves by 1.2 microseconds, which at the slow
 *  rates where it actually binds is worth well under 0.1 cents of readout. */
export function wfSwingBudgetSeconds(sampleRate) {
  const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
  const baseSamples = Math.max(WF_MIN_OFFSET_SAMPLES, Math.round(sr * WF_BASE_DELAY_SECONDS));
  const maxSwingSamples = Math.max(1, baseSamples - WF_MIN_OFFSET_SAMPLES);
  return maxSwingSamples / sr;
}

/**
 * The processor's swing allocation, extracted verbatim.
 *
 * Each term is clamped to the swing budget, and if the terms together overflow
 * it they are scaled down PROPORTIONALLY so the relative balance between wow,
 * flutter and drift survives the clamp. A proportional scale is also the honest
 * answer: when the budget bites, the deepest term is the one being asked for
 * beyond what the buffer can do, and every term comes back smaller by the same
 * factor rather than one term silently vanishing.
 *
 * `drift` is deliberately NOT a factor here, matching the processor: the walk's
 * target is `(rng*2-1) * driftAmt`, so `driftAmp` is a valid bound for the term
 * at any setting and the full amount is reserved. Reserving at drift = 0 costs
 * 1.8% of the budget — a conservative, documented choice, not an oversight, and
 * replicating it here is what keeps the readout honest.
 *
 * Returns the allocated amplitudes AND the cents each term actually ends up
 * delivering, so a UI can print the achieved value without re-deriving it.
 */
export function wfSwingPlan({
  wowDepth = 0,
  wowRate = 0.5,
  flutterDepth = 0,
  flutterRate = 11,
  sampleRate = 48000,
} = {}) {
  const budget = wfSwingBudgetSeconds(sampleRate);
  let wowAmp = Math.min(wfCentsToAmplitudeSeconds(wowDepth, wowRate), budget);
  let flutterAmp = Math.min(wfCentsToAmplitudeSeconds(flutterDepth, flutterRate), budget);
  let driftAmp = Math.min(wfCentsToAmplitudeSeconds(WF_DRIFT_MAX_CENTS, WF_DRIFT_RATE_HZ), budget);
  const total = wowAmp + flutterAmp + driftAmp;
  let scale = 1;
  if (total > budget) {
    scale = budget / total;
    wowAmp *= scale;
    flutterAmp *= scale;
    driftAmp *= scale;
  }
  return {
    budget,
    scale,
    wowAmp,
    flutterAmp,
    driftAmp,
    wowCents: wfAchievableCents(wowDepth, wowRate, wowAmp),
    flutterCents: wfAchievableCents(flutterDepth, flutterRate, flutterAmp),
  };
}
