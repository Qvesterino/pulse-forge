/* eslint-disable */
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
// Ultina — Transient Shaper Module
//
// Transient/sustain envelope shaper with:
// - Global modes: Precise, Balanced, Loose
// - Contour shapes: Sharp, Medium, Smooth
// - Multiband (1-3 bands)
// - M/S channel mode
// - Attack/sustain amount (-100 to +100)
// ═══════════════════════════════════════════════════════════

import type {
  ModuleProcessArgs,
  ModuleProcessorContext,
  UltinaModuleProcessor,
} from "../ultinaProcessor.js";
import {
  clamp,
  dbToLinear,
  sanitizeSample,
} from "../primitives.js";
import {
  channelModeFromValue,
  type BandCount,
  type CrossoverMode,
} from "../../contracts/channelModes.js";
import { MultibandProcessor } from "../multiband.js";

// ── Constants ──────────────────────────────────────────────

const TRANSIENT_MAX_BANDS = 3;

// Global mode configurations:
// Each mode defines attack/release time multipliers
interface GlobalModeConfig {
  attackMult: number;
  releaseMult: number;
  envSpeed: number; // Envelope follower speed factor
}

const GLOBAL_MODES: Record<number, GlobalModeConfig> = {
  0: { attackMult: 0.5, releaseMult: 0.7, envSpeed: 1.5 }, // Precise: fast
  1: { attackMult: 1.0, releaseMult: 1.0, envSpeed: 1.0 }, // Balanced: medium
  2: { attackMult: 2.0, releaseMult: 1.5, envSpeed: 0.6 }, // Loose: slow
};

// Contour shape configurations:
// Each shape defines the gain curve characteristics
interface ContourConfig {
  sharpness: number; // 0=smooth, 1=sharp
  thresholdDb: number; // Detection threshold
}

const CONTOUR_SHAPES: Record<number, ContourConfig> = {
  0: { sharpness: 0.9, thresholdDb: -40 }, // Sharp
  1: { sharpness: 0.5, thresholdDb: -50 }, // Medium
  2: { sharpness: 0.2, thresholdDb: -60 }, // Smooth
};

// ── Per-band state ─────────────────────────────────────────

interface TransientBandState {
  // Envelope followers for transient detection
  fastEnv: number;
  slowEnv: number;
  // Transient/sustain gain
  transientGain: number;
  sustainGain: number;
  // Previous gain for smoothing
  prevTransientGain: number;
  prevSustainGain: number;
}

// ── Meter interface ────────────────────────────────────────

export interface TransientMeters {
  /** Transient detection level per band (0-1). */
  transientLevel: number[];
  /** Per-band output peak (dBFS). */
  outputPeakDb: number[];
}

// ── Module ─────────────────────────────────────────────────

export class TransientModuleProcessor implements UltinaModuleProcessor {
  private sampleRate = 44100;
  private maxBlockSize = 512;

  // Per-band state
  private bands: TransientBandState[] = [];

  // Multiband
  private multiband = new MultibandProcessor();

  // Dry buffer
  private dryL: Float32Array = new Float32Array(0);
  private dryR: Float32Array = new Float32Array(0);

  // Meter state
  private transientLevels: number[] = new Array(TRANSIENT_MAX_BANDS).fill(0);
  private outputPeaks: number[] = new Array(TRANSIENT_MAX_BANDS).fill(-100);

  // Cached multiband config
  private cachedBandCount = -1;
  private cachedXover1 = -1;
  private cachedXover2 = -1;

  prepare(ctx: ModuleProcessorContext): void {
    this.sampleRate = ctx.sampleRate;
    this.maxBlockSize = ctx.maxBlockSize;

    this.ensureBuffers(this.maxBlockSize);

    // Initialize band state
    this.bands = [];
    for (let i = 0; i < TRANSIENT_MAX_BANDS; i++) {
      this.bands.push({
        fastEnv: 0,
        slowEnv: 0,
        transientGain: 1,
        sustainGain: 1,
        prevTransientGain: 1,
        prevSustainGain: 1,
      });
    }

    this.multiband.prepare(this.sampleRate, 2, this.maxBlockSize, 1);
  }

