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
// Ultina — Sculptor Module
//
// Adaptive spectral shaper with instrument target profiles.
// Analyzes the input spectrum across 8 bands, compares with a
// target curve for the selected instrument, and applies
// corrective bell-filter gains to shape the spectrum toward
// the target.
//
// Algorithm:
//   1. 8-band analysis via bandpass biquads + envelope followers
//   2. Compute relative per-band level (band - average)
//   3. Corrective gain = (targetCurve - relativeLevel) * amount
//   4. Smooth gains and apply via series bell biquad chain
//   5. Dry/Wet blend
//
// Target profiles: Guitar, Bass, Kick, Piano, Snare, Speech
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
  linearToDb,
  resetBiquad,
  sanitizeSample,
  setBandPass,
  setBell,
  smoothCoef,
  type BiquadState,
} from "../primitives.js";
import { channelModeFromValue } from "../../contracts/channelModes.js";
import { MidSideProcessor } from "../multiband.js";
import type { SculptorMeters } from "../../contracts/meters.js";

// ── Constants ──────────────────────────────────────────────

const NUM_BANDS = 8;
const MAX_CORRECTION_DB = 12;
const BELL_Q = 1.5;
const ANALYSIS_Q = 2.0;

// Band center frequencies (log-spaced ~80 Hz to ~11.2 kHz)
const BAND_FREQS = [80, 170, 350, 700, 1400, 2800, 5600, 11200];

// Target spectral curves per profile (dB per band, relative to average)
// Index: 0=Guitar, 1=Bass, 2=Kick, 3=Piano, 4=Snare, 5=Speech
const TARGET_CURVES: readonly number[][] = [
  // Guitar: warm mids, controlled highs
  [-1,  2,  3,  2,  1,  0, -1, -2],
  // Bass: strong lows, rolled-off highs
  [ 4,  3,  2,  0, -2, -3, -4, -5],
  // Kick: deep low end, slight click
  [ 5,  2, -1, -2,  0,  1,  0, -1],
  // Piano: nearly flat, slight presence
  [ 0,  0,  1,  1,  1,  1,  0, -1],
  // Snare: punchy mids and crack
  [-2,  3,  2,  0,  1,  3,  4,  2],
  // Speech: presence boost, roll-off extremes
  [-4, -2,  0,  1,  2,  2,  0, -3],
];

// ── Module ─────────────────────────────────────────────────

export class SculptorModuleProcessor implements UltinaModuleProcessor {
  private sampleRate = 44100;
  private maxBlockSize = 512;

  // Analysis: bandpass biquads (single channel — ch 0 only)
  private analysisBiquads: BiquadState[] = [];

  // Processing: bell biquads (2 channels for stereo, ch 0 for M/S)
  private bellBiquads: BiquadState[] = [];

  // Per-band envelope followers
  private envFollowers: number[] = new Array(NUM_BANDS).fill(0);

  // Per-band smoothed gain (dB)
  private smoothedGainDb: number[] = new Array(NUM_BANDS).fill(0);

  // Envelope follower coefficients
  private envAtkCoef = 0;
  private envRelCoef = 0;

  // Gain smoothing coefficients
  private gainAtkCoef = 0;
  private gainRelCoef = 0;

  // Mid/Side processor
  private midSide = new MidSideProcessor();

  // Dry buffers
  private dryL: Float32Array = new Float32Array(0);
  private dryR: Float32Array = new Float32Array(0);

  // Meter data (current curves for display)
  private currentTargetCurve: Float32Array = new Float32Array(NUM_BANDS);
  private currentSpectralCurve: Float32Array = new Float32Array(NUM_BANDS);

  prepare(ctx: ModuleProcessorContext): void {
    this.sampleRate = ctx.sampleRate;
    this.maxBlockSize = ctx.maxBlockSize;

    this.dryL = new Float32Array(this.maxBlockSize);
    this.dryR = new Float32Array(this.maxBlockSize);

    // Create analysis biquads (1 channel)
    this.analysisBiquads = [];
    for (let b = 0; b < NUM_BANDS; b++) {
      this.analysisBiquads.push(createBiquad(1));
    }

    // Create bell biquads (2 channels)
    this.bellBiquads = [];
    for (let b = 0; b < NUM_BANDS; b++) {
      this.bellBiquads.push(createBiquad(2));
    }

    // Configure analysis bandpass filters
    for (let b = 0; b < NUM_BANDS; b++) {
      setBandPass(this.analysisBiquads[b].coeffs, BAND_FREQS[b], ANALYSIS_Q, this.sampleRate);
    }

    // Initialize bell filters flat
    for (let b = 0; b < NUM_BANDS; b++) {
      setBell(this.bellBiquads[b].coeffs, BAND_FREQS[b], 0, BELL_Q, this.sampleRate);
    }

    // Envelope follower: fast attack (5 ms), moderate release (50 ms)
    this.envAtkCoef = smoothCoef(5, this.sampleRate);
    this.envRelCoef = smoothCoef(50, this.sampleRate);

    // Gain smoothing: moderate attack (20 ms), slower release (100 ms).
    // The smoother runs ONCE PER BLOCK, so the coefficient must cover a
    // whole block — with the per-sample coefficient the real time
    // constant was block-size times longer (~10 s at 256-frame blocks)
    // and the corrective gains took ~10 s to materialize.
    this.gainAtkCoef = 1 - Math.exp(-this.maxBlockSize / (0.020 * this.sampleRate));
    this.gainRelCoef = 1 - Math.exp(-this.maxBlockSize / (0.100 * this.sampleRate));

    this.midSide.prepare(this.maxBlockSize, 2);
  }

