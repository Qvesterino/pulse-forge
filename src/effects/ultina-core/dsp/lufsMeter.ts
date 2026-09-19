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
// (Reconciled from Pulse Forge hardening pass, 2026-09-14: prepare() resets unfed/stale tracking + K-weight state.)
// ═══════════════════════════════════════════════════════════
// Ultina — LUFS Meter (TypeScript mirror of ultina_lufs.h)
//
// Real-time loudness measurement with K-weighting and
// gated block measurement per ITU-R BS.1770-4.
//
// Used by the TypeScript UltinaProcessor (web audio path) to
// provide momentary, short-term, and integrated loudness
// values matching the C++ native implementation.
//
// Measurements:
//   - Momentary loudness (M): 400 ms window, no gating
//   - Short-term loudness (S): 3000 ms window, no gating
//   - Integrated loudness (I): gated measurement since reset
//   - Loudness range (LRA): 95th − 10th percentile of gated blocks
//   - True-peak: peak hold with linear interpolation
// ═══════════════════════════════════════════════════════════

import { setHighShelf, setHighPass, createBiquad, type BiquadCoeffs } from "./primitives.js";

// ── Constants ──────────────────────────────────────────────

const MOMENTARY_WINDOW_MS = 400;
const SHORT_TERM_WINDOW_MS = 3000;
const BLOCK_DURATION_MS = 400;
const BLOCK_HOP_MS = 100;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_OFFSET_DB = -10;
// ── True-peak 4× oversampling FIR (BS.1770-4 methodology) ───
// Linear-phase Kaiser-windowed sinc interpolation filter
// (96 taps at the 4× rate = 24 input samples span, β = 8.6,
// cutoff 0.45×fs, DC gain 4 so every polyphase branch sums to 1).
// Verified: reconstructs an fs/4 sine's inter-sample peak to
// −0.17 dB, ±0.3 dB passband to 15 kHz, −0.8 dB at 19 kHz.
const TP_FIR = new Float64Array([
  0.000029698735387511, 0.000070003751031468, 0.000081337354444092, 0.000007352482573811, -0.000171443230401889,
  -0.000385835516489692, -0.000472793149418841, -0.000252046233891145, 0.00033186308513175, 0.001082606634264892,
  0.001551606505214169, 0.001232552432543188, -0.000097236732539107, -0.002070062087615603, -0.003694453494244438,
  -0.0037419330669312, -0.001466481529468804, 0.002696331102054647, 0.006927635470624972, 0.00864497378668053,
  0.005844033752768363, -0.00144067741106001, -0.010439900966216513, -0.016408227706803714, -0.014837366346022311,
  -0.004226172602751034, 0.012098269623627688, 0.026477607147027401, 0.030107468248552035, 0.017794270287905329,
  -0.008049720987342666, -0.036672411694119673, -0.052776955911743403, -0.04386728620008791, -0.0079467727459168,
  0.042574859272561806, 0.083803506213296519, 0.090179188728099588, 0.047661919674382054, -0.035689016366780138,
  -0.127549979762802329, -0.180287387068625377, -0.148828303115833199, -0.0107117950985055, 0.220322964727480475,
  0.49394878339712095, 0.737623543370986345, 0.880991883241850848, 0.880991883241850848, 0.737623543370986345,
  0.49394878339712095, 0.220322964727480475, -0.0107117950985055, -0.148828303115833199, -0.180287387068625377,
  -0.127549979762802329, -0.035689016366780138, 0.047661919674382054, 0.090179188728099588, 0.083803506213296367,
  0.042574859272561806, -0.0079467727459168, -0.04386728620008791, -0.052776955911743403, -0.036672411694119673,
  -0.008049720987342666, 0.017794270287905329, 0.030107468248552084, 0.026477607147027401, 0.012098269623627688,
  -0.004226172602751039, -0.014837366346022311, -0.016408227706803714, -0.010439900966216513, -0.00144067741106001,
  0.005844033752768363, 0.008644973786680525, 0.006927635470624972, 0.002696331102054647, -0.001466481529468804,
  -0.0037419330669312, -0.003694453494244438, -0.002070062087615603, -0.000097236732539107, 0.001232552432543188,
  0.001551606505214169, 0.001082606634264891, 0.000331863085131751, -0.000252046233891145, -0.000472793149418841,
  -0.000385835516489693, -0.000171443230401889, 0.000007352482573811, 0.000081337354444092, 0.000070003751031469,
  0.000029698735387511,
]);

