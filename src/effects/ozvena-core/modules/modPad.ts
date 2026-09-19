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
// Ozvena — Mod Pad
//
// Two modulation modes for animating the reverb tail:
//
//   1. RandomFat — sample-rate-jittered LFO. Each output sample is
//      multiplied by a small random factor (centred on 1.0) drawn
//      from a smoothed pseudo-random walk. This produces the
//      "thicker" / chorus-like tail of Neoverb's RandomFat mode.
//
//   2. Pitch — Doppler-style delay modulation. A slow LFO drives the
//      read pointer of the wet bus a small amount (±1 sample at
//      0.05 Hz), producing subtle pitch wobble.
//
// Depth (X) is normalised 0..1.25 (Neoverb allows up to 125%).
// Rate (Y) is mapped 0..1 → 0.05 Hz..8 Hz.
// ═══════════════════════════════════════════════════════════

import { clamp, hermiteInterp } from "../dsp/math.js";

export interface ModParams {
  enabled: boolean;
  mode: "randomFat" | "pitch";
  /** Depth 0..1.25 (1.0 = unity, 1.25 = 25% over unity). */
  depthX: number;
  /** Rate 0..1, mapped to 0.05 Hz..8 Hz. */
  rateY: number;
}

/**
 * Mulberry32 PRNG — small, fast, deterministic per-seed. Used for
 * RandomFat mode.
 */
function makeRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ModPad {
  prepare(sampleRate: number): void;
  process(wet: Float32Array[], frameCount: number): void;
  setParams(p: ModParams): void;
  getModParams(): { rateHz: number; depthSamples: number };
  reset(): void;
}

export function createModPad(): ModPad {
  let sampleRate = 44100;
  let params: ModParams = { enabled: false, mode: "randomFat", depthX: 0.25, rateY: 0.24 };

  // RandomFat: smoothed PRNG state (one-pole on raw output).
  let rng = makeRng(0xc0ffee);
  let smoothed = 0;

  // Pitch: small fractional delay buffer per channel + LFO phase.
  const MAX_PITCH_DELAY = 4; // samples (1 sample ~ 24 cents @ 1 kHz)
  let pitchBufL: Float32Array = new Float32Array(MAX_PITCH_DELAY * 2 + 16);
  let pitchBufR: Float32Array = new Float32Array(MAX_PITCH_DELAY * 2 + 16);
  let pitchWi = 0;
  let lfoPhase = 0;

  function rateHz(): number {
    // Y ∈ [0, 1] → 0.05 Hz .. 8 Hz (log).
    const y = clamp(params.rateY, 0, 1);
    if (y <= 0) return 0.05;
    if (y >= 1) return 8.0;
    const logMin = Math.log(0.05);
    const logMax = Math.log(8.0);
    return Math.exp(logMin + y * (logMax - logMin));
  }

  return {
    prepare(sr) {
      sampleRate = clamp(sr, 8000, 192000);
      rng = makeRng(0xc0ffee);
      smoothed = 0;
      pitchBufL = new Float32Array(MAX_PITCH_DELAY * 2 + 16);
      pitchBufR = new Float32Array(MAX_PITCH_DELAY * 2 + 16);
      pitchWi = 0;
      lfoPhase = 0;
    },

    process(wet, frameCount) {
      if (!params.enabled || frameCount <= 0) return;
      const depth = clamp(params.depthX, 0, 1.25);
      const rate = rateHz();

      if (params.mode === "randomFat") {
        // One-pole smoothing alpha tied to the rate parameter.
        const alpha = 1 - Math.exp(-rate / Math.max(1e-3, sampleRate));
        for (let i = 0; i < frameCount; i++) {
          // Random walk centred on 0, smoothed.
          const raw = rng() * 2 - 1; // [-1, 1]
          smoothed += alpha * (raw - smoothed);
          // Modulator = 1 + depth * smoothed. Output = wet * modulator.
          const mod = 1 + depth * 0.04 * smoothed;
          for (let c = 0; c < wet.length; c++) {
            wet[c][i] *= mod;
          }
        }
      } else {
        // Pitch: short delay-line modulation. Each channel carries a
        // small ring buffer; LFO controls the read offset.
        const lfoInc = rate / sampleRate;
        const len = pitchBufL.length;
        for (let i = 0; i < frameCount; i++) {
          lfoPhase += lfoInc;
          if (lfoPhase >= 1) lfoPhase -= 1;
          const lfo = Math.sin(lfoPhase * 2 * Math.PI);
          // Read offset: up to MAX_PITCH_DELAY samples (~24 cents at 1 kHz).
          const offset = 1 + depth * MAX_PITCH_DELAY * (lfo * 0.5 + 0.5);

          // Push current samples into the ring.
          pitchBufL[pitchWi] = wet[0]?.[i] ?? 0;
          if (wet.length > 1) pitchBufR[pitchWi] = wet[1][i];

          // Read from (writeIdx - offset) mod len.
          const readIdx = (pitchWi - offset + len * 2) % len;
          const i1 = Math.floor(readIdx);
          const frac = readIdx - i1;
          const i0 = (i1 - 1 + len) % len;
          const i2 = (i1 + 1) % len;
          const i3 = (i1 + 2) % len;

          // 4-point Hermite (Catmull-Rom) — the LFO sweeps the read
          // pointer continuously, so a 2-point lerp would alias. The
          // modulated read lives INSIDE the wet path here (pitch wobble
          // on the reverb tail), where interpolation artifacts ring on.
          const lSample = hermiteInterp(pitchBufL[i0], pitchBufL[i1], pitchBufL[i2], pitchBufL[i3], frac);
          const rSample = hermiteInterp(pitchBufR[i0], pitchBufR[i1], pitchBufR[i2], pitchBufR[i3], frac);

          // Crossfade: dry (current) ↔ wet (modulated read) by depth.
          if (wet.length > 0) wet[0][i] = wet[0][i] * (1 - depth * 0.3) + lSample * (depth * 0.3);
          if (wet.length > 1) wet[1][i] = wet[1][i] * (1 - depth * 0.3) + rSample * (depth * 0.3);

          pitchWi = (pitchWi + 1) % len;
        }
      }
    },

    setParams(p) {
      params = { ...p };
    },

    getModParams() {
      const depth = clamp(params.depthX, 0, 1.25);
      const rate = rateHz();
      if (params.mode === "pitch") {
        return { rateHz: rate, depthSamples: depth * MAX_PITCH_DELAY };
      }
      return { rateHz: rate * 0.5, depthSamples: depth * 2.0 };
    },

    reset() {
      smoothed = 0;
      pitchBufL.fill(0);
      pitchBufR.fill(0);
      pitchWi = 0;
      lfoPhase = 0;
    },
  };
}
