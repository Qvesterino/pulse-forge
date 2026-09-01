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
// Ultina — Unmask Module
//
// 32-band spectral masking solver. Analyzes both the main signal
// and a sidechain reference, detects frequency regions where the
// sidechain masks the main signal, and applies dynamic gain
// reduction to carve out space for the main signal to cut through.
//
// Algorithm:
//   1. 32-band analysis via bandpass biquads + envelope followers
//      for both main and sidechain signals
//   2. Per-band masking level = sidechainLevel - mainLevel
//   3. Where masking exceeds threshold, apply proportional gain
//      reduction to the main signal in that band
//   4. Smooth gains and apply via bell filter chain
//   5. Dry/Wet blend and delta listen
//
// Parameters:
//   - enabled, amount (0-100), sidechainEnabled
//   - maskingThresholdDb (-40..0), responseSpeedHz (0.5..50)
//   - channelMode (stereo/mid/side/transient/sustain)
//   - learnActive, delta
// ═══════════════════════════════════════════════════════════

import type {
  ModuleProcessArgs,
  ModuleProcessorContext,
  UltinaModuleProcessor,
} from "../ultinaProcessor.js";
import {
  ampToDb,
  clamp,
  createBiquad,
  resetBiquad,
  sanitizeSample,
  setBandPass,
  setBell,
  smoothCoef,
  type BiquadState,
} from "../primitives.js";
import { channelModeFromValue } from "../../contracts/channelModes.js";
import { MidSideProcessor } from "../multiband.js";
import type { UnmaskMeters } from "../../contracts/meters.js";
import {
  SpectralRegistry,
  SPECTRAL_BANDS,
} from "../spectralRegistry.js";

// ── Constants ──────────────────────────────────────────────

const NUM_BANDS = 32;
const MAX_REDUCTION_DB = 12;
const BELL_Q = 2.5;
const ANALYSIS_Q = 3.0;

// Generate 32 log-spaced band center frequencies from 40 Hz to 16000 Hz
const LOG_MIN = Math.log(40);
const LOG_MAX = Math.log(16000);
const BAND_FREQS: number[] = [];
for (let i = 0; i < NUM_BANDS; i++) {
  const t = i / (NUM_BANDS - 1);
  BAND_FREQS.push(Math.round(Math.exp(LOG_MIN + t * (LOG_MAX - LOG_MIN))));
}

// ── Module ─────────────────────────────────────────────────

export class UnmaskModuleProcessor implements UltinaModuleProcessor {
  private sampleRate = 44100;
  private maxBlockSize = 256;
  private channelCount = 2;

  // Analysis filter banks (bandpass)
  private mainAnalysisFilters: BiquadState[] = [];
  private scAnalysisFilters: BiquadState[] = [];

  // Processing filter chain (bell EQs applied to main signal)
  private processFilters: BiquadState[] = [];

  // Envelope followers
  private mainEnv: Float32Array = new Float32Array(NUM_BANDS);
  private scEnv: Float32Array = new Float32Array(NUM_BANDS);

  // Smoothed gain values
  private gainDb: Float32Array = new Float32Array(NUM_BANDS);
  private gainSmoothed: Float32Array = new Float32Array(NUM_BANDS);

  // Smoothing coefficient
  private gainSmoothCoef = 0.001;

  // Metering state
  private maskingPerBandDb: Float32Array = new Float32Array(NUM_BANDS);
  private gainReductionPerBandDb: Float32Array = new Float32Array(NUM_BANDS);
  private maskingScore = 0;

  /** Learn mode: auto-calibrated masking threshold (persists after learn). */
  private learnedThresholdDb = -15;
  private learnSmoothCoef = 0.02;

  // Cross-instance ecosystem: aggregate masker from all other Ultina instances
  private ecosystemMaskerDb: Float32Array = new Float32Array(SPECTRAL_BANDS);
  private instanceId: string = "";

  // M/S processor
  private midSide = new MidSideProcessor();

  // Buffers
  private dryBuf: Float32Array[] = [];
  private analysisBuf: Float32Array = new Float32Array(0);
  private scAnalysisBuf: Float32Array = new Float32Array(0);

