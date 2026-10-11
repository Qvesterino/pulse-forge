/**
 * SKRUTKA group-delay model — the pure analog of skrutka-processor.js.
 *
 * The processor is a cascade of identical all-pass sections; its group delay
 * is a closed-form function of (dispersion, punch, focusHz, spread), so the
 * panel curve and the tests evaluate the SAME math the worklet runs, without
 * rendering: an all-pass section has |H| = 1, and the total cascade group
 * delay is the sum of the per-section delays.
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
export const SKRUTKA_PUNCH_R_MAX = 0.93;
export const SKRUTKA_PUNCH_BAND_RATIO = 3.5;
export const SKRUTKA_PUNCH_FOCUS_MAX_HZ = 6000;
export const SKRUTKA_SPREAD_OFFSET = 0.12;
export const SKRUTKA_FOCUS_MIN_HZ = 40; // descriptor floor
export const SKRUTKA_FOCUS_MAX_HZ = 4000; // descriptor ceiling

export interface SkrutkaCurveParams {
  dispersion: number;
  punch: number;
  focusHz: number;
  spread: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Pole radius of the DISPERSION stage (matches the processor). */
export function skrutkaRadius(dispersion: number): number {
  return clamp(SKRUTKA_R_FLOOR + SKRUTKA_R_RANGE * clamp(dispersion, 0, 1), 0.05, SKRUTKA_R_MAX);
}

/** Pole radius of the PUNCH stage (matches the processor). */
export function skrutkaPunchRadius(punch: number): number {
  return SKRUTKA_PUNCH_R_MAX * Math.abs(clamp(punch, -1, 1));
}

/** Center frequency of the PUNCH stage: sign picks the band (matches the processor). */
export function skrutkaPunchFocus(focusHz: number, punch: number, sampleRate: number): number {
  const f = clamp(focusHz, SKRUTKA_FOCUS_MIN_HZ, SKRUTKA_FOCUS_MAX_HZ);
  const center = punch >= 0 ? f / SKRUTKA_PUNCH_BAND_RATIO : f * SKRUTKA_PUNCH_BAND_RATIO;
  return clamp(center, SKRUTKA_FOCUS_MIN_HZ, Math.min(SKRUTKA_PUNCH_FOCUS_MAX_HZ, sampleRate * 0.45));
}

/** Focus pole frequency for one channel after the SPREAD offset. */
export function skrutkaFocusForChannel(focusHz: number, spread: number, channel: "L" | "R"): number {
  const f = clamp(focusHz, SKRUTKA_FOCUS_MIN_HZ, SKRUTKA_FOCUS_MAX_HZ);
  const s = clamp(spread, 0, 1);
  const factor = channel === "L" ? 1 - SKRUTKA_SPREAD_OFFSET * s : 1 + SKRUTKA_SPREAD_OFFSET * s;
  return clamp(f * factor, SKRUTKA_FOCUS_MIN_HZ, 6000);
}

/** Phase (radians) of the 2nd-order all-pass biquad at ω (c1 = −2r·cosω0, c2 = r²). */
function biquadAllpassPhase(omega: number, c1: number, c2: number): number {
  const cos1 = Math.cos(omega);
  const sin1 = Math.sin(omega);
  const cos2 = Math.cos(2 * omega);
  const sin2 = Math.sin(2 * omega);
  const numRe = c2 + c1 * cos1 + cos2;
  const numIm = -c1 * sin1 - sin2;
  const denRe = 1 + c1 * cos1 + c2 * cos2;
  const denIm = -c1 * sin1 - c2 * sin2;
  return Math.atan2(numIm, numRe) - Math.atan2(denIm, denRe);
}

const PHASE_DELTA = 1e-3; // rad, central difference for −dφ/dω

/** Group delay of the full wet chain (long + punch) at `freqHz`, in samples. */
export function skrutkaGroupDelaySamples(
  params: SkrutkaCurveParams,
  sampleRate: number,
  freqHz: number,
  channel: "L" | "R" = "L",
): number {
  const omega = clamp((2 * Math.PI * freqHz) / sampleRate, 1e-4, Math.PI - 1e-4);
  const radius = skrutkaRadius(params.dispersion);
  const c2 = radius * radius;
  const w0 = Math.min(
    (2 * Math.PI * skrutkaFocusForChannel(params.focusHz, params.spread, channel)) / sampleRate,
    Math.PI * 0.95,
  );
  const c1 = -2 * radius * Math.cos(w0);
  const longDelay =
    SKRUTKA_LONG_SECTIONS *
    (-(biquadAllpassPhase(omega + PHASE_DELTA, c1, c2) - biquadAllpassPhase(omega - PHASE_DELTA, c1, c2)) /
      (2 * PHASE_DELTA));
  const punchRadius = skrutkaPunchRadius(params.punch);
  if (punchRadius <= 1e-4) return longDelay;
  const wPunch = Math.min(
    (2 * Math.PI * skrutkaPunchFocus(params.focusHz, params.punch, sampleRate)) / sampleRate,
    Math.PI * 0.95,
  );
  const pc2 = punchRadius * punchRadius;
  const pc1 = -2 * punchRadius * Math.cos(wPunch);
  const punchDelay =
    SKRUTKA_PUNCH_SECTIONS *
    (-(biquadAllpassPhase(omega + PHASE_DELTA, pc1, pc2) - biquadAllpassPhase(omega - PHASE_DELTA, pc1, pc2)) /
      (2 * PHASE_DELTA));
  return longDelay + punchDelay;
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
  const out: SkrutkaCurvePoint[] = [];
  const ratio = Math.log(fHi / fLo);
  for (let i = 0; i < points; i++) {
    const freqHz = fLo * Math.exp((i / (points - 1)) * ratio);
    out.push({
      freqHz,
      lMs: (skrutkaGroupDelaySamples(params, sampleRate, freqHz, "L") / sampleRate) * 1000,
      rMs: (skrutkaGroupDelaySamples(params, sampleRate, freqHz, "R") / sampleRate) * 1000,
    });
  }
  return out;
}

/** Peak group delay of the L channel (ms) and the frequency it lands at. */
export function skrutkaPeakDelay(params: SkrutkaCurveParams, sampleRate: number): { ms: number; freqHz: number } {
  let best = { ms: 0, freqHz: 0 };
  for (const point of skrutkaCurve(params, sampleRate, 240)) {
    if (point.lMs > best.ms) best = { ms: point.lMs, freqHz: point.freqHz };
  }
  return best;
}
