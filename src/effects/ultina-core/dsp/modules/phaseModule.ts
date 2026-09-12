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
// Ultina — Phase Module
//
// Phase correction and alignment module providing:
//   - Phase rotation (all-pass filter for waveform symmetry correction)
//   - Time shift (differential delay between L/R channels)
//   - Phase learn (auto-detect asymmetry, suggest rotation)
//   - Sidechain alignment (detect time offset via cross-correlation)
//   - Auto align (automatically apply detected offset)
//
// Meters: asymmetry (0-1), correlation (-1..1), detectedOffsetMs
// ═══════════════════════════════════════════════════════════

import type {
  ModuleProcessArgs,
  ModuleProcessorContext,
  UltinaModuleProcessor,
} from "../ultinaProcessor.js";
import {
  clamp,
  sanitizeSample,
  smoothCoef,
} from "../primitives.js";
import { DryDelayMixer } from "../dryDelay.js";
import type { PhaseMeters } from "../../contracts/meters.js";

// ── Module ───────────────────────────────────────────────────

export class PhaseModuleProcessor implements UltinaModuleProcessor {
  private sampleRate = 44100;
  private maxBlockSize = 512;

  // DC blocker state (per channel)
  private dcPrevX = [0, 0];
  private dcPrevY = [0, 0];
  private dcCoef = 0.995;

  // All-pass filter state (per channel) — single-state TDF-II
  private allPassState = [0, 0];

  // Delay buffers (per channel) — sized in prepare() to cover the
  // requested shift at the active sample rate (50 ms max + 1 sample
  // headroom). The previous fixed-size buffer silently capped at ~93 ms
  // regardless of sampleRate, breaking >48 kHz operation.
  private delayBufL: Float32Array = new Float32Array(0);
  private delayBufR: Float32Array = new Float32Array(0);
  private delayBufferSize = 0;
  private delayWritePos = 0;

  // Dry buffers
  private dryL: Float32Array = new Float32Array(0);
  private dryR: Float32Array = new Float32Array(0);

  // Latency-compensated dry/wet mixing. The Time Shift is a deliberate
  // INTER-CHANNEL offset (one channel delayed, the other not) — it cannot be
  // scalar-compensated by the host and stays a creative feature. What the
  // module CAN do is delay its own dry copy per channel by the matching wet
  // latency, so mix < 100 % and delta stay free of delayed-copy combing on
  // BOTH channels independently.
  private dryDelay = new DryDelayMixer();
  private pooledMeters: PhaseMeters | null = null;
  // Host-compensable (scalar) latency: the delay common to both channels
  // (min of the two per-channel delays — with a one-sided shift that is 0)
  // plus the all-pass group delay (1 sample) while rotation is active.
  private commonDelaySamples = 0;
  private allPassActive = false;
  // Sidechain cross-correlation is time-decimated: a full ±maxLag sweep
  // every chunk costs O(maxLag·chunk) per block; every 8th chunk (~11 Hz at
  // a 128 quantum) tracks the 200 ms-smoothed offset more than well enough.
  private xcorrBlockCounter = 0;
  private static readonly XCORR_INTERVAL = 8;
  /** Reusable chunk channel views for the dry-delay mixer (no per-chunk
   * allocation on the audio thread). */
  private chunkChannels: Float32Array[] = [
    new Float32Array(0),
    new Float32Array(0),
  ];

  // ── Analysis state ──
  // Peak envelopes for asymmetry
  private posPeakEnv = 0;
  private negPeakEnv = 0;
  private peakAtkCoef = 0;
  private peakRelCoef = 0;

  // Running correlation accumulators
  private corrSum: number = 0;  // Σ(L*R)
  private corrLsq: number = 0;  // Σ(L²)
  private corrRsq: number = 0;  // Σ(R²)
  private corrCount: number = 0;

  // Cross-correlation buffer for sidechain offset detection
  private xcorrMaxOffsetSamples = 0;
  private detectedOffsetMs = 0;

  // Smoothed meter values
  private smoothAsymmetry = 0;
  private smoothCorrelation = 1;

  // Learn result (suggested rotation)
  private learnedRotation = 0;

