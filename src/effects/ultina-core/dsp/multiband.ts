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
// (Reconciled from Pulse Forge hardening pass, 2026-09-14: allocation-free copyN in crossover splits.)
// ═══════════════════════════════════════════════════════════
// Ultina — Multiband Framework (TypeScript Reference)
//
// Provides the shared multiband processing infrastructure used
// by all multiband modules: crossover splitting, mid/side
// encoding, transient/sustain separation, and band processing.
//
// All buffers are preallocated in prepare(). process() is
// allocation-free.
// ═══════════════════════════════════════════════════════════

import {
  clamp,
  sanitizeSample,
  createBiquad,
  setLowPass,
  setHighPass,
  resetBiquad,
  type BiquadState,
  type FirFilterState,
  createFirFilter,
  designLowPassFir,
  resetFirFilter,
  processFirSample,
  DEFAULT_FIR_TAPS,
  encodeMidSide,
  decodeMidSide,
} from "./primitives.js";
import type { BandCount, ChannelMode, CrossoverMode } from "../contracts/channelModes.js";

/**
 * Bounded scalar copy — `dst.set(src.subarray(0, n))` semantics WITHOUT the
 * two TypedArray view objects per call (this runs several times per channel
 * per block in the crossover splits; subarray views here were the largest
 * remaining audio-thread allocation source).
 */
function copyN(dst: Float32Array, src: Float32Array, n: number): void {
  for (let i = 0; i < n; i++) dst[i] = src[i];
}

// ── Linkwitz-Riley crossover ───────────────────────────────

/** Butterworth Q for LR4 sections. */
export const LR4_Q = 1 / Math.SQRT2; // ≈ 0.7071

/** One crossover split point: complementary LP and HP branches. */
export interface CrossoverSplit {
  lp: BiquadState[]; // 2 sections for LR4
  hp: BiquadState[]; // 2 sections for LR4
}

/** Maximum supported band count — all buffers are sized for this. */
const MAX_BANDS = 3;

export class CrossoverNetwork {
  private splits: CrossoverSplit[] = [];
  private bandCount: BandCount = 1;
  private channelCount = 2;
  private maxBlockSize = 8192;

  // ── Pre-allocated LR4 work buffers (allocation-free process) ──
  private lr4Work: Float32Array[] = [];
  private lr4LpOut: Float32Array[] = [];
  private lr4MidLp: Float32Array[] = [];

  // ── FIR (linear-phase / hybrid) state ──────────────────────
  private crossoverMode: CrossoverMode = "analog";
  private firNumTaps = DEFAULT_FIR_TAPS;
  private firLatency = (DEFAULT_FIR_TAPS - 1) / 2;
  /** FIR filters indexed [splitIndex][channelIndex]. */
  private firFilters: FirFilterState[][] = [];
  /** Cached frequencies so we only re-design when changed. */
  private firFreqCache: number[] = [];
  /** Scratch buffer for LP outputs during splitFir (one per split). */
  private firLpOuts: number[] = [0, 0];

  prepare(channelCount: number, bandCount: BandCount, maxBlockSize: number = 8192): void {
    this.channelCount = Math.max(1, channelCount);
    this.bandCount = bandCount;
    this.maxBlockSize = Math.max(1, maxBlockSize);
    // REALTIME SAFETY: always allocate the structures for the MAXIMUM
    // band count (3 bands = 2 splits) — setBandCount() is then a pure
    // counter flip instead of reallocating filters and buffers on the
    // audio thread when the user changes band count during playback.
    const splitCount = MAX_BANDS - 1;
    this.splits = [];
    for (let i = 0; i < splitCount; i++) {
      this.splits.push({
        lp: [createBiquad(this.channelCount), createBiquad(this.channelCount)],
        hp: [createBiquad(this.channelCount), createBiquad(this.channelCount)],
      });
    }

    // Pre-allocate LR4 work buffers (allocation-free process)
    this.lr4Work = [];
    this.lr4LpOut = [];
    this.lr4MidLp = [];
    for (let ch = 0; ch < this.channelCount; ch++) {
      this.lr4Work.push(new Float32Array(this.maxBlockSize));
      this.lr4LpOut.push(new Float32Array(this.maxBlockSize));
      this.lr4MidLp.push(new Float32Array(this.maxBlockSize));
    }

    // Init FIR state for hybrid mode
    this.firNumTaps = DEFAULT_FIR_TAPS;
    this.firLatency = (this.firNumTaps - 1) / 2;
    this.firFilters = [];
    this.firFreqCache = [];
    for (let s = 0; s < splitCount; s++) {
      const channelFilters: FirFilterState[] = [];
      for (let c = 0; c < this.channelCount; c++) {
        channelFilters.push(createFirFilter(this.firNumTaps));
      }
      this.firFilters.push(channelFilters);
      this.firFreqCache.push(0);
    }
  }

