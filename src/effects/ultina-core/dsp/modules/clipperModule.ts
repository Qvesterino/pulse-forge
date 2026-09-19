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
// (Reconciled from Pulse Forge hardening pass, 2026-09-14: stale meter-slot reset on band-count reduction.)
// ═══════════════════════════════════════════════════════════
// Ultina — Clipper Module
//
// Multiband soft-knee clipper with optional 4x oversampling.
// Features: drive, ceiling, knee, M/S + T/S channel modes.
//
// Clipping curve:
//   - Below ceiling - knee: linear pass-through
//   - In knee region: smoothstep quadratic (C1 continuous)
//   - Above ceiling: hard limit
// ═══════════════════════════════════════════════════════════

import type { ModuleProcessArgs, ModuleProcessorContext, UltinaModuleProcessor } from "../ultinaProcessor.js";
import { clamp, dbToLinear, sanitizeSample, ampToDb } from "../primitives.js";
import {
  OS_FACTOR,
  OS_LATENCY_SAMPLES,
  type OsChannelState,
  createOsChannelState,
  resetOsChannelState,
  upsample as osUpsample,
  downsample as os_Downsample,
} from "../oversampler.js";
import { channelModeFromValue, type BandCount, type CrossoverMode } from "../../contracts/channelModes.js";
import { MultibandProcessor } from "../multiband.js";
import { DryDelayMixer } from "../dryDelay.js";
import type { BandMeters } from "../../contracts/meters.js";

// ── Constants ──────────────────────────────────────────────

const CLIPPER_MAX_BANDS = 3;

// ── Meter interface ────────────────────────────────────────

export interface ClipperMeters {
  bands: BandMeters[];
  /** Amount of clipping (dB reduction). */
  clippingReductionDb: number[];
}

// ── Per-band meter state ───────────────────────────────────

interface BandMeterState {
  inputPeak: number;
  outputPeak: number;
  outputRmsSum: number;
  outputRmsCount: number;
  clippingReduction: number; // peak reduction this block
}

function createBandMeterState(): BandMeterState {
  return {
    inputPeak: 0,
    outputPeak: 0,
    outputRmsSum: 0,
    outputRmsCount: 0,
    clippingReduction: 0,
  };
}

function resetBandMeterState(s: BandMeterState): void {
  s.inputPeak = 0;
  s.outputPeak = 0;
  s.outputRmsSum = 0;
  s.outputRmsCount = 0;
  s.clippingReduction = 0;
}

// ── Module ─────────────────────────────────────────────────

export class ClipperModuleProcessor implements UltinaModuleProcessor {
  private sampleRate = 44100;
  private maxBlockSize = 512;

  // Multiband
  private multiband = new MultibandProcessor();

  // Per-band oversampling state (2 channels × max bands)
  private osStates: OsChannelState[][] = [];

  /** Whether oversampling is currently active (for latency reporting). */
  private osActive = false;

  // Dry buffer for delta listen
  // Latency-compensated dry/wet mixing (see dsp/dryDelay.ts).
  private dryDelay = new DryDelayMixer();
  private pooledMeters: ClipperMeters | null = null;
  private dryL: Float32Array = new Float32Array(0);
  // Reused chunk wrappers — see the chunk loop in process().
  private chunkChannelsWrap: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  private dryR: Float32Array = new Float32Array(0);

  // Per-band meter state
  private bandMeters: BandMeterState[] = [];

  // Cached config
  private cachedBandCount = -1;
  private cachedXover1 = -1;
  private cachedXover2 = -1;

  prepare(ctx: ModuleProcessorContext): void {
    this.sampleRate = ctx.sampleRate;
    this.maxBlockSize = ctx.maxBlockSize;

    const maxOsFrames = this.maxBlockSize * OS_FACTOR;

    this.dryL = new Float32Array(this.maxBlockSize);
    this.dryR = new Float32Array(this.maxBlockSize);

    // Allocate OS state for max 2 channels × max bands
    this.osStates = [];
    for (let b = 0; b < CLIPPER_MAX_BANDS; b++) {
      const chStates: OsChannelState[] = [];
      for (let ch = 0; ch < 2; ch++) {
        chStates.push(createOsChannelState(maxOsFrames));
      }
      this.osStates.push(chStates);
    }

    // Band meters
    this.bandMeters = [];
    for (let b = 0; b < CLIPPER_MAX_BANDS; b++) {
      this.bandMeters.push(createBandMeterState());
    }

    this.multiband.prepare(this.sampleRate, 2, this.maxBlockSize, 1);
    this.dryDelay.prepare(this.maxBlockSize);
    // prepare() rebuilds crossover filters; invalidate cached split values.
    this.cachedBandCount = -1;
    this.cachedXover1 = -1;
    this.cachedXover2 = -1;
  }

