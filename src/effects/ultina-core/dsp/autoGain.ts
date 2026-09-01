/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ultina. Do not edit by hand — this is
 * a byte-faithful copy of the upstream DSP oracle so Pulse Forge and
 * VocalForge validate against the SAME golden vectors
 * (tests/ultina-vectors.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ultina.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ultina — Auto-Gain Controller
//
// P1: Auto-Gain Feedback Loop
//
// Continuously measures output loudness (short-term LUFS) and
// adjusts gain to converge toward a user-defined target LUFS.
//
// Architecture:
//   ┌─────────────────────────────────────────────┐
//   │  Output Audio → LUFS Meter (short-term)     │
//   │        ↓                                     │
//   │  Error = targetLufs - shortTermLufs         │
//   │        ↓                                     │
//   │  PI Controller (slow, ~2s time constant)     │
//   │        ↓                                     │
//   │  gainCorrectionDb (clamped ±12 dB)           │
//   │        ↓                                     │
//   │  Added to outputGainDb → applied to signal   │
//   └─────────────────────────────────────────────┘
//
// The controller uses short-term LUFS (3-second window) for
// responsiveness, but only updates every BLOCK_UPDATE_MS to
// avoid jitter. Gain changes are smoothed per-sample by the
// processor's existing output gain smoother.
// ═══════════════════════════════════════════════════════════

import { smoothCoef } from "./primitives.js";

// ── Constants ───────────────────────────────────────────────

/** Minimum LUFS reading to consider valid (below this = silence). */
const MIN_VALID_LUFS = -60;

/** Maximum gain correction in dB (clamped both directions). */
const MAX_GAIN_CORRECTION_DB = 12;

/** Time constant for the integrator — how fast it converges. */
const CONVERGENCE_TIME_CONSTANT_MS = 2000;

/** Minimum time between controller updates (ms). */
const BLOCK_UPDATE_MS = 200;

/** Startup delay — controller waits this long before engaging (ms). */
const STARTUP_DELAY_MS = 1000;

// ── Types ───────────────────────────────────────────────────

export interface AutoGainReading {
  /** Current gain correction being applied (dB). */
  gainCorrectionDb: number;
  /** Current error: target - actual (dB). Positive = too quiet. */
  errorDb: number;
  /** Current short-term LUFS reading. */
  currentLufs: number;
  /** Target LUFS. */
  targetLufs: number;
  /** Whether the controller is active and engaged. */
  active: boolean;
}

// ── Auto-Gain Controller ────────────────────────────────────

export class AutoGainController {
  private enabled = false;
  private targetLufs = -14;
  private sampleRate = 48000;

  // Controller state
  private gainCorrectionDb = 0;
  private currentErrorDb = 0;
  private currentLufs = -70;
  private msSinceStart = 0;
  private msSinceLastUpdate = 0;

  // Smoothing for the gain target
  private gainSmootherAlpha = 0;
  private smoothedGainDb = 0;

  /** Prepare the controller for operation. */
  prepare(sampleRate: number, _maxBlockSize: number): void {
    this.sampleRate = sampleRate;
    this.gainSmootherAlpha = smoothCoef(CONVERGENCE_TIME_CONSTANT_MS, sampleRate);
    this.reset();
  }

  /** Reset all state. */
  reset(): void {
    this.gainCorrectionDb = 0;
    this.currentErrorDb = 0;
    this.currentLufs = -70;
    this.msSinceStart = 0;
    this.msSinceLastUpdate = 0;
    this.smoothedGainDb = 0;
  }

  /** Set whether auto-gain is enabled. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      // Gradually return to zero — handled by smoother target change
    }
  }

  /** Set target LUFS. */
  setTargetLufs(lufs: number): void {
    this.targetLufs = lufs;
  }

  /**
   * Process one block. Reads current short-term LUFS and updates
   * the gain correction.
   *
   * @param shortTermLufs  Current short-term LUFS from the LUFS meter
   * @param frameCount     Number of samples in this block
   * @returns              The gain correction in dB to add to output gain
   */
  process(shortTermLufs: number, frameCount: number): number {
    const blockMs = (frameCount / this.sampleRate) * 1000;
    this.msSinceStart += blockMs;
    this.msSinceLastUpdate += blockMs;

    // Store latest LUFS reading
    this.currentLufs = shortTermLufs;

    // Not enabled → return 0 (smoother will ramp to zero)
    if (!this.enabled) {
      this.gainCorrectionDb = 0;
      this.smoothedGainDb += (0 - this.smoothedGainDb) * Math.min(1, this.gainSmootherAlpha * frameCount * 4);
      return this.smoothedGainDb;
    }

    // During startup delay, ramp from 0
    if (this.msSinceStart < STARTUP_DELAY_MS) {
      this.smoothedGainDb += (0 - this.smoothedGainDb) * Math.min(1, this.gainSmootherAlpha * frameCount * 4);
      return this.smoothedGainDb;
    }

    // Only update the controller at intervals
    if (this.msSinceLastUpdate >= BLOCK_UPDATE_MS) {
      this.msSinceLastUpdate = 0;
      this.updateController();
    }

    // Smooth the gain correction toward the target
    const alpha = Math.min(1, this.gainSmootherAlpha * frameCount);
    this.smoothedGainDb += (this.gainCorrectionDb - this.smoothedGainDb) * alpha;

    // Final safety: never let a non-finite correction reach the audio path
    if (!Number.isFinite(this.smoothedGainDb)) {
      this.smoothedGainDb = 0;
      this.gainCorrectionDb = 0;
    }

    return this.smoothedGainDb;
  }

  /** Internal: compute the PI controller update with anti-windup. */
  private updateController(): void {
    // Ignore readings that are too quiet (silence) or invalid. A NaN
    // LUFS reading must never enter the integrator — every clamp below
    // is a comparison, and all NaN comparisons are false, so NaN would
    // sail straight through and poison the gain forever.
    if (!Number.isFinite(this.currentLufs) || this.currentLufs < MIN_VALID_LUFS) {
      // Don't change gain — hold current value
      return;
    }

    // Compute error: positive = signal too quiet, need more gain
    this.currentErrorDb = this.targetLufs - this.currentLufs;

    // PI-like integrator: add a fraction of the error
    const gainPerUpdate = BLOCK_UPDATE_MS / CONVERGENCE_TIME_CONSTANT_MS;
    const candidate = this.gainCorrectionDb + this.currentErrorDb * gainPerUpdate;

    // Clamp with back-calculation anti-windup:
    // if the candidate exceeds limits, only advance to the limit
    // so the integrator does not wind up beyond the clamp range
    if (candidate > MAX_GAIN_CORRECTION_DB) {
      this.gainCorrectionDb = MAX_GAIN_CORRECTION_DB;
    } else if (candidate < -MAX_GAIN_CORRECTION_DB) {
      this.gainCorrectionDb = -MAX_GAIN_CORRECTION_DB;
    } else {
      this.gainCorrectionDb = candidate;
    }
  }

  /** Get current auto-gain state for metering/display. */
  getReading(): AutoGainReading {
    return {
      gainCorrectionDb: this.smoothedGainDb,
      errorDb: this.currentErrorDb,
      currentLufs: this.currentLufs,
      targetLufs: this.targetLufs,
      active: this.enabled && this.msSinceStart >= STARTUP_DELAY_MS,
    };
  }

  /** Get the raw (unsmoothed) gain correction target in dB. */
  getRawGainCorrectionDb(): number {
    return this.gainCorrectionDb;
  }
}
