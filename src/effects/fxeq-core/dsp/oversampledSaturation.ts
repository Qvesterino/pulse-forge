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
// FXEQ — Oversampled saturation wrapper
//
// Wraps the waveshaper with up/downsampling so the nonlinear shape
// runs at 2× or 4× the host sample rate. This is the only correct
// way to handle the harmonics that saturation generates above the
// host Nyquist; linear interpolation aliases them back into the
// audible band.
//
// Implementation note: we use **direct FIR filtering** rather than
// polyphase decomposition. The polyphase approach has a structural
// problem with symmetric windowed-sinc kernels — the center tap
// concentrates all the energy in one phase, leaving the other
// subfilters as single-tap delays that don't actually filter.
//
// Direct FIR is computationally more expensive (~factor × extra
// operations) but produces correct anti-aliasing at any factor.
//
// Modes of operation:
//   - factor = 1 → passthrough (no aliasing concern; cheap).
//   - factor = 2 → upsample 2× → shape → lowpass → downsample 2×.
//   - factor = 4 → same with 4×.
//
// The wrapper reports its added latency to the host so PDC stays
// correct. Cross-block FIR history is held in the per-channel
// delay lines.
// ═══════════════════════════════════════════════════════════

import type { Channels } from "../dsp/types.js";
import {
  applyShapeEx,
  createSaturationState,
  modeNeedsDCBlock,
  dcBlockSaturation,
  type SaturationChannelState,
} from "../dsp/waveshapers.js";
import {
  designLowpassKernel,
  type OversampleFactor,
  pickOversampleFactor,
} from "../dsp/oversampler.js";

export interface OversampledSaturation {
  prepare(sampleRate: number, channelCount: number, maxBlockSize: number): void;
  process(
    channels: Channels,
    frameCount: number,
    mode: number,
    driveDb: number,
    mix01: number,
    outputLinear: number,
    quality: "eco" | "standard" | "high" | "render",
  ): void;
  getLatencySamples(): number;
  reset(): void;
  /**
   * Zero the FIR delay lines and the dry-alignment ring WITHOUT touching the
   * waveshaper state or the reported latency. Called when the module is
   * re-enabled after a bypassed period: process() did not run while
   * bypassed, so the FIR history and dry ring hold pre-bypass audio that
   * would otherwise replay as a stale burst on the first active block.
   */
  clearDelayHistory(): void;
}

