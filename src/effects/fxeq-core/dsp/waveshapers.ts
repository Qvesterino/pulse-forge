/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/fxeq. Do not edit by hand — this is a
 * byte-faithful copy of the upstream DSP oracle so Pulse Forge and VocalForge
 * validate against the SAME golden fixtures (tests/fxeq-golden/). Fix DSP
 * issues upstream, then re-vendor via scripts/vendor-fxeq.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// FXEQ — Waveshaper transfer functions
//
// Modes 0, 3, 4, 5 are stateless pure functions.
// Modes 1, 2, 6, 7 are stateful (require SaturationChannelState).
// applyShapeEx() dispatches to the correct version.
// applyShape() remains for backward compatibility (stateless fallback).
// ═══════════════════════════════════════════════════════════

import { clamp, fastTanh } from "./mathUtils.js";

/** Indices must stay in sync with saturation mode parameter. */
export const SAT_MODES = [
  "cleanWarmth",
  "tube",
  "tape",
  "brightEdge",
  "aggressive",
  "foldback",
  "cathode",
  "transformer",
] as const;

export type SatMode = (typeof SAT_MODES)[number];

export interface SaturationChannelState {
  millerLpf: number;
  hystFlux: number;
  tapeBump: number;
  transformerFlux: number;
  dcPrevIn: number;
  dcPrev: number;
  /** Previous input sample for ADAA (Anti-Derivative Anti-Aliasing). */
  adaaPrevIn: number;
}

export function createSaturationState(): SaturationChannelState {
  return {
    millerLpf: 0,
    hystFlux: 0,
    tapeBump: 0,
    transformerFlux: 0,
    dcPrevIn: 0,
    dcPrev: 0,
    adaaPrevIn: 0,
  };
}

export function modeNeedsDCBlock(mode: number): boolean {
  return mode === 1 || mode === 2 || mode === 6 || mode === 7;
}

export function dcBlockSaturation(x: number, st: SaturationChannelState, sr: number): number {
  const dcAlpha = Math.exp((-2 * Math.PI * 20) / sr);
  const out = x - st.dcPrevIn + dcAlpha * st.dcPrev;
  st.dcPrevIn = x;
  st.dcPrev = out;
  return out;
}

// ── Stateless modes ──

// 0 — Clean Warmth: tanh(x), subtle and transparent.
export function shapeCleanWarmth(x: number): number {
  return fastTanh(x);
}

// 3 — Bright Edge: cubic soft-clip (x - x^3/3), presence/air.
export function shapeBrightEdge(x: number): number {
  const shaped = x - (x * x * x) / 3;
  return clamp(shaped, -1.5, 1.5);
}

// 4 — Aggressive: soft-knee hard clip at 0.8.
export function shapeAggressive(x: number): number {
  const knee = 0.8;
  const ax = x < 0 ? -x : x;
  if (ax <= knee) return x;
  const sign = x < 0 ? -1 : 1;
  const over = ax - knee;
  return sign * (knee + (1 - knee) * fastTanh(over / (1 - knee)));
}

// 5 — Foldback: signals above threshold fold back, rich harmonics.
//     ADAA applied via stateful wrapper (derivative is discontinuous
//     at fold points, but ADAA still helps in the linear region).
export function shapeFoldback(x: number, threshold = 0.9): number {
  const t = threshold;
  if (x > t || x < -t) {
    return Math.abs(Math.abs((x - t) % (4 * t)) - 2 * t) - t;
  }
  return x;
}

/** Foldback with ADAA — uses the derivative at the current point. */
function shapeFoldbackADAA(x: number, prevX: number, threshold: number): number {
  const t = threshold;
  const fx = shapeFoldback(x, t);
  // Approximate derivative numerically (central difference).
  const eps = 1e-4;
  const fPlus = shapeFoldback(x + eps, t);
  const fMinus = shapeFoldback(x - eps, t);
  const fp = (fPlus - fMinus) / (2 * eps);
  return fx + fp * (x - prevX) * 0.5;
}

// ── ADAA (Anti-Derivative Anti-Aliasing) ─────────────────────
//
// First-order ADAA reduces aliasing by ~6 dB/octave without
// oversampling. For a waveshaper y = f(x):
//   y_adaa[n] = f(x[n]) + f'(x[n]) * (x[n] - x[n-1]) / 2
//
// This is trapezoidal integration of the derivative, which
// smooths the transfer function's discontinuities.

/** ADAA for tube: f(x) = x/(1+a*x²), f'(x) = (1-a*x²)/(1+a*x²)² */
function adaaTube(x: number, prevX: number, a: number): number {
  const ax2 = a * x * x;
  const denom = 1 + ax2;
  const fx = x / denom;
  const fp = (1 - ax2) / (denom * denom);
  return fx + fp * (x - prevX) * 0.5;
}

/** ADAA for tanh: f(x) = tanh(x), f'(x) = 1 - tanh²(x) */
function adaaTanh(x: number, prevX: number): number {
  const tx = fastTanh(x);
  const fp = 1 - tx * tx;
  return tx + fp * (x - prevX) * 0.5;
}

// ── Stateful modes ──