  prepare(ctx: ModuleProcessorContext): void {
    this.sampleRate = ctx.sampleRate;
    this.maxBlockSize = ctx.maxBlockSize;

    this.dryL = new Float32Array(this.maxBlockSize);
    this.dryR = new Float32Array(this.maxBlockSize);

    // Size the delay buffer to cover the maximum requested shift
    // (50 ms) at the active sample rate, plus headroom.
    this.delayBufferSize = Math.max(
      Math.ceil((50 * this.sampleRate) / 1000) + 1,
      this.maxBlockSize,
    );
    this.delayBufL = new Float32Array(this.delayBufferSize);
    this.delayBufR = new Float32Array(this.delayBufferSize);
    this.delayWritePos = 0;
    this.dryDelay.prepare(
      this.maxBlockSize,
      Math.ceil((50 * this.sampleRate) / 1000),
    );

    // DC blocker coefficient (~20 Hz cutoff)
    this.dcCoef = 1 - 2 * Math.PI * 20 / this.sampleRate;
    if (this.dcCoef < 0.9) this.dcCoef = 0.9;

    // Peak envelope coefficients
    this.peakAtkCoef = smoothCoef(5, this.sampleRate);
    this.peakRelCoef = smoothCoef(200, this.sampleRate);

    // Max cross-correlation search range (+50 ms), clamped to the
    // delay buffer size.
    this.xcorrMaxOffsetSamples = Math.min(
      Math.floor(50 * this.sampleRate / 1000),
      this.delayBufferSize - 1,
    );

    this.reset();
  }