  setCrossoverMode(mode: CrossoverMode): void {
    if (mode !== this.crossoverMode) {
      this.crossoverMode = mode;
      this.reset();
    }
  }

  getCrossoverMode(): CrossoverMode {
    return this.crossoverMode;
  }

  /** Latency introduced by the crossover in samples (0 for analog, M for hybrid). */
  getLatency(): number {
    return this.crossoverMode === "hybrid" && this.bandCount > 1 ? this.firLatency : 0;
  }

  setBandCount(bandCount: BandCount): void {
    if (bandCount !== this.bandCount) {
      this.bandCount = bandCount;
      // Filter states of newly included splits may be stale — clear
      // them (allocation-free) so no transients carry across the
      // switch. Coefficients are re-applied by the owning module's
      // updateMultiband right after the band count changes.
      this.reset();
    }
  }

  setFrequency(splitIndex: number, freqHz: number, sampleRate: number): void {
    // LR4 (analog) path
    if (splitIndex >= 0 && splitIndex < this.splits.length) {
      const split = this.splits[splitIndex];
      for (const bq of split.lp) setLowPass(bq.coeffs, freqHz, LR4_Q, sampleRate);
      for (const bq of split.hp) setHighPass(bq.coeffs, freqHz, LR4_Q, sampleRate);
    }

    // FIR (hybrid) path — re-design only when frequency changes
    if (splitIndex >= 0 && splitIndex < this.firFilters.length) {
      if (this.firFreqCache[splitIndex] !== freqHz) {
        this.firFreqCache[splitIndex] = freqHz;
        for (const fir of this.firFilters[splitIndex]) {
          designLowPassFir(fir, freqHz, sampleRate, this.firNumTaps);
        }
      }
    }
  }

  reset(): void {
    for (const split of this.splits) {
      for (const bq of split.lp) resetBiquad(bq);
      for (const bq of split.hp) resetBiquad(bq);
    }
    for (const splitFirs of this.firFilters) {
      for (const fir of splitFirs) resetFirFilter(fir);
    }
  }

  getBandCount(): BandCount {
    return this.bandCount;
  }

  /**
   * Split input into N bands. Writes into bandOut[0..N-1].
   * Each bandOut element is an array of Float32Array (per channel).
   * Dispatches between LR4 (analog) and FIR (hybrid) modes.
   */
  split(input: Float32Array[], bandOut: Float32Array[][], frameCount: number, _sampleRate: number): void {
    // M/S and T/S channel modes feed a SINGLE-channel buffer through the
    // multiband chain — honor the actual input width, never assume the
    // module's full channel count (a missing channel here crashes the
    // audio callback with a TypeError).
    const chCount = Math.min(this.channelCount, input.length);
    if (this.bandCount === 1) {
      // Single band: just copy (both modes identical)
      for (let ch = 0; ch < chCount; ch++) {
        copyN(bandOut[0][ch], input[ch], frameCount);
      }
      return;
    }

    if (this.crossoverMode === "hybrid") {
      this.splitFir(input, bandOut, frameCount);
    } else {
      this.splitLr4(input, bandOut, frameCount);
    }
  }

