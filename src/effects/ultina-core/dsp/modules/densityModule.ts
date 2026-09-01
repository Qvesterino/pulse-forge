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
// Ultina — Density Module
//
// Upward compressor with multiband and M/S support.
// Lifts quiet signals toward the threshold, increasing density
// without reducing peaks.
//
// Upward compression curve:
//   - Above threshold: no processing (linear)
//   - Below threshold: positive gain proportional to distance
//     from threshold, capped by rangeDb
//   - Gain = min(rangeDb, (thresholdDb - detectedDb) * (1 - 1/ratio))
// ═══════════════════════════════════════════════════════════

import type {
  ModuleProcessArgs,
  ModuleProcessorContext,
  UltinaModuleProcessor,
} from "../ultinaProcessor.js";
import {
  ampToDb,
  clamp,
  dbToLinear,
  linearToDb,
  sanitizeSample,
  smoothCoef,
} from "../primitives.js";
import {
  channelModeFromValue,
  type BandCount,
  type CrossoverMode,
} from "../../contracts/channelModes.js";
import { MultibandProcessor } from "../multiband.js";
import type { BandMeters } from "../../contracts/meters.js";

// ── Constants ──────────────────────────────────────────────

const DENSITY_MAX_BANDS = 3;

// ── Meter interface ────────────────────────────────────────

export interface DensityMeters {
  bands: BandMeters[];
  /** Upward gain applied per band (dB). */
  upwardGainDb: number[];
}

// ── Per-band state ─────────────────────────────────────────

interface BandState {
  peakEnv: { process(target: number): number };
  rmsDetector: { process(input: number): number };
  gainLinear: number;       // Current smoothed gain
  targetGainDb: number;     // Target gain before smoothing
  attackCoef: number;
  releaseCoef: number;
}

interface BandMeterState {
  inputPeak: number;
  outputPeak: number;
  outputRmsSum: number;
  outputRmsCount: number;
  upwardGain: number;
}

function createBandState(): BandState {
  // Placeholder — will be properly initialized in prepare
  return {
    peakEnv: { process: (t: number) => t },
    rmsDetector: { process: (i: number) => i },
    gainLinear: 1,
    targetGainDb: 0,
    attackCoef: 0.001,
    releaseCoef: 0.001,
  };
}

function createBandMeterState(): BandMeterState {
  return {
    inputPeak: 0,
    outputPeak: 0,
    outputRmsSum: 0,
    outputRmsCount: 0,
    upwardGain: 0,
  };
}

function resetBandMeterState(s: BandMeterState): void {
  s.inputPeak = 0;
  s.outputPeak = 0;
  s.outputRmsSum = 0;
  s.outputRmsCount = 0;
  s.upwardGain = 0;
}

// ── Module ─────────────────────────────────────────────────

export class DensityModuleProcessor implements UltinaModuleProcessor {
  private sampleRate = 44100;
  private maxBlockSize = 512;

  // Multiband
  private multiband = new MultibandProcessor();

  // Per-band envelope followers and state
  private bands: BandState[] = [];

  // Per-band meter state
  private bandMeters: BandMeterState[] = [];

  // Dry buffer for delta listen
  private dryL: Float32Array = new Float32Array(0);
  private dryR: Float32Array = new Float32Array(0);

  // Cached config
  private cachedBandCount = -1;
  private cachedXover1 = -1;
  private cachedXover2 = -1;

  prepare(ctx: ModuleProcessorContext): void {
    this.sampleRate = ctx.sampleRate;
    this.maxBlockSize = ctx.maxBlockSize;

    this.dryL = new Float32Array(this.maxBlockSize);
    this.dryR = new Float32Array(this.maxBlockSize);

    // Allocate band state
    this.bands = [];
    for (let b = 0; b < DENSITY_MAX_BANDS; b++) {
      this.bands.push(createBandState());
    }

    // Allocate band meters
    this.bandMeters = [];
    for (let b = 0; b < DENSITY_MAX_BANDS; b++) {
      this.bandMeters.push(createBandMeterState());
    }

    this.multiband.prepare(this.sampleRate, 2, this.maxBlockSize, 1);

    // Initialize proper envelope followers now that we have sampleRate
    this.initEnvelopeFollowers();
  }