  process(args: ModuleProcessArgs): void {
    const { channels, frameCount, sidechain, params } = args;

    if (channels.length < 2) return;

    const enabled = (params["phase.enabled"] ?? 0) >= 0.5;
    if (!enabled) return;

    // Read parameters
    const learnActive = (params["phase.learnActive"] ?? 0) >= 0.5;
    const rotationDegrees = clamp(params["phase.rotationDegrees"] ?? 0, -180, 180);
    const timeShiftMs = clamp(params["phase.timeShiftMs"] ?? 0, -50, 50);
    const sidechainEnabled = (params["phase.sidechainEnabled"] ?? 0) >= 0.5;
    const autoAlignActive = (params["phase.autoAlignActive"] ?? 0) >= 0.5;
    const deltaListen = (params["phase.delta"] ?? 0) >= 0.5;
    const mixPercent = clamp(params["phase.mix"] ?? 100, 0, 100);

    // Determine effective rotation (learn overrides manual)
    const effectiveRotation = learnActive ? this.learnedRotation : rotationDegrees;

    // Determine effective time shift (auto-align overrides manual)
    let effectiveShiftMs = timeShiftMs;
    if (autoAlignActive && sidechainEnabled) {
      effectiveShiftMs = this.detectedOffsetMs;
    }

    // Compute all-pass coefficient from rotation. At rotation 0 the all-pass
    // degenerates to a pure z⁻¹ — skip the section entirely (and clear its
    // state) so a zeroed Rotation knob adds neither color nor latency.
    const c = clamp(effectiveRotation / 180, -0.99, 0.99);
    this.allPassActive = Math.abs(c) > 1e-6;
    if (!this.allPassActive) {
      this.allPassState[0] = 0;
      this.allPassState[1] = 0;
    }

    // Compute delay samples (clamp to the delay buffer capacity)
    const shiftSamples = Math.round(effectiveShiftMs * this.sampleRate / 1000);
    const delayL = Math.min(Math.max(0, shiftSamples), this.delayBufferSize - 1);
    const delayR = Math.min(Math.max(0, -shiftSamples), this.delayBufferSize - 1);
    // Scalar, host-compensable latency = the part common to both channels.
    this.commonDelaySamples = Math.min(delayL, delayR);

    // Process in chunks
    let offset = 0;
    while (offset < frameCount) {
      const remaining = frameCount - offset;
      const chunkSize = Math.min(remaining, this.maxBlockSize);

      // Chunk views: the common single-chunk case passes the channel
      // buffers directly (no subarray view allocation on the audio thread).
      const chunkL = offset === 0 ? channels[0] : channels[0].subarray(offset, offset + chunkSize);
      const chunkR = offset === 0 ? channels[1] : channels[1].subarray(offset, offset + chunkSize);

      // Store dry signal (bounded copy — the channel buffer may be longer
      // than this chunk; .set() with a longer source would throw)
      this.ensureBuffers(chunkSize);
      for (let i = 0; i < chunkSize; i++) {
        this.dryL[i] = channels[0][offset + i];
        this.dryR[i] = channels[1][offset + i];
      }

      // ── Process each sample ──
      for (let i = 0; i < chunkSize; i++) {
        let xL = chunkL[i];
        let xR = chunkR[i];

        // DC blocker
        const yL_dc = xL - this.dcPrevX[0] + this.dcCoef * this.dcPrevY[0];
        const yR_dc = xR - this.dcPrevX[1] + this.dcCoef * this.dcPrevY[1];
        this.dcPrevX[0] = xL;
        this.dcPrevX[1] = xR;
        this.dcPrevY[0] = yL_dc;
        this.dcPrevY[1] = yR_dc;
        xL = sanitizeSample(yL_dc);
        xR = sanitizeSample(yR_dc);

        // All-pass phase rotation (skipped entirely at rotation 0 — the
        // degenerate form is a pure z⁻¹ delay the user did not ask for)
        // H(z) = (c + z^-1) / (1 + c*z^-1)
        // y = c*x + s; s = x - c*y
        if (this.allPassActive) {
          const sL0 = this.allPassState[0];
          const sR0 = this.allPassState[1];
          const yL_ap = c * xL + sL0;
          const yR_ap = c * xR + sR0;
          this.allPassState[0] = xL - c * yL_ap;
          this.allPassState[1] = xR - c * yR_ap;
          xL = sanitizeSample(yL_ap);
          xR = sanitizeSample(yR_ap);
        }

        // Time shift via delay buffer
        this.delayBufL[this.delayWritePos] = xL;
        this.delayBufR[this.delayWritePos] = xR;

        const readPosL = (this.delayWritePos - delayL + this.delayBufferSize) % this.delayBufferSize;
        const readPosR = (this.delayWritePos - delayR + this.delayBufferSize) % this.delayBufferSize;

        const yL = this.delayBufL[readPosL];
        const yR = this.delayBufR[readPosR];

        this.delayWritePos = (this.delayWritePos + 1) % this.delayBufferSize;

        chunkL[i] = yL;
        chunkR[i] = yR;

        // ── Analysis: peak envelopes (for asymmetry) ──
        const mid = (this.dryL[i] + this.dryR[i]) * 0.5;
        const posPeak = mid > 0 ? mid : 0;
        const negPeak = mid < 0 ? -mid : 0;

        const posCoef = posPeak > this.posPeakEnv ? this.peakAtkCoef : this.peakRelCoef;
        const negCoef = negPeak > this.negPeakEnv ? this.peakAtkCoef : this.peakRelCoef;
        this.posPeakEnv += posCoef * (posPeak - this.posPeakEnv);
        this.negPeakEnv += negCoef * (negPeak - this.negPeakEnv);

        // ── Analysis: correlation ──
        this.corrSum += this.dryL[i] * this.dryR[i];
        this.corrLsq += this.dryL[i] * this.dryL[i];
        this.corrRsq += this.dryR[i] * this.dryR[i];
        this.corrCount++;
      }

      // ── Compute meter values ──
      // Asymmetry
      const peakSum = this.posPeakEnv + this.negPeakEnv;
      const asymmetry = peakSum > 1e-8
        ? Math.abs(this.posPeakEnv - this.negPeakEnv) / peakSum
        : 0;
      const asymCoef = smoothCoef(50, this.sampleRate) * chunkSize;
      this.smoothAsymmetry += Math.min(1, asymCoef) * (asymmetry - this.smoothAsymmetry);

      // Correlation
      let corr = 1;
      if (this.corrLsq > 1e-8 && this.corrRsq > 1e-8 && this.corrCount > 0) {
        corr = this.corrSum / (Math.sqrt(this.corrLsq) * Math.sqrt(this.corrRsq));
        corr = clamp(corr, -1, 1);
      }
      const corrCoef = Math.min(1, smoothCoef(100, this.sampleRate) * chunkSize);
      this.smoothCorrelation += corrCoef * (corr - this.smoothCorrelation);

      // Decay correlation accumulators (to track over time)
      const decay = 0.99;
      this.corrSum *= decay;
      this.corrLsq *= decay;
      this.corrRsq *= decay;

      // ── Learn mode: update suggested rotation ──
      if (learnActive) {
        // Suggest rotation based on asymmetry
        // If positive peaks dominate, rotate negative; vice versa
        const asym = this.posPeakEnv > this.negPeakEnv
          ? this.smoothAsymmetry
          : -this.smoothAsymmetry;
        // Map asymmetry (0-1) to rotation degrees (0-90)
        const targetRot = asym * 90;
        const learnCoef = Math.min(1, smoothCoef(500, this.sampleRate) * chunkSize);
        this.learnedRotation += learnCoef * (targetRot - this.learnedRotation);
      }

      // ── Sidechain alignment: cross-correlation (time-decimated) ──
      if (sidechainEnabled && sidechain && sidechain.length >= 1) {
        this.xcorrBlockCounter++;
        if (this.xcorrBlockCounter >= PhaseModuleProcessor.XCORR_INTERVAL) {
          this.xcorrBlockCounter = 0;
          const sc = sidechain[0];
          // Simple cross-correlation at a few lags
          let bestLag = 0;
          let bestCorr = -Infinity;

          const maxLag = Math.min(this.xcorrMaxOffsetSamples, chunkSize - 1);
          for (let lag = -maxLag; lag <= maxLag; lag++) {
            let sum = 0;
            let count = 0;
            for (let i = Math.max(0, lag); i < Math.min(chunkSize, chunkSize + lag); i++) {
              const scIdx = i - lag;
              if (scIdx >= 0 && scIdx < sc.length) {
                sum += this.dryL[i] * sc[scIdx];
                count++;
              }
            }
            if (count > 0) {
              const avg = sum / count;
              if (avg > bestCorr) {
                bestCorr = avg;
                bestLag = lag;
              }
            }
          }

          const detectedMs = bestLag / this.sampleRate * 1000;
          // Compensate for the decimated run rate: the smoothing coefficient
          // is scaled by the interval so the 200 ms response time constant
          // stays the same as a per-block sweep would have.
          const detectCoef = Math.min(1, smoothCoef(200, this.sampleRate) * chunkSize * PhaseModuleProcessor.XCORR_INTERVAL);
          this.detectedOffsetMs += detectCoef * (detectedMs - this.detectedOffsetMs);
        }
      }

      // ── Mix dry/wet — per-channel latency-compensated (see dryDelay.ts):
      // each dry channel is delayed by its own wet-path latency, so mix <
      // 100 % and delta listen carry no delayed-copy combing despite the
      // inter-channel Time Shift.
      const mix = mixPercent / 100;
      // Reusable 2-slot view of the current chunk (no per-chunk allocation).
      this.chunkChannels[0] = chunkL;
      this.chunkChannels[1] = chunkR;
      this.dryDelay.processPerChannel(
        this.chunkChannels,
        this.dryL,
        this.dryR,
        chunkSize,
        delayL,
        delayR,
        mix,
        deltaListen,
      );

      offset += chunkSize;
    }
  }