  /**
   * FIR (linear-phase) crossover split.
   *
   * Uses complementary FIR LP/HP pairs designed via windowed-sinc.
   * Perfect reconstruction: low + mid + high = delayed input.
   *
   * Band assignment (all share the same group delay M):
   *   - Low  = LP(freq1, input)
   *   - High = input_delayed - LP(freq2, input)  [or LP(freq1) for 2-band]
   *   - Mid  = LP(freq2) - LP(freq1)              [3-band only]
   */
  private splitFir(input: Float32Array[], bandOut: Float32Array[][], frameCount: number): void {
    const N = this.firNumTaps;
    const M = this.firLatency;
    const ch = Math.min(this.channelCount, input.length);
    // Only convolve the splits the active band count uses — in 2-band mode
    // split 1's output is never read (bands derive from lpOuts[0] + delayed).
    const numSplits = Math.min(this.firFilters.length, this.bandCount - 1);

    for (let i = 0; i < frameCount; i++) {
      for (let c = 0; c < ch; c++) {
        // Compute LP output for each split point.
        // All FIRs process the same input, so delay lines are identical.
        // We reuse firFilters[0][c]'s delay line to read the delayed input.
        const lpOuts = this.firLpOuts;
        for (let s = 0; s < numSplits; s++) {
          lpOuts[s] = processFirSample(this.firFilters[s][c], input[c][i]);
        }

        // Read the input sample from M steps ago (center of the FIR).
        // After processFirSample, writePos has advanced past the just-written
        // sample. The just-written position is (writePos - 1), and the center
        // is (writePos - 1 - M).
        const fir0 = this.firFilters[0][c];
        let delayIdx = fir0.writePos - 1 - M;
        if (delayIdx < 0) delayIdx += N;
        const delayed = fir0.delayLine[delayIdx];

        // Assign bands
        if (this.bandCount === 2) {
          bandOut[0][c][i] = sanitizeSample(lpOuts[0]);
          bandOut[1][c][i] = sanitizeSample(delayed - lpOuts[0]);
        } else {
          // 3-band
          bandOut[0][c][i] = sanitizeSample(lpOuts[0]);
          bandOut[2][c][i] = sanitizeSample(delayed - lpOuts[1]);
          bandOut[1][c][i] = sanitizeSample(lpOuts[1] - lpOuts[0]);
        }
      }
    }
  }

  /**
   * LR4 (analog, zero-latency) crossover split.
   * Uses cascaded Butterworth biquad sections.
   * All work buffers are pre-allocated — no allocations in this path.
   */
  private splitLr4(input: Float32Array[], bandOut: Float32Array[][], frameCount: number): void {
    if (this.bandCount === 1) {
      for (let ch = 0; ch < this.channelCount; ch++) {
        copyN(bandOut[0][ch], input[ch], frameCount);
      }
      return;
    }

    // Copy input to pre-allocated work buffer (width-honoring — see split())
    const chCount = Math.min(this.channelCount, input.length);
    for (let ch = 0; ch < chCount; ch++) {
      copyN(this.lr4Work[ch], input[ch], frameCount);
    }

    // Run ONLY the splits the active band count needs. The remaining
    // pre-allocated splits may still hold coefficients from an earlier
    // 3-band configuration (setBandCount resets state, NOT coefficients)
    // — cascading them would double-filter the high band and break the
    // LR4 allpass sum after a 3-band → 2-band switch.
    const activeSplits = this.bandCount - 1;
    for (let s = 0; s < activeSplits; s++) {
      const split = this.splits[s];

      // LP branch → copy work to lpOut, then cascade LP sections.
      // ONLY split 0's LP output is consumed (band 0); in 3-band mode the
      // mid band's LP1 pass happens ONCE in the post-loop refinement below.
      // Running the LP branch at s === 1 anyway would advance split1.lp's
      // biquad state on HP0(input) and leave it polluted for the refinement
      // pass — every block would be filtered twice through split1.lp,
      // corrupting the mid band and the LR4 flat-sum reconstruction.
      if (s === 0) {
        for (let ch = 0; ch < chCount; ch++) {
          copyN(this.lr4LpOut[ch], this.lr4Work[ch], frameCount);
        }
        for (const bq of split.lp) {
          for (let ch = 0; ch < chCount; ch++) {
            processBiquadInPlace(bq, this.lr4LpOut[ch], ch, frameCount);
          }
        }
      }

      // HP branch → cascade HP sections on work buffer (becomes input for next split)
      for (const bq of split.hp) {
        for (let ch = 0; ch < chCount; ch++) {
          processBiquadInPlace(bq, this.lr4Work[ch], ch, frameCount);
        }
      }

      if (s === 0) {
        // Band 0 = lowest
        for (let ch = 0; ch < chCount; ch++) {
          copyN(bandOut[0][ch], this.lr4LpOut[ch], frameCount);
        }
      }

      if (s === activeSplits - 1) {
        // Last split: work = highest band
        const lastBand = this.bandCount - 1;
        for (let ch = 0; ch < chCount; ch++) {
          copyN(bandOut[lastBand][ch], this.lr4Work[ch], frameCount);
        }
      } else {
        if (this.bandCount === 3 && s === 0) {
          // Store HP output as band 1 candidate; will be refined at split 1
          for (let ch = 0; ch < chCount; ch++) {
            copyN(bandOut[1][ch], this.lr4Work[ch], frameCount);
          }
        }
      }
    }

    // For 3-band: apply LP of split 1 to the middle band candidate
    if (this.bandCount === 3 && this.splits.length === 2) {
      const split1 = this.splits[1];
      for (let ch = 0; ch < chCount; ch++) {
        copyN(this.lr4MidLp[ch], bandOut[1][ch], frameCount);
      }
      for (const bq of split1.lp) {
        for (let ch = 0; ch < chCount; ch++) {
          processBiquadInPlace(bq, this.lr4MidLp[ch], ch, frameCount);
        }
      }
      for (let ch = 0; ch < chCount; ch++) {
        copyN(bandOut[1][ch], this.lr4MidLp[ch], frameCount);
      }
    }
  }