  process(args: ModuleProcessArgs): void {
    const { channels, frameCount, params } = args;

    if (channels.length < 2) return;

    const enabled = (params["transient.enabled"] ?? 0) >= 0.5;
    if (!enabled) return;

    this.ensureBuffers(frameCount);

    // Read parameters
    const globalMode = Math.round(clamp(params["transient.globalMode"] ?? 1, 0, 2));
    const contourShape = Math.round(clamp(params["transient.contourShape"] ?? 1, 0, 2));
    const attackAmount = clamp(params["transient.attackAmount"] ?? 0, -100, 100) / 100;
    const sustainAmount = clamp(params["transient.sustainAmount"] ?? 0, -100, 100) / 100;
    const bandCount = Math.round(clamp(params["transient.bandCount"] ?? 1, 1, 3)) as BandCount;
    const xover1 = clamp(params["transient.crossoverHz1"] ?? 250, 20, 20000);
    const xover2 = clamp(params["transient.crossoverHz2"] ?? 2500, 20, 20000);
    const channelModeRaw = Math.round(clamp(params["transient.channelMode"] ?? 0, 0, 4));
    const channelMode = channelModeFromValue(channelModeRaw);
    const deltaListen = (params["transient.delta"] ?? 0) >= 0.5;
    const mixPercent = clamp(params["transient.mix"] ?? 100, 0, 100);

    const modeCfg = GLOBAL_MODES[globalMode] ?? GLOBAL_MODES[1];
    const contourCfg = CONTOUR_SHAPES[contourShape] ?? CONTOUR_SHAPES[1];

    // Update multiband config
    this.updateMultiband(bandCount, xover1, xover2);
    const xoverMode: CrossoverMode = (params["transient.crossoverMode"] ?? 0) >= 0.5 ? "hybrid" : "analog";
    this.multiband.setCrossoverMode(xoverMode);

    // Store dry signal
    this.dryL.set(channels[0].subarray(0, frameCount));
    this.dryR.set(channels[1].subarray(0, frameCount));

    // Process through multiband
    this.multiband.process(
      channels,
      frameCount,
      (bandIdx, bandChannels, bandFrames) => {
        this.processBand(
          bandIdx,
          bandChannels,
          bandFrames,
          modeCfg,
          contourCfg,
          attackAmount,
          sustainAmount,
        );
      },
      channelMode,
    );

    // Mix dry/wet
    const mix = mixPercent / 100;
    if (mix < 0.999) {
      for (let i = 0; i < frameCount; i++) {
        channels[0][i] = sanitizeSample(channels[0][i] * mix + this.dryL[i] * (1 - mix));
        channels[1][i] = sanitizeSample(channels[1][i] * mix + this.dryR[i] * (1 - mix));
      }
    }

    // Delta listen
    if (deltaListen) {
      for (let i = 0; i < frameCount; i++) {
        channels[0][i] = sanitizeSample(channels[0][i] - this.dryL[i]);
        channels[1][i] = sanitizeSample(channels[1][i] - this.dryR[i]);
      }
    }

    // (Per-band output peaks are measured inside processBand.)
  }

  reset(): void {
    for (const band of this.bands) {
      band.fastEnv = 0;
      band.slowEnv = 0;
      band.transientGain = 1;
      band.sustainGain = 1;
      band.prevTransientGain = 1;
      band.prevSustainGain = 1;
    }
    this.multiband.reset();
    this.transientLevels.fill(0);
    this.outputPeaks.fill(-100);
  }

  getMeters(): TransientMeters {
    return {
      transientLevel: [...this.transientLevels],
      outputPeakDb: [...this.outputPeaks],
    };
  }

  /** Hybrid crossover group delay (samples). */
  getLatency(): number {
    return this.multiband.getCrossoverLatency();
  }

  // ── Internal methods ──────────────────────────────────────

  private ensureBuffers(size: number): void {
    if (this.dryL.length < size) {
      this.dryL = new Float32Array(size);
      this.dryR = new Float32Array(size);
    }
  }

  private updateMultiband(bandCount: BandCount, xover1: number, xover2: number): void {
    if (bandCount !== this.cachedBandCount) {
      this.multiband.setBandCount(bandCount);
      this.cachedBandCount = bandCount;
      // setBandCount rebuilds the crossover (coefficients wiped) —
      // force both split frequencies to be re-applied below.
      this.cachedXover1 = -1;
      this.cachedXover2 = -1;
    }
    if (xover1 !== this.cachedXover1) {
      this.multiband.setCrossover(0, xover1);
      this.cachedXover1 = xover1;
    }
    if (xover2 !== this.cachedXover2 && bandCount >= 3) {
      this.multiband.setCrossover(1, xover2);
      this.cachedXover2 = xover2;
    }
  }