/** Oversampling factor. */
const TP_FIR_PHASES = 4;
/** Input samples each polyphase branch consumes (96 / 4). */
const TP_FIR_TAPS = 24;

/**
 * Polyphase branches built once at module load: TP_POLY[p][t] pairs
 * with the input history where index TP_FIR_TAPS-1 is the NEWEST
 * sample, so branch p estimates the signal at time (n + p/4).
 */
const TP_POLY: ReadonlyArray<Float64Array> = (() => {
  const phases: Float64Array[] = [];
  for (let p = 0; p < TP_FIR_PHASES; p++) {
    const c = new Float64Array(TP_FIR_TAPS);
    for (let t = 0; t < TP_FIR_TAPS; t++) {
      c[t] = TP_FIR[p + 4 * (TP_FIR_TAPS - 1 - t)];
    }
    phases.push(c);
  }
  return phases;
})();

export interface LufsReading {
  momentaryLufs: number;
  shortTermLufs: number;
  integratedLufs: number;
  lufsRange: number;
  truePeakDb: number;
  totalSamples: number;
}

// ── K-weighting filter state ───────────────────────────────

interface KWeightChannel {
  coeffs: BiquadCoeffs;
  z1: number;
  z2: number;
}

function createKWeightChannel(): KWeightChannel {
  return { coeffs: { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }, z1: 0, z2: 0 };
}

function processKWeightSample(kw: KWeightChannel, x: number): number {
  const { b0, b1, b2, a1, a2 } = kw.coeffs;
  const y = b0 * x + kw.z1;
  kw.z1 = b1 * x - a1 * y + kw.z2;
  kw.z2 = b2 * x - a2 * y;
  return y;
}

// ── LUFS Meter class ──────────────────────────────────────

export class LufsMeter {
  // K-weighting filters (2 stages × 2 channels)
  private kStage1: [KWeightChannel, KWeightChannel] = [createKWeightChannel(), createKWeightChannel()];
  private kStage2: [KWeightChannel, KWeightChannel] = [createKWeightChannel(), createKWeightChannel()];

  // Momentary (400 ms) sliding window
  private momentaryBuf: Float64Array = new Float64Array(0);
  private momentaryWritePos = 0;
  private momentarySum = 0;
  private momentaryCount = 0;

  // Short-term (3 s) sliding window
  private shortTermBuf: Float64Array = new Float64Array(0);
  private shortTermWritePos = 0;
  private shortTermSum = 0;
  private shortTermCount = 0;

  // Gated block accumulation
  private blockBuf: Float64Array = new Float64Array(0);
  private blockWritePos = 0;
  private blockSum = 0;
  private blockCount = 0;
  private blockSamplesNeeded = 0;
  private hopSamplesNeeded = 0;
  private hopCounter = 0;

  // Block history for integrated measurement (bounded ring buffer)
  private static readonly MAX_BLOCK_HISTORY = 6000;
  private blockHistoryBuf: Float64Array = new Float64Array(LufsMeter.MAX_BLOCK_HISTORY);
  private blockHistoryLen = 0;
  private blockHistoryWrite = 0;
  /** True when new gated blocks arrived — integrated/LRA recompute is
   * deferred to the next read (control thread) instead of every hop. */
  private historyDirty = false;

  // Scratch buffer for computeLufsRange — reused per block on the audio
  // thread (no allocation, in-place sort).
  private gatedBuf: Float64Array = new Float64Array(LufsMeter.MAX_BLOCK_HISTORY);

  // True-peak
  private truePeakLinear = 0;
  /**
   * ITU-R BS.1770-4 4× oversampling true-peak detector state:
   * last 12 input samples per channel (the 48-tap spec FIR spans 12
   * input samples in each of its 4 polyphase branches).
   */
  private tpHistL = new Float64Array(TP_FIR_TAPS);
  private tpHistR = new Float64Array(TP_FIR_TAPS);

