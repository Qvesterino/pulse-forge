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

  return {
    prepare(sr, cc, maxBlockSize = 4096) {
      channelCount = Math.max(1, Math.min(2, cc));
      preparedMaxBlockSize = Math.max(64, maxBlockSize);
      ensureWetScratch(preparedMaxBlockSize);
      void sr;
    },

    loadIr(ir, _sr, irCh: IrChannelCount = 2) {
      if (ir.length === 0 || (irCh !== 1 && irCh !== 2 && irCh !== 4)) {
        conv[0] = conv[1] = conv[2] = conv[3] = null;
        irLengthSamples = 0;
        irChannels = 0;
        return;
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
      if (!params.enabled || !conv[0] || frameCount <= 0) return;
      // The host must respect the capacity announced at prepare(). Avoid a
      // realtime allocation if a malformed caller submits a larger block.
      if (frameCount > preparedMaxBlockSize || frameCount > scratchWetL.length) return;

      const mix = clamp(params.mix / 100, 0, 1);
      if (mix < 1e-6) return;
      const n = Math.min(channelCount, channels.length);

      if (irChannels === 4 && n === 2) {
        // TRUE-STEREO: outL = inL·LL + inR·RL, outR = inL·LR + inR·RR.
        const inL = channels[0];
        const inR = channels[1];
        // Non-null asserted: guarded by conv[0].isLoaded + irChannels===4
        // (all four convolvers are created together in loadIr).
        const c0 = conv[0] as PartitionedConvolver;
        const c1 = conv[1] as PartitionedConvolver;
        const c2 = conv[2] as PartitionedConvolver;
        const c3 = conv[3] as PartitionedConvolver;
        c0.process(inL, frameCount, scratchWetL);      // LL → outL
        c1.process(inL, frameCount, scratchTmp);       // LR → part outR
        c2.process(inR, frameCount, scratchWetR);      // RL → part outL
        c3.process(inR, frameCount, scratchTmp2);      // RR → outR
        for (let i = 0; i < frameCount; i++) {
          scratchWetL[i] += scratchWetR[i];                 // outL = LL + RL
          scratchWetR[i] = scratchTmp[i] + scratchTmp2[i];  // outR = LR + RR
        }
      } else {
        // Mono broadcast (mono IR) or dual-mono stereo (L→L, R→R).
        for (let c = 0; c < n; c++) {
          const cv = irChannels === 1 ? conv[0] : conv[c];
          const wet = c === 0 ? scratchWetL : scratchWetR;
          if (cv && wet) cv.process(channels[c], frameCount, wet);
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
    },
  };
}