  private processBand(
    bandIdx: number,
    bandChannels: Float32Array[],
    bandFrames: number,
    modeCfg: GlobalModeConfig,
    contourCfg: ContourConfig,
    attackAmount: number,
    sustainAmount: number,
  ): void {
    const band = this.bands[bandIdx];
    const chL = bandChannels[0];
    const chR = bandChannels.length >= 2 ? bandChannels[1] : bandChannels[0];

    // Envelope follower coefficients (fast and slow)
    // Fast env: tracks transients quickly
    // Slow env: tracks sustain level
    const fastAttackMs = 0.5 * modeCfg.attackMult;
    const fastReleaseMs = 20 * modeCfg.releaseMult;
    const slowAttackMs = 10 * modeCfg.attackMult;
    const slowReleaseMs = 150 * modeCfg.releaseMult;

    const fastAttackCoef = Math.exp(-1 / (fastAttackMs * 0.001 * this.sampleRate));
    const fastReleaseCoef = Math.exp(-1 / (fastReleaseMs * 0.001 * this.sampleRate));
    const slowAttackCoef = Math.exp(-1 / (slowAttackMs * 0.001 * this.sampleRate));
    const slowReleaseCoef = Math.exp(-1 / (slowReleaseMs * 0.001 * this.sampleRate));

    // Smoothing coefficient for gain changes
    const gainSmoothCoef = Math.exp(-1 / (2 * 0.001 * this.sampleRate)); // 2ms smoothing

    // Compute target gains from amount parameters
    // attackAmount > 0: boost transient (increase gain when transient detected)
    // attackAmount < 0: reduce transient
    const transientGainBoost = attackAmount > 0
      ? dbToLinear(attackAmount * 12) // Up to +12dB boost
      : dbToLinear(attackAmount * 6); // Up to -6dB cut

    // sustainAmount > 0: boost sustain
    // sustainAmount < 0: reduce sustain
    const sustainGainBoost = sustainAmount > 0
      ? dbToLinear(sustainAmount * 8)
      : dbToLinear(sustainAmount * 12);

    let maxTransientLevel = 0;

    for (let i = 0; i < bandFrames; i++) {
      // Detect signal from left channel (or mono)
      const input = Math.abs(chL[i]);

      // Update fast and slow envelopes (peak follower)
      if (input > band.fastEnv) {
        band.fastEnv = fastAttackCoef * band.fastEnv + (1 - fastAttackCoef) * input;
      } else {
        band.fastEnv = fastReleaseCoef * band.fastEnv + (1 - fastReleaseCoef) * input;
      }

      if (input > band.slowEnv) {
        band.slowEnv = slowAttackCoef * band.slowEnv + (1 - slowAttackCoef) * input;
      } else {
        band.slowEnv = slowReleaseCoef * band.slowEnv + (1 - slowReleaseCoef) * input;
      }

      // Transient detection: ratio of fast to slow envelope
      let transientAmount = 0;
      if (band.slowEnv > 1e-8) {
        transientAmount = band.fastEnv / band.slowEnv;
        // Normalize: transientAmount ≈ 1 means steady state, > 1 means transient
        transientAmount = Math.max(0, Math.min(1, (transientAmount - 1) * contourCfg.sharpness * 2));
      }

      maxTransientLevel = Math.max(maxTransientLevel, transientAmount);

      // Compute transient and sustain gains
      // Transient gain: high when transientAmount is high
      const targetTransientGain = 1 + (transientGainBoost - 1) * transientAmount;

      // Sustain gain: high when transientAmount is low
      const sustainAmountNorm = 1 - transientAmount;
      const targetSustainGain = 1 + (sustainGainBoost - 1) * sustainAmountNorm;

      // Smooth gain transitions
      band.transientGain = gainSmoothCoef * band.transientGain + (1 - gainSmoothCoef) * targetTransientGain;
      band.sustainGain = gainSmoothCoef * band.sustainGain + (1 - gainSmoothCoef) * targetSustainGain;

      // Apply combined gain
      // The total gain is a blend of transient and sustain gain
      // weighted by transientAmount
      const combinedGain = band.transientGain * transientAmount + band.sustainGain * (1 - transientAmount);

      chL[i] = sanitizeSample(chL[i] * combinedGain);
      if (bandChannels.length >= 2) {
        chR[i] = sanitizeSample(chR[i] * combinedGain);
      }
    }

    // Update meters
    this.transientLevels[bandIdx] = maxTransientLevel;

    // Output peak
    let peak = 0;
    for (let i = 0; i < bandFrames; i++) {
      const a = Math.abs(chL[i]);
      if (a > peak) peak = a;
    }
    this.outputPeaks[bandIdx] = peak > 1e-10 ? 20 * Math.log10(peak) : -100;
  }

}