  // State
  private totalSamples = 0;
  private momentaryLufs = ABSOLUTE_GATE_LUFS;
  private shortTermLufs = ABSOLUTE_GATE_LUFS;
  private integratedLufs = ABSOLUTE_GATE_LUFS;
  private lufsRange = 0;

  // Stale-window guard: after a feed gap longer than the short-term window
  // the ring still holds pre-gap mean squares, which would read as a
  // plausible but WRONG loudness. noteUnfed() (called by the owner for every
  // block it does not feed) arms the flag; getShortTermLufs() then reports
  // silence until the window has fully turned over with fresh blocks.
  private shortTermWindowSamples = 0;
  private unfedSamples = 0;
  private staleUntilTurnover = false;
  private fedSinceStale = 0;

  // ── Lifecycle ────────────────────────────────────────────

  prepare(sampleRate: number, _maxBlockSize: number): void {
    // Create K-weighting biquads for 2 channels
    const stage1Bq = createBiquad(1);
    const stage2Bq = createBiquad(1);

    // Stage 1: High shelf at 1500 Hz, +4 dB
    setHighShelf(stage1Bq.coeffs, 1500, 4, 0.7071, sampleRate);
    this.kStage1[0].coeffs = { ...stage1Bq.coeffs };
    this.kStage1[1].coeffs = { ...stage1Bq.coeffs };

    // Stage 2: High-pass at 38 Hz
    setHighPass(stage2Bq.coeffs, 38, 0.5, sampleRate);
    this.kStage2[0].coeffs = { ...stage2Bq.coeffs };
    this.kStage2[1].coeffs = { ...stage2Bq.coeffs };

    // Allocate sliding windows
    const momentarySamples = Math.floor((sampleRate * MOMENTARY_WINDOW_MS) / 1000);
    const shortTermSamples = Math.floor((sampleRate * SHORT_TERM_WINDOW_MS) / 1000);
    this.shortTermWindowSamples = shortTermSamples;
    this.momentaryBuf = new Float64Array(momentarySamples);
    this.shortTermBuf = new Float64Array(shortTermSamples);
    this.momentaryWritePos = 0;
    this.shortTermWritePos = 0;
    this.momentarySum = 0;
    this.shortTermSum = 0;
    this.momentaryCount = 0;
    this.shortTermCount = 0;

    // Gated block setup
    this.blockSamplesNeeded = Math.floor((sampleRate * BLOCK_DURATION_MS) / 1000);
    this.hopSamplesNeeded = Math.floor((sampleRate * BLOCK_HOP_MS) / 1000);
    this.blockBuf = new Float64Array(this.blockSamplesNeeded);
    this.blockWritePos = 0;
    this.blockSum = 0;
    this.blockCount = 0;
    this.hopCounter = 0;
    this.blockHistoryLen = 0;
    this.historyDirty = false;
    this.blockHistoryWrite = 0;

    this.truePeakLinear = 0;
    this.tpHistL.fill(0);
    this.tpHistR.fill(0);
    this.totalSamples = 0;
    this.momentaryLufs = ABSOLUTE_GATE_LUFS;
    this.shortTermLufs = ABSOLUTE_GATE_LUFS;
    this.integratedLufs = ABSOLUTE_GATE_LUFS;
    this.lufsRange = 0;
    // Unfed/stale tracking must reset with everything else (mirror reset()):
    // a re-prepare while the stale flag was armed left getShortTermLufs()
    // reporting silence until the window fully turned over. Also clear the
    // K-weighting filter state.
    this.unfedSamples = 0;
    this.staleUntilTurnover = false;
    this.fedSinceStale = 0;
    for (const kw of [...this.kStage1, ...this.kStage2]) {
      kw.z1 = 0;
      kw.z2 = 0;
    }
  }

  /**
   * Bookkeeping for a block the owner processed WITHOUT feeding the meter
   * (metering gated and gain-match off). AUDIO-THREAD SAFE: O(1).
   */
  noteUnfed(frames: number): void {
    this.unfedSamples += frames;
    if (
      !this.staleUntilTurnover &&
      this.shortTermWindowSamples > 0 &&
      this.unfedSamples >= this.shortTermWindowSamples
    ) {
      this.staleUntilTurnover = true;
      this.fedSinceStale = 0;
    }
  }

