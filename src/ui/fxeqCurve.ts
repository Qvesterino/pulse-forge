/**
 * FXEQ panel — per-band EQ magnitude response for the paint-editor canvas.
 *
 * Pure math shared with the vendored core: the overlay must draw the SAME
 * transfer function the DSP applies (RBJ cookbook sections on the biquad
 * primitive), so the coefficients are built with the core's own setters and
 * evaluated on the unit circle.
 *
 * This module is UI-side only — no audio state, safe to call per frame.
 */
import {
  setHighShelf,
  setLowShelf,
  setPeaking,
  type BiquadCoeffs,
} from "../effects/fxeq-core/dsp/biquad";

/** The band-EQ parameters the curve responds to (band-prefix stripped). */
export interface BandEqCurveParams {
  enabled: number;
  lowFreq: number;
  lowGainDb: number;
  peak1Freq: number;
  peak1GainDb: number;
  peak1Q: number;
  peak2Freq: number;
  peak2GainDb: number;
  peak2Q: number;
  highFreq: number;
  highGainDb: number;
}

/** Scratch coefficient sets — the setters are pure math, no DSP state. */
const lowShelfCoeffs: BiquadCoeffs = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
const peak1Coeffs: BiquadCoeffs = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
const peak2Coeffs: BiquadCoeffs = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
const highShelfCoeffs: BiquadCoeffs = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };

/** Magnitude of one normalized biquad at freqHz, in dB. */
export function biquadMagnitudeDb(c: BiquadCoeffs, freqHz: number, sampleRate: number): number {
  const w = (2 * Math.PI * freqHz) / sampleRate;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const c2w = Math.cos(2 * w);
  const s2w = Math.sin(2 * w);
  // H(e^jw) = (b0 + b1·e^-jw + b2·e^-j2w) / (1 + a1·e^-jw + a2·e^-j2w)
  const numRe = c.b0 + c.b1 * cw + c.b2 * c2w;
  const numIm = -(c.b1 * sw + c.b2 * s2w);
  const denRe = 1 + c.a1 * cw + c.a2 * c2w;
  const denIm = -(c.a1 * sw + c.a2 * s2w);
  const denMag = Math.hypot(denRe, denIm);
  if (denMag < 1e-12) return 0; // degenerate section — draw flat, never NaN
  const mag = Math.hypot(numRe, numIm) / denMag;
  return 20 * Math.log10(mag > 1e-9 ? mag : 1e-9);
}

/**
 * Composite magnitude (dB) of one band's EQ chain at freqHz. Disabled EQ
 * or a stateless probe returns 0 (flat) — matches the DSP, where
 * enabled < 0.5 is a true no-op.
 */
export function bandEqMagnitudeDb(
  eq: BandEqCurveParams,
  freqHz: number,
  sampleRate: number,
): number {
  if (!(eq.enabled >= 0.5)) return 0;
  // Same filter order as the band-EQ module: shelf → peak → peak → shelf.
  setLowShelf(lowShelfCoeffs, eq.lowFreq, eq.lowGainDb, sampleRate);
  setPeaking(peak1Coeffs, eq.peak1Freq, eq.peak1Q, eq.peak1GainDb, sampleRate);
  setPeaking(peak2Coeffs, eq.peak2Freq, eq.peak2Q, eq.peak2GainDb, sampleRate);
  setHighShelf(highShelfCoeffs, eq.highFreq, eq.highGainDb, sampleRate);
  let total = 0;
  total += biquadMagnitudeDb(lowShelfCoeffs, freqHz, sampleRate);
  total += biquadMagnitudeDb(peak1Coeffs, freqHz, sampleRate);
  total += biquadMagnitudeDb(peak2Coeffs, freqHz, sampleRate);
  total += biquadMagnitudeDb(highShelfCoeffs, freqHz, sampleRate);
  return total;
}
