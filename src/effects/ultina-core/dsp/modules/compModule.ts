/* eslint-disable */
// @ts-nocheck
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
// Ultina — Compressor Module (TypeScript Reference)
//
// Multiband compressor with three character modes and three
// detection algorithms. Supports sidechain, auto-release,
// auto-makeup, knee, mix, and delta listen.
//
// Signal flow:
//   Input → [Sidechain HPF] → [Multiband Split]
//   → [Per-Band Gain Reduction] → [Multiband Sum]
//   → [Auto Makeup] → [Mix/Delta] → Output
//
// Modes:
//   Punch:  Fast attack, aggressive ratio, slight warmth
//   Modern: Balanced, transparent
//   Vintage: Slow, warm, tube-style saturation on makeup
//
// Detection:
//   Peak:        Instantaneous peak detection
//   RMS:         Short-window RMS level
//   TrueEnvelope: 4x oversampled peak interpolation for precision
// ═══════════════════════════════════════════════════════════

import type {
  UltinaModuleProcessor,
  ModuleProcessorContext,
  ModuleProcessArgs,
} from "../ultinaProcessor.js";
import {
  clamp,
  dbToLinear,
  linearToDb,
  sanitizeSample,
  fastTanh,
  smoothCoef,
  EnvelopeFollower,
  RmsDetector,
  OnePoleSmoother,
  createBiquad,
  setHighPass,
  resetBiquad,
  processBiquad,
  type BiquadState,
} from "../primitives.js";
import {
  MultibandProcessor,
} from "../multiband.js";
import {
  channelModeFromValue,
  type BandCount,
  type CrossoverMode,
} from "../../contracts/channelModes.js";

// ── Constants ───────────────────────────────────────────────

export const COMP_MAX_BANDS = 3;

/** Comp mode enum values. */
const COMP_MODES = ["punch", "modern", "vintage"] as const;
type CompMode = typeof COMP_MODES[number];

/** Detection mode enum values. */
const DETECTION_MODES = ["peak", "rms", "trueEnvelope"] as const;
type DetectionMode = typeof DETECTION_MODES[number];

// ── Band state ──────────────────────────────────────────────

interface CompBandState {
  /** Envelope follower for peak detection. */
  peakEnv: EnvelopeFollower;
  /** RMS detector for RMS mode. */
  rmsDetector: RmsDetector;
  /** Current smoothed gain reduction (dB, positive = reduction). */
  gainReductionDb: number;
  /** Target gain reduction (pre-smoothing). */
  targetGrDb: number;
  /** Attack coefficient (cached). */
  attackCoef: number;
  /** Release coefficient (cached). */
  releaseCoef: number;
  /** Hold counter (samples remaining in hold state). */
  holdCounter: number;
  /** Previous detection value for True Envelope interpolation. */
  prevDetected: number;
}

// ── Module meters ───────────────────────────────────────────

export interface CompMeters {
  /** Per-band gain reduction (dB, positive = reduction). */
  gainReduction: number[];
  /** Per-band output level (dB). */
  outputLevels: number[];
  /** Computed auto-makeup gain (dB). */
  autoMakeupDb: number;
}

// ── Compressor Module ───────────────────────────────────────

export class CompModuleProcessor implements UltinaModuleProcessor {
  private sampleRate = 44100;
  private maxBlockSize = 512;
  private bands: CompBandState[] = [];
  private multiband = new MultibandProcessor();

  // Sidechain HPF
  private scHpf: BiquadState = createBiquad(2);

  // Dry buffer for mix
  private dryL: Float32Array = new Float32Array(0);
  private dryR: Float32Array = new Float32Array(0);

  // Meter state
  private gainReduction: number[] = new Array(COMP_MAX_BANDS).fill(0);
  private outputLevels: number[] = new Array(COMP_MAX_BANDS).fill(-100);
  private autoMakeupDb = 0;
  private autoMakeupSmoother = new OnePoleSmoother();

  // Cached config
  private cachedBandCount = -1;
  private cachedXover1 = -1;
  private cachedXover2 = -1;