  // Cached meter arrays (to avoid reallocation)
  private meterMaskingDb: Float32Array = new Float32Array(NUM_BANDS);
  private meterGainRedDb: Float32Array = new Float32Array(NUM_BANDS);

  /** Set the instance ID for cross-instance spectral communication. */
  setInstanceId(id: string): void {
    this.instanceId = id;
  }

  prepare(ctx: ModuleProcessorContext): void {
    this.sampleRate = ctx.sampleRate;
    this.maxBlockSize = ctx.maxBlockSize;
    this.channelCount = ctx.channelCount;

    // Per-block smoothing coefficient (accounts for block size)
    this.gainSmoothCoef = 1 - Math.exp(-this.maxBlockSize / (0.05 * this.sampleRate));

    // Create analysis filter banks
    this.mainAnalysisFilters = [];
    this.scAnalysisFilters = [];
    for (let i = 0; i < NUM_BANDS; i++) {
      const freq = BAND_FREQS[i];
      const clampedFreq = Math.min(freq, this.sampleRate / 2 - 1);

      const mainBq = createBiquad(1);
      setBandPass(mainBq.coeffs, clampedFreq, ANALYSIS_Q, this.sampleRate);
      this.mainAnalysisFilters.push(mainBq);

      const scBq = createBiquad(1);
      setBandPass(scBq.coeffs, clampedFreq, ANALYSIS_Q, this.sampleRate);
      this.scAnalysisFilters.push(scBq);
    }

    // Create processing bell filter chain (2 channels for stereo processing)
    this.processFilters = [];
    for (let i = 0; i < NUM_BANDS; i++) {
      const freq = BAND_FREQS[i];
      const clampedFreq = Math.min(freq, this.sampleRate / 2 - 1);
      const bq = createBiquad(this.channelCount);
      setBell(bq.coeffs, clampedFreq, 0, BELL_Q, this.sampleRate);
      this.processFilters.push(bq);
    }

    // Prepare M/S
    this.midSide.prepare(this.maxBlockSize, this.channelCount);

    // Allocate buffers
    this.ensureBuffers(this.maxBlockSize);
  }

  process(args: ModuleProcessArgs): void {
    const { channels, frameCount, sidechain, params } = args;

    const enabled = params["unmask.enabled"] ?? 0;
    const amount = params["unmask.amount"] ?? 50;
    const scEnabled = params["unmask.sidechainEnabled"] ?? 0;
    const thresholdDb = params["unmask.maskingThresholdDb"] ?? -15;
    const responseHz = params["unmask.responseSpeedHz"] ?? 5;
    const channelModeRaw = params["unmask.channelMode"] ?? 0;
    const delta = params["unmask.delta"] ?? 0;
    const mixPercent = clamp(params["unmask.mix"] ?? 100, 0, 100);
    const ecosystemEnabled = (params["unmask.ecosystemEnabled"] ?? 0) >= 0.5;

    if (enabled < 0.5) return;

    this.ensureBuffers(frameCount);

    // Store dry signal for delta/dryWet
    const n = Math.min(channels[0].length, frameCount);
    for (let ch = 0; ch < channels.length; ch++) {
      if (!this.dryBuf[ch] || this.dryBuf[ch].length < n) {
        this.dryBuf[ch] = new Float32Array(n);
      }
      this.dryBuf[ch].set(channels[ch].subarray(0, n));
    }

    // Update response smoothing
    const envCoef = smoothCoef(1000 / Math.max(0.5, responseHz), this.sampleRate);

    // ── Analysis: run bandpass on ch0 for main and sidechain ──
    this.runAnalysis(channels, sidechain, scEnabled, frameCount, envCoef);

    // ── Cross-instance ecosystem: merge aggregate masker from all other instances ──
    if (ecosystemEnabled && this.instanceId) {
      const hasData = SpectralRegistry.getInstance().getAggregateMasker(
        this.instanceId,
        this.ecosystemMaskerDb,
      );
      if (hasData) {
        // Merge: for each band, take the MAX of the local scEnv (as amplitude)
        // and the ecosystem masker (converted from dB to amplitude).
        // This ensures the loudest masker — whether local sidechain or
        // another instance — determines the masking level.
        for (let b = 0; b < NUM_BANDS; b++) {
          const ecoAmp = Math.pow(10, this.ecosystemMaskerDb[b] / 20);
          if (ecoAmp > this.scEnv[b]) {
            this.scEnv[b] = ecoAmp;
          }
        }
      }
    }

    // ── Compute masking and gain reduction ──
    const learnActive = (params["unmask.learnActive"] ?? 0) >= 0.5;
    this.computeMaskingAndGain(amount, thresholdDb, envCoef, learnActive);

    // ── Apply bell filter chain with smoothed gains ──
    this.applyGainChain(channels, frameCount, channelModeRaw);

    // ── Mix dry/wet ──
    const mix = mixPercent / 100;
    if (mix < 0.999) {
      for (let ch = 0; ch < channels.length; ch++) {
        for (let i = 0; i < n; i++) {
          channels[ch][i] = sanitizeSample(channels[ch][i] * mix + this.dryBuf[ch][i] * (1 - mix));
        }
      }
    }

    // ── Delta listen ──
    if (delta >= 0.5) {
      for (let ch = 0; ch < channels.length; ch++) {
        for (let i = 0; i < n; i++) {
          channels[ch][i] = sanitizeSample(channels[ch][i] - this.dryBuf[ch][i]);
        }
      }
    } else {
      // Sanitize output (handles NaN/Infinity from edge cases)
      for (let ch = 0; ch < channels.length; ch++) {
        for (let i = 0; i < n; i++) {
          channels[ch][i] = sanitizeSample(channels[ch][i]);
        }
      }
    }
  }

