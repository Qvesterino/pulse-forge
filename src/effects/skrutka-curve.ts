/**
 * TWIST group-delay model — the pure analog of skrutka-processor.js (v2).
 *
 * The processor is a cascade of all-pass sections plus a punch stage blended
 * against the long output; its group delay is a closed-form function of the
 * static parameters, so the panel curve and the tests evaluate the SAME math
 * the worklet runs, without rendering. An all-pass section has |H| = 1, so
 * the cascade phase is the sum of section phases; the punch MIX blend is a
 * complex sum (1 − pm) + pm·H_punch evaluated exactly.
 *
 * The DYNAMIC (envelope) and KEY (sidechain) radius drives are
 * signal-dependent and cannot be drawn as one curve: `skrutkaDynRadiusRange`
 * exposes the base radius and the driven ceiling for the shaded band, and
 * `skrutkaLfoFocusRange` exposes the FOCUS sweep range for the MOTION band.
 *
 * Keep the constants in lockstep with src/audio-worklets/skrutka-processor.js
 * — tests/skrutka-golden.test.ts pins the measured processor phase against
 * this model, so a drift between the two fails loudly.
 */

export const SKRUTKA_LONG_SECTIONS = 8;
export const SKRUTKA_PUNCH_SECTIONS = 3;
export const SKRUTKA_R_FLOOR = 0.15;
export const SKRUTKA_R_RANGE = 0.83;
export const SKRUTKA_R_MAX = 0.985;
export const SKRUTKA_R_HARD_MAX = 0.995;
export const SKRUTKA_RESO_R_FLOOR = 0.45;
export const SKRUTKA_RESO_R_RANGE = 0.53;
export const SKRUTKA_PUNCH_R_MAX = 0.93;
export const SKRUTKA_PUNCH_BAND_RATIO = 3.5;
export const SKRUTKA_PUNCH_FOCUS_MAX_HZ = 6000;
export const SKRUTKA_SPREAD_OFFSET = 0.12;
export const SKRUTKA_FOCUS_MIN_HZ = 40; // descriptor floor
export const SKRUTKA_FOCUS_MAX_HZ = 4000; // descriptor ceiling
export const SKRUTKA_SECTION_MIN_HZ = 20;
export const SKRUTKA_SECTION_MAX_HZ = 8000;

/** SHAPE labels, index = param value. */
export const SKRUTKA_SHAPE_LABELS = ["GULP", "CHIRP", "DOUBLE", "RESO"] as const;

export interface SkrutkaCurveParams {
  dispersion: number;
  punch: number;
  focusHz: number;
  spread: number;
  shape?: number;
  punchHz?: number;
  punchMix?: number;
  /** M/S field (−1 mid-only … +1 side-only); 0 = legacy stereo topology. */
  field?: number;
}

/** Which chain a curve describes: legacy L/R or the M/S field components. */
export type SkrutkaChannel = "L" | "R" | "M" | "S";