  process(args: ModuleProcessArgs): void {
    const { channels, frameCount, params } = args;

    if (channels.length < 2) return;

    const enabled = (params["clipper.enabled"] ?? 0) >= 0.5;
    if (!enabled) return;

    // Read parameters
    const ceilingDb = clamp(params["clipper.ceilingDb"] ?? -1, -24, 0);
    const kneeDb = clamp(params["clipper.kneeDb"] ?? 2, 0, 12);
    const driveDb = clamp(params["clipper.driveDb"] ?? 0, 0, 24);
    const bandCount = Math.round(clamp(params["clipper.bandCount"] ?? 1, 1, 3)) as BandCount;
    const xover1 = clamp(params["clipper.crossoverHz1"] ?? 250, 20, 20000);
    const xover2 = clamp(params["clipper.crossoverHz2"] ?? 2500, 20, 20000);
    const channelModeRaw = Math.round(clamp(params["clipper.channelMode"] ?? 0, 0, 4));
    const channelMode = channelModeFromValue(channelModeRaw);
    const oversampling = (params["clipper.oversampling"] ?? 1) >= 0.5;
    this.osActive = oversampling;
    const deltaListen = (params["clipper.delta"] ?? 0) >= 0.5;
    const mixPercent = clamp(params["clipper.mix"] ?? 100, 0, 100);

    // Pre-compute clipper curve parameters
    const driveLin = dbToLinear(driveDb);
    const ceilingLin = dbToLinear(ceilingDb);
    // Knee width in linear amplitude, clamped so the knee never extends below
    // zero amplitude. For kneeDb > ~6.02 (10^(6.02/20) ≈ 2) the raw span
    // ceilingLin - kneeLin goes negative: the "below knee: linear" branch
    // becomes unreachable, near-zero inputs land in the smoothstep branch and
    // are mapped to ~(kneeStart + 0.5·kneeLin) garbage, and the meter's
    // absX/|out| ratio hits |out| = 0 → Infinity. Clamping at 0 makes every
    // knee > 6.02 dB behave exactly like the 6.02 dB boundary curve.
    const kneeLin = Math.min(dbToLinear(ceilingDb + kneeDb) - ceilingLin, ceilingLin);

    // Update multiband config if changed
    this.updateMultiband(bandCount, xover1, xover2);
    const xoverMode: CrossoverMode = (params["clipper.crossoverMode"] ?? 0) >= 0.5 ? "hybrid" : "analog";
    this.multiband.setCrossoverMode(xoverMode);

    // Reset per-call meter readings
    for (let b = 0; b < bandCount; b++) {
      this.bandMeters[b].clippingReduction = 0;
      this.bandMeters[b].outputRmsSum = 0;
      this.bandMeters[b].outputRmsCount = 0;
    }

    // Process in chunks of maxBlockSize (multiband clamps to maxBlockSize)
    const chunkSize = this.maxBlockSize;
    for (let offset = 0; offset < frameCount; offset += chunkSize) {
      const remaining = Math.min(chunkSize, frameCount - offset);

      // Create subarray views for this chunk
      // Reused chunk wrappers (audio thread): the common single-chunk case
      // passes the channel buffers directly — subarray views are only
      // created for genuine multi-chunk blocks.
      const chunkChannels = this.chunkChannelsWrap;
      chunkChannels[0] = offset === 0 ? channels[0] : channels[0].subarray(offset, offset + remaining);
      chunkChannels[1] = offset === 0 ? channels[1] : channels[1].subarray(offset, offset + remaining);

      // Store dry signal for delta (bounded copy — the channel buffer may
      // be longer than this chunk; .set() with a longer source would throw)
      this.ensureBuffers(remaining);
      for (let i = 0; i < remaining; i++) {
        this.dryL[i] = channels[0][offset + i];
        this.dryR[i] = channels[1][offset + i];
      }

      // Process through multiband
      this.multiband.process(
        chunkChannels,
        remaining,
        (bandIdx, bandChannels, bandFrames) => {
          this.processBand(bandIdx, bandChannels, bandFrames, driveLin, ceilingLin, kneeLin, kneeDb, oversampling);
        },
        channelMode,
      );

      // Final ceiling enforcement — prevents overshoot from
      // FIR filter ringing and multiband crossover summation
      for (let i = 0; i < remaining; i++) {
        const s0 = chunkChannels[0][i];
        if (s0 > ceilingLin) chunkChannels[0][i] = ceilingLin;
        else if (s0 < -ceilingLin) chunkChannels[0][i] = -ceilingLin;
        const s1 = chunkChannels[1][i];
        if (s1 > ceilingLin) chunkChannels[1][i] = ceilingLin;
        else if (s1 < -ceilingLin) chunkChannels[1][i] = -ceilingLin;
      }

      // Mix dry/wet
      // Mix dry/wet — the dry copy is delayed by the wet path's current
      // latency (crossover + oversampler) so mix < 100 % stays phase-coherent
      // and delta listen has no delayed-copy echo (see dsp/dryDelay.ts).
      const mix = mixPercent / 100;
      this.dryDelay.process(
        chunkChannels,
        this.dryL,
        this.dryR,
        remaining,
        this.multiband.getCrossoverLatency() + (this.osActive ? OS_LATENCY_SAMPLES : 0),
        mix,
        deltaListen,
      );
    }
  }

