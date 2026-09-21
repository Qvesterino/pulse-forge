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
// (Reconciled from Pulse Forge hardening pass, 2026-09-14: tap crossfade old-distance double-modulo wrap.)
// ═══════════════════════════════════════════════════════════
// Ozvena — Reflections Engine (E1)
//
// Early reflections — initial echoes from walls. Schroeder/Moorer
// style tapped delay lines (NOT an FDN — early reflections need
// discrete, sharp, decorrelated echoes, not diffuse wash).
//
//   • Up to 16 taps per channel, with perceptually smooth time spacing
//   • Tap gain follows 1/√n envelope (so the overall energy decays
//     smoothly without a sharp buildup)
//   • Per-tap low-pass that progressively darkens later reflections
//   • Diffusion control: tap density scaling (low diffusion = sparse
//     discrete echoes; high diffusion = dense cluster)
//   • Angle (0..100) maps to a phase offset between L/R tap sets,
//     shifting the apparent source position
//   • Space + size macros couple time + density
//   • Stereo decorrelated L/R via mutually-incommensurate tap sets
//
// Range: 36.73 .. 250 ms
// ═══════════════════════════════════════════════════════════

import type { ReflectionsEngineState } from "../v2/types.js";
import { clamp, flushDenormal, sanitize } from "../dsp/math.js";
import { createBiquad, setLowPass, processBiquad, type BiquadState } from "../dsp/biquad.js";

export interface ReflectionsParams extends ReflectionsEngineState {}

// Base tap lengths in ms @ 44.1 kHz, low-diffusion sparse layout.
// 12 taps total: 6 left + 6 right (mutually incommensurate prime multiples).
const BASE_TAPS_MS_L: readonly number[] = [
  4.31, 7.93, 12.17, 17.84, 24.62, 32.18, 41.07, 51.36, 63.41, 76.83, 92.05, 108.74,
];
const BASE_TAPS_MS_R: readonly number[] = [
  5.12, 9.41, 14.07, 19.66, 27.13, 35.41, 44.86, 55.72, 68.31, 82.14, 97.85, 115.42,
];

const MAX_TAPS = BASE_TAPS_MS_L.length;

export interface ReflectionsEngine {
  prepare(sampleRate: number, channelCount: number): void;
  process(channels: Float32Array[], frameCount: number): void;
  setParams(p: ReflectionsParams): void;
  getLatencySamples(): number;
  reset(): void;
}

interface TapLayout {
  /** Per-channel tap delays in samples (valid up to activeCount). */
  tapsL: Float32Array;
  tapsR: Float32Array;
  /** Per-channel tap gains (1/√n envelope). */
  gainsL: Float32Array;
  gainsR: Float32Array;
  /** Per-channel low-pass coefficients (one-pole α). */
  lpAlphaL: Float32Array;
  lpAlphaR: Float32Array;
  /** Number of active taps (the arrays above are sized to MAX_TAPS). */
  activeCount: number;
}