  /**
   * Analysis cadence: the 32-band analysis filters run at the FULL
   * sample rate (a stride-N feed rescales each filter's response by N
   * and aliases — the old stride-4 version read frequency-warped
   * levels). To bound CPU, the analysis runs every 4th block; the
   * smoothed envelopes make the ~10–40 ms update granularity
   * inaudible at the module's response speeds.
   */
  private static readonly ANALYSIS_INTERVAL = 4;
  /** Starts at INTERVAL so the very first block is analyzed immediately. */
  private analysisBlockCounter = UnmaskModuleProcessor.ANALYSIS_INTERVAL;

  private runAnalysis(
    channels: Float32Array[],
    sidechain: Float32Array[] | null,
    scEnabled: number,
    frameCount: number,
    envCoef: number,
  ): void {
    const mainSrc = channels[0];
    const scSrc = scEnabled >= 0.5 && sidechain && sidechain.length > 0
      ? sidechain[0]
      : null;

    if (scSrc) {
      // Copy sidechain source to analysis buffer
      const n = Math.min(frameCount, this.scAnalysisBuf.length);
      for (let i = 0; i < n; i++) {
        this.scAnalysisBuf[i] = scSrc[i];
      }
    } else {
      // No sidechain: decay sc envelopes toward 0 every block (cheap)
      const decayFactor = 1 - envCoef;
      for (let b = 0; b < NUM_BANDS; b++) {
        this.scEnv[b] *= decayFactor;
      }
    }

    this.analysisBlockCounter++;
    if (this.analysisBlockCounter < UnmaskModuleProcessor.ANALYSIS_INTERVAL) {
      return;
    }
    this.analysisBlockCounter = 0;

    // Copy main source to analysis buffer
    const nMain = Math.min(frameCount, this.analysisBuf.length);
    for (let i = 0; i < nMain; i++) {
      this.analysisBuf[i] = mainSrc[i];
    }

    // Main analysis: bandpass at full rate, hoisted filter state
    for (let b = 0; b < NUM_BANDS; b++) {
      const bq = this.mainAnalysisFilters[b];
      const c = bq.coeffs;
      let z1 = bq.z1[0];
      let z2 = bq.z2[0];
      let env = this.mainEnv[b];

      for (let i = 0; i < nMain; i++) {
        const x = this.analysisBuf[i];
        const y = c.b0 * x + z1;
        z1 = c.b1 * x - c.a1 * y + z2;
        z2 = c.b2 * x - c.a2 * y;
        const abs = y < 0 ? -y : y;
        env += envCoef * (abs - env);
      }

      bq.z1[0] = z1;
      bq.z2[0] = z2;
      this.mainEnv[b] = env;
    }

    // Sidechain analysis
    if (scSrc) {
      for (let b = 0; b < NUM_BANDS; b++) {
        const bq = this.scAnalysisFilters[b];
        const c = bq.coeffs;
        let z1 = bq.z1[0];
        let z2 = bq.z2[0];
        let env = this.scEnv[b];

        for (let i = 0; i < nMain; i++) {
          const x = this.scAnalysisBuf[i];
          const y = c.b0 * x + z1;
          z1 = c.b1 * x - c.a1 * y + z2;
          z2 = c.b2 * x - c.a2 * y;
          const abs = y < 0 ? -y : y;
          env += envCoef * (abs - env);
        }

        bq.z1[0] = z1;
        bq.z2[0] = z2;
        this.scEnv[b] = env;
      }
    }
  }