export function createOversampledSaturation(): OversampledSaturation {
  let prepared = false;
  let sampleRate = 44100;
  let channelCount = 2;
  let maxBlockSize = 0;

  // ── Pre-built filter sets (audit M1: no allocation in process()) ──
  // The oversampling factor changes with drive/quality automation, and
  // the old code redesigned the FIR kernels and reallocated every buffer
  // inside process() at each threshold crossing — GC spikes on the audio
  // thread. Both factor configurations are now built once in prepare();
  // process() only picks a ready-made set.
  interface FilterSet {
    upKernel: Float32Array;
    downKernel: Float32Array;
    upTaps: number;
    downTaps: number;
  }
  let sets: { 2: FilterSet; 4: FilterSet; 8: FilterSet } | null = null;
  // Per-factor, per-channel FIR delay lines (same rationale).
  const upDelayByFactor = new Map<number, Float32Array[]>();
  const downDelayByFactor = new Map<number, Float32Array[]>();

  // Per-channel oversampled scratch buffers (sized for the largest
  // factor so a factor switch never reallocates).
  let upsampled: Float32Array[] = [];  // [ch][N*4]
  let processed: Float32Array[] = [];  // [ch][N*4]

  let lastFactor: OversampleFactor = 1;

  // Wet/dry alignment (audit C2): the oversampled path delays the wet
  // signal by the up+down FIR group delay while the dry term used the
  // undelayed input, so any mix < 100 % comb-filtered against an ~8-sample
  // offset. The FIR pair here is symmetric with (taps-1)/factor = 8 input
  // samples of delay at both 2× (17 taps) and 4× (33 taps), so a ring of
  // that exact length aligns the dry reference with the wet path.
  const DRY_DELAY = 8;
  let dryDelay: Float32Array[] = []; // [ch][DRY_DELAY]
  let dryPos: number[] = [];

  let satState: SaturationChannelState[] = [];

  function buildFilterSet(factor: 2 | 4 | 8): FilterSet {
    // Design two FIR lowpass filters:
    //  1) Upsample lowpass at oversampled rate (removes spectral images).
    //  2) Downsample lowpass at oversampled rate (anti-alias before decimation).
    // Both share the same design — cutoff at input Nyquist. We use a
    // causal (time-reversed) symmetric kernel so it can be applied
    // sample-by-sample without look-ahead.
    const cutoff = sampleRate / 2;
    // Taps proportional to factor: more taps for higher factor for
    // sharper transition. (taps-1)/factor = 8 input samples of group
    // delay at EVERY factor, so DRY_DELAY stays valid.
    const taps = factor === 8 ? 65 : factor === 4 ? 33 : 17;
    const sym = designLowpassKernel(cutoff, sampleRate * factor, taps);
    // Time-reverse to make causal (FIR with peak at index 0).
    const upKernel = new Float32Array(sym.length);
    const downKernel = new Float32Array(sym.length);
    for (let i = 0; i < sym.length; i++) {
      upKernel[i] = sym[sym.length - 1 - i];
      downKernel[i] = sym[sym.length - 1 - i];
    }
    return { upKernel, downKernel, upTaps: upKernel.length, downTaps: downKernel.length };
  }

  function allocBuffers(): void {
    upsampled = [];
    processed = [];
    satState = [];
    dryDelay = [];
    dryPos = [];
    upDelayByFactor.clear();
    downDelayByFactor.clear();
    // P-engine #10: sized for the largest factor (8×) so a quality
    // switch to render never reallocates on the audio thread.
    const maxFactor = 8;
    const oversampledLen = Math.max(maxBlockSize * maxFactor, maxBlockSize);
    for (let c = 0; c < channelCount; c++) {
      upsampled.push(new Float32Array(oversampledLen));
      processed.push(new Float32Array(oversampledLen));
      satState.push(createSaturationState());
      dryDelay.push(new Float32Array(DRY_DELAY));
      dryPos.push(0);
    }
    const tapsFor = (f: number): number => (f === 8 ? 65 : f === 4 ? 33 : 17);
    for (const factor of [2, 4, 8] as const) {
      const taps = tapsFor(factor);
      const ups: Float32Array[] = [];
      const downs: Float32Array[] = [];
      for (let c = 0; c < channelCount; c++) {
        ups.push(new Float32Array(taps));
        downs.push(new Float32Array(taps));
      }
      upDelayByFactor.set(factor, ups);
      downDelayByFactor.set(factor, downs);
    }
  }

  return {
    prepare(sr, cc, maxBs) {
      sampleRate = sr;
      channelCount = Math.max(1, cc);
      maxBlockSize = Math.max(1, maxBs);
      sets = { 2: buildFilterSet(2), 4: buildFilterSet(4), 8: buildFilterSet(8) };
      allocBuffers();
      prepared = true;
    },

    process(channels, frameCount, mode, driveDb, mix01, outputLinear, quality) {
      if (!prepared || frameCount <= 0) return;
      const driveLinear = Math.pow(10, driveDb / 20);
      const wet = mix01;
      const dry = 1 - wet;

      // Audit M1: switching quality/drive across an oversampling threshold
      // only flips to a pre-built filter set — no kernel design, no buffer
      // reallocation on the audio thread. The NEW factor's FIR delay lines
      // are zeroed on the switch: they hold history from the previous
      // period at that factor (possibly long ago under drive automation),
      // which would replay as a stale burst instead of filtering live
      // audio. The dry ring needs no clearing — it is clocked every block
      // while the module is enabled (both factor paths).
      const factor = pickOversampleFactor(quality, mode, driveDb);
      if (factor !== lastFactor) {
        const staleUp = upDelayByFactor.get(factor);
        const staleDown = downDelayByFactor.get(factor);
        if (staleUp) for (const d of staleUp) d.fill(0);
        if (staleDown) for (const d of staleDown) d.fill(0);
      }
      lastFactor = factor;

      if (factor === 1) {
        for (let c = 0; c < channels.length; c++) {
          const buf = channels[c];
          const st = satState[c] ?? (satState[c] = createSaturationState());
          // Clock the dry-alignment ring even at 1× so it holds live dry
          // history: drive automation crossing the oversample threshold
          // flips the factor 1↔2+ mid-stream, and the oversampled path's
          // delayed dry read would otherwise replay content from the
          // previous oversampled period as a stale burst.
          const dryRing = dryDelay[c] ?? (dryDelay[c] = new Float32Array(DRY_DELAY));
          let ringPos = dryPos[c] ?? 0;
          for (let i = 0; i < frameCount; i++) {
            const x = buf[i];
            dryRing[ringPos] = x;
            ringPos = (ringPos + 1) % DRY_DELAY;
            const driven = x * driveLinear;
            let shaped = applyShapeEx(mode, driven, st, sampleRate, driveLinear) * outputLinear;
            if (modeNeedsDCBlock(mode)) shaped = dcBlockSaturation(shaped, st, sampleRate);
            buf[i] = x * dry + shaped * wet;
          }
          dryPos[c] = ringPos;
        }
        return;
      }

      // Direct-FIR oversampling path.
      const factorK = factor;
      const upsampledLen = frameCount * factorK;
      const osr = sampleRate * factorK;
      // Pick the pre-built filter set + delay lines for this factor
      // (P-engine #10: includes the offline 8× set).
      const set = factor === 8 ? sets![8] : factor === 4 ? sets![4] : sets![2];
      const upKernel = set.upKernel;
      const downKernel = set.downKernel;
      const upTaps = set.upTaps;
      const downTaps = set.downTaps;
      const upDelay = upDelayByFactor.get(factor)!;
      const downDelay = downDelayByFactor.get(factor)!;
      // Wet-path group delay in input samples; the dry ring reads this
      // far back so both mix terms stay time-aligned (audit C2).
      const dryDelayAmt = Math.min(
        DRY_DELAY,
        Math.max(0, Math.round(((upTaps - 1) + (downTaps - 1)) / (2 * factorK))),
      );

      for (let c = 0; c < channels.length; c++) {
        const inBuf = channels[c];
        const upBuf = upsampled[c];
        const procBuf = processed[c];
        const delay = upDelay[c];
        const st = satState[c] ?? (satState[c] = createSaturationState());
        const dryRing = dryDelay[c] ?? (dryDelay[c] = new Float32Array(DRY_DELAY));
        let ringPos = dryPos[c] ?? 0;

        // Step 1: upsample by factor (insert zeros, then lowpass at
        // oversampled rate). Direct convolution with the upKernel.
        // The delay line holds past INPUT samples; we insert (factor-1)
        // zeros between each new input sample.
        for (let n = 0; n < frameCount; n++) {
          // Shift delay line (newest first).
          for (let i = upTaps - 1; i > 0; i--) delay[i] = delay[i - 1];
          delay[0] = inBuf[n];

          // Produce `factor` output samples per input sample. Each
          // output sample uses the same delay line but the kernel is
          // shifted to simulate the inserted zeros.
          for (let p = 0; p < factorK; p++) {
            // For phase p of factor, the effective kernel is
            // upKernel[p], upKernel[p+factor], upKernel[p+2*factor], ...
            // applied to the input-rate delay line (where zeros are
            // implicit at non-input-sample positions).
            let acc = 0;
            for (let t = p, k = 0; t < upTaps; t += factorK, k++) {
              acc += upKernel[t] * delay[k];
            }
            upBuf[n * factorK + p] = acc;
          }
        }

        // Step 2: apply waveshaper at oversampled rate.
        for (let i = 0; i < upsampledLen; i++) {
          const driven = upBuf[i] * driveLinear;
          let shaped = applyShapeEx(mode, driven, st, osr, driveLinear) * outputLinear;
          if (modeNeedsDCBlock(mode)) shaped = dcBlockSaturation(shaped, st, osr);
          procBuf[i] = shaped;
        }

        // Step 3: downsample with anti-aliasing filter.
        // Push ALL factor oversampled samples through the delay line per
        // output sample so the FIR lowpass actually filters alias energy.
        // Skipping the in-between samples defeats the anti-alias filter.
        const dDelay = downDelay[c];
        let procIdx = 0;
        for (let n = 0; n < frameCount; n++) {
          for (let p = 0; p < factorK; p++) {
            for (let i = downTaps - 1; i > 0; i--) dDelay[i] = dDelay[i - 1];
            dDelay[0] = procBuf[procIdx];
            procIdx++;
          }
          let acc = 0;
          for (let t = 0; t < downTaps; t++) acc += downKernel[t] * dDelay[t];
          // Delay the dry term by the FIR group delay so dry and wet are
          // time-aligned at any mix position (audit C2).
          const delayedDry = dryRing[(ringPos - dryDelayAmt + DRY_DELAY) % DRY_DELAY];
          dryRing[ringPos] = inBuf[n];
          ringPos = (ringPos + 1) % DRY_DELAY;
          inBuf[n] = delayedDry * dry + acc * wet;
        }
        dryPos[c] = ringPos;
      }
    },

    getLatencySamples() {
      if (lastFactor <= 1 || !sets) return 0;
      // Total wet-path latency = upsample group delay + downsample group
      // delay, both FIR pairs symmetric with (taps-1) samples at the
      // oversampled rate. (taps-1)/factor = 8 input samples at 2× (17
      // taps), 4× (33 taps) AND 8× (65 taps) — matching DRY_DELAY.
      const set = lastFactor === 8 ? sets[8] : lastFactor === 4 ? sets[4] : sets[2];
      const upLatency = (set.upTaps - 1) / (2 * lastFactor);
      const downLatency = (set.downTaps - 1) / (2 * lastFactor);
      return Math.round(upLatency + downLatency);
    },

    clearDelayHistory() {
      for (const delays of upDelayByFactor.values()) for (const d of delays) d.fill(0);
      for (const delays of downDelayByFactor.values()) for (const d of delays) d.fill(0);
      for (const d of dryDelay) d.fill(0);
      for (let c = 0; c < dryPos.length; c++) dryPos[c] = 0;
    },

    reset() {
      for (const delays of upDelayByFactor.values()) for (const d of delays) d.fill(0);
      for (const delays of downDelayByFactor.values()) for (const d of delays) d.fill(0);
      for (const d of dryDelay) d.fill(0);
      for (let c = 0; c < dryPos.length; c++) dryPos[c] = 0;
      for (const st of satState) {
        st.millerLpf = 0; st.hystFlux = 0; st.tapeBump = 0;
        st.transformerFlux = 0; st.dcPrevIn = 0; st.dcPrev = 0;
        st.adaaPrevIn = 0;
      }
      // Reset the oversampling factor too: the host reads getLatencySamples()
      // (via maxBandLatency) BEFORE the next process() runs, so a stale factor
      // from pre-reset audio made the first post-reset block carry the old
      // alignment delay — a reset processor was not equivalent to a freshly
      // prepared one. A fresh processor starts with factor 1.
      lastFactor = 1;
    },
  };
}