  reset(): void {
    for (const bandStates of this.osStates) {
      for (const s of bandStates) {
        resetOsChannelState(s);
      }
    }
    for (const bm of this.bandMeters) {
      resetBandMeterState(bm);
    }
    this.multiband.reset();
    this.dryDelay.reset();
  }

  getMeters(): ClipperMeters {
    if (!this.pooledMeters) {
      this.pooledMeters = {
        bands: this.bandMeters.map(() => ({
          inputPeakDb: -100,
          outputPeakDb: -100,
          gainReductionDb: 0,
          outputRmsDb: -100,
        })),
        clippingReductionDb: new Array(this.bandMeters.length).fill(0),
      };
    }
    const m = this.pooledMeters;
    // POOLED snapshot (audio thread — getMeters runs at meter cadence inside
    // UltinaProcessor.getMeters). The next call overwrites every field;
    // postMessage clones, direct readers must copy immediately.
    for (let b = 0; b < m.bands.length; b++) {
      const bm = this.bandMeters[b];
      const dst = m.bands[b];
      dst.inputPeakDb = ampToDb(bm.inputPeak);
      dst.outputPeakDb = ampToDb(bm.outputPeak);
      dst.gainReductionDb = bm.clippingReduction;
      dst.outputRmsDb = bm.outputRmsCount > 0 ? ampToDb(Math.sqrt(bm.outputRmsSum / bm.outputRmsCount)) : -100;
      m.clippingReductionDb[b] = bm.clippingReduction;
    }
    return m;
  }