  private initEnvelopeFollowers(): void {
    for (const band of this.bands) {
      band.peakEnv = this.createPeakEnv();
      band.rmsDetector = this.createRmsDetector();
    }
  }

  private createPeakEnv(): { process(target: number): number } {
    // Simple one-pole peak follower
    let state = 0;
    let attackCoef = smoothCoef(10, this.sampleRate);
    let releaseCoef = smoothCoef(150, this.sampleRate);
    return {
      process(target: number): number {
        const absTarget = Math.abs(target);
        const coef = absTarget > state ? attackCoef : releaseCoef;
        state += coef * (absTarget - state);
        return state;
      },
    };
  }

  private createRmsDetector(): { process(input: number): number } {
    // RMS detector with ~50ms window approximation via one-pole
    let sumSq = 0;
    const coef = smoothCoef(50, this.sampleRate);
    return {
      process(input: number): number {
        const sq = input * input;
        sumSq += coef * (sq - sumSq);
        return Math.sqrt(Math.max(0, sumSq));
      },
    };
  }

  process(args: ModuleProcessArgs): void {
    const { channels, frameCount, params } = args;

    if (channels.length < 2) return;

    const enabled = (params["density.enabled"] ?? 0) >= 0.5;
    if (!enabled) return;

    // Read parameters
    const thresholdDb = clamp(params["density.thresholdDb"] ?? -30, -60, 0);
    const rangeDb = clamp(params["density.rangeDb"] ?? 6, 0, 24);
    const ratio = clamp(params["density.ratio"] ?? 2, 1, 10);
    const attackMs = clamp(params["density.attackMs"] ?? 10, 0.5, 200);
    const releaseMs = clamp(params["density.releaseMs"] ?? 150, 10, 2000);
    const bandCount = Math.round(clamp(params["density.bandCount"] ?? 1, 1, 3)) as BandCount;
    const xover1 = clamp(params["density.crossoverHz1"] ?? 250, 20, 20000);
    const xover2 = clamp(params["density.crossoverHz2"] ?? 2500, 20, 20000);
    const channelModeRaw = Math.round(clamp(params["density.channelMode"] ?? 0, 0, 2));
    const channelMode = channelModeFromValue(channelModeRaw);
    const deltaListen = (params["density.delta"] ?? 0) >= 0.5;
    const mixPercent = clamp(params["density.mix"] ?? 100, 0, 100);

    // Update multiband config if changed
    this.updateMultiband(bandCount, xover1, xover2);
    const xoverMode: CrossoverMode = (params["density.crossoverMode"] ?? 0) >= 0.5 ? "hybrid" : "analog";
    this.multiband.setCrossoverMode(xoverMode);

    // Reset per-call meter readings
    for (let b = 0; b < bandCount; b++) {
      resetBandMeterState(this.bandMeters[b]);
    }

    // Process in chunks to handle frameCount > maxBlockSize
    let offset = 0;
    while (offset < frameCount) {
      const remaining = frameCount - offset;
      const chunkSize = Math.min(remaining, this.maxBlockSize);

      // Create chunk views
      const chunkChannels: Float32Array[] = [
        channels[0].subarray(offset, offset + chunkSize),
        channels[1].subarray(offset, offset + chunkSize),
      ];

      // Store dry signal
      this.ensureBuffers(chunkSize);
      this.dryL.set(chunkChannels[0]);
      this.dryR.set(chunkChannels[1]);

      // Process through multiband
      this.multiband.process(
        chunkChannels,
        chunkSize,
        (bandIdx, bandChannels, bandFrames) => {
          this.processBand(
            bandIdx, bandChannels, bandFrames,
            thresholdDb, rangeDb, ratio, attackMs, releaseMs,
          );
        },
        channelMode,
      );

      // Mix dry/wet
      const mix = mixPercent / 100;
      if (mix < 0.999) {
        for (let i = 0; i < chunkSize; i++) {
          chunkChannels[0][i] = sanitizeSample(chunkChannels[0][i] * mix + this.dryL[i] * (1 - mix));
          chunkChannels[1][i] = sanitizeSample(chunkChannels[1][i] * mix + this.dryR[i] * (1 - mix));
        }
      }

      // Delta listen
      if (deltaListen) {
        for (let i = 0; i < chunkSize; i++) {
          chunkChannels[0][i] = sanitizeSample(chunkChannels[0][i] - this.dryL[i]);
          chunkChannels[1][i] = sanitizeSample(chunkChannels[1][i] - this.dryR[i]);
        }
      }

      offset += chunkSize;
    }
  }