/** FIELD crossfade amounts (matches the processor). */
export function skrutkaFieldAmounts(field: number): { mid: number; side: number } {
  const f = clamp(field, -1, 1);
  return { mid: f <= 0 ? 1 : 1 - f, side: f >= 0 ? 1 : 1 + f };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Pole radius of the DISPERSION stage (matches the processor). */
export function skrutkaRadius(dispersion: number, shape = 0): number {
  const reso = Math.round(clamp(shape, 0, 3)) === 3;
  const floor = reso ? SKRUTKA_RESO_R_FLOOR : SKRUTKA_R_FLOOR;
  const span = reso ? SKRUTKA_RESO_R_RANGE : SKRUTKA_R_RANGE;
  return clamp(floor + span * clamp(dispersion, 0, 1), 0.05, SKRUTKA_R_MAX);
}

/** Per-section FOCUS multipliers for a shape (matches the processor). */
export function skrutkaSectionFactors(shape: number): number[] {
  const out: number[] = [];
  for (let s = 0; s < SKRUTKA_LONG_SECTIONS; s++) {
    if (shape === 1)
      out.push(0.5 * Math.pow(4, s / (SKRUTKA_LONG_SECTIONS - 1))); // CHIRP
    else if (shape === 2)
      out.push(s % 2 === 0 ? 1 / SKRUTKA_PUNCH_BAND_RATIO : SKRUTKA_PUNCH_BAND_RATIO); // DOUBLE
    else out.push(1); // GULP / RESO
  }
  return out;
}

/** Pole radius of the PUNCH stage (matches the processor). */
export function skrutkaPunchRadius(punch: number): number {
  return SKRUTKA_PUNCH_R_MAX * Math.abs(clamp(punch, -1, 1));
}

/** Center frequency of the PUNCH stage: explicit punchHz, else AUTO by sign. */
export function skrutkaPunchFocus(focusHz: number, punch: number, punchHz: number, sampleRate: number): number {
  const f = clamp(focusHz, SKRUTKA_FOCUS_MIN_HZ, SKRUTKA_FOCUS_MAX_HZ);
  const center =
    punchHz > 0
      ? clamp(punchHz, 0, SKRUTKA_PUNCH_FOCUS_MAX_HZ)
      : punch >= 0
        ? f / SKRUTKA_PUNCH_BAND_RATIO
        : f * SKRUTKA_PUNCH_BAND_RATIO;
  return clamp(center, SKRUTKA_FOCUS_MIN_HZ, Math.min(SKRUTKA_PUNCH_FOCUS_MAX_HZ, sampleRate * 0.45));
}

/**
 * Focus pole frequency for one chain after the SPREAD offset.
 * L/R are the legacy stereo chains (opposite offsets); M/S are the FIELD
 * components (mid centered, side takes the offset).
 */
export function skrutkaFocusForChannel(focusHz: number, spread: number, channel: SkrutkaChannel): number {
  const f = clamp(focusHz, SKRUTKA_FOCUS_MIN_HZ, SKRUTKA_FOCUS_MAX_HZ);
  const s = clamp(spread, 0, 1);
  const factor =
    channel === "M" ? 1 : channel === "L" ? 1 - SKRUTKA_SPREAD_OFFSET * s : 1 + SKRUTKA_SPREAD_OFFSET * s;
  return clamp(f * factor, SKRUTKA_FOCUS_MIN_HZ, SKRUTKA_SECTION_MAX_HZ);
}

export interface SkrutkaDynRadiusRange {
  /** Static base radius (dyn/key inactive). */
  base: number;
  /** Radius ceiling the dynamic/key drives can reach. */
  driven: number;
}

/** Base radius and the driven ceiling for the panel's shaded band. */
export function skrutkaDynRadiusRange(params: SkrutkaCurveParams): SkrutkaDynRadiusRange {
  return { base: skrutkaRadius(params.dispersion, params.shape ?? 0), driven: SKRUTKA_R_HARD_MAX };
}

/** FOCUS sweep range of the LFO (multiplicative ±depth octaves). */
export function skrutkaLfoFocusRange(focusHz: number, depth: number): { lo: number; hi: number } {
  const f = clamp(focusHz, SKRUTKA_FOCUS_MIN_HZ, SKRUTKA_FOCUS_MAX_HZ);
  const d = clamp(depth, 0, 1);
  return {
    lo: clamp(f * Math.pow(2, -d), SKRUTKA_FOCUS_MIN_HZ, SKRUTKA_FOCUS_MAX_HZ),
    hi: clamp(f * Math.pow(2, d), SKRUTKA_FOCUS_MIN_HZ, SKRUTKA_FOCUS_MAX_HZ),
  };
}

interface Complex {
  re: number;
  im: number;
}

/** 2nd-order all-pass biquad response at ω (c1 = −2r·cosω0, c2 = r²). */
function biquadAllpassAt(omega: number, c1: number, c2: number): Complex {
  const cos1 = Math.cos(omega);
  const sin1 = Math.sin(omega);
  const cos2 = Math.cos(2 * omega);
  const sin2 = Math.sin(2 * omega);
  const numRe = c2 + c1 * cos1 + cos2;
  const numIm = -c1 * sin1 - sin2;
  const denRe = 1 + c1 * cos1 + c2 * cos2;
  const denIm = -c1 * sin1 - c2 * sin2;
  const denMag = denRe * denRe + denIm * denIm;
  if (denMag < 1e-18) return { re: 1, im: 0 };
  return {
    re: (numRe * denRe + numIm * denIm) / denMag,
    im: (numIm * denRe - numRe * denIm) / denMag,
  };
}

/** Phase (radians) of the full wet chain at ω: long cascade + punch blend. */
function skrutkaPhaseAt(
  params: SkrutkaCurveParams,
  sampleRate: number,
  omega: number,
  channel: SkrutkaChannel,
  radiusOverride?: number,
): number {
  const shape = Math.round(clamp(params.shape ?? 0, 0, 3));
  const radius = radiusOverride ?? skrutkaRadius(params.dispersion, shape);
  const c2 = radius * radius;
  const focus = skrutkaFocusForChannel(params.focusHz, params.spread, channel);
  const factors = skrutkaSectionFactors(shape);
  let phase = 0;
  for (let s = 0; s < SKRUTKA_LONG_SECTIONS; s++) {
    const f = clamp(focus * factors[s], SKRUTKA_SECTION_MIN_HZ, SKRUTKA_SECTION_MAX_HZ);
    const w0 = Math.min((2 * Math.PI * f) / sampleRate, Math.PI * 0.95);
    const c1 = -2 * radius * Math.cos(w0);
    const h = biquadAllpassAt(omega, c1, c2);
    phase += Math.atan2(h.im, h.re);
  }
  const punchRadius = skrutkaPunchRadius(params.punch);
  const punchMix = clamp(params.punchMix ?? 1, 0, 1);
  if (punchRadius > 1e-4 && punchMix > 1e-4) {
    const punchFocus = skrutkaPunchFocus(params.focusHz, params.punch, params.punchHz ?? 0, sampleRate);
    const wPunch = Math.min((2 * Math.PI * punchFocus) / sampleRate, Math.PI * 0.95);
    const pc2 = punchRadius * punchRadius;
    const pc1 = -2 * punchRadius * Math.cos(wPunch);
    let punchRe = 1;
    let punchIm = 0;
    for (let s = 0; s < SKRUTKA_PUNCH_SECTIONS; s++) {
      const h = biquadAllpassAt(omega, pc1, pc2);
      const re = punchRe * h.re - punchIm * h.im;
      const im = punchRe * h.im + punchIm * h.re;
      punchRe = re;
      punchIm = im;
    }
    // Parallel blend against unity: B = (1 − pm) + pm·H_punch.
    const blendRe = 1 - punchMix + punchMix * punchRe;
    const blendIm = punchMix * punchIm;
    phase += Math.atan2(blendIm, blendRe);
  }
  return phase;
}

const PHASE_DELTA = 1e-3; // rad, central difference for −dφ/dω

/** Group delay of the full wet chain at `freqHz`, in samples. */
export function skrutkaGroupDelaySamples(
  params: SkrutkaCurveParams,
  sampleRate: number,
  freqHz: number,
  channel: SkrutkaChannel = "L",
  radiusOverride?: number,
): number {
  const omega = clamp((2 * Math.PI * freqHz) / sampleRate, 1e-4, Math.PI - 1e-4);
  const plus = skrutkaPhaseAt(params, sampleRate, omega + PHASE_DELTA, channel, radiusOverride);
  const minus = skrutkaPhaseAt(params, sampleRate, omega - PHASE_DELTA, channel, radiusOverride);
  return -(plus - minus) / (2 * PHASE_DELTA);
}

/** Group delay at `freqHz` for a specific pole radius (panel's live dot). */
export function skrutkaDelayAt(
  params: SkrutkaCurveParams,
  sampleRate: number,
  freqHz: number,
  radius: number,
  channel: SkrutkaChannel = "L",
): number {
  return skrutkaGroupDelaySamples(params, sampleRate, freqHz, channel, radius);
}

export interface SkrutkaCurvePoint {
  freqHz: number;
  /** Group delay in milliseconds for the L channel. */
  lMs: number;
  /** Group delay in milliseconds for the R channel (differs with SPREAD). */
  rMs: number;
}

/** Log-spaced group-delay curve for the panel (30 Hz … 16 kHz). */
export function skrutkaCurve(
  params: SkrutkaCurveParams,
  sampleRate: number,
  points = 160,
  fLo = 30,
  fHi = 16000,
): SkrutkaCurvePoint[] {
  return curveWith(params, sampleRate, undefined, points, fLo, fHi);
}

/** Same curve at a fixed pole radius (the panel's DYNAMIC/KEY driven band). */
export function skrutkaCurveWithRadius(
  params: SkrutkaCurveParams,
  sampleRate: number,
  radius: number,
  points = 160,
  fLo = 30,
  fHi = 16000,
): SkrutkaCurvePoint[] {
  return curveWith(params, sampleRate, radius, points, fLo, fHi);
}

/** One chain's group-delay curve (L/R legacy or M/S field components). */
export function skrutkaComponentCurve(
  params: SkrutkaCurveParams,
  sampleRate: number,
  channel: SkrutkaChannel,
  points = 160,
  fLo = 30,
  fHi = 16000,
  radiusOverride?: number,
): { freqHz: number; ms: number }[] {
  const out: { freqHz: number; ms: number }[] = [];
  const ratio = Math.log(fHi / fLo);
  for (let i = 0; i < points; i++) {
    const freqHz = fLo * Math.exp((i / (points - 1)) * ratio);
    out.push({
      freqHz,
      ms: (skrutkaGroupDelaySamples(params, sampleRate, freqHz, channel, radiusOverride) / sampleRate) * 1000,
    });
  }
  return out;
}

function curveWith(
  params: SkrutkaCurveParams,
  sampleRate: number,
  radius: number | undefined,
  points: number,
  fLo: number,
  fHi: number,
): SkrutkaCurvePoint[] {
  const out: SkrutkaCurvePoint[] = [];
  const ratio = Math.log(fHi / fLo);
  for (let i = 0; i < points; i++) {
    const freqHz = fLo * Math.exp((i / (points - 1)) * ratio);
    out.push({
      freqHz,
      lMs: (skrutkaGroupDelaySamples(params, sampleRate, freqHz, "L", radius) / sampleRate) * 1000,
      rMs: (skrutkaGroupDelaySamples(params, sampleRate, freqHz, "R", radius) / sampleRate) * 1000,
    });
  }
  return out;
}

/** Peak group delay of one chain (ms) and the frequency it lands at. */
export function skrutkaPeakDelay(
  params: SkrutkaCurveParams,
  sampleRate: number,
  channel: SkrutkaChannel = "L",
): { ms: number; freqHz: number } {
  let best = { ms: 0, freqHz: 0 };
  for (const point of skrutkaComponentCurve(params, sampleRate, channel, 240)) {
    if (point.ms > best.ms) best = { ms: point.ms, freqHz: point.freqHz };
  }
  return best;
}

/**
 * Invert the peak-delay mapping: find the dispersion whose L-channel peak
 * delay is closest to `targetMs` (panel drag → knob). Bisection over the
 * monotone region is stable enough for a pointer gesture; 20 iterations.
 */
export function skrutkaDispersionForPeakMs(base: SkrutkaCurveParams, sampleRate: number, targetMs: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    const peak = skrutkaPeakDelay({ ...base, dispersion: mid }, sampleRate).ms;
    if (peak < targetMs) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
