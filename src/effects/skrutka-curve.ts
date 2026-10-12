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
export const SKRUTKA_PUNCH_R_HARD_MAX = 0.97; // ceiling for the DYNAMIC PUNCH drive
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
  /** Signed envelope drive; either polarity can increase the radius. */
  dyn?: number;
  /** 0 = OFF, 1 = PUMP, 2 = DUCK, with fractional transition states. */
  keyMode?: number;
  /** Dry/wet blend at the output stage. Omitted means fully wet. */
  mix?: number;
  /** Output gain in dB, applied after the dry/wet blend. */
  output?: number;
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
  const resoBlend = clamp(clamp(shape, 0, 3) - 2, 0, 1);
  const regular = SKRUTKA_R_FLOOR + SKRUTKA_R_RANGE * clamp(dispersion, 0, 1);
  const reso = SKRUTKA_RESO_R_FLOOR + SKRUTKA_RESO_R_RANGE * clamp(dispersion, 0, 1);
  const radius = resoBlend <= 0 ? regular : resoBlend >= 1 ? reso : regular + (reso - regular) * resoBlend;
  return clamp(radius, 0.05, SKRUTKA_R_MAX);
}

/** Per-section FOCUS multipliers for a shape (matches the processor). */
export function skrutkaSectionFactors(shape: number): number[] {
  const out: number[] = [];
  const boundedShape = clamp(shape, 0, 3);
  const shapeIndex = Math.min(2, Math.floor(boundedShape));
  const shapeBlend = boundedShape - shapeIndex;
  for (let s = 0; s < SKRUTKA_LONG_SECTIONS; s++) {
    const factorAt = (index: number) => {
      if (index === 1) return 0.5 * Math.pow(4, s / (SKRUTKA_LONG_SECTIONS - 1)); // CHIRP
      if (index === 2) return s % 2 === 0 ? 1 / SKRUTKA_PUNCH_BAND_RATIO : SKRUTKA_PUNCH_BAND_RATIO; // DOUBLE
      return 1; // GULP / RESO
    };
    const from = factorAt(shapeIndex);
    const to = factorAt(shapeIndex + 1);
    out.push(shapeBlend <= 0 ? from : shapeBlend >= 1 ? to : from + (to - from) * shapeBlend);
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
 * Focus pole frequency for one chain after the SPREAD/FIELD offset.
 * L/R are the legacy stereo chains; in FIELD mode the first chain glides from
 * the left offset toward center while the second chain keeps the side offset.
 */
export function skrutkaFocusForChannel(focusHz: number, spread: number, channel: SkrutkaChannel, field = 1): number {
  const f = clamp(focusHz, SKRUTKA_FOCUS_MIN_HZ, SKRUTKA_FOCUS_MAX_HZ);
  const s = clamp(spread, 0, 1);
  const fieldBlend = clamp(Math.abs(field), 0, 1);
  const factor =
    channel === "M"
      ? 1 - SKRUTKA_SPREAD_OFFSET * s * (1 - fieldBlend)
      : channel === "L"
        ? 1 - SKRUTKA_SPREAD_OFFSET * s
        : 1 + SKRUTKA_SPREAD_OFFSET * s;
  return clamp(f * factor, SKRUTKA_FOCUS_MIN_HZ, SKRUTKA_SECTION_MAX_HZ);
}

export interface SkrutkaDynRadiusRange {
  /** Static base radius (dyn/key inactive). */
  base: number;
  /** Lowest radius reachable through the active KEY mode. */
  min: number;
  /** Highest radius reachable through DYNAMIC and KEY PUMP. */
  max: number;
}

/** Reachable radius range for the envelope and sidechain controls. */
export function skrutkaDynRadiusRange(params: SkrutkaCurveParams): SkrutkaDynRadiusRange {
  const base = skrutkaRadius(params.dispersion, params.shape ?? 0);
  const keyMode = clamp(params.keyMode ?? 0, 0, 2);
  const pumpBlend = keyMode < 1 ? keyMode : 2 - keyMode;
  const duckBlend = keyMode < 1 ? 0 : keyMode - 1;
  const keyDelta = pumpBlend * (SKRUTKA_R_HARD_MAX - base) - duckBlend * base * 0.7;
  const dynamicHeadroom = Math.abs(clamp(params.dyn ?? 0, -1, 1)) * (SKRUTKA_R_HARD_MAX - base);
  return {
    base,
    min: clamp(Math.min(base, base + keyDelta), 0.05, SKRUTKA_R_HARD_MAX),
    max: clamp(Math.max(base + dynamicHeadroom, base + dynamicHeadroom + keyDelta), 0.05, SKRUTKA_R_HARD_MAX),
  };
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

const COMPLEX_ONE: Complex = { re: 1, im: 0 };

function complexAdd(a: Complex, b: Complex): Complex {
  return { re: a.re + b.re, im: a.im + b.im };
}

function complexScale(value: Complex, amount: number): Complex {
  return { re: value.re * amount, im: value.im * amount };
}

function complexMultiply(a: Complex, b: Complex): Complex {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}

function allPassCascadeAt(omega: number, focusHz: number, sampleRate: number, radius: number, shape: number): Complex {
  const factors = skrutkaSectionFactors(shape);
  let response = COMPLEX_ONE;
  for (const factor of factors) {
    const sectionHz = clamp(focusHz * factor, SKRUTKA_SECTION_MIN_HZ, SKRUTKA_SECTION_MAX_HZ);
    const w0 = Math.min((2 * Math.PI * sectionHz) / sampleRate, Math.PI * 0.95);
    const c1 = -2 * radius * Math.cos(w0);
    response = complexMultiply(response, biquadAllpassAt(omega, c1, radius * radius));
  }
  return response;
}

function punchTransferAt(params: SkrutkaCurveParams, sampleRate: number, omega: number, punchRadius: number): Complex {
  const punchMix = clamp(params.punchMix ?? 1, 0, 1);
  if (punchRadius <= 1e-4 || punchMix <= 1e-4) return COMPLEX_ONE;
  const punchFocus = skrutkaPunchFocus(params.focusHz, params.punch, params.punchHz ?? 0, sampleRate);
  const wPunch = Math.min((2 * Math.PI * punchFocus) / sampleRate, Math.PI * 0.95);
  const c1 = -2 * punchRadius * Math.cos(wPunch);
  let punchWet = COMPLEX_ONE;
  for (let section = 0; section < SKRUTKA_PUNCH_SECTIONS; section++) {
    punchWet = complexMultiply(punchWet, biquadAllpassAt(omega, c1, punchRadius * punchRadius));
  }
  return complexAdd(complexScale(COMPLEX_ONE, 1 - punchMix), complexScale(punchWet, punchMix));
}

/**
 * Exact complex transfer for one diagonal L/R or M/S component at the output.
 * It includes the FIELD dry/dispersed blend, PUNCH parallel blend, rack MIX,
 * and OUTPUT gain. In intermediate FIELD states the M/S channels can crossfeed;
 * this returns the exact response for a unit input on the selected component.
 */
export function skrutkaOutputTransferAt(
  params: SkrutkaCurveParams,
  sampleRate: number,
  freqHz: number,
  channel: SkrutkaChannel = "L",
  radiusOverride?: number,
  punchRadiusOverride?: number,
): Complex {
  const omega = clamp((2 * Math.PI * freqHz) / sampleRate, 1e-4, Math.PI - 1e-4);
  const shape = clamp(params.shape ?? 0, 0, 3);
  const radius = radiusOverride ?? skrutkaRadius(params.dispersion, shape);
  const punchRadius = punchRadiusOverride ?? skrutkaPunchRadius(params.punch);
  const field = clamp(params.field ?? 0, -1, 1);
  const fieldActive = Math.abs(field) > 1e-4;
  let longTransfer: Complex;

  if (!fieldActive) {
    const focus = skrutkaFocusForChannel(params.focusHz, params.spread, channel, field);
    longTransfer = allPassCascadeAt(omega, focus, sampleRate, radius, shape);
  } else {
    const focusA = skrutkaFocusForChannel(params.focusHz, params.spread, "M", field);
    const focusB = skrutkaFocusForChannel(params.focusHz, params.spread, "S", field);
    const transferA = allPassCascadeAt(omega, focusA, sampleRate, radius, shape);
    const transferB = allPassCascadeAt(omega, focusB, sampleRate, radius, shape);
    const angle = Math.abs(field) * (Math.PI / 4);
    const cross = Math.cos(angle) * Math.sin(angle);
    const average = complexScale(complexAdd(transferA, transferB), 0.5);
    const rawDifference = complexAdd(transferA, complexScale(transferB, -1));
    const difference = complexScale(rawDifference, cross);
    const midDiagonal = complexAdd(average, difference);
    const sideDiagonal = complexAdd(average, complexScale(difference, -1));
    const crossfeed = complexScale(rawDifference, Math.cos(2 * angle) * 0.5);
    const amounts = skrutkaFieldAmounts(field);
    const midAmount = amounts.mid;
    const sideAmount = amounts.side;
    const midOut = complexAdd(complexScale(COMPLEX_ONE, 1 - midAmount), complexScale(midDiagonal, midAmount));
    const sideOut = complexAdd(complexScale(COMPLEX_ONE, 1 - sideAmount), complexScale(sideDiagonal, sideAmount));
    const midToSide = complexScale(crossfeed, sideAmount);
    const sideToMid = complexScale(crossfeed, midAmount);
    if (channel === "M") longTransfer = midOut;
    else if (channel === "S") longTransfer = sideOut;
    else if (channel === "L") {
      longTransfer = complexScale(complexAdd(complexAdd(midOut, sideOut), complexAdd(midToSide, sideToMid)), 0.5);
    } else {
      longTransfer = complexScale(
        complexAdd(complexAdd(midOut, sideOut), complexScale(complexAdd(midToSide, sideToMid), -1)),
        0.5,
      );
    }
  }

  const punch = punchTransferAt(params, sampleRate, omega, punchRadius);
  const wetTransfer = complexMultiply(longTransfer, punch);
  const mix = clamp(params.mix ?? 1, 0, 1);
  const mixedTransfer = complexAdd(complexScale(COMPLEX_ONE, 1 - mix), complexScale(wetTransfer, mix));
  const outputGain = Math.pow(10, clamp(params.output ?? 0, -18, 12) / 20);
  return complexScale(mixedTransfer, outputGain);
}

/** Output magnitude including OUTPUT gain, bounded to a finite dB range. */
export function skrutkaOutputMagnitudeDbAt(
  params: SkrutkaCurveParams,
  sampleRate: number,
  freqHz: number,
  channel: SkrutkaChannel = "L",
  radiusOverride?: number,
  punchRadiusOverride?: number,
): number {
  const response = skrutkaOutputTransferAt(params, sampleRate, freqHz, channel, radiusOverride, punchRadiusOverride);
  return clamp(20 * Math.log10(Math.max(Math.hypot(response.re, response.im), 1e-6)), -120, 60);
}

/**
 * Local output group delay in samples. A deep cancellation null has no stable
 * phase derivative, so it returns null; the magnitude plot exposes that null.
 */
export function skrutkaOutputGroupDelaySamples(
  params: SkrutkaCurveParams,
  sampleRate: number,
  freqHz: number,
  channel: SkrutkaChannel = "L",
  radiusOverride?: number,
  punchRadiusOverride?: number,
): number | null {
  const omega = clamp((2 * Math.PI * freqHz) / sampleRate, 1e-4, Math.PI - 1e-4);
  const at = (w: number) =>
    skrutkaOutputTransferAt(
      params,
      sampleRate,
      (w * sampleRate) / (2 * Math.PI),
      channel,
      radiusOverride,
      punchRadiusOverride,
    );
  const center = at(omega);
  const plus = at(omega + PHASE_DELTA);
  const minus = at(omega - PHASE_DELTA);
  const floor = 1e-5; // −100 dB: phase is not actionable below this response level.
  if (
    Math.hypot(center.re, center.im) < floor ||
    Math.hypot(plus.re, plus.im) < floor ||
    Math.hypot(minus.re, minus.im) < floor
  )
    return null;
  const cross = plus.im * minus.re - plus.re * minus.im;
  const dot = plus.re * minus.re + plus.im * minus.im;
  return -Math.atan2(cross, dot) / (2 * PHASE_DELTA);
}

/** Log-spaced full output response, used by the OUTPUT DELAY and OUTPUT LEVEL views. */
export function skrutkaOutputComponentCurve(
  params: SkrutkaCurveParams,
  sampleRate: number,
  channel: SkrutkaChannel,
  points = 160,
  fLo = 30,
  fHi = 16000,
  radiusOverride?: number,
  punchRadiusOverride?: number,
  measure: "delay" | "level" | "both" = "both",
): { freqHz: number; ms: number | null; db: number }[] {
  const out: { freqHz: number; ms: number | null; db: number }[] = [];
  const ratio = Math.log(fHi / fLo);
  for (let i = 0; i < points; i++) {
    const freqHz = fLo * Math.exp((i / (points - 1)) * ratio);
    out.push({
      freqHz,
      ms:
        measure === "level"
          ? null
          : ((skrutkaOutputGroupDelaySamples(
              params,
              sampleRate,
              freqHz,
              channel,
              radiusOverride,
              punchRadiusOverride,
            ) ?? Number.NaN) /
              sampleRate) *
            1000,
      db:
        measure === "delay"
          ? 0
          : skrutkaOutputMagnitudeDbAt(params, sampleRate, freqHz, channel, radiusOverride, punchRadiusOverride),
    });
  }
  return out;
}

/** Phase (radians) of the full wet chain at ω: long cascade + punch blend. */
function skrutkaPhaseAt(
  params: SkrutkaCurveParams,
  sampleRate: number,
  omega: number,
  channel: SkrutkaChannel,
  radiusOverride?: number,
  punchRadiusOverride?: number,
): number {
  // SHAPE is a discrete project choice, but the worklet glides through its
  // fractional values during automation and snapshot morphs. Keep the model
  // continuous too so the panel curve follows the coefficients the DSP uses.
  const shape = clamp(params.shape ?? 0, 0, 3);
  const radius = radiusOverride ?? skrutkaRadius(params.dispersion, shape);
  const c2 = radius * radius;
  const focus = skrutkaFocusForChannel(params.focusHz, params.spread, channel, params.field ?? 0);
  const factors = skrutkaSectionFactors(shape);
  let phase = 0;
  for (let s = 0; s < SKRUTKA_LONG_SECTIONS; s++) {
    const f = clamp(focus * factors[s], SKRUTKA_SECTION_MIN_HZ, SKRUTKA_SECTION_MAX_HZ);
    const w0 = Math.min((2 * Math.PI * f) / sampleRate, Math.PI * 0.95);
    const c1 = -2 * radius * Math.cos(w0);
    const h = biquadAllpassAt(omega, c1, c2);
    phase += Math.atan2(h.im, h.re);
  }
  const punchRadius = punchRadiusOverride ?? skrutkaPunchRadius(params.punch);
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
/**
 * Group delay of the full wet chain at `freqHz`, in samples. The phase is
 * evaluated as the sum of principal (`atan2`) phases, so the ±δ neighbours
 * are unwrapped against the center value before the central difference —
 * a branch crossing (high-Q punch blend) would otherwise read as a 2π jump.
 */
export function skrutkaGroupDelaySamples(
  params: SkrutkaCurveParams,
  sampleRate: number,
  freqHz: number,
  channel: SkrutkaChannel = "L",
  radiusOverride?: number,
  punchRadiusOverride?: number,
): number {
  const omega = clamp((2 * Math.PI * freqHz) / sampleRate, 1e-4, Math.PI - 1e-4);
  const phi0 = skrutkaPhaseAt(params, sampleRate, omega, channel, radiusOverride, punchRadiusOverride);
  const phiPlus = skrutkaPhaseAt(params, sampleRate, omega + PHASE_DELTA, channel, radiusOverride, punchRadiusOverride);
  const phiMinus = skrutkaPhaseAt(
    params,
    sampleRate,
    omega - PHASE_DELTA,
    channel,
    radiusOverride,
    punchRadiusOverride,
  );
  const unwrap = (v: number) => v + 2 * Math.PI * Math.round((phi0 - v) / (2 * Math.PI));
  return -(unwrap(phiPlus) - unwrap(phiMinus)) / (2 * PHASE_DELTA);
}

/** Group delay at `freqHz` for a specific pole radius (panel's live dot). */
export function skrutkaDelayAt(
  params: SkrutkaCurveParams,
  sampleRate: number,
  freqHz: number,
  radius: number,
  channel: SkrutkaChannel = "L",
  punchRadiusOverride?: number,
): number {
  return skrutkaGroupDelaySamples(params, sampleRate, freqHz, channel, radius, punchRadiusOverride);
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
  punchRadiusOverride?: number,
): { freqHz: number; ms: number }[] {
  const out: { freqHz: number; ms: number }[] = [];
  const ratio = Math.log(fHi / fLo);
  for (let i = 0; i < points; i++) {
    const freqHz = fLo * Math.exp((i / (points - 1)) * ratio);
    out.push({
      freqHz,
      ms:
        (skrutkaGroupDelaySamples(params, sampleRate, freqHz, channel, radiusOverride, punchRadiusOverride) /
          sampleRate) *
        1000,
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
  radiusOverride?: number,
  punchRadiusOverride?: number,
): { ms: number; freqHz: number } {
  let best = { ms: 0, freqHz: 0 };
  for (const point of skrutkaComponentCurve(
    params,
    sampleRate,
    channel,
    240,
    30,
    16000,
    radiusOverride,
    punchRadiusOverride,
  )) {
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