  prepare(ctx: ModuleProcessorContext): void {
    this.sampleRate = ctx.sampleRate;
    this.maxBlockSize = ctx.maxBlockSize;

    this.ensureBuffers(this.maxBlockSize);
    this.scHpf = createBiquad(2);

    this.bands = [];
    for (let i = 0; i < COMP_MAX_BANDS; i++) {
      this.bands.push({
        peakEnv: new EnvelopeFollower(),
        rmsDetector: new RmsDetector(),
        gainReductionDb: 0,
        targetGrDb: 0,
        attackCoef: 0,
        releaseCoef: 0,
        holdCounter: 0,
        prevDetected: 0,
      });
      this.bands[i].peakEnv.prepare(10, 100, this.sampleRate);
      this.bands[i].rmsDetector.prepare(10, this.sampleRate);
    }

    this.autoMakeupSmoother.setTimeConstant(50, this.sampleRate);
    this.multiband.prepare(this.sampleRate, 2, this.maxBlockSize, 1);
  }

  process(args: ModuleProcessArgs): void {
    const { channels, frameCount, sidechain, params } = args;

    if (channels.length < 2) return;

    const enabled = (params["comp.enabled"] ?? 0) >= 0.5;
    if (!enabled) return;

    this.ensureBuffers(frameCount);

    // Read parameters
    const mode = COMP_MODES[Math.round(clamp(params["comp.mode"] ?? 1, 0, 2))];
    const detectionMode = DETECTION_MODES[Math.round(clamp(params["comp.detectionMode"] ?? 1, 0, 2))];
    const thresholdDb = params["comp.thresholdDb"] ?? -20;
    const ratio = clamp(params["comp.ratio"] ?? 3, 1, 20);
    const attackMs = clamp(params["comp.attackMs"] ?? 10, 0.1, 200);
    const releaseMs = clamp(params["comp.releaseMs"] ?? 100, 5, 2000);
    const kneeDb = clamp(params["comp.kneeDb"] ?? 0, 0, 24);
    const makeupDb = params["comp.makeupDb"] ?? 0;
    const makeupAuto = (params["comp.makeupAuto"] ?? 0) >= 0.5;
    const autoRelease = (params["comp.autoRelease"] ?? 0) >= 0.5;
    const mixPercent = clamp(params["comp.mix"] ?? 100, 0, 100);
    const scEnabled = (params["comp.sidechainEnabled"] ?? 0) >= 0.5;
    const scHpfHz = clamp(params["comp.sidechainHpfHz"] ?? 20, 20, 2000);
    const bandCount = Math.round(clamp(params["comp.bandCount"] ?? 1, 1, 3)) as BandCount;
    const xover1 = params["comp.crossoverHz1"] ?? 250;
    const xover2 = params["comp.crossoverHz2"] ?? 2500;
    const channelModeRaw = Math.round(clamp(params["comp.channelMode"] ?? 0, 0, 4));
    const channelMode = channelModeFromValue(channelModeRaw);
    const deltaListen = (params["comp.delta"] ?? 0) >= 0.5;

    // Apply mode-specific adjustments
    const { effectiveAttack, effectiveRelease, effectiveRatio } = this.applyMode(mode, attackMs, releaseMs, ratio);

    // Update multiband config if changed
    this.updateMultiband(bandCount, xover1, xover2);
    const xoverMode: CrossoverMode = (params["comp.crossoverMode"] ?? 0) >= 0.5 ? "hybrid" : "analog";
    this.multiband.setCrossoverMode(xoverMode);

    // Store dry signal for mix
    this.dryL.set(channels[0].subarray(0, frameCount));
    this.dryR.set(channels[1].subarray(0, frameCount));

    // Prepare sidechain signal
    let detectSource: Float32Array[] = channels;
    if (scEnabled && sidechain && sidechain.length >= 2) {
      // Apply HPF to sidechain
      setHighPass(this.scHpf.coeffs, scHpfHz, 0.707, this.sampleRate);
      this.scHpfBufferL.set(sidechain[0].subarray(0, frameCount));
      this.scHpfBufferR.set(sidechain[1].subarray(0, frameCount));
      const scChannels = [this.scHpfBufferL, this.scHpfBufferR];
      processBiquad(this.scHpf, scChannels, frameCount);
      detectSource = scChannels;
    }

    // Prepare per-band params
    const bandThresholdDb = [
      params["comp.band0.thresholdDb"] ?? thresholdDb,
      params["comp.band1.thresholdDb"] ?? thresholdDb,
      params["comp.band2.thresholdDb"] ?? thresholdDb,
    ];

    // Process through multiband
    const scActive = scEnabled && sidechain && sidechain.length >= 2;
    this.multiband.process(
      channels,
      frameCount,
      (bandIdx, bandChannels, bandFrames) => {
        this.processBand(
          bandIdx,
          bandChannels,
          bandFrames,
          scActive ? detectSource : null,
          bandThresholdDb[bandIdx],
          effectiveAttack,
          effectiveRelease,
          effectiveRatio,
          kneeDb,
          detectionMode,
          autoRelease,
        );
      },
      channelMode,
    );

    // Auto makeup
    let finalMakeup = makeupDb;
    if (makeupAuto) {
      // Estimate makeup from average gain reduction
      let avgGr = 0;
      for (let b = 0; b < bandCount; b++) {
        avgGr += this.gainReduction[b];
      }
      avgGr /= bandCount;
      const targetMakeup = avgGr * 0.5; // Half the GR as makeup
      // Iterate smoother per-sample for proper convergence
      for (let i = 0; i < frameCount; i++) {
        this.autoMakeupDb = this.autoMakeupSmoother.process(targetMakeup);
      }
      finalMakeup += this.autoMakeupDb;
    }

    // Apply makeup gain
    if (finalMakeup !== 0) {
      const makeupLinear = dbToLinear(finalMakeup);
      for (let ch = 0; ch < 2; ch++) {
        const data = channels[ch];
        for (let i = 0; i < frameCount; i++) {
          data[i] = sanitizeSample(data[i] * makeupLinear);
        }
      }
    }

    // Vintage mode: add warmth on makeup
    if (mode === "vintage" && finalMakeup > 0.5) {
      const warmth = clamp(finalMakeup / 12, 0, 0.3);
      for (let ch = 0; ch < 2; ch++) {
        const data = channels[ch];
        for (let i = 0; i < frameCount; i++) {
          const x = data[i];
          const sat = fastTanh(x * 1.5) / 1.5;
          data[i] = sanitizeSample(x * (1 - warmth) + sat * warmth);
        }
      }
    }

    // Mix dry/wet
    const mix = mixPercent / 100;
    if (mix < 0.999) {
      for (let i = 0; i < frameCount; i++) {
        const wetL = channels[0][i];
        const wetR = channels[1][i];
        channels[0][i] = sanitizeSample(wetL * mix + this.dryL[i] * (1 - mix));
        channels[1][i] = sanitizeSample(wetR * mix + this.dryR[i] * (1 - mix));
      }
    }

    // Delta listen: output = wet - dry (matches global delta + all other modules)
    if (deltaListen) {
      for (let i = 0; i < frameCount; i++) {
        channels[0][i] = sanitizeSample(channels[0][i] - this.dryL[i]);
        channels[1][i] = sanitizeSample(channels[1][i] - this.dryR[i]);
      }
    }

    // (Per-band output levels are measured inside processBand.)
  }