  reset(): void {
    for (const band of this.bands) {
      band.gainLinear = 1;
      band.targetGainDb = 0;
    }
    this.initEnvelopeFollowers();
    this.multiband.reset();
    for (const bm of this.bandMeters) {
      resetBandMeterState(bm);
    }
  }

  getMeters(): DensityMeters {
    const bands: BandMeters[] = this.bandMeters.map((bm) => ({
      inputPeakDb: ampToDb(bm.inputPeak),
      outputPeakDb: ampToDb(bm.outputPeak),
      outputRmsDb: bm.outputRmsCount > 0
        ? ampToDb(Math.sqrt(bm.outputRmsSum / bm.outputRmsCount))
        : -100,
      gainReductionDb: -bm.upwardGain, // negative of upward gain for consistent display
    }));

    return {
      bands,
      upwardGainDb: this.bandMeters.map((bm) => bm.upwardGain),
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
    channels: Float32Array[],
    frameCount: number,
    thresholdDb: number,
    rangeDb: number,
    ratio: number,
    attackMs: number,
    releaseMs: number,
  ): void {
    const band = this.bands[bandIdx];
    const bm = this.bandMeters[bandIdx];

    // Update attack/release coefficients
    band.attackCoef = smoothCoef(attackMs, this.sampleRate);
    band.releaseCoef = smoothCoef(releaseMs, this.sampleRate);

    // Detection source: use channel 0 (left / mid)
    const detectCh = channels[0] ?? channels[0];

    let maxUpwardGain = 0;

    for (let i = 0; i < frameCount; i++) {
      // ── Detection (RMS) ──
      const detected = band.rmsDetector.process(detectCh[i]);
      const detectedDb = linearToDb(Math.max(1e-10, detected));

      // ── Upward gain computation ──
      // Only apply gain when signal is below threshold
      let targetGainDb = 0;
      if (detectedDb < thresholdDb) {
        const distance = thresholdDb - detectedDb;
        targetGainDb = distance * (1 - 1 / ratio);
        // Cap at rangeDb
        targetGainDb = Math.min(rangeDb, targetGainDb);
      }

      // ── Smooth gain ──
      // Attack: gain increasing (toward more upward gain)
      // Release: gain decreasing (back toward 0)
      const coef = targetGainDb > band.targetGainDb
        ? band.attackCoef
        : band.releaseCoef;
      band.targetGainDb += coef * (targetGainDb - band.targetGainDb);

      // Track max upward gain for meters
      if (band.targetGainDb > maxUpwardGain) maxUpwardGain = band.targetGainDb;

      // ── Apply gain ──
      const gainLinear = dbToLinear(band.targetGainDb);
      for (let ch = 0; ch < channels.length; ch++) {
        channels[ch][i] = sanitizeSample(channels[ch][i] * gainLinear);
      }

      // ── Meter tracking ──
      const inAbs = Math.abs(detectCh[i]);
      if (inAbs > bm.inputPeak) bm.inputPeak = inAbs;

      const outAbs = Math.abs(channels[0][i]);
      if (outAbs > bm.outputPeak) bm.outputPeak = outAbs;
      bm.outputRmsSum += channels[0][i] * channels[0][i];
      bm.outputRmsCount++;
    }

    // Store smoothed upward gain meter
    bm.upwardGain = bm.upwardGain * 0.7 + maxUpwardGain * 0.3;
  }
}