  reset(): void {
    this.dcPrevX = [0, 0];
    this.dcPrevY = [0, 0];
    this.allPassState = [0, 0];
    this.delayBufL.fill(0);
    this.delayBufR.fill(0);
    this.delayWritePos = 0;
    this.posPeakEnv = 0;
    this.negPeakEnv = 0;
    this.corrSum = 0;
    this.corrLsq = 0;
    this.corrRsq = 0;
    this.corrCount = 0;
    this.detectedOffsetMs = 0;
    this.smoothAsymmetry = 0;
    this.smoothCorrelation = 1;
    this.learnedRotation = 0;
    this.dryDelay.reset();
    this.xcorrBlockCounter = 0;
  }

  getMeters(): PhaseMeters {
    if (!this.pooledMeters) {
      this.pooledMeters = { asymmetry: 0, correlation: 1, detectedOffsetMs: 0 };
    }
    const m = this.pooledMeters;
    // POOLED snapshot (audio thread — getMeters runs at meter cadence inside
    // UltinaProcessor.getMeters). The next call overwrites every field;
    // postMessage clones, direct readers must copy immediately.
    m.asymmetry = clamp(this.smoothAsymmetry, 0, 1);
    m.correlation = clamp(this.smoothCorrelation, -1, 1);
    m.detectedOffsetMs = this.detectedOffsetMs;
    return m;
  }

  /**
   * Scalar, host-compensable latency: the delay common to BOTH channels
   * (the inter-channel Time Shift offset is a deliberate creative feature,
   * not a transport delay the host should advance) plus the all-pass group
   * delay while a rotation is active. Zero until the first processed block
   * materializes the current parameter values.
   */
  getLatency(): number {
    return this.commonDelaySamples + (this.allPassActive ? 1 : 0);
  }

  // ── Internal ──

  private ensureBuffers(size: number): void {
    if (this.dryL.length < size) {
      this.dryL = new Float32Array(size);
      this.dryR = new Float32Array(size);
    }
  }

  /**
   * Re-enable clears the time-shift delay lines: while the module sits
   * outside the active chain (or early-returns on the disabled param) the
   * ring freezes, and the first delayL/delayR samples after re-entry would
   * otherwise replay audio captured before the disable — up to 50 ms of
   * arbitrarily old material spliced into the live output.
   */
  onEnabledTransition(enabled: boolean): void {
    if (!enabled) return;
    this.delayBufL.fill(0);
    this.delayBufR.fill(0);
    this.delayWritePos = 0;
  }
}