export function createReflectionsEngine(): ReflectionsEngine {
  let sampleRate = 44100;
  let channelCount = 2;
  let prepared = false;
  let params: ReflectionsParams = {
    enabled: true,
    space: 0.5,
    time: 80,
    size: 0.5,
    diffusion: 70,
    angle: 50,
    lowpassHz: 8000,
    mix: 100,
    width: 1,
  };

  // Per-channel delay line ring buffers (one per channel), sized to the
  // longest tap. A single persistent write cursor per channel makes the
  // engine block-size independent.
  let bufferL: Float32Array = new Float32Array(1);
  let bufferR: Float32Array = new Float32Array(1);
  let writePosL = 0;
  let writePosR = 0;
  let maxLen = 1;
  // Per-channel per-tap one-pole LPF state.
  let lpfL: Float32Array = new Float32Array(MAX_TAPS);
  let lpfR: Float32Array = new Float32Array(MAX_TAPS);
  // Tap-length crossfade (mirrors the FDN engines): time/size automation
  // moves the tap distances; blending the previous tap set out over ~20 ms
  // turns the jump into an inaudible morph.
  const oldTapsL = new Float64Array(MAX_TAPS);
  const oldTapsR = new Float64Array(MAX_TAPS);
  let tapFadeRemaining = 0;
  let tapFadeLen = 1;
  let oldActiveCount = 0;
  let hasRendered = false;
  // Number of tap slots valid in oldTapsL/oldTapsR during a fade
  // (the shared count of the previous and current layouts).
  let tapBlendCount = 0;

  let layout: TapLayout = {
    tapsL: new Float32Array(MAX_TAPS),
    tapsR: new Float32Array(MAX_TAPS),
    gainsL: new Float32Array(MAX_TAPS),
    gainsR: new Float32Array(MAX_TAPS),
    lpAlphaL: new Float32Array(MAX_TAPS),
    lpAlphaR: new Float32Array(MAX_TAPS),
    activeCount: 0,
  };
  // Side biquad for the global low-pass on later reflections.
  let sideBiquad: BiquadState = createBiquad(2);

  // Pre-allocated per-block wet scratch (grow-only). The process loop used
  // to slice() the dry channels and allocate fresh wet buffers on every
  // block, which churned the GC in the realtime path.
  let wetScratchL = new Float32Array(0);
  let wetScratchR = new Float32Array(0);

  function ensureScratch(n: number): void {
    if (wetScratchL.length < n) {
      const size = Math.max(1024, n);
      wetScratchL = new Float32Array(size);
      wetScratchR = new Float32Array(size);
    }
  }

  function recomputeLayout(): void {
    // Roadmap O1/O7: `space` and `size` are the documented macros ("adjusts
    // time + size together", default 0.5). They were carried in the state,
    // written by the assistant and exposed as automation targets, but read
    // by NO engine — an automated "space" produced no sound change. Wire
    // them as multiplicative offsets around the neutral 0.5 midpoint so
    // existing projects (space/size = 0.5) stay bit-identical.
    // (Reconciled from Pulse Forge audit, 2026-09-19.)
    const spaceScale = 1 + (clamp(params.space ?? 0.5, 0, 1) - 0.5) * 0.6;
    const sizeScale = 1 + (clamp(params.size ?? 0.5, 0, 1) - 0.5) * 0.6;
    const timeMs = clamp(params.time * spaceScale, 36.73, 250);
    const diffusion = clamp((clamp(params.diffusion, 0, 100) / 100) * sizeScale, 0, 1);
    const angle = clamp(params.angle, 0, 100) / 100;

    // Use `diffusion` to decide how many taps are active. diffusion 0 = 4 taps,
    // diffusion 1 = all 12 taps.
    const activeCount = Math.max(4, Math.floor(4 + diffusion * (MAX_TAPS - 4)));

    // Layout arrays are allocated once at MAX_TAPS capacity and only
    // refilled here — setParams() (every automation tick) must not allocate.
    const tapsL = layout.tapsL;
    const tapsR = layout.tapsR;
    const gainsL = layout.gainsL;
    const gainsR = layout.gainsR;
    const lpAlphaL = layout.lpAlphaL;
    const lpAlphaR = layout.lpAlphaR;

    const norm = 1 / Math.sqrt(activeCount);
    const lpBaseHz = clamp(params.lowpassHz, 30, 20000);
    const lpBaseAlpha = 1 - Math.exp((-2 * Math.PI * lpBaseHz) / sampleRate);

    // Scale base taps so the LAST active tap lands exactly on `timeMs`.
    // BASE_TAPS_MS_* are milliseconds; convert to samples at this rate.
    const msToSamples = sampleRate / 1000;
    const lastBaseL = BASE_TAPS_MS_L[activeCount - 1];
    const lastBaseR = BASE_TAPS_MS_R[activeCount - 1];
    const scaleL = (timeMs / lastBaseL) * msToSamples;
    const scaleR = (timeMs / lastBaseR) * msToSamples;

    // Preserve the previous tap layout for the crossfade BEFORE refilling
    // (only shared tap slots blend; extra/removed taps appear or vanish
    // smoothly because the per-tap gains carry 1/sqrt(n) normalization).
    const sharedCount = Math.min(activeCount, oldActiveCount);
    for (let i = 0; i < sharedCount; i++) {
      oldTapsL[i] = tapsL[i];
      oldTapsR[i] = tapsR[i];
    }
    tapBlendCount = sharedCount;

    for (let i = 0; i < activeCount; i++) {
      // Scale base tap by (timeMs / last-base-tap) so the LAST active
      // tap reaches the desired time. Earlier taps are scaled linearly.
      const baseL = BASE_TAPS_MS_L[i];
      const baseR = BASE_TAPS_MS_R[i];
      tapsL[i] = Math.max(1, Math.round(baseL * scaleL));
      tapsR[i] = Math.max(1, Math.round(baseR * scaleR));

      gainsL[i] = norm;
      gainsR[i] = norm * (0.85 + 0.3 * angle); // angle scales R slightly

      // Progressively darken later taps.
      const darken = 1 - 0.7 * (i / Math.max(1, activeCount - 1));
      lpAlphaL[i] = clamp(lpBaseAlpha * darken, 1e-6, 1);
      lpAlphaR[i] = clamp(lpBaseAlpha * darken, 1e-6, 1);
    }
    layout.activeCount = activeCount;

    // Arm the tap crossfade when a shared tap distance actually moved.
    // prepare() clears the fade after its initial recompute.
    if (prepared && hasRendered && oldActiveCount > 0) {
      let changed = false;
      for (let i = 0; i < sharedCount; i++) {
        if (tapsL[i] !== oldTapsL[i] || tapsR[i] !== oldTapsR[i]) {
          changed = true;
          break;
        }
      }
      if (changed) {
        tapFadeLen = Math.max(1, Math.round(0.02 * sampleRate));
        tapFadeRemaining = tapFadeLen;
      }
    }
    oldActiveCount = activeCount;

    // The maximum tap length determines the ring wrap length. The backing
    // buffers are sized for the full parameter range in prepare(); a grow
    // here is a contract-violation fallback, not a steady-state path.
    maxLen = 1;
    for (let i = 0; i < activeCount; i++) {
      maxLen = Math.max(maxLen, tapsL[i], tapsR[i]);
    }
    if (bufferL.length < maxLen) {
      bufferL = new Float32Array(maxLen);
      bufferR = new Float32Array(maxLen);
    }
  }

  return {
    prepare(sr, cc) {
      sampleRate = clamp(sr, 8000, 192000);
      channelCount = Math.max(1, cc);
      recomputeLayout();
      tapFadeRemaining = 0;
      hasRendered = false;
      sideBiquad = createBiquad(channelCount);
      // The lowpass here is in series with the tap LPF, so a sharper cutoff
      // than the per-tap value is reasonable.
      setLowPass(sideBiquad.coeffs, clamp(params.lowpassHz, 30, 20000), 0.7071, sampleRate);

      prepared = true; // Size the ring for the FULL parameter range (250 ms worst case) so
      // setParams() never reallocates it — mirrors the native engine.
      const maxScaleL = ((250 / BASE_TAPS_MS_L[MAX_TAPS - 1]) * sampleRate) / 1000;
      const maxScaleR = ((250 / BASE_TAPS_MS_R[MAX_TAPS - 1]) * sampleRate) / 1000;
      const capacity = Math.max(
        1,
        Math.ceil(Math.max(BASE_TAPS_MS_L[MAX_TAPS - 1] * maxScaleL, BASE_TAPS_MS_R[MAX_TAPS - 1] * maxScaleR)),
      );
      bufferL = new Float32Array(capacity);
      bufferR = new Float32Array(capacity);
      writePosL = 0;
      writePosR = 0;
      lpfL = new Float32Array(MAX_TAPS);
      lpfR = new Float32Array(MAX_TAPS);
    },

    process(channels, frameCount) {
      if (!params.enabled || frameCount <= 0) return;

      // PURE-WET contract: the engine writes ONLY the reflection tail into
      // the channel buffers — the processor owns every dry/blend/mix gain.
      // (The `mix` parameter is applied by the processor's wet-bus mix.)
      const len = channels.length;
      const hasL = len > 0;
      const hasR = len > 1;
      ensureScratch(frameCount);
      const wetL = hasL ? wetScratchL : null;
      const wetR = hasR ? wetScratchR : null;

      const tapsL = layout.tapsL;
      const tapsR = layout.tapsR;
      const gainsL = layout.gainsL;
      const gainsR = layout.gainsR;
      const lpAlphaL = layout.lpAlphaL;
      const lpAlphaR = layout.lpAlphaR;
      const activeCount = layout.activeCount;

      let wl = writePosL;
      let wr = writePosR;
      for (let i = 0; i < frameCount; i++) {
        // Push current input into ring buffers (read-then-write).
        const inL = hasL ? channels[0][i] : 0;
        const inR = hasR ? channels[1][i] : inL;

        if (hasL) bufferL[wl] = inL;
        if (hasR) bufferR[wr] = inR;
        wl++;
        if (wl >= maxLen) wl = 0;
        wr++;
        if (wr >= maxLen) wr = 0;

        let sumL = 0;
        let sumR = 0;
        if (hasL) {
          for (let t = 0; t < activeCount; t++) {
            const d = tapsL[t];
            const idx = wl - d;
            const ri = idx < 0 ? idx + maxLen : idx;
            let s = bufferL[ri];
            if (tapFadeRemaining > 0 && t < tapBlendCount) {
              // Tap crossfade: blend the previous tap distance out. The old
              // distance can EXCEED the current maxLen (maxLen is derived
              // from the NEW tap set — sweeping time downward shrinks it),
              // so a single wrap-add can still land negative and read
              // `undefined` → NaN → the tap's LPF state latches NaN and the
              // tap goes permanently silent. Double-modulo, like the FDN
              // engines' readTap, wraps any distance safely.
              const tFade = tapFadeRemaining / tapFadeLen;
              const oldD = oldTapsL[t];
              const rawL = wl - oldD;
              const oldRi = ((rawL % maxLen) + maxLen) % maxLen;
              const sOld = bufferL[oldRi];
              s = s * (1 - tFade) + sOld * tFade;
            }
            lpfL[t] += lpAlphaL[t] * (s - lpfL[t]);
            lpfL[t] = flushDenormal(lpfL[t]);
            sumL += sanitize(lpfL[t]) * gainsL[t];
          }
        }
        if (hasR) {
          for (let t = 0; t < activeCount; t++) {
            const d = tapsR[t];
            const idx = wr - d;
            const ri = idx < 0 ? idx + maxLen : idx;
            let s = bufferR[ri];
            if (tapFadeRemaining > 0 && t < tapBlendCount) {
              // Tap crossfade: blend the previous tap distance out (see the
              // left-channel comment — double-modulo keeps the old-distance
              // read inside the ring even when it exceeds maxLen).
              const tFade = tapFadeRemaining / tapFadeLen;
              const oldD = oldTapsR[t];
              const rawR = wr - oldD;
              const oldRi = ((rawR % maxLen) + maxLen) % maxLen;
              const sOld = bufferR[oldRi];
              s = s * (1 - tFade) + sOld * tFade;
            }
            lpfR[t] += lpAlphaR[t] * (s - lpfR[t]);
            lpfR[t] = flushDenormal(lpfR[t]);
            sumR += sanitize(lpfR[t]) * gainsR[t];
          }
        }

        // Engine produces the tail only — no internal mix gain.
        if (wetL) wetL[i] = sumL;
        if (wetR) wetR[i] = sumR;
        // Tap-crossfade clock: per-SAMPLE like the FDN engines. The old
        // code decremented once per BLOCK, so the 20 ms fade stretched to
        // 128x its length (2.56 s at 128-frame blocks) and scaled with the
        // host block size — E1 TIME automation audibly morphed for seconds.
        // (Reconciled from Pulse Forge audit, 2026-09-19.)
        if (tapFadeRemaining > 0) tapFadeRemaining--;
      }
      writePosL = wl;
      writePosR = wr;
      hasRendered = true;

      // Apply side-chain low-pass to wet.
      if (wetL && wetR) processBiquad(sideBiquad, [wetL, wetR], frameCount);
      else if (wetL) processBiquad(sideBiquad, [wetL], frameCount);

      // Pure wet write-back — no dry, no mix gain. Roadmap O6: output
      // M/S width (1 = untouched, default; 0 = mono sum) mirrors the FDN
      // engines convention.
      const w = clamp(params.width ?? 1, 0, 1);
      if (wetL && wetR && w < 1) {
        for (let i = 0; i < frameCount; i++) {
          const mono = (wetL[i] + wetR[i]) * 0.5;
          channels[0][i] = wetL[i] * w + mono * (1 - w);
          channels[1][i] = wetR[i] * w + mono * (1 - w);
        }
      } else if (wetL) {
        for (let i = 0; i < frameCount; i++) {
          channels[0][i] = wetL[i];
        }
      }
      if (wetR && !(wetL && w < 1)) {
        for (let i = 0; i < frameCount; i++) {
          channels[1][i] = wetR[i];
        }
      }
    },

    setParams(p) {
      params = { ...p };
      recomputeLayout();
      setLowPass(sideBiquad.coeffs, clamp(params.lowpassHz, 30, 20000), 0.7071, sampleRate);
    },

    getLatencySamples() {
      return 0;
    },

    reset() {
      tapFadeRemaining = 0;
      bufferL.fill(0);
      bufferR.fill(0);
      writePosL = 0;
      writePosR = 0;
      lpfL.fill(0);
      lpfR.fill(0);
      sideBiquad.z1.fill(0);
      sideBiquad.z2.fill(0);
    },
  };
}