  reset(): void {
    for (const band of this.bands) {
      band.peakEnv.reset();
      band.rmsDetector.reset();
      band.gainReductionDb = 0;
      band.targetGrDb = 0;
      band.holdCounter = 0;
      band.prevDetected = 0;
    }
    this.gainReduction.fill(0);
    this.outputLevels.fill(-100);
    this.autoMakeupDb = 0;
    this.autoMakeupSmoother.reset(0);
    this.multiband.reset();
    resetBiquad(this.scHpf);
  }

  getMeters(): CompMeters {
    return {
      gainReduction: [...this.gainReduction],
      outputLevels: [...this.outputLevels],
      autoMakeupDb: this.autoMakeupDb,
    };
  }

  /** Hybrid crossover group delay (samples). */
  getLatency(): number {
    return this.multiband.getCrossoverLatency();
  }

  // ── Internal ──────────────────────────────────────────────

  private scHpfBufferL: Float32Array = new Float32Array(0);
  private scHpfBufferR: Float32Array = new Float32Array(0);

  private ensureBuffers(requiredSize: number): void {
    if (this.dryL.length < requiredSize) {
      this.dryL = new Float32Array(requiredSize);
      this.dryR = new Float32Array(requiredSize);
      this.scHpfBufferL = new Float32Array(requiredSize);
      this.scHpfBufferR = new Float32Array(requiredSize);
    }
  }

