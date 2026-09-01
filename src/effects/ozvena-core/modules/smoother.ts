/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ozvena. Do not edit by hand — this is
 * a byte-faithful copy of the upstream DSP oracle so Pulse Forge and
 * VocalForge validate against the SAME golden fixtures
 * (tests/ozvena-golden.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ozvena.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ozvena — Smoother (transient shaper)
//
// Softens transients of the input signal so they don't step on the
// reverb tail. Operates by detecting onsets (rising energy) and
// applying a short gain reduction proportional to the onset strength.
//
// Implementation:
//   • Envelope follower (attack/release)
//   • Transient detector (fast-vs-slow envelope diff)
//   • Gain computer: when onset > 0, reduce gain by amount% scaled
//     by onset strength (capped at -12 dB)
//   • Smooth release back to unity
//
// Stereo-coupled: amount and detection are computed on max(L,R) so a
// transient on one channel reduces gain on both (preserves image).
// ═══════════════════════════════════════════════════════════

import { clamp } from "../dsp/math.js";
import {
  createArEnvelope,
  createTransientDetector,
  type ArEnvelope,
  type TransientDetector,
} from "../dsp/smoother.js";

export interface SmootherParams {
  enabled: boolean;
  /** 0..100 — how aggressively to suppress transients. */
  amount: number;
}

export interface Smoother {
  prepare(sampleRate: number): void;
  process(channels: Float32Array[], frameCount: number): void;
  setParams(p: SmootherParams): void;
  getCurrentReductionDb(): number;
  reset(): void;
}

export function createSmoother(): Smoother {
  let sampleRate = 44100;
  let params: SmootherParams = { enabled: true, amount: 30 };

  let envelope: ArEnvelope = createArEnvelope(44100, 2, 50);
  let detector: TransientDetector = createTransientDetector(44100, 50);
  let reductionDb = 0; // current gain reduction in dB (≤ 0)
  let reductionTargetDb = 0; // smoothed target
  // Release smoothing coefficient (per-sample).
  let releaseAlpha = 0;

  function recompute(): void {
    envelope = createArEnvelope(sampleRate, 2, 50);
    detector = createTransientDetector(sampleRate, 50);
    // Release: restore unity at ~250 ms.
    releaseAlpha = 1 - Math.exp(-1 / ((0.25 * sampleRate)));
  }

  return {
    prepare(sr) {
      sampleRate = clamp(sr, 8000, 192000);
      recompute();
    },

    process(channels, frameCount) {
      if (!params.enabled || frameCount <= 0) return;
      const amountNorm = clamp(params.amount, 0, 100) / 100;

      for (let i = 0; i < frameCount; i++) {
        // Use the max(L,R) for envelope + onset detection so transients
        // in either channel trigger the reduction.
        let l = 0;
        let r = 0;
        if (channels.length > 0) l = channels[0][i];
        if (channels.length > 1) r = channels[1][i];
        else r = l;
        const peak = Math.max(Math.abs(l), Math.abs(r));

        // Drive the envelope + detector.
        envelope.processSample(peak);
        const onset = detector.processSample(peak);

        // Target reduction (dB). Up to -12 dB at full onset × amount.
        if (onset > 0) {
          reductionTargetDb = -12 * onset * amountNorm;
        } else {
          reductionTargetDb = 0;
        }

        // Smooth toward target. Snap up, smooth release down.
        if (reductionTargetDb < reductionDb) {
          reductionDb = reductionTargetDb; // attack (immediate)
        } else {
          reductionDb += releaseAlpha * (reductionTargetDb - reductionDb);
        }

        // Convert to linear gain.
        const gain = Math.pow(10, reductionDb / 20);

        for (let c = 0; c < channels.length; c++) {
          channels[c][i] *= gain;
        }
      }
    },

    setParams(p) {
      params = { ...p };
    },

    getCurrentReductionDb() {
      return reductionDb;
    },

    reset() {
      envelope.reset();
      detector.reset();
      reductionDb = 0;
      reductionTargetDb = 0;
    },
  };
}