  process(args: ModuleProcessArgs): void {
    const { channels, frameCount, params } = args;

    if (channels.length < 2) return;

    const enabled = (params["sculptor.enabled"] ?? 0) >= 0.5;
    if (!enabled) return;

    // Read parameters
    const targetProfile = Math.round(clamp(params["sculptor.targetProfile"] ?? 5, 0, 5));
    const amount = clamp(params["sculptor.amount"] ?? 50, 0, 100) / 100;
    const lowFreq = clamp(params["sculptor.lowFreqBoundaryHz"] ?? 20, 20, 1000);
    const highFreq = clamp(params["sculptor.highFreqBoundaryHz"] ?? 16000, 1000, 20000);
    const dryWet = clamp(params["sculptor.dryWet"] ?? 100, 0, 100) / 100;
    const channelModeRaw = Math.round(clamp(params["sculptor.channelMode"] ?? 0, 0, 2));
    const channelMode = channelModeFromValue(channelModeRaw);
    const deltaListen = (params["sculptor.delta"] ?? 0) >= 0.5;

    const targetCurve = TARGET_CURVES[targetProfile];

    // Store target curve for meters
    for (let b = 0; b < NUM_BANDS; b++) {
      this.currentTargetCurve[b] = targetCurve[b];
    }

    // Process in chunks to handle frameCount > maxBlockSize
    let offset = 0;
    while (offset < frameCount) {
      const remaining = frameCount - offset;
      const chunkSize = Math.min(remaining, this.maxBlockSize);

      const chunkL = channels[0].subarray(offset, offset + chunkSize);
      const chunkR = channels[1].subarray(offset, offset + chunkSize);

      // Store dry signal
      this.ensureBuffers(chunkSize);
      this.dryL.set(chunkL);
      this.dryR.set(chunkR);

      // Determine analysis signal and channels to process
      let analysisSignal: Float32Array;
      let processChannels: Float32Array[];
      let msResult: { mid: Float32Array; side: Float32Array } | null = null;

      if (channelMode === "mid" || channelMode === "side") {
        msResult = this.midSide.encode(chunkL, chunkR, chunkSize, channelMode);
        if (msResult) {
          const target = channelMode === "mid" ? msResult.mid : msResult.side;
          analysisSignal = target;
          processChannels = [target];
        } else {
          analysisSignal = chunkL;
          processChannels = [chunkL, chunkR];
        }
      } else {
        analysisSignal = chunkL;
        processChannels = [chunkL, chunkR];
      }

      // ── Analysis: update per-band envelope followers ──
      for (let b = 0; b < NUM_BANDS; b++) {
        this.runBandpassAnalysis(b, analysisSignal, chunkSize);
      }

      // ── Compute average band level (for relative measurement) ──
      let sumDb = 0;
      let validBands = 0;
      for (let b = 0; b < NUM_BANDS; b++) {
        if (BAND_FREQS[b] >= lowFreq && BAND_FREQS[b] <= highFreq) {
          sumDb += ampToDb(this.envFollowers[b]);
          validBands++;
        }
      }
      const avgDb = validBands > 0 ? sumDb / validBands : -60;

      // ── Compute and smooth per-band corrective gains ──
      for (let b = 0; b < NUM_BANDS; b++) {
        let targetGainDb: number;

        if (BAND_FREQS[b] < lowFreq || BAND_FREQS[b] > highFreq) {
          // Outside boundaries: release toward 0
          targetGainDb = 0;
        } else {
          const measuredDb = ampToDb(this.envFollowers[b]);
          const relativeLevel = measuredDb - avgDb;
          targetGainDb = (targetCurve[b] - relativeLevel) * amount;
          targetGainDb = clamp(targetGainDb, -MAX_CORRECTION_DB, MAX_CORRECTION_DB);
        }

        // Smooth the gain
        const coef = targetGainDb > this.smoothedGainDb[b]
          ? this.gainAtkCoef
          : this.gainRelCoef;
        this.smoothedGainDb[b] += coef * (targetGainDb - this.smoothedGainDb[b]);
      }

      // ── Update bell filter coefficients ──
      for (let b = 0; b < NUM_BANDS; b++) {
        const g = this.smoothedGainDb[b];
        setBell(this.bellBiquads[b].coeffs, BAND_FREQS[b], g, BELL_Q, this.sampleRate);
        this.currentSpectralCurve[b] = g;
      }

      // ── Process through bell chain ──
      for (let b = 0; b < NUM_BANDS; b++) {
        if (Math.abs(this.smoothedGainDb[b]) < 0.001) continue;

        const { b0, b1, b2, a1, a2 } = this.bellBiquads[b].coeffs;
        for (let ch = 0; ch < processChannels.length; ch++) {
          let z1 = this.bellBiquads[b].z1[ch];
          let z2 = this.bellBiquads[b].z2[ch];
          const data = processChannels[ch];
          for (let i = 0; i < chunkSize; i++) {
            const x = data[i];
            const y = b0 * x + z1;
            z1 = b1 * x - a1 * y + z2;
            z2 = b2 * x - a2 * y;
            data[i] = sanitizeSample(y);
          }
          this.bellBiquads[b].z1[ch] = z1;
          this.bellBiquads[b].z2[ch] = z2;
        }
      }

      // ── Decode M/S back to L/R if needed ──
      if (msResult) {
        // msResult.mid was modified (for "mid" mode) or left unchanged (for "side" mode)
        // msResult.side was modified (for "side" mode) or left unchanged (for "mid" mode)
        // decode reads from these internal buffers and writes to chunkL/chunkR
        this.midSide.decode(msResult.mid, msResult.side, chunkSize, chunkL, chunkR);
      }

      // ── Dry/Wet blend ──
      if (deltaListen) {
        // Delta: output processed - dry
        for (let i = 0; i < chunkSize; i++) {
          chunkL[i] = sanitizeSample(chunkL[i] - this.dryL[i]);
          chunkR[i] = sanitizeSample(chunkR[i] - this.dryR[i]);
        }
      } else {
        const wet = dryWet;
        const dry = 1 - dryWet;
        for (let i = 0; i < chunkSize; i++) {
          chunkL[i] = sanitizeSample(chunkL[i] * wet + this.dryL[i] * dry);
          chunkR[i] = sanitizeSample(chunkR[i] * wet + this.dryR[i] * dry);
        }
      }

      offset += chunkSize;
    }
  }