  private applyMode(
    mode: CompMode,
    attackMs: number,
    releaseMs: number,
    ratio: number,
  ): { effectiveAttack: number; effectiveRelease: number; effectiveRatio: number } {
    switch (mode) {
      case "punch":
        return {
          effectiveAttack: attackMs * 0.5, // Faster attack
          effectiveRelease: releaseMs * 0.7,
          effectiveRatio: ratio * 1.15, // Slightly more aggressive
        };
      case "vintage":
        return {
          effectiveAttack: attackMs * 2.0, // Slower attack
          effectiveRelease: releaseMs * 1.5,
          effectiveRatio: ratio * 0.85, // Gentler
        };
      case "modern":
      default:
        return {
          effectiveAttack: attackMs,
          effectiveRelease: releaseMs,
          effectiveRatio: ratio,
        };
    }
  }

  private updateMultiband(bandCount: BandCount, xover1: number, xover2: number): void {
    if (this.cachedBandCount !== bandCount) {
      this.multiband.setBandCount(bandCount);
      this.cachedBandCount = bandCount;
      // setBandCount rebuilds the crossover (coefficients wiped) —
      // force both split frequencies to be re-applied below.
      this.cachedXover1 = -1;
      this.cachedXover2 = -1;
    }
    if (this.cachedXover1 !== xover1) {
      this.multiband.setCrossover(0, xover1);
      this.cachedXover1 = xover1;
    }
    if (this.cachedXover2 !== xover2 && bandCount >= 3) {
      this.multiband.setCrossover(1, xover2);
      this.cachedXover2 = xover2;
    }
  }

