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
// Ozvena — Convolution Reverb Engine
//
// IR-based reverb using partitioned FFT convolution. Follows
// the same engine contract as ReflectionsEngine / PlateChamberEngine /
// HallEngine: input → in-place output where output = dry*(1-mix) + wet*mix.
//
// Pre/post EQ is handled by the processor's Pre EQ / Reverb EQ stages,
// NOT by this engine. The engine is a pure convolution + wet-only output.
//
// Allocation-free at steady state (scratch buffers reused).
// ═══════════════════════════════════════════════════════════

import { clamp } from "../dsp/math.js";
import {
  createPartitionedConvolver,
  type PartitionedConvolver,
  recommendPartitionSize,
} from "../dsp/fftPartitioned.js";

export interface ConvolutionEngineParams {
  /** Wet mix 0..100. */
  mix: number;
  /** Enabled flag. */
  enabled: boolean;
}

export const DEFAULT_CONVOLUTION_ENGINE_PARAMS: ConvolutionEngineParams = {
  mix: 50,
  enabled: true,
};

export type IrChannelCount = 1 | 2 | 4;

export interface ConvolutionEngine {
  prepare(sampleRate: number, channelCount: number, maxBlockSize?: number): void;
  /**
   * Load an impulse response. Clears any existing IR.
   * `irChannels`: 1 = mono (broadcast), 2 = stereo (L→L, R→R),
   * 4 = TRUE-STEREO interleaved (LL, LR, RL, RR — Space Designer
   * convention: outL = inL·LL + inR·RL, outR = inL·LR + inR·RR).
   */
  loadIr(ir: Float32Array, sampleRate: number, irChannels?: IrChannelCount): void;
  /** Remove the active IR and return to a dry/no-convolution state. */
  clearIr(): void;
  /** Returns true if an IR is currently loaded. */
  isIrLoaded(): boolean;
  /** Latency in samples (partitionSize / 2). */
  getLatencySamples(): number;
  /** IR length in samples (per channel). */
  getIrLengthSamples(): number;
  /** Channel count of the loaded IR (1/2/4), 0 when empty. */
  getIrChannels(): IrChannelCount | 0;
  process(channels: Float32Array[], frameCount: number): void;
  setParams(p: ConvolutionEngineParams): void;
  reset(): void;
}

/**
 * Create a convolution reverb engine.
 *
 * @param partitionSize  FFT size for partitioned convolution (power of two).
 *                       Defaults to 2048.
 */