  /**
   * Sum bands back together. LR4 crossovers sum to flat (allpass).
   */
  sum(bands: Float32Array[][], output: Float32Array[], frameCount: number): void {
    // Output may be narrower than the module channel count (M/S mode sums
    // back into the single mid buffer) — honor it.
    const chCount = Math.min(this.channelCount, output.length);
    for (let ch = 0; ch < chCount; ch++) {
      output[ch].fill(0, 0, frameCount);
      for (let b = 0; b < this.bandCount; b++) {
        for (let i = 0; i < frameCount; i++) {
          output[ch][i] += bands[b][ch][i];
        }
      }
      // Sanitize
      for (let i = 0; i < frameCount; i++) {
        output[ch][i] = sanitizeSample(output[ch][i]);
      }
    }
  }
}

// Local helper to process biquad on a single channel in-place
function processBiquadInPlace(bq: BiquadState, data: Float32Array, ch: number, frameCount: number): void {
  // Hot path: no per-sample sanitize (the LR4 cascade runs up to 8× per
  // block per module). The state is guarded once per block; the crossover
  // sum() and module outputs sanitize.
  const { b0, b1, b2, a1, a2 } = bq.coeffs;
  let z1 = bq.z1[ch];
  let z2 = bq.z2[ch];
  for (let i = 0; i < frameCount; i++) {
    const x = data[i];
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    data[i] = y;
  }
  bq.z1[ch] = z1;
  bq.z2[ch] = z2;
  if (!Number.isFinite(z1) || !Number.isFinite(z2)) {
    bq.z1[ch] = 0;
    bq.z2[ch] = 0;
  }
}

// ── Mid/Side processor ─────────────────────────────────────

export class MidSideProcessor {
  private midBuf: Float32Array = new Float32Array(0);
  private sideBuf: Float32Array = new Float32Array(0);
  private result: { mid: Float32Array; side: Float32Array } | null = null;

  prepare(maxBlockSize: number, _channelCount: number): void {
    this.midBuf = new Float32Array(maxBlockSize);
    this.sideBuf = new Float32Array(maxBlockSize);
  }

  /**
   * If channel mode is mid or side, encode to M/S.
   * Returns the active channel buffer for processing.
   * If stereo mode, returns null (process both channels directly).
   */
  encode(
    left: Float32Array,
    right: Float32Array,
    frameCount: number,
    channelMode: ChannelMode,
  ): { mid: Float32Array; side: Float32Array } | null {
    if (channelMode !== "mid" && channelMode !== "side") return null;

    if (frameCount > this.midBuf.length) {
      this.midBuf = new Float32Array(frameCount);
      this.sideBuf = new Float32Array(frameCount);
    }

    encodeMidSide(left, right, frameCount, this.midBuf, this.sideBuf);
    // Pooled result object: encode() runs inside process() on the audio
    // thread — a fresh {mid, side} per block is render-thread GC churn.
    // The object is overwritten on every call; consumers read it
    // synchronously and never retain it.
    if (!this.result) this.result = { mid: this.midBuf, side: this.sideBuf };
    this.result.mid = this.midBuf;
    this.result.side = this.sideBuf;
    return this.result;
  }

  /**
   * Decode M/S back to L/R and write into output buffers.
   * Only called when channel mode was mid or side.
   */
  decode(
    mid: Float32Array,
    side: Float32Array,
    frameCount: number,
    leftOut: Float32Array,
    rightOut: Float32Array,
  ): void {
    decodeMidSide(mid, side, frameCount, leftOut, rightOut);
  }
}

// ── Transient/Sustain separator ────────────────────────────