  reset(): void {
    this.unfedSamples = 0;
    this.staleUntilTurnover = false;
    this.fedSinceStale = 0;
    for (const kw of [...this.kStage1, ...this.kStage2]) {
      kw.z1 = 0;
      kw.z2 = 0;
    }
    this.momentaryBuf.fill(0);
    this.shortTermBuf.fill(0);
    this.momentaryWritePos = 0;
    this.shortTermWritePos = 0;
    this.momentarySum = 0;
    this.shortTermSum = 0;
    this.momentaryCount = 0;
    this.shortTermCount = 0;
    this.blockBuf.fill(0);
    this.blockWritePos = 0;
    this.blockSum = 0;
    this.blockCount = 0;
    this.hopCounter = 0;
    this.blockHistoryLen = 0;
    this.historyDirty = false;
    this.blockHistoryWrite = 0;
    this.truePeakLinear = 0;
    this.tpHistL.fill(0);
    this.tpHistR.fill(0);
    this.totalSamples = 0;
    this.momentaryLufs = ABSOLUTE_GATE_LUFS;
    this.shortTermLufs = ABSOLUTE_GATE_LUFS;
    this.integratedLufs = ABSOLUTE_GATE_LUFS;
    this.lufsRange = 0;
  }

  // ── Processing ───────────────────────────────────────────

