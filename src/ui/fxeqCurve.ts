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
  setHighPass,
  setHighShelf,
  setLowPass,
  setLowShelf,
  setPeaking,
  type BiquadCoeffs,
} from "../effects/fxeq-core/dsp/biquad";
import {
  BUTTERWORTH_SECTION_Q,
  snapCrossoverOrder,
  type CrossoverOrder,
} from "../effects/fxeq-core/dsp/crossoverStage";

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
export function bandEqMagnitudeDb(eq: BandEqCurveParams, freqHz: number, sampleRate: number): number {
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

// Scratch section coefficients for the crossover window (max LR8 = 4).
const hpSectionCoeffs: BiquadCoeffs[] = [0, 1, 2, 3].map(() => ({ b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }));
const lpSectionCoeffs: BiquadCoeffs[] = [0, 1, 2, 3].map(() => ({ b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }));

/**
 * Magnitude (dB) of the crossover's response for band `bandIndex` (0-based)
 * of a `splits.length`-band split, at freqHz — the progressive LR cascade:
 * HP_0 · … · HP_{bandIndex-1} · LP_{bandIndex} (the top band carries only
 * the HP stages). This is the "band window" the panel draws as a dashed
 * skirt: flat passband, −6 dB at each split it is built around, and a
 * 12/24/48 dB-per-octave stopband for LR2/LR4/LR8.
 *
 * The allpass phase equalization is deliberately NOT included — it is
 * magnitude-flat, so the window's color is purely the LR cascade. Section
 * polarity (the LR2 HP flip) does not affect magnitude.
 */
export function crossoverBandMagnitudeDb(
  bandIndex: number,
  splits: number[],
  order: number,
  freqHz: number,
  sampleRate: number,
): number {
  const snapped: CrossoverOrder = snapCrossoverOrder(order);
  const q = BUTTERWORTH_SECTION_Q[snapped];
  let totalDb = 0;
  const hpStages = Math.min(bandIndex, splits.length);
  for (let j = 0; j < hpStages; j++) {
    for (let s = 0; s < q.length; s++) {
      setHighPass(hpSectionCoeffs[s], splits[j], q[s], sampleRate);
      totalDb += biquadMagnitudeDb(hpSectionCoeffs[s], freqHz, sampleRate);
    }
  }
  const lpStage = bandIndex;
  if (lpStage >= 0 && lpStage < splits.length) {
    for (let s = 0; s < q.length; s++) {
      setLowPass(lpSectionCoeffs[s], splits[lpStage], q[s], sampleRate);
      totalDb += biquadMagnitudeDb(lpSectionCoeffs[s], freqHz, sampleRate);
    }
  }
  return totalDb;
}
