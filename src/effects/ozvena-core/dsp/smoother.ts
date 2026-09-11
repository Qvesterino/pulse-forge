/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ozvena. Do not edit by hand — this is
 * a semantics-faithful copy of the upstream DSP oracle (line endings are
 * normalized) so Pulse Forge and
 * VocalForge validate against the SAME golden fixtures
 * (tests/ozvena-golden.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ozvena.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ozvena — Envelope / parameter smoother
//
// Two flavours of one-pole smoothing:
//   1. Time-constant smoother — used for de-click parameter changes.
//   2. Envelope follower       — attack/release follower used by
//      the Smoother transient shaper and by the FFT snapshot
//      trigger in Auto Cut / Unmask analyzers.
//
// All allocation-free, scalar.
// ═══════════════════════════════════════════════════════════

import { TAU } from "./math.js";

// ── 1. Time-constant smoother ────────────────────────────────

export interface Smoother {
  setTimeConstantMs(ms: number, sampleRate: number): void;
  setCoeff(alpha: number): void;
  reset(value?: number): void;
  processValue(target: number): number;
  getValue(): number;
}

export function createSmoother(sampleRate: number, timeConstantMs = 20): Smoother {
  let alpha = 1 - Math.exp(-1 / ((timeConstantMs / 1000) * sampleRate));
  let value = 0;

  return {
    setTimeConstantMs(ms, sr) {
      alpha = 1 - Math.exp(-1 / ((ms / 1000) * sr));
    },
    setCoeff(a) {
      alpha = a;
    },
    reset(v = 0) {
      value = v;
    },
    processValue(target) {
      value += alpha * (target - value);
      return value;
    },
    getValue() {
      return value;
    },
  };
}

// ── 2. Attack/Release envelope follower ──────────────────────

/**
 * Standard AR envelope follower:
 *   - On rising input, attack coefficient (fast) is used.
 *   - On falling input, release coefficient (slow) is used.
 * Tracks the peak (rectified) level of the input signal.
 */
export interface ArEnvelope {
  setAttackReleaseMs(attackMs: number, releaseMs: number, sampleRate: number): void;
  processSample(x: number): number;
  getValue(): number;
  reset(value?: number): void;
}

export function createArEnvelope(
  sampleRate: number,
  attackMs = 10,
  releaseMs = 100,
): ArEnvelope {
  let attackAlpha = 1 - Math.exp(-1 / ((attackMs / 1000) * sampleRate));
  let releaseAlpha = 1 - Math.exp(-1 / ((releaseMs / 1000) * sampleRate));
  let value = 0;

  return {
    setAttackReleaseMs(aMs, rMs, sr) {
      attackAlpha = 1 - Math.exp(-1 / ((aMs / 1000) * sr));
      releaseAlpha = 1 - Math.exp(-1 / ((rMs / 1000) * sr));
    },
    processSample(x) {
      const rect = x < 0 ? -x : x;
      const alpha = rect > value ? attackAlpha : releaseAlpha;
      value += alpha * (rect - value);
      return value;
    },
    getValue() {
      return value;
    },
    reset(v = 0) {
      value = v;
    },
  };
}

// ── 3. RMS follower (slow) ───────────────────────────────────

/**
 * One-pole RMS follower. Tracks the running RMS level over a slow
 * window (default 300 ms) for visualisation and Auto Cut analysis.
 */
export interface RmsFollower {
  setTimeConstantMs(ms: number, sampleRate: number): void;
  processSample(x: number): number;
  getValue(): number;
  reset(): void;
}

export function createRmsFollower(sampleRate: number, timeConstantMs = 300): RmsFollower {
  let alpha = 1 - Math.exp(-1 / ((timeConstantMs / 1000) * sampleRate));
  let sumSq = 0;
  return {
    setTimeConstantMs(ms, sr) {
      alpha = 1 - Math.exp(-1 / ((ms / 1000) * sr));
    },
    processSample(x) {
      sumSq += alpha * (x * x - sumSq);
      return Math.sqrt(Math.max(0, sumSq));
    },
    getValue() {
      return Math.sqrt(Math.max(0, sumSq));
    },
    reset() {
      sumSq = 0;
    },
  };
}

// ── 4. Transient detector ───────────────────────────────────

/**
 * Transient detector: returns a value 0..1 representing how strongly
 * the input is rising compared to the smoothed envelope. Used by
 * the Smoother transient shaper to detect onsets.
 *
 *   onset = max(0, envelopeLevel - smoothedLevel) / smoothedLevel
 *
 * Returns 0 when there's no transient (signal stable or falling).
 */
export interface TransientDetector {
  setSmoothingMs(ms: number, sampleRate: number): void;
  processSample(x: number): number;
  reset(): void;
}

export function createTransientDetector(
  sampleRate: number,
  smoothingMs = 50,
): TransientDetector {
  let alpha = 1 - Math.exp(-1 / ((smoothingMs / 1000) * sampleRate));
  let fastEnv = 0;
  let slowEnv = 0;

  return {
    setSmoothingMs(ms, sr) {
      alpha = 1 - Math.exp(-1 / ((ms / 1000) * sr));
    },
    processSample(x) {
      const rect = x < 0 ? -x : x;
      // Fast envelope (1 ms attack) + slow envelope (smoothingMs release).
      fastEnv += (1 - Math.exp(-1 / (0.001 * sampleRate))) * (rect - fastEnv);
      slowEnv += alpha * (rect - slowEnv);
      // Onset = max(0, fast - slow) / (slow + ε)
      const diff = fastEnv - slowEnv;
      if (diff <= 0 || slowEnv < 1e-6) return 0;
      return Math.min(1, diff / slowEnv);
    },
    reset() {
      fastEnv = 0;
      slowEnv = 0;
    },
  };
}

// Suppress unused import warning when only some helpers are used.
void TAU;