export class TransientSustainSeparator {
  private transientEnv: number[] = [0, 0];
  private sustainEnv: number[] = [0, 0];
  private fastCoef = 0;
  private slowCoef = 0;

  prepare(sampleRate: number): void {
    this.fastCoef = 1 - Math.exp(-1 / ((5 / 1000) * sampleRate));
    this.slowCoef = 1 - Math.exp(-1 / ((200 / 1000) * sampleRate));
    this.transientEnv = [0, 0];
    this.sustainEnv = [0, 0];
  }

  reset(): void {
    this.transientEnv.fill(0);
    this.sustainEnv.fill(0);
  }

  separate(
    input: Float32Array,
    frameCount: number,
    transientBuf: Float32Array,
    sustainBuf: Float32Array,
    channelIndex: number = 0,
  ): void {
    const ch = channelIndex & 1;
    let tEnv = this.transientEnv[ch];
    let sEnv = this.sustainEnv[ch];

    for (let i = 0; i < frameCount; i++) {
      const abs = Math.abs(input[i]);

      if (abs > tEnv) {
        tEnv += this.fastCoef * (abs - tEnv);
      } else {
        tEnv += this.slowCoef * (abs - tEnv);
      }

      sEnv += this.slowCoef * (abs - sEnv);

      const tAmount = sEnv > 1e-8 ? clamp(tEnv / sEnv - 1, 0, 1) : 0;

      transientBuf[i] = input[i] * tAmount;
      sustainBuf[i] = input[i] * (1 - tAmount);
    }

    this.transientEnv[ch] = tEnv;
    this.sustainEnv[ch] = sEnv;
  }
}

// ── Multiband processor wrapper ────────────────────────────

/**
 * Combines crossover, M/S, and T/S for a multiband module.
 * Provides a simple interface: split → process bands → sum.
 */
export interface BandProcessFn {
  (bandIndex: number, channels: Float32Array[], frameCount: number): void;
}

export class MultibandProcessor {
  private crossover = new CrossoverNetwork();
  private midSide = new MidSideProcessor();
  private tsSeparator = new TransientSustainSeparator();

  // Preallocated band buffers
  private bandBuffers: Float32Array[][] = [];
  private transientBuf: Float32Array = new Float32Array(0);
  private sustainBuf: Float32Array = new Float32Array(0);
  // Stereo T/S processing runs both channels through one crossover call so
  // each channel keeps its own filter state slot. Reusing transientBuf for
  // L then R made the single-channel path share state and leak L into R.
  private transientStereoBufs: Float32Array[] = [];
  private sustainStereoBufs: Float32Array[] = [];
  // Reused single-band wrapper for the M/S and mono T/S paths (audio-thread
  // process() call — a fresh [target] literal per block is GC churn).
  private singleChannelWrap: Float32Array[] = [new Float32Array(0)];

  private sampleRate = 48000;
  private channelCount = 2;
  private maxBlockSize = 8192;
  private prepared = false;

  prepare(sampleRate: number, channelCount: number, maxBlockSize: number, bandCount: BandCount): void {
    this.sampleRate = sampleRate;
    this.channelCount = Math.max(1, channelCount);
    this.maxBlockSize = Math.max(1, maxBlockSize);

    this.crossover.prepare(this.channelCount, bandCount, this.maxBlockSize);
    this.midSide.prepare(this.maxBlockSize, this.channelCount);
    this.tsSeparator.prepare(sampleRate);

    // Preallocate band buffers for the MAXIMUM band count — live band
    // count changes must not allocate on the audio thread.
    this.bandBuffers = [];
    for (let b = 0; b < MAX_BANDS; b++) {
      const channels: Float32Array[] = [];
      for (let ch = 0; ch < this.channelCount; ch++) {
        channels.push(new Float32Array(this.maxBlockSize));
      }
      this.bandBuffers.push(channels);
    }

    this.transientBuf = new Float32Array(this.maxBlockSize);
    this.sustainBuf = new Float32Array(this.maxBlockSize);
    this.transientStereoBufs = [new Float32Array(this.maxBlockSize), new Float32Array(this.maxBlockSize)];
    this.sustainStereoBufs = [new Float32Array(this.maxBlockSize), new Float32Array(this.maxBlockSize)];

    this.prepared = true;
  }

  setCrossover(splitIndex: number, freqHz: number): void {
    this.crossover.setFrequency(splitIndex, freqHz, this.sampleRate);
  }

  setCrossoverMode(mode: CrossoverMode): void {
    this.crossover.setCrossoverMode(mode);
  }