  reset(): void {
    for (const bq of this.analysisBiquads) resetBiquad(bq);
    for (const bq of this.bellBiquads) resetBiquad(bq);
    this.envFollowers.fill(0);
    this.smoothedGainDb.fill(0);
    this.currentTargetCurve.fill(0);
    this.currentSpectralCurve.fill(0);
    // Re-init bell filters flat
    for (let b = 0; b < NUM_BANDS; b++) {
      setBell(this.bellBiquads[b].coeffs, BAND_FREQS[b], 0, BELL_Q, this.sampleRate);
    }
  }

  getMeters(): SculptorMeters {
    // Convert envelope followers to dB for band level display
    const bandLevelDb = new Float32Array(NUM_BANDS);
    let totalActiveGain = 0;
    for (let b = 0; b < NUM_BANDS; b++) {
      bandLevelDb[b] = linearToDb(Math.max(1e-10, this.envFollowers[b]));
      totalActiveGain += Math.abs(this.smoothedGainDb[b]);
    }
    // amountActive: 0-1 normalized by theoretical max (all bands at max correction)
    const amountActive = clamp(
      totalActiveGain / (NUM_BANDS * MAX_CORRECTION_DB),
      0,
      1,
    );
    return {
      spectralCurveDb: new Float32Array(this.currentSpectralCurve),
      targetCurveDb: new Float32Array(this.currentTargetCurve),
      bandLevelDb,
      amountActive,
    };
  }

  // ── Internal methods ──────────────────────────────────────

  private ensureBuffers(size: number): void {
    if (this.dryL.length < size) {
      this.dryL = new Float32Array(size);
      this.dryR = new Float32Array(size);
    }
  }

  /**
   * Run bandpass analysis on a signal and update the per-band envelope follower.
   * Does NOT modify the input buffer.
   */
  private runBandpassAnalysis(bandIdx: number, input: Float32Array, frameCount: number): void {
    const bq = this.analysisBiquads[bandIdx];
    const { b0, b1, b2, a1, a2 } = bq.coeffs;
    let z1 = bq.z1[0];
    let z2 = bq.z2[0];
    let env = this.envFollowers[bandIdx];
    const atkCoef = this.envAtkCoef;
    const relCoef = this.envRelCoef;

    for (let i = 0; i < frameCount; i++) {
      const x = input[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      const abs = Math.abs(y);
      const coef = abs > env ? atkCoef : relCoef;
      env += coef * (abs - env);
    }

    bq.z1[0] = z1;
    bq.z2[0] = z2;
    this.envFollowers[bandIdx] = env;
  }
}