  private processBand(
    bandIdx: number,
    channels: Float32Array[],
    frameCount: number,
    sidechainSource: Float32Array[] | null,
    thresholdDb: number,
    attackMs: number,
    releaseMs: number,
    ratio: number,
    kneeDb: number,
    detectionMode: DetectionMode,
    autoRelease: boolean,
  ): void {
    const band = this.bands[bandIdx];

    // Update attack/release coefficients
    band.attackCoef = smoothCoef(attackMs, this.sampleRate);
    band.releaseCoef = smoothCoef(releaseMs, this.sampleRate);

    // Detect on sidechain if provided, otherwise on the band's own signal
    const detectCh = sidechainSource ? (sidechainSource[0] ?? channels[0]) : channels[0];

    for (let i = 0; i < frameCount; i++) {
      // ── Detection ──
      let detected: number;
      switch (detectionMode) {
        case "peak": {
          const sample = Math.abs(detectCh[i] ?? channels[0][i]);
          detected = band.peakEnv.process(sample);
          break;
        }
        case "rms": {
          const sample = Math.abs(detectCh[i] ?? channels[0][i]);
          detected = band.rmsDetector.process(sample);
          break;
        }
        case "trueEnvelope": {
          // Interpolated peak: look at neighboring samples for true peak estimation
          const s0 = Math.abs(band.prevDetected);
          const s1 = Math.abs(detectCh[i] ?? channels[0][i]);
          const s2 = Math.abs(detectCh[i + 1] ?? channels[0][i + 1] ?? 0);
          // Simple quadratic interpolation for peak position
          const denom = s0 - 2 * s1 + s2;
          let truePeak = s1;
          if (Math.abs(denom) > 1e-10) {
            const offset = 0.5 * (s0 - s2) / denom;
            if (Math.abs(offset) <= 0.5) {
              truePeak = s1 - 0.25 * (s0 - s2) * offset;
            }
          }
          band.prevDetected = s1;
          detected = band.peakEnv.process(truePeak);
          break;
        }
        default: {
          detected = band.peakEnv.process(Math.abs(detectCh[i] ?? channels[0][i]));
        }
      }

      // ── Gain computer ──
      const detectedDb = linearToDb(Math.max(1e-10, detected));
      let grDb = this.computeGainReduction(detectedDb, thresholdDb, ratio, kneeDb);

      // ── Auto-release ──
      let releaseCoef = band.releaseCoef;
      if (autoRelease) {
        // Faster release when GR is high (program-dependent)
        const grFraction = clamp(band.gainReductionDb / 12, 0, 1);
        const fastRelease = smoothCoef(releaseMs * 0.2, this.sampleRate);
        releaseCoef = band.releaseCoef * (1 - grFraction) + fastRelease * grFraction;
      }

      // ── Hold ──
      if (grDb > 0.1) {
        band.holdCounter = Math.round((attackMs / 1000) * this.sampleRate); // Hold for one attack time
      } else if (band.holdCounter > 0) {
        band.holdCounter--;
        grDb = band.targetGrDb; // Hold previous GR
      }
      band.targetGrDb = grDb;

      // ── Smooth gain reduction ──
      const coef = grDb > band.gainReductionDb ? band.attackCoef : releaseCoef;
      band.gainReductionDb += coef * (grDb - band.gainReductionDb);

      // ── Apply gain ──
      const gainLinear = dbToLinear(-band.gainReductionDb);
      for (let ch = 0; ch < channels.length; ch++) {
        channels[ch][i] = sanitizeSample(channels[ch][i] * gainLinear);
      }
    }

    // Store meter values (smoothed): per-band gain reduction AND
    // per-band output level measured from this band's own signal.
    this.gainReduction[bandIdx] = this.gainReduction[bandIdx] * 0.7 + band.gainReductionDb * 0.3;

    let bandPeak = 0;
    for (let i = 0; i < frameCount; i++) {
      const a = Math.abs(channels[0][i]);
      if (a > bandPeak) bandPeak = a;
    }
    const bandPeakDb = linearToDb(Math.max(1e-10, bandPeak));
    this.outputLevels[bandIdx] = this.outputLevels[bandIdx] * 0.8 + bandPeakDb * 0.2;
  }

  /**
   * Compute gain reduction from detected level.
   * Implements soft knee compression curve.
   * Returns positive dB for reduction.
   */
  private computeGainReduction(
    detectedDb: number,
    thresholdDb: number,
    ratio: number,
    kneeDb: number,
  ): number {
    // Below threshold: no compression
    if (kneeDb <= 0) {
      // Hard knee
      if (detectedDb <= thresholdDb) return 0;
      return (detectedDb - thresholdDb) * (1 - 1 / ratio);
    }

    // Soft knee: compression starts kneeDb/2 below threshold
    const kneeStart = thresholdDb - kneeDb / 2;
    const kneeEnd = thresholdDb + kneeDb / 2;

    if (detectedDb <= kneeStart) {
      return 0;
    }

    if (detectedDb >= kneeEnd) {
      // Above knee: full compression
      return (detectedDb - thresholdDb) * (1 - 1 / ratio);
    }

    // Within knee: quadratic interpolation
    const x = detectedDb - kneeStart;
    const w = kneeDb; // knee width
    // The gain reduction within the knee follows a quadratic curve
    // that smoothly transitions from 0 to the full compression line
    const fullGr = (detectedDb - thresholdDb) * (1 - 1 / ratio);
    const kneeFraction = (x / w);
    return fullGr * kneeFraction * kneeFraction;
  }

}