  getCrossoverLatency(): number {
    return this.crossover.getLatency();
  }

  setBandCount(bandCount: BandCount): void {
    if (bandCount !== this.crossover.getBandCount()) {
      // Pure delegation — band buffers are pre-allocated for the max
      // count in prepare(), so this never allocates.
      this.crossover.setBandCount(bandCount);
    }
  }

  reset(): void {
    this.crossover.reset();
    this.tsSeparator.reset();
    for (const band of this.bandBuffers) {
      for (const ch of band) ch.fill(0);
    }
    for (const ch of this.transientStereoBufs) ch.fill(0);
    for (const ch of this.sustainStereoBufs) ch.fill(0);
  }

  /**
   * Process audio through the multiband chain.
   * The bandProcessFn is called for each band.
   */
  process(
    channels: Float32Array[],
    frameCount: number,
    bandProcessFn: BandProcessFn,
    channelMode: ChannelMode = "stereo",
  ): void {
    if (!this.prepared) return;
    if (frameCount > this.maxBlockSize) {
      frameCount = this.maxBlockSize;
    }

    if (channelMode === "mid" || channelMode === "side") {
      // Process only mid or side
      // For mono input (1 channel), skip M/S
      if (this.channelCount < 2) {
        this.processBands(channels, frameCount, bandProcessFn);
        return;
      }

      const msResult = this.midSide.encode(channels[0], channels[1], frameCount, channelMode);
      if (!msResult) return;
      const target = channelMode === "mid" ? msResult.mid : msResult.side;

      // Process as single-band (reused wrapper — audio-thread path)
      const singleChannel = this.singleChannelWrap;
      singleChannel[0] = target;
      this.processBands(singleChannel, frameCount, bandProcessFn);

      // Decode back — use the MidSideProcessor's internal buffers
      this.midSide.decode(msResult.mid, msResult.side, frameCount, channels[0], channels[1]);
    } else if (channelMode === "transient" || channelMode === "sustain") {
      // Process only transient or sustain component
      if (this.channelCount < 2) {
        // Mono: process single channel
        this.tsSeparator.separate(channels[0], frameCount, this.transientBuf, this.sustainBuf, 0);
        const target = channelMode === "transient" ? this.transientBuf : this.sustainBuf;
        const singleChannel = this.singleChannelWrap;
        singleChannel[0] = target;
        this.processBands(singleChannel, frameCount, bandProcessFn);
        // Mix back: replace only the targeted component
        const otherBuf = channelMode === "transient" ? this.sustainBuf : this.transientBuf;
        for (let i = 0; i < frameCount; i++) {
          channels[0][i] = target[i] + otherBuf[i];
        }
      } else {
        // For stereo T/S, separate both channels first and process them as a
        // stereo pair. This preserves independent crossover state slots;
        // processing [targetL] and [targetR] sequentially would reuse slot 0
        // and make L's filter tail seed R.
        const stereoChannels = Math.min(2, this.channelCount, channels.length);
        for (let ch = 0; ch < stereoChannels; ch++) {
          this.tsSeparator.separate(
            channels[ch],
            frameCount,
            this.transientStereoBufs[ch],
            this.sustainStereoBufs[ch],
            ch,
          );
        }
        const target = channelMode === "transient" ? this.transientStereoBufs : this.sustainStereoBufs;
        this.processBands(target, frameCount, bandProcessFn);
        const other = channelMode === "transient" ? this.sustainStereoBufs : this.transientStereoBufs;
        for (let ch = 0; ch < stereoChannels; ch++) {
          for (let i = 0; i < frameCount; i++) {
            channels[ch][i] = target[ch][i] + other[ch][i];
          }
        }
      }
    } else {
      // Stereo: normal multiband processing
      this.processBands(channels, frameCount, bandProcessFn);
    }
  }

  private processBands(channels: Float32Array[], frameCount: number, bandProcessFn: BandProcessFn): void {
    const bandCount = this.crossover.getBandCount();

    if (bandCount === 1) {
      // Single band: process directly
      bandProcessFn(0, channels, frameCount);
      return;
    }

    // Split into bands
    this.crossover.split(channels, this.bandBuffers, frameCount, this.sampleRate);

    // Process each band
    for (let b = 0; b < bandCount; b++) {
      bandProcessFn(b, this.bandBuffers[b], frameCount);
    }

    // Sum back
    this.crossover.sum(this.bandBuffers, channels, frameCount);
  }
}