  /** Hybrid crossover group delay + oversampler latency (samples). */
  getLatency(): number {
    let lat = this.multiband.getCrossoverLatency();
    if (this.osActive) {
      // Upsample FIR (7 OS) + downsample FIR (7 OS) + alignment delay (2 OS)
      // = 16 OS samples = exactly 4 base samples (see oversampler.ts).
      lat += OS_LATENCY_SAMPLES;
    }
    return lat;
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
      // Bands beyond the new count must not keep publishing stale
      // peak/RMS readings — getMeters reports the full 3-slot arrays
      // (same contract as compModule's GR/level reset).
      for (let b = bandCount; b < CLIPPER_MAX_BANDS; b++) {
        resetBandMeterState(this.bandMeters[b]);
      }
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
    driveLin: number,
    ceilingLin: number,
    kneeLin: number,
    _kneeDb: number,
    oversampling: boolean,
  ): void {
    const chL = bandChannels[0];
    // M/S channel modes deliver a SINGLE-band mono buffer (length 1).
    // Aliasing chR to chL would apply the knee curve twice — the smoothstep
    // knee region is not idempotent, so peaks would be over-compressed.
    const stereo = bandChannels.length >= 2;
    const chR = stereo ? bandChannels[1] : bandChannels[0];

    const bm = this.bandMeters[bandIdx];

    // Measure input peak
    let inPeak = 0;
    for (let i = 0; i < bandFrames; i++) {
      const a = Math.abs(chL[i]);
      if (a > inPeak) inPeak = a;
    }
    if (inPeak > bm.inputPeak) bm.inputPeak = inPeak;
    // Decay input peak meter slowly
    bm.inputPeak = Math.max(inPeak, bm.inputPeak * 0.95);

    let maxReductionDb = 0;

    if (oversampling && bandFrames > 0) {
      const osStateL = this.osStates[bandIdx][0];
      const osStateR = this.osStates[bandIdx][1];

      // Upsample 4x
      this.upsample(chL, osStateL, bandFrames);
      if (stereo) this.upsample(chR, osStateR, bandFrames);

      const osFrames = bandFrames * OS_FACTOR;

      // Process clipping at 4x rate
      const redL = this.applyClipping(osStateL.osBuffer, osFrames, driveLin, ceilingLin, kneeLin);
      const redR = stereo ? this.applyClipping(osStateR.osBuffer, osFrames, driveLin, ceilingLin, kneeLin) : redL;
      maxReductionDb = Math.max(redL, redR);

      // Downsample 4x
      this.downsample(osStateL, chL, bandFrames);
      if (stereo) this.downsample(osStateR, chR, bandFrames);
    } else {
      // No oversampling: process directly
      const redL = this.applyClipping(chL, bandFrames, driveLin, ceilingLin, kneeLin);
      const redR = stereo ? this.applyClipping(chR, bandFrames, driveLin, ceilingLin, kneeLin) : redL;
      maxReductionDb = Math.max(redL, redR);
    }

    // Measure output peak + RMS
    let outPeak = 0;
    let rmsSum = 0;
    for (let i = 0; i < bandFrames; i++) {
      const a = Math.abs(chL[i]);
      if (a > outPeak) outPeak = a;
      rmsSum += chL[i] * chL[i];
    }
    bm.outputPeak = Math.max(outPeak, bm.outputPeak * 0.95);
    bm.outputRmsSum += rmsSum;
    bm.outputRmsCount += bandFrames;
    bm.clippingReduction = Math.max(maxReductionDb, bm.clippingReduction);
  }

  /**
   * Apply soft-knee clipping curve to a buffer.
   * Returns the maximum gain reduction in dB observed.
   */
  private applyClipping(
    buf: Float32Array,
    frames: number,
    driveLin: number,
    ceilingLin: number,
    kneeLin: number,
  ): number {
    let maxReductionDb = 0;
    const kneeStart = ceilingLin - kneeLin;

    for (let i = 0; i < frames; i++) {
      // Apply drive
      const x = buf[i] * driveLin;
      const absX = Math.abs(x);
      const sign = x < 0 ? -1 : 1;

      let out: number;

      if (absX <= kneeStart) {
        // Below knee: linear pass-through
        out = x;
      } else if (absX >= ceilingLin) {
        // Above ceiling: hard clip
        out = sign * ceilingLin;

        // Track reduction
        if (absX > ceilingLin * 1.001) {
          const redDb = 20 * Math.log10(absX / ceilingLin);
          if (redDb > maxReductionDb) maxReductionDb = redDb;
        }
      } else {
        // In knee region: smoothstep quadratic transition
        // t goes from 0 (at kneeStart) to 1 (at ceilingLin)
        const t = (absX - kneeStart) / kneeLin;
        // Smoothstep: 3t² - 2t³
        // At t=0: value=kneeStart, derivative matches linear (slope 1)
        // At t=1: value=ceilingLin, derivative=0 (flat, matching hard clip)
        const smooth = 3 * t * t - 2 * t * t * t;
        out = sign * (kneeStart + kneeLin * smooth);

        // Track reduction (only meaningful if significant)
        if (absX > 1e-6) {
          const redDb = 20 * Math.log10(absX / Math.abs(out));
          if (redDb > maxReductionDb) maxReductionDb = redDb;
        }
      }

      buf[i] = sanitizeSample(out);
    }

    return maxReductionDb;
  }

  // ── Oversampling (shared half-band FIR) ──────────────────

  private upsample(input: Float32Array, osState: OsChannelState, frames: number): void {
    osUpsample(input, osState, frames);
  }

  private downsample(osState: OsChannelState, output: Float32Array, frames: number): void {
    os_Downsample(osState, output, frames);
  }
}