// 1 — Tube: Miller capacitance LPF (drive-dependent HF rolloff) +
//         asymmetric soft clip (grid current on positive half) + ADAA.
export function shapeTubeStateful(
  x: number,
  st: SaturationChannelState,
  sr: number,
  driveLevel: number,
): number {
  const millerCutoff = 12000 / (1 + driveLevel * 0.4);
  const ma = 1 - Math.exp((-2 * Math.PI * millerCutoff) / sr);
  st.millerLpf += ma * (x - st.millerLpf);
  const grid = st.millerLpf;

  // ADAA: correct for the slope of the clipping function.
  const prevGrid = st.adaaPrevIn;
  const a = grid >= 0 ? 0.3 : 0.7;
  const result = adaaTube(grid, prevGrid, a);
  st.adaaPrevIn = grid;

  return result;
}

// 2 — Tape: Hysteresis loop (~800Hz time constant) +
//         signal-dependent bias (even harmonics) +
//         head bump low-shelf (+3 dB @ 120 Hz) + ADAA on tanh core.
export function shapeTapeStateful(x: number, st: SaturationChannelState, sr: number): number {
  const hystRate = Math.exp((-2 * Math.PI * 800) / sr);
  st.hystFlux = hystRate * st.hystFlux + (1 - hystRate) * x;
  const hystInput = st.hystFlux * 1.3 + 0.1 * x * x;

  // ADAA on the tanh core for anti-aliasing.
  const magnetized = adaaTanh(hystInput, st.adaaPrevIn);
  st.adaaPrevIn = hystInput;

  const bumpAlpha = 1 - Math.exp((-2 * Math.PI * 120) / sr);
  st.tapeBump += bumpAlpha * (magnetized - st.tapeBump);

  return magnetized + 0.4 * st.tapeBump;
}

// 6 — Cathode: Gentle 2nd harmonic warmth.
export function shapeCathode(x: number): number {
  return x - 0.08 * x * Math.abs(x);
}

// 7 — Transformer: Core flux integration (~200Hz, "sag") +
//                  BH curve + 2nd harmonic.
export function shapeTransformerStateful(
  x: number,
  st: SaturationChannelState,
  sr: number,
): number {
  const fluxRate = 1 - Math.exp((-2 * Math.PI * 200) / sr);
  st.transformerFlux += fluxRate * (x - st.transformerFlux);
  const bh = fastTanh((x + 0.3 * st.transformerFlux) * 1.1);
  const even = 0.15 * x * Math.abs(x);
  return 0.85 * bh + even;
}

// ── Stateful dispatch ──
export function applyShapeEx(
  mode: number,
  x: number,
  st: SaturationChannelState,
  sr: number,
  driveLevel: number,
): number {
  switch (mode) {
    case 0:
      return shapeCleanWarmth(x);
    case 1:
      return shapeTubeStateful(x, st, sr, driveLevel); // ADAA built-in
    case 2:
      return shapeTapeStateful(x, st, sr); // ADAA built-in
    case 3:
      return shapeBrightEdge(x);
    case 4:
      return shapeAggressive(x);
    case 5: {
      // Foldback with ADAA.
      const result = shapeFoldbackADAA(x, st.adaaPrevIn, 0.9);
      st.adaaPrevIn = x;
      return result;
    }
    case 6:
      return shapeCathode(x);
    case 7:
      return shapeTransformerStateful(x, st, sr);
    default:
      return shapeCleanWarmth(x);
  }
}

// ── Stateless fallback (backward compat — no ADAA, no state) ──
//
// applyShape() is the thin does-no-ADAA path. It's retained for tests
// that want to compare the ADAA-enabled path (applyShapeEx) against the
// raw transfer function; production audio always goes through
// applyShapeEx. The folds (1, 2, 7) here are stateless fallbacks —
// not identical to the stateful versions in applyShapeEx, just enough
// to be useful for unit-level transform checks.
export function applyShape(mode: number, x: number): number {
  switch (mode) {
    case 0:
      return shapeCleanWarmth(x);
    case 1:
      return x / (1 + Math.pow(Math.abs(x), 0.7)); // tube stateless
    case 2:
      return fastTanh(1.2 * x); // tape stateless
    case 3:
      return shapeBrightEdge(x);
    case 4:
      return shapeAggressive(x);
    case 5:
      return shapeFoldback(x, 0.9); // non-ADAA foldback
    case 6: {
      const ax = Math.abs(x);
      const s = x < 0 ? -1 : 1;
      return (s * Math.round(ax * 8)) / 8; // cathode stair-step
    }
    case 7: {
      const odd = fastTanh(x * 1.1);
      const even = (x * x * x) / 3;
      return clamp(0.8 * odd + (x >= 0 ? 0.25 : 0.15) * even, -1.5, 1.5);
    }
    default:
      return shapeCleanWarmth(x);
  }
}

// ── Legacy stateless dispatch (backward compat — no stateful behavior) ──
// Note: the legacy applyShape dispatch + *_Legacy helpers were removed
// (Audit #D1). Every saturation caller uses applyShapeEx(); the legacy
// path was dead code with no consumer in this package.
