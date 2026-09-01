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
// FXEQ — Crossover filter stages
//
// Linkwitz-Riley crossover sections built from the biquad primitive.
//
// LR4 (24 dB/oct): each branch = two cascaded 2nd-order Butterworth
//   sections (Q = 1/√2 ≈ 0.7071). At fc each branch is -6 dB and the
//   LP/HP pair is phase-aligned, so they are power-complementary and
//   sum to a flat-magnitude allpass — the basis of flat reconstruction.
//
// LR2 (12 dB/oct): each branch = one 2nd-order section with Q = 0.5.
// ═══════════════════════════════════════════════════════════

import {
  type BiquadState,
  createBiquad,
  setLowPass,
  setHighPass,
  resetBiquad,
  processBiquad,
} from "./biquad.js";

/** Butterworth Q for LR4 sections. */
export const LR4_Q = 1 / Math.SQRT2; // ≈ 0.7071
/** Butterworth Q for LR2 sections. */
export const LR2_Q = 0.5;

/** One crossover split point: complementary LP and HP branches. */
export interface CrossoverStage {
  /** Low-pass branch biquads (2 for LR4, 1 for LR2). */
  lp: BiquadState[];
  /** High-pass branch biquads (2 for LR4, 1 for LR2). */
  hp: BiquadState[];
}

export type CrossoverOrder = 2 | 4;

/** Create a crossover stage for `channelCount` channels. */
export function createCrossoverStage(
  channelCount: number,
  order: CrossoverOrder = 4,
): CrossoverStage {
  const sections = order === 4 ? 2 : 1;
  return {
    lp: Array.from({ length: sections }, () => createBiquad(channelCount)),
    hp: Array.from({ length: sections }, () => createBiquad(channelCount)),
  };
}

/** Set crossover frequency and rebuild coefficients for a stage. */
export function tuneCrossoverStage(
  stage: CrossoverStage,
  freqHz: number,
  sampleRate: number,
  order: CrossoverOrder = 4,
): void {
  const q = order === 4 ? LR4_Q : LR2_Q;
  for (const bq of stage.lp) setLowPass(bq.coeffs, freqHz, q, sampleRate);
  for (const bq of stage.hp) setHighPass(bq.coeffs, freqHz, q, sampleRate);
}

/** Reset all biquad state in a stage. */
export function resetCrossoverStage(stage: CrossoverStage): void {
  for (const bq of stage.lp) resetBiquad(bq);
  for (const bq of stage.hp) resetBiquad(bq);
}

/**
 * Apply the LP branch of a stage to `input`, writing the filtered result
 * into `outBuf` (per channel). `input` is read-only.
 */
export function applyLpBranch(
  stage: CrossoverStage,
  input: Float32Array[],
  outBuf: Float32Array[],
  frameCount: number,
): void {
  // Copy input into outBuf, then cascade the LP biquads in place.
  for (let c = 0; c < outBuf.length; c++) {
    outBuf[c].set(input[c].subarray(0, frameCount));
  }
  for (const bq of stage.lp) processBiquad(bq, outBuf, frameCount);
}

/**
 * Apply the HP branch of a stage to `input`, writing the filtered result
 * into `outBuf`.
 */
export function applyHpBranch(
  stage: CrossoverStage,
  input: Float32Array[],
  outBuf: Float32Array[],
  frameCount: number,
): void {
  for (let c = 0; c < outBuf.length; c++) {
    outBuf[c].set(input[c].subarray(0, frameCount));
  }
  for (const bq of stage.hp) processBiquad(bq, outBuf, frameCount);
}