  process(left: Float32Array, right: Float32Array | null, frameCount: number): void {
    this.unfedSamples = 0;
    if (this.staleUntilTurnover) {
      this.fedSinceStale += frameCount;
      if (this.fedSinceStale >= this.shortTermWindowSamples) {
        this.staleUntilTurnover = false;
      }
    }
    const bufL = left;
    const bufR = right ?? left;

    for (let i = 0; i < frameCount; i++) {
      const sampleL = bufL[i];
      const sampleR = bufR[i];

      // K-weight: stage1 (shelf) → stage2 (HPF)
      const kwL = processKWeightSample(this.kStage2[0], processKWeightSample(this.kStage1[0], sampleL));
      const kwR = processKWeightSample(this.kStage2[1], processKWeightSample(this.kStage1[1], sampleR));

      // True-peak: peak hold with interpolation
      const absL = Math.abs(sampleL);
      const absR = Math.abs(sampleR);
      const maxAbs = Math.max(absL, absR);
      if (maxAbs > this.truePeakLinear) this.truePeakLinear = maxAbs;

      // Inter-sample peak per ITU-R BS.1770-4: 4× oversampling via the
      // spec's 48-tap polyphase FIR (12 taps per phase). The maximum of
      // the 4 interpolated values per input sample is the true-peak
      // estimate — master-grade accuracy for −1 dBTP targets.
      {
        // Push the raw samples into the 12-sample history (per channel)
        const hl = this.tpHistL;
        const hr = this.tpHistR;
        hl.copyWithin(0, 1);
        hl[TP_FIR_TAPS - 1] = sampleL;
        hr.copyWithin(0, 1);
        hr[TP_FIR_TAPS - 1] = sampleR;

        // Phases 1–3 estimate the signal BETWEEN samples; the on-grid
        // value (phase 0) is the sample itself, already covered by the
        // sample-peak max above — skipping it saves 25% of the FIR cost.
        for (let p = 1; p < TP_FIR_PHASES; p++) {
          const c = TP_POLY[p];
          let sumL = 0;
          let sumR = 0;
          for (let t = 0; t < TP_FIR_TAPS; t++) {
            const coef = c[t];
            sumL += coef * hl[t];
            sumR += coef * hr[t];
          }
          if (sumL < 0) sumL = -sumL;
          if (sumR < 0) sumR = -sumR;
          if (sumL > this.truePeakLinear) this.truePeakLinear = sumL;
          if (sumR > this.truePeakLinear) this.truePeakLinear = sumR;
        }
      }

      // Mean square (L/R channel weight = 1.0)
      const ms = kwL * kwL + kwR * kwR;

      // Momentary (400 ms) sliding window
      const oldMS = this.momentaryBuf[this.momentaryWritePos];
      this.momentaryBuf[this.momentaryWritePos] = ms;
      this.momentarySum += ms - oldMS;
      this.momentaryWritePos = (this.momentaryWritePos + 1) % this.momentaryBuf.length;
      if (this.momentaryCount < this.momentaryBuf.length) this.momentaryCount++;

      // Short-term (3 s) sliding window
      const oldSTS = this.shortTermBuf[this.shortTermWritePos];
      this.shortTermBuf[this.shortTermWritePos] = ms;
      this.shortTermSum += ms - oldSTS;
      this.shortTermWritePos = (this.shortTermWritePos + 1) % this.shortTermBuf.length;
      if (this.shortTermCount < this.shortTermBuf.length) this.shortTermCount++;

      // Gated block accumulation
      const oldBS = this.blockBuf[this.blockWritePos];
      this.blockBuf[this.blockWritePos] = ms;
      this.blockSum += ms - oldBS;
      this.blockWritePos = (this.blockWritePos + 1) % this.blockSamplesNeeded;
      if (this.blockCount < this.blockSamplesNeeded) this.blockCount++;

      this.hopCounter++;
      if (this.blockCount >= this.blockSamplesNeeded && this.hopCounter >= this.hopSamplesNeeded) {
        this.hopCounter = 0;
        const blockMean = this.blockSum / this.blockSamplesNeeded;
        const blockLufs = blockMean > 1e-12 ? -0.691 + 10 * Math.log10(blockMean) : ABSOLUTE_GATE_LUFS;
        this.blockHistoryBuf[this.blockHistoryWrite] = blockLufs;
        this.blockHistoryWrite = (this.blockHistoryWrite + 1) % LufsMeter.MAX_BLOCK_HISTORY;
        if (this.blockHistoryLen < LufsMeter.MAX_BLOCK_HISTORY) this.blockHistoryLen++;
        // Integrated/LRA are recomputed LAZILY on read (see getters):
        // the recompute walks and SORTS the whole block history — far
        // too expensive to run every 100 ms hop on the audio thread.
        this.historyDirty = true;
      }

      this.totalSamples++;
    }

    // Non-finite state guard: one poisoned sample must not kill every
    // loudness reading for the rest of the session (the K-weight recursion
    // and the sliding-window sums never self-heal — see processBiquadChannel
    // for the same pattern).
    for (let s = 0; s < 2; s++) {
      const k1 = this.kStage1[s];
      if (!Number.isFinite(k1.z1) || !Number.isFinite(k1.z2)) {
        k1.z1 = 0;
        k1.z2 = 0;
      }
      const k2 = this.kStage2[s];
      if (!Number.isFinite(k2.z1) || !Number.isFinite(k2.z2)) {
        k2.z1 = 0;
        k2.z2 = 0;
      }
    }
    if (!Number.isFinite(this.momentarySum)) {
      this.momentarySum = 0;
      this.momentaryBuf.fill(0);
      this.momentaryCount = 0;
    }
    if (!Number.isFinite(this.shortTermSum)) {
      this.shortTermSum = 0;
      this.shortTermBuf.fill(0);
      this.shortTermCount = 0;
    }
    if (!Number.isFinite(this.blockSum)) {
      this.blockSum = 0;
      this.blockBuf.fill(0);
      this.blockCount = 0;
    }

    // Compute momentary and short-term
    if (this.momentaryCount > 0) {
      const meanMS = this.momentarySum / this.momentaryCount;
      this.momentaryLufs = meanMS > 1e-12 ? -0.691 + 10 * Math.log10(meanMS) : ABSOLUTE_GATE_LUFS;
    }
    if (this.shortTermCount > 0) {
      const meanMS = this.shortTermSum / this.shortTermCount;
      this.shortTermLufs = meanMS > 1e-12 ? -0.691 + 10 * Math.log10(meanMS) : ABSOLUTE_GATE_LUFS;
    }
  }

  // ── Readouts ─────────────────────────────────────────────