  private computeMaskingAndGain(
    amount: number,
    thresholdDb: number,
    _envCoef: number,
    learnActive: boolean,
  ): void {
    const amountFactor = clamp(amount / 100, 0, 1);

    // Learn mode auto-calibrates the masking threshold from the
    // observed masking profile: threshold tracks the average masking
    // level over bands that actually mask, minus a 6 dB headroom, so
    // only genuinely problematic overlap triggers reduction.
    if (learnActive) {
      let sum = 0;
      let count = 0;
      for (let b = 0; b < NUM_BANDS; b++) {
        if (this.maskingPerBandDb[b] > -6) {
          sum += this.maskingPerBandDb[b];
          count++;
        }
      }
      if (count > 0) {
        const target = clamp(sum / count - 6, -40, 0);
        this.learnedThresholdDb += this.learnSmoothCoef * (target - this.learnedThresholdDb);
      }
    }

    const effectiveThreshold = learnActive ? this.learnedThresholdDb : thresholdDb;

    let totalMasking = 0;
    let activeBands = 0;

    for (let b = 0; b < NUM_BANDS; b++) {
      // Compute masking level (sidechain louder than main by how much)
      const mainDb = ampToDb(this.mainEnv[b]);
      const scDb = ampToDb(this.scEnv[b]);
      // Both silent (e.g. before the first analysis block) must not
      // read as 0 dB masking (−200 − (−200)) and trigger reduction.
      const maskingDb = (this.mainEnv[b] < 1e-9 && this.scEnv[b] < 1e-9)
        ? -200
        : scDb - mainDb;

      this.maskingPerBandDb[b] = maskingDb;

      // Compute gain reduction
      // Only reduce when masking exceeds threshold
      let targetGain = 0;
      if (maskingDb > effectiveThreshold) {
        const excess = maskingDb - effectiveThreshold;
        targetGain = -clamp(excess * amountFactor, 0, MAX_REDUCTION_DB);
      }

      this.gainDb[b] = targetGain;

      // Smooth the gain
      const gs = this.gainSmoothed[b];
      this.gainSmoothed[b] = gs + this.gainSmoothCoef * (targetGain - gs);

      this.gainReductionPerBandDb[b] = this.gainSmoothed[b];

      // Track masking score
      if (maskingDb > effectiveThreshold) {
        totalMasking += clamp(maskingDb - effectiveThreshold, 0, MAX_REDUCTION_DB);
        activeBands++;
      }
    }

    // Overall masking score (0-1)
    const maxPossibleMasking = NUM_BANDS * MAX_REDUCTION_DB;
    this.maskingScore = totalMasking / maxPossibleMasking;
  }