export function createConvolutionEngine(
  partitionSize = 2048,
): ConvolutionEngine {
  let channelCount = 2;
  let preparedMaxBlockSize = 4096;
  let params: ConvolutionEngineParams = { ...DEFAULT_CONVOLUTION_ENGINE_PARAMS };

  // Partitioned convolvers. True-stereo uses 4 taps:
  // conv[0]=LL, conv[1]=LR, conv[2]=RL, conv[3]=RR.
  // 2ch: conv[0]=L, conv[1]=R. 1ch: conv[0] only (broadcast).
  const conv: (PartitionedConvolver | null)[] = [null, null, null, null];
  let irChannels: IrChannelCount | 0 = 0;
  let irLengthSamples = 0;

  // IR-swap crossfade (~50 ms): the previous convolver set keeps processing
  // and its wet output is blended out while the new set blends in, so an
  // IR change during playback morphs instead of stepping. The old set is
  // dropped when the fade completes.
  const oldConv: (PartitionedConvolver | null)[] = [null, null, null, null];
  let oldIrChannels: IrChannelCount | 0 = 0;
  let convFadePos = 0;
  let convFadeLen = 0;
  let hostSampleRate = 44100;
  // The crossfade only matters while audio is actually flowing; a swap
  // during silence applies instantly (nothing to blend).
  let hasRendered = false;
  // Extra scratch for the fading-out set (allocated once, at swap time on
  // the control thread — never in process()).
  let oldScratchL = new Float32Array(4096);
  let oldScratchR = new Float32Array(4096);
  let oldTmp1 = new Float32Array(4096);
  let oldTmp2 = new Float32Array(4096);

  // Scratch buffers for wet-only output.
  let scratchWetL: Float32Array = new Float32Array(4096);
  let scratchWetR: Float32Array = new Float32Array(4096);
  let scratchTmp: Float32Array = new Float32Array(4096);
  let scratchTmp2: Float32Array = new Float32Array(4096);

  function ensureWetScratch(frameCount: number) {
    if (scratchWetL.length < frameCount) {
      const size = Math.max(4096, frameCount);
      scratchWetL = new Float32Array(size);
      scratchWetR = new Float32Array(size);
      scratchTmp = new Float32Array(size);
      scratchTmp2 = new Float32Array(size);
    }
  }

  function ensureOldScratch() {
    if (oldScratchL.length < preparedMaxBlockSize) {
      oldScratchL = new Float32Array(preparedMaxBlockSize);
      oldScratchR = new Float32Array(preparedMaxBlockSize);
      oldTmp1 = new Float32Array(preparedMaxBlockSize);
      oldTmp2 = new Float32Array(preparedMaxBlockSize);
    }
  }

  /**
   * Compute the wet output of one convolver set into outL/outR
   * (mirrors the historical single-set process() body).
   */
  function computeWetSet(
    set: (PartitionedConvolver | null)[],
    setIrChannels: IrChannelCount | 0,
    channels: Float32Array[],
    frameCount: number,
    n: number,
    outL: Float32Array,
    outR: Float32Array,
    tmp1: Float32Array,
    tmp2: Float32Array,
  ): void {
    if (setIrChannels === 4 && n === 2) {
      // TRUE-STEREO: outL = inL·LL + inR·RL, outR = inL·LR + inR·RR.
      const inL = channels[0];
      const inR = channels[1];
      const c0 = set[0] as PartitionedConvolver;
      const c1 = set[1] as PartitionedConvolver;
      const c2 = set[2] as PartitionedConvolver;
      const c3 = set[3] as PartitionedConvolver;
      c0.process(inL, frameCount, outL);      // LL → outL
      c1.process(inL, frameCount, tmp1);      // LR → part outR
      c2.process(inR, frameCount, outR);      // RL → part outL
      c3.process(inR, frameCount, tmp2);      // RR → outR
      for (let i = 0; i < frameCount; i++) {
        outL[i] += outR[i];                   // outL = LL + RL
        outR[i] = tmp1[i] + tmp2[i];          // outR = LR + RR
      }
    } else {
      // Mono broadcast (mono IR) or dual-mono stereo (L→L, R→R).
      for (let c = 0; c < n; c++) {
        const cv = setIrChannels === 1 ? set[0] : set[c];
        const wet = c === 0 ? outL : outR;
        if (cv && wet) cv.process(channels[c], frameCount, wet);
      }
    }
  }

  return {
    prepare(sr, cc, maxBlockSize = 4096) {
      channelCount = Math.max(1, Math.min(2, cc));
      preparedMaxBlockSize = Math.max(64, maxBlockSize);
      hostSampleRate = sr;
      ensureWetScratch(preparedMaxBlockSize);
      if (oldScratchL.length < preparedMaxBlockSize) {
        oldScratchL = new Float32Array(preparedMaxBlockSize);
        oldScratchR = new Float32Array(preparedMaxBlockSize);
        oldTmp1 = new Float32Array(preparedMaxBlockSize);
        oldTmp2 = new Float32Array(preparedMaxBlockSize);
      }
      // A re-prepare cancels any in-flight IR crossfade.
      convFadePos = 0;
      convFadeLen = 0;
      hasRendered = false;
      oldConv[0] = oldConv[1] = oldConv[2] = oldConv[3] = null;
    },

    loadIr(ir, _sr, irCh: IrChannelCount = 2) {
      if (ir.length === 0 || (irCh !== 1 && irCh !== 2 && irCh !== 4)) {
        conv[0] = conv[1] = conv[2] = conv[3] = null;
        irLengthSamples = 0;
        irChannels = 0;
        return;
      }
      // An IR swap while audio flows: move the active set aside and arm
      // the wet crossfade (only when an IR was actually loaded).
      if (conv[0] !== null && preparedMaxBlockSize > 0 && hasRendered) {
        oldConv[0] = conv[0]; oldConv[1] = conv[1];
        oldConv[2] = conv[2]; oldConv[3] = conv[3];
        oldIrChannels = irChannels;
        convFadeLen = Math.max(1, Math.round(0.05 * hostSampleRate));
        convFadePos = 0;
        ensureOldScratch();
      }
      irLengthSamples = Math.floor(ir.length / irCh);
      irChannels = irCh;
      if (irLengthSamples === 0) {
        conv[0] = conv[1] = conv[2] = conv[3] = null;
        irChannels = 0;
        return;
      }
      const ps = Math.max(partitionSize, recommendPartitionSize(irLengthSamples));
      const mk = (chIdx: number): PartitionedConvolver => {
        const data = new Float32Array(irLengthSamples);
        for (let i = 0; i < irLengthSamples; i++) {
          data[i] = ir[i * irCh + chIdx] ?? 0;
        }
        return createPartitionedConvolver(data, {
          irLength: irLengthSamples,
          partitionSize: ps,
        });
      };
      if (channelCount === 1) {
        // Mono bus: single convolver (first channel of the IR).
        conv[0] = mk(0);
        conv[1] = null;
        conv[2] = null;
        conv[3] = null;
        irChannels = 1;
      } else if (irCh === 1) {
        // Mono IR: broadcast to both bus channels.
        conv[0] = mk(0);
        conv[1] = mk(0);
        conv[2] = null;
        conv[3] = null;
        irChannels = 1;
      } else if (irCh === 2) {
        conv[0] = mk(0); // L
        conv[1] = mk(1); // R
        conv[2] = null;
        conv[3] = null;
      } else {
        conv[0] = mk(0); // LL
        conv[1] = mk(1); // LR
        conv[2] = mk(2); // RL
        conv[3] = mk(3); // RR
      }
    },

    clearIr() {
      if (conv[0] !== null && hasRendered) {
        // Fade the outgoing IR out instead of stepping to silence.
        oldConv[0] = conv[0]; oldConv[1] = conv[1];
        oldConv[2] = conv[2]; oldConv[3] = conv[3];
        oldIrChannels = irChannels;
        convFadeLen = Math.max(1, Math.round(0.05 * hostSampleRate));
        convFadePos = 0;
        ensureOldScratch();
      }
      conv[0] = conv[1] = conv[2] = conv[3] = null;
      irLengthSamples = 0;
      irChannels = 0;
    },

    isIrLoaded() {
      return conv[0] !== null;
    },

    getIrChannels() {
      return irChannels;
    },

    process(channels, frameCount) {
      const fading = convFadePos < convFadeLen;
      if (!params.enabled || (!conv[0] && !fading) || frameCount <= 0) return;
      // The host must respect the capacity announced at prepare(). Avoid a
      // realtime allocation if a malformed caller submits a larger block.
      if (frameCount > preparedMaxBlockSize || frameCount > scratchWetL.length) return;

      const mix = clamp(params.mix / 100, 0, 1);
      if (mix < 1e-6) {
        if (fading) {
          convFadePos += frameCount;
          if (convFadePos >= convFadeLen) {
            convFadeLen = 0;
            oldConv[0] = oldConv[1] = oldConv[2] = oldConv[3] = null;
          }
        }
        return;
      }
      const n = Math.min(channelCount, channels.length);

      // Active wet (zero when the IR was cleared mid-fade).
      if (conv[0]) {
        computeWetSet(conv, irChannels, channels, frameCount, n, scratchWetL, scratchWetR, scratchTmp, scratchTmp2);
      } else {
        scratchWetL.fill(0, 0, frameCount);
        scratchWetR.fill(0, 0, frameCount);
      }

      // IR-swap crossfade: blend the outgoing set's wet output down while
      // the new set's output comes up (equal-gain over ~50 ms).
      if (fading && oldConv[0] !== null) {
        ensureOldScratch();
        computeWetSet(oldConv, oldIrChannels, channels, frameCount, n, oldScratchL, oldScratchR, oldTmp1, oldTmp2);
        const gOutStart = convFadePos / convFadeLen;
        const gStep = 1 / convFadeLen;
        for (let c = 0; c < n; c++) {
          const wetNew = c === 0 ? scratchWetL : scratchWetR;
          const wetOld = c === 0 ? oldScratchL : oldScratchR;
          let g = gOutStart;
          for (let i = 0; i < frameCount; i++) {
            wetNew[i] = wetNew[i] * g + wetOld[i] * (1 - g);
            g += gStep;
            if (g > 1) g = 1;
          }
        }
      }

      // Advance the fade clock (block-quantized; sub-block resolution is
      // irrelevant at a 50 ms scale).
      if (fading) {
        convFadePos += frameCount;
        if (convFadePos >= convFadeLen) {
          convFadeLen = 0;
          convFadePos = 0;
          oldConv[0] = oldConv[1] = oldConv[2] = oldConv[3] = null;
        }
      }

      // 2. Mix: output = dry * (1-mix) + wet * mix.
      for (let c = 0; c < n; c++) {
        const dry = channels[c];
        const wet = c === 0 ? scratchWetL : scratchWetR;
        for (let i = 0; i < frameCount; i++) {
          dry[i] = dry[i] * (1 - mix) + wet[i] * mix;
        }
      }
      hasRendered = true;
    },

    setParams(p) {
      params = { ...p };
    },

    getLatencySamples() {
      return conv[0] ? conv[0].latency : 0;
    },

    getIrLengthSamples() {
      return irLengthSamples;
    },

    reset() {
      for (const cv of conv) cv?.reset();
      convFadePos = 0;
      convFadeLen = 0;
      hasRendered = false;
      oldConv[0] = oldConv[1] = oldConv[2] = oldConv[3] = null;
    },
  };
}