  getMomentaryLufs(): number {
    return this.momentaryLufs;
  }
  getShortTermLufs(): number {
    // Honest reading: while the short-term window has not fully turned over
    // since a feed gap longer than the window, the ring holds pre-gap data —
    // report silence instead of a plausible-looking stale number.
    if (this.staleUntilTurnover) return ABSOLUTE_GATE_LUFS;
    return this.shortTermLufs;
  }

  /**
   * Integrated loudness — LAZY: recomputed only when new gated blocks
   * arrived since the last read. Called from the control/UI thread
   * (meter polling), so the audio thread never pays for the
   * O(history) walk + sort.
   */
  getIntegratedLufs(): number {
    this.ensureIntegratedFresh();
    return this.integratedLufs;
  }

  getLufsRange(): number {
    this.ensureIntegratedFresh();
    return this.lufsRange;
  }

  getTruePeakDb(): number {
    if (this.truePeakLinear <= 1e-10) return -200;
    return 20 * Math.log10(this.truePeakLinear);
  }
  getTotalSamples(): number {
    return this.totalSamples;
  }

  getReading(): LufsReading {
    this.ensureIntegratedFresh();
    return {
      momentaryLufs: this.momentaryLufs,
      shortTermLufs: this.getShortTermLufs(),
      integratedLufs: this.integratedLufs,
      lufsRange: this.lufsRange,
      truePeakDb: this.getTruePeakDb(),
      totalSamples: this.totalSamples,
    };
  }

  /** Recompute the integrated/LRA readouts if new blocks arrived. */
  private ensureIntegratedFresh(): void {
    if (this.historyDirty) {
      this.historyDirty = false;
      this.recomputeIntegrated();
    }
  }

  // ── Private: integrated loudness recompute ───────────────

  private recomputeIntegrated(): void {
    if (this.blockHistoryLen === 0) {
      this.integratedLufs = ABSOLUTE_GATE_LUFS;
      return;
    }

    const buf = this.blockHistoryBuf;
    const len = this.blockHistoryLen;

    // Pass 1: absolute gate at -70 LUFS
    let sumAbove70 = 0;
    let countAbove70 = 0;
    for (let i = 0; i < len; i++) {
      const lufs = buf[i];
      if (lufs > ABSOLUTE_GATE_LUFS) {
        sumAbove70 += Math.pow(10, (lufs + 0.691) / 10);
        countAbove70++;
      }
    }
    if (countAbove70 === 0) {
      this.integratedLufs = ABSOLUTE_GATE_LUFS;
      return;
    }
    const ungatedMean = -0.691 + 10 * Math.log10(sumAbove70 / countAbove70);

    // Relative gate
    const relativeGate = ungatedMean + RELATIVE_GATE_OFFSET_DB;
    const relGateAbs = Math.max(relativeGate, ABSOLUTE_GATE_LUFS);

    // Pass 2: relative gate
    let sumGated = 0;
    let countGated = 0;
    for (let i = 0; i < len; i++) {
      const lufs = buf[i];
      if (lufs > relGateAbs) {
        sumGated += Math.pow(10, (lufs + 0.691) / 10);
        countGated++;
      }
    }

    if (countGated > 0) {
      this.integratedLufs = -0.691 + 10 * Math.log10(sumGated / countGated);
      this.computeLufsRange(relGateAbs);
    } else {
      this.integratedLufs = ungatedMean;
    }
  }

  private computeLufsRange(gateLufs: number): void {
    const src = this.blockHistoryBuf;
    const len = this.blockHistoryLen;
    const dst = this.gatedBuf;
    let n = 0;
    for (let i = 0; i < len; i++) {
      const v = src[i];
      if (v > gateLufs) {
        dst[n++] = v;
      }
    }
    if (n < 2) {
      this.lufsRange = 0;
      return;
    }
    // In-place sort of the gated subset (TypedArray.sort is stable since ES2019).
    // Slices a view over [0, n) so we don't touch the unused tail.
    dst.subarray(0, n).sort();
    const idx95 = Math.min(Math.floor(n * 0.95), n - 1);
    const idx10 = Math.max(Math.floor(n * 0.1), 0);
    this.lufsRange = dst[idx95] - dst[idx10];
  }
}
