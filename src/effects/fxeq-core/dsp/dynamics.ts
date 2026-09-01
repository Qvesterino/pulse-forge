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
// FXEQ — Dynamic processor (envelope follower + gain computer)
//
// Used by per-band dynamic EQ to track signal level and compute
// gain reduction based on threshold and range parameters.
//
// Architecture:
//   1. Envelope follower: peak detector with separate attack/release
//   2. Gain computer: maps envelope to gain reduction (threshold/range)
//   3. Gain smoothing: one-pole filter on the gain output
// ═══════════════════════════════════════════════════════════

/** Per-band dynamic state. */
export interface DynamicState {
  /** Current envelope value (linear, 0..∞). */
  envelope: number;
  /** Current gain reduction in dB (for metering). 0 = no reduction. */
  gainReductionDb: number;
  /** Current smoothed gain (linear, 0..1). */
  smoothedGain: number;
}

export function createDynamicState(): DynamicState {
  return { envelope: 0, gainReductionDb: 0, smoothedGain: 1 };
}

/**
 * Process one sample through the envelope follower.
 * Uses peak detection with separate attack (fast) and release (slow) coefficients.
 */
export function processEnvelope(
  x: number,           // absolute input level
  state: DynamicState,
  _attackCoef: number,  // fast (close to 1 = slow attack)
  releaseCoef: number, // slow (close to 1 = slow release)
): number {
  // Peak envelope: attack is instant (track the peak), release is smooth.
  if (x > state.envelope) {
    state.envelope = x; // instant attack
  } else {
    state.envelope = state.envelope * releaseCoef + x * (1 - releaseCoef);
  }
  return state.envelope;
}

/**
 * Compute gain reduction from envelope level.
 *
 * Compression model:
 *   - Below threshold: gain = 1 (no reduction)
 *   - Above threshold: gain decreases linearly toward (1 - range)
 *   - range is in linear (e.g., 0.5 = -6 dB max reduction)
 *
 * Returns linear gain (0..1).
 */
export function computeGain(
  envelope: number,
  thresholdLin: number,
  rangeLin: number,
): number {
  if (envelope <= thresholdLin || thresholdLin <= 0) return 1;
  // Linear gain reduction above threshold.
  const over = (envelope - thresholdLin) / thresholdLin;
  const maxReduction = 1 - rangeLin;
  const gain = 1 - over * (1 - maxReduction);
  return Math.max(maxReduction, Math.min(1, gain));
}

/**
 * Convert dB range to linear range.
 * rangeDb = -6 → rangeLin = 0.5 (max -6 dB reduction)
 */
export function rangeDbToLin(rangeDb: number): number {
  return Math.pow(10, rangeDb / 20);
}

/**
 * Update attack/release coefficients from time constants.
 */
export function computeCoefs(
  attackMs: number,
  releaseMs: number,
  sampleRate: number,
): { attack: number; release: number } {
  return {
    attack: Math.exp(-1 / ((attackMs / 1000) * sampleRate)),
    release: Math.exp(-1 / ((releaseMs / 1000) * sampleRate)),
  };
}