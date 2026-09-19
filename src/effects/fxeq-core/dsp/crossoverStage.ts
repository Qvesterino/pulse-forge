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
// LR2 (12 dB/oct): each branch = one 2nd-order section with Q = 0.5;
// LR4 (24 dB/oct): each branch = two cascaded 2nd-order Butterworth
//   sections (Q = 1/√2 ≈ 0.7071). At fc each branch is -6 dB and the
//   LP/HP pair is phase-aligned, so they are power-complementary and
//   sum to a flat-magnitude allpass — the basis of flat reconstruction.
// LR8 (48 dB/oct): each branch = two cascaded 4th-order Butterworth
//   sections (Q = 0.5412 and 1.3066, repeated) — the master-bus tier.
// ═══════════════════════════════════════════════════════════

import {
  type BiquadState,
  createBiquad,
  setFlat,
  setLowPass,
  setHighPass,
  resetBiquad,
  processBiquad,
} from "./biquad.js";

/** Butterworth Q for the 2nd-order LR2 section. */
export const LR2_Q = 0.5;
/** Butterworth Q for each 2nd-order LR4 section. */
export const LR4_Q = 1 / Math.SQRT2; // ≈ 0.7071

/**
 * Per-section Q for every supported Linkwitz-Riley order. LR8 is made by
 * cascading two 4th-order Butterworth filters, so its 4 biquads repeat the
 * canonical 4th-order Q pair; it is deliberately not an 8th-order
 * Butterworth branch (which would be only -3 dB at the split).
 */
export const BUTTERWORTH_SECTION_Q: Record<CrossoverOrder, readonly number[]> = {
  2: [LR2_Q],
  4: [LR4_Q, LR4_Q],
  8: [0.5411961001461971, 1.3065629648763766, 0.5411961001461971, 1.3065629648763766],
};

/** Number of 2nd-order sections per LR-N branch. */
export function sectionsFor(order: CrossoverOrder): number {
  return order / 2;
}

/** Snap an arbitrary host value onto the supported order set {2, 4, 8}. */
export function snapCrossoverOrder(value: number): CrossoverOrder {
  if (!Number.isFinite(value)) return 4;
  if (value < 3) return 2;
  if (value < 6) return 4;
  return 8;
}

/** One crossover split point: complementary LP and HP branches. */
export interface CrossoverStage {
  /** Low-pass branch biquads (allocated for LR8 = 4). */
  lp: BiquadState[];
  /** High-pass branch biquads (allocated for LR8 = 4). */
  hp: BiquadState[];
  /**
   * Sections currently part of the cascade. Stages are allocated for the
   * largest order so an order switch never reallocates — tuning lowers
   * this count and flats+resets the retired sections, and the branch
   * processors only cascade the active prefix.
   */
  activeSections: number;
}

export type CrossoverOrder = 2 | 4 | 8;

/** Create a crossover stage for `channelCount` channels (max-order allocation). */
export function createCrossoverStage(channelCount: number, order: CrossoverOrder = 4): CrossoverStage {
  const sections = sectionsFor(8); // allocate for the largest order
  return {
    lp: Array.from({ length: sections }, () => createBiquad(channelCount)),
    hp: Array.from({ length: sections }, () => createBiquad(channelCount)),
    activeSections: sectionsFor(order),
  };
}

/** Set crossover frequency and rebuild coefficients for a stage. */
export function tuneCrossoverStage(
  stage: CrossoverStage,
  freqHz: number,
  sampleRate: number,
  order: CrossoverOrder = 4,
): void {
  const q = BUTTERWORTH_SECTION_Q[order];
  stage.activeSections = sectionsFor(order);
  for (let i = 0; i < stage.lp.length; i++) {
    if (i < stage.activeSections) {
      setLowPass(stage.lp[i].coeffs, freqHz, q[i % q.length], sampleRate);
      setHighPass(stage.hp[i].coeffs, freqHz, q[i % q.length], sampleRate);
      if (order === 2) {
        // LR2 polarity quirk (verified numerically): the RBJ HP section
        // lands 180° out of phase with the LP at EVERY frequency — the raw
        // pair cancels completely at fc. Negating the HP feed-forward path
        // restores the flat allpass sum (|LP−HP| = 1 at all f). LR4/LR8
        // pair in-phase and need no flip; golden fixtures use LR4 only.
        const c = stage.hp[i].coeffs;
        c.b0 = -c.b0;
        c.b1 = -c.b1;
        c.b2 = -c.b2;
      }
    } else {
      // A retired section (order downswitch) must be inert AND silent if it
      // ever runs again before a retune: flat coefficients, zeroed state.
      setFlat(stage.lp[i]);
      setFlat(stage.hp[i]);
      resetBiquad(stage.lp[i]);
      resetBiquad(stage.hp[i]);
    }
  }
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
  // Copy input into outBuf, then cascade the LP biquads in place. Only the
  // ACTIVE section prefix runs — retired sections (order downswitch) hold
  // flat coefficients but must not even clock.
  for (let c = 0; c < outBuf.length; c++) {
    const source = input[c];
    const target = outBuf[c];
    for (let i = 0; i < frameCount; i++) target[i] = source[i];
  }
  for (let s = 0; s < stage.activeSections; s++) processBiquad(stage.lp[s], outBuf, frameCount);
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
    const source = input[c];
    const target = outBuf[c];
    for (let i = 0; i < frameCount; i++) target[i] = source[i];
  }
  for (let s = 0; s < stage.activeSections; s++) processBiquad(stage.hp[s], outBuf, frameCount);
}