  private applyGainChain(
    channels: Float32Array[],
    frameCount: number,
    channelModeRaw: number,
  ): void {
    const channelMode = channelModeFromValue(channelModeRaw);

    // Build list of active bands (gain above threshold) once per block
    // and update their coefficients
    const activeBands: number[] = [];
    for (let b = 0; b < NUM_BANDS; b++) {
      const gain = this.gainSmoothed[b];
      if (gain < -0.01 || gain > 0.01) {
        const freq = Math.min(BAND_FREQS[b], this.sampleRate / 2 - 1);
        setBell(this.processFilters[b].coeffs, freq, gain, BELL_Q, this.sampleRate);
        activeBands.push(b);
      }
    }

    // Early exit: no active bands = passthrough
    if (activeBands.length === 0) return;

    // Apply processing
    if (channelMode === "stereo") {
      this.processChannelsDirect(channels, frameCount, activeBands);
    } else {
      // M/S processing: process ONLY the selected component — the
      // other passes through untouched (previously both were
      // processed, ignoring the mode's intent).
      const msResult = this.midSide.encode(channels[0], channels[1], frameCount, channelMode);
      if (msResult) {
        const target: Float32Array[] = [
          channelMode === "mid" ? msResult.mid : msResult.side,
        ];
        this.processChannelsDirect(target, frameCount, activeBands);
        const chunkL = channels[0];
        const chunkR = channels[1] ?? channels[0];
        this.midSide.decode(msResult.mid, msResult.side, frameCount, chunkL, chunkR);
      } else {
        // Fallback: process as stereo
        this.processChannelsDirect(channels, frameCount, activeBands);
      }
    }
  }

  /**
   * Apply active bell filters in series to channels.
   * Optimized: no per-sample sanitizeSample calls (NaN is handled
   * at the final output stage), coefficient references cached.
   */
  private processChannelsDirect(
    channels: Float32Array[],
    frameCount: number,
    activeBands: number[],
  ): void {
    const n = Math.min(channels[0].length, frameCount);
    const numCh = channels.length;

    for (const b of activeBands) {
      const bq = this.processFilters[b];
      const c = bq.coeffs;

      for (let ch = 0; ch < numCh; ch++) {
        const data = channels[ch];
        let z1 = bq.z1[ch];
        let z2 = bq.z2[ch];

        for (let i = 0; i < n; i++) {
          const x = data[i];
          const y = c.b0 * x + z1;
          z1 = c.b1 * x - c.a1 * y + z2;
          z2 = c.b2 * x - c.a2 * y;
          data[i] = y;
        }

        bq.z1[ch] = z1;
        bq.z2[ch] = z2;
      }
    }
  }

  reset(): void {
    for (let b = 0; b < NUM_BANDS; b++) {
      resetBiquad(this.mainAnalysisFilters[b]);
      resetBiquad(this.scAnalysisFilters[b]);
      resetBiquad(this.processFilters[b]);
      this.mainEnv[b] = 0;
      this.scEnv[b] = 0;
      this.gainDb[b] = 0;
      this.gainSmoothed[b] = 0;
      this.maskingPerBandDb[b] = 0;
      this.gainReductionPerBandDb[b] = 0;
    }
    this.maskingScore = 0;
    this.learnedThresholdDb = -15;
  }

  getMeters(): UnmaskMeters {
    // Copy to cached meter arrays
    this.meterMaskingDb.set(this.maskingPerBandDb);
    this.meterGainRedDb.set(this.gainReductionPerBandDb);
    return {
      maskingPerBandDb: this.meterMaskingDb,
      gainReductionPerBandDb: this.meterGainRedDb,
      maskingScore: this.maskingScore,
      learnedThresholdDb: this.learnedThresholdDb,
    };
  }

  private ensureBuffers(size: number): void {
    if (this.analysisBuf.length < size) {
      this.analysisBuf = new Float32Array(size);
      this.scAnalysisBuf = new Float32Array(size);
    }
    while (this.dryBuf.length < this.channelCount) {
      this.dryBuf.push(new Float32Array(size));
    }
    for (let ch = 0; ch < this.channelCount; ch++) {
      if (!this.dryBuf[ch] || this.dryBuf[ch].length < size) {
        this.dryBuf[ch] = new Float32Array(size);
      }
    }
  }
}
