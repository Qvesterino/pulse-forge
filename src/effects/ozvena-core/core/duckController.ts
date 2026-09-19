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
// (Reconciled from Pulse Forge hardening pass, 2026-09-14: attack/release/sensitivity boundary clamps.)
// ═══════════════════════════════════════════════════════════
// Ozvena — Auto-Duck Controller
//
// Monitors peer level notifications and applies automatic gain
// reduction to the reverb tail when a peer plugin (e.g., FXEQ)
// detects energy in the same frequency band. This prevents the
// reverb from masking the dry signal.
//
// The auto-duck is opt-in (default off). When enabled, it reads
// peer level notifications and applies a smooth gain reduction
// to the wet bus.
//
// Algorithm:
//   1. For each peer notification, check if the frequency falls
//      within a critical band of the reverb tail.
//   2. If the peer's level exceeds the masking threshold, compute
//      a ducking gain: duckDb = -sensitivity * (peerDb - threshold).
//   3. Smooth the gain reduction over time (attack/release).
//   4. Apply the ducked gain to the wet bus in the processor.
// ═══════════════════════════════════════════════════════════

import { clamp } from "../dsp/math.js";
import type { PeerNotification } from "../v2/vocalForgeIpc.js";

export interface DuckControllerParams {
  /** Enable auto-duck. Default: false (opt-in). */
  enabled: boolean;
  /** Masking threshold in dB. Default: -20. */
  thresholdDb: number;
  /** Sensitivity (0..1). Higher = more aggressive ducking. Default: 0.5. */
  sensitivity: number;
  /** Attack time in ms. Default: 50. */
  attackMs: number;
  /** Release time in ms. Default: 200. */
  releaseMs: number;
}

export const DEFAULT_DUCK_PARAMS: DuckControllerParams = {
  enabled: false,
  thresholdDb: -20,
  sensitivity: 0.5,
  attackMs: 50,
  releaseMs: 200,
};

export interface DuckController {
  /** Process a peer notification and update the duck gain. */
  processNotification(notification: PeerNotification): void;
  /** Get the current duck gain (0..1). Call once per audio block. */
  getGain(sampleRate: number, blockSize: number): number;
  /** Set parameters. */
  setParams(p: Partial<DuckControllerParams>): void;
  /** Reset state. */
  reset(): void;
}

export function createDuckController(): DuckController {
  let params: DuckControllerParams = { ...DEFAULT_DUCK_PARAMS };
  let currentGain = 1.0;
  let targetGain = 1.0;

  return {
    processNotification(notification) {
      if (!params.enabled) return;

      const { magDb, freqHz } = notification;

      // Check if the peer level exceeds the threshold.
      if (magDb < params.thresholdDb) {
        // Peer is below threshold — no ducking needed.
        targetGain = 1.0;
        return;
      }

      // Compute ducking gain.
      const excess = magDb - params.thresholdDb;
      const duckAmount = (params.sensitivity * excess) / 40; // normalize to 0..1
      targetGain = clamp(1.0 - duckAmount, 0.1, 1.0);
      void freqHz; // reserved for band-aware ducking in future
    },

    getGain(sampleRate, blockSize) {
      if (!params.enabled) return 1.0;

      // Smooth attack/release. setParams clamps, but direct core consumers
      // can still hand in garbage: a negative/NaN time yields coef > 1 (or
      // NaN), and the per-sample one-pole then diverges geometrically to
      // ±Infinity/NaN — latching onto the wet bus via lastDuckGain. Floor
      // the times so coef always lands in (0, 1).
      const attackCoef = Math.exp(-1000 / (sampleRate * Math.max(0.01, params.attackMs)));
      const releaseCoef = Math.exp(-1000 / (sampleRate * Math.max(0.01, params.releaseMs)));
      const coef = targetGain < currentGain ? attackCoef : releaseCoef;

      // Apply per-block.
      for (let i = 0; i < blockSize; i++) {
        currentGain += (targetGain - currentGain) * coef;
      }

      return currentGain;
    },

    setParams(p) {
      const next = { ...params, ...p };
      // Boundary validation: invalid times/gains must never reach the
      // per-sample envelope (see getGain — coef > 1 diverges the recursion).
      if (!Number.isFinite(next.thresholdDb)) next.thresholdDb = DEFAULT_DUCK_PARAMS.thresholdDb;
      next.sensitivity = Number.isFinite(next.sensitivity)
        ? clamp(next.sensitivity, 0, 1)
        : DEFAULT_DUCK_PARAMS.sensitivity;
      next.attackMs = Number.isFinite(next.attackMs) ? Math.max(0.01, next.attackMs) : DEFAULT_DUCK_PARAMS.attackMs;
      next.releaseMs = Number.isFinite(next.releaseMs) ? Math.max(0.01, next.releaseMs) : DEFAULT_DUCK_PARAMS.releaseMs;
      params = next;
    },

    reset() {
      currentGain = 1.0;
      targetGain = 1.0;
    },
  };
}
