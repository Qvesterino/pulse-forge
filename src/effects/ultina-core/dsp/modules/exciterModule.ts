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
// Ultina — Exciter Module
//
// 8 saturation/distortion types with 4x oversampling,
// multiband processing, tone slider, pre-emphasis modes.
//
// Saturation types (blendable): Tube, Warm, Tape, Retro
// Distortion types (trash mode): Overdrive, Scream, Clipper, Scratch
// ═══════════════════════════════════════════════════════════

import type { ModuleProcessArgs, ModuleProcessorContext, UltinaModuleProcessor } from "../ultinaProcessor.js";
import {
  clamp,
  dbToLinear,
  fastTanh,
  sanitizeSample,
  softClip,
  hardClip,
  tubeSaturation,
  tubeAsymSaturation,
  tapeSaturation,
  warmSaturation,
} from "../primitives.js";
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

// ── Constants ──────────────────────────────────────────────

const EXCITER_MAX_BANDS = 3;

/** Tone tilt crossover corner (Hz) — see applyTone. */
const EXCITER_TONE_CORNER_HZ = 200;

// ── Meter interface ────────────────────────────────────────

export interface ExciterMeters {
  /** Per-band harmonic content increase (dB). */
  harmonicContentDb: number[];
  /** Per-band output peak (dBFS). */
  outputPeakDb: number[];
  /** Oversampling active. */
  oversampling: boolean;
}

// ── Module ─────────────────────────────────────────────────

interface SatAmounts {
  tubeAmt: number;
  tubeAsymAmt: number;
  warmAmt: number;
  tapeAmt: number;
  retroAmt: number;
  odAmt: number;
  screamAmt: number;
  clipAmt: number;
  scratchAmt: number;
}

export class ExciterModuleProcessor implements UltinaModuleProcessor {
  private sampleRate = 44100;
  private maxBlockSize = 512;

  // Multiband
  private multiband = new MultibandProcessor();

  // Per-band oversampling state (2 channels × max bands)
  private osStates: OsChannelState[][] = [];

  // Dry buffer for mix
  private dryL: Float32Array = new Float32Array(0);
  private dryR: Float32Array = new Float32Array(0);
  // Reused saturation amounts record — see process().
  private amountsBuf: SatAmounts = {
    tubeAmt: 0,
    tubeAsymAmt: 0,
    warmAmt: 0,
    tapeAmt: 0,
    retroAmt: 0,
    odAmt: 0,
    screamAmt: 0,
    clipAmt: 0,
    scratchAmt: 0,
  };
  // Per-block scalars + persistent band callback (audio thread — a fresh
  // closure per process() call is steady-state GC churn).
  private curTrashMode = false;
  private curToneSlider = 0;
  private curOversampling = false;
  private bandCb = (bandIdx: number, bandChannels: Float32Array[], bandFrames: number): void => {
    this.processBand(
      bandIdx,
      bandChannels,
      bandFrames,
      this.curTrashMode,
      this.amountsBuf,
      this.curToneSlider,
      this.curOversampling,
    );
  };
  // Latency-compensated dry/wet mixing (see dsp/dryDelay.ts).
  private dryDelay = new DryDelayMixer();
  private pooledMeters: ExciterMeters | null = null;

  // Tone filter state (per channel, per band)
  private toneLowState: number[] = [];
  private toneHighState: number[] = [];

  // Meter state
  private harmonicContent: number[] = new Array(EXCITER_MAX_BANDS).fill(0);
  private outputPeaks: number[] = new Array(EXCITER_MAX_BANDS).fill(-100);
  private osActive = false;

  // Cached config
  private cachedBandCount = -1;
  private cachedXover1 = -1;
  private cachedXover2 = -1;

  prepare(ctx: ModuleProcessorContext): void {
    this.sampleRate = ctx.sampleRate;
    this.maxBlockSize = ctx.maxBlockSize;

    const maxOsFrames = this.maxBlockSize * OS_FACTOR;

    // Allocate dry buffers
    this.dryL = new Float32Array(this.maxBlockSize);
    this.dryR = new Float32Array(this.maxBlockSize);

    // Allocate OS state for max 2 channels × max bands
    this.osStates = [];
    for (let b = 0; b < EXCITER_MAX_BANDS; b++) {
      const chStates: OsChannelState[] = [];
      for (let ch = 0; ch < 2; ch++) {
        chStates.push(createOsChannelState(maxOsFrames));
      }
      this.osStates.push(chStates);
    }

    // Tone filter state
    this.toneLowState = new Array(EXCITER_MAX_BANDS * 2).fill(0);
    this.toneHighState = new Array(EXCITER_MAX_BANDS * 2).fill(0);

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

    const enabled = (params["exciter.enabled"] ?? 0) >= 0.5;
    if (!enabled) return;

    this.ensureBuffers(frameCount);

    // Read parameters
    const trashMode = (params["exciter.trashMode"] ?? 0) >= 0.5;
    const tubeAmt = clamp(params["exciter.tubeAmount"] ?? 0, 0, 100) / 100;
    const tubeAsymAmt = clamp(params["exciter.tubeAsymAmount"] ?? 0, 0, 100) / 100;
    const warmAmt = clamp(params["exciter.warmAmount"] ?? 30, 0, 100) / 100;
    const tapeAmt = clamp(params["exciter.tapeAmount"] ?? 0, 0, 100) / 100;
    const retroAmt = clamp(params["exciter.retroAmount"] ?? 0, 0, 100) / 100;
    const odAmt = clamp(params["exciter.overdriveAmount"] ?? 0, 0, 100) / 100;
    const screamAmt = clamp(params["exciter.screamAmount"] ?? 0, 0, 100) / 100;
    const clipAmt = clamp(params["exciter.clipperAmount"] ?? 0, 0, 100) / 100;
    const scratchAmt = clamp(params["exciter.scratchAmount"] ?? 0, 0, 100) / 100;
    const toneSlider = clamp(params["exciter.toneSlider"] ?? 0, -100, 100) / 100;
    const bandCount = Math.round(clamp(params["exciter.bandCount"] ?? 1, 1, 3)) as BandCount;
    const xover1 = clamp(params["exciter.crossoverHz1"] ?? 2000, 20, 20000);
    const xover2 = clamp(params["exciter.crossoverHz2"] ?? 8000, 20, 20000);
    const channelModeRaw = Math.round(clamp(params["exciter.channelMode"] ?? 0, 0, 4));
    const channelMode = channelModeFromValue(channelModeRaw);
    const oversampling = (params["exciter.oversampling"] ?? 1) >= 0.5;
    const mixPercent = clamp(params["exciter.mix"] ?? 50, 0, 100);
    const deltaListen = (params["exciter.delta"] ?? 0) >= 0.5;

    this.osActive = oversampling;
    // Reused amounts record (audio thread — the object literal would be a
    // per-block allocation); processBand reads it synchronously.
    const amounts = this.amountsBuf;
    amounts.tubeAmt = tubeAmt;
    amounts.tubeAsymAmt = tubeAsymAmt;
    amounts.warmAmt = warmAmt;
    amounts.tapeAmt = tapeAmt;
    amounts.retroAmt = retroAmt;
    amounts.odAmt = odAmt;
    amounts.screamAmt = screamAmt;
    amounts.clipAmt = clipAmt;
    amounts.scratchAmt = scratchAmt;

    // Update multiband config if changed
    this.updateMultiband(bandCount, xover1, xover2);
    const xoverMode: CrossoverMode = (params["exciter.crossoverMode"] ?? 0) >= 0.5 ? "hybrid" : "analog";
    this.multiband.setCrossoverMode(xoverMode);

    // Store dry signal for mix (copy loop — subarray() allocates a view)
    for (let i = 0; i < frameCount; i++) {
      this.dryL[i] = channels[0][i];
      this.dryR[i] = channels[1][i];
    }

    // Process through multiband — persistent bound callback (allocated once;
    // the per-block scalars travel through fields, not the closure).
    this.curTrashMode = trashMode;
    this.curToneSlider = toneSlider;
    this.curOversampling = oversampling;
    this.multiband.process(channels, frameCount, this.bandCb, channelMode);

    // Mix dry/wet — the dry copy is delayed by the wet path's current
    // latency (crossover + oversampler) so mix < 100 % stays phase-coherent
    // and delta listen has no delayed-copy echo (see dsp/dryDelay.ts).
    const mix = mixPercent / 100;
    this.dryDelay.process(
      channels,
      this.dryL,
      this.dryR,
      frameCount,
      this.multiband.getCrossoverLatency() + (this.osActive ? OS_LATENCY_SAMPLES : 0),
      mix,
      deltaListen,
    );

    // Module-output sanitize: ONE pass at the boundary. The downsample
    // FIR is a linear combination of sanitized OS samples, so its output
    // can sit a hair above the ±32 rail for insane inputs — clamp here.
    for (let ch = 0; ch < channels.length; ch++) {
      const data = channels[ch];
      for (let i = 0; i < frameCount; i++) {
        data[i] = sanitizeSample(data[i]);
      }
    }

    // (Per-band output peaks are measured inside processBand —
    // overwriting band 0 with the full-mix peak hid the real bands.)
  }

  reset(): void {
    for (const bandStates of this.osStates) {
      for (const s of bandStates) {
        resetOsChannelState(s);
      }
    }
    this.toneLowState.fill(0);
    this.toneHighState.fill(0);
    this.multiband.reset();
    this.dryDelay.reset();
    this.harmonicContent.fill(0);
    this.outputPeaks.fill(-100);
  }

  getMeters(): ExciterMeters {
    if (!this.pooledMeters) {
      this.pooledMeters = {
        harmonicContentDb: new Array(this.harmonicContent.length).fill(0),
        outputPeakDb: new Array(this.outputPeaks.length).fill(0),
        oversampling: false,
      };
    }
    const m = this.pooledMeters;
    // POOLED snapshot (audio thread — getMeters runs at meter cadence inside
    // UltinaProcessor.getMeters). The next call overwrites every field;
    // postMessage clones, direct readers must copy immediately.
    for (let i = 0; i < m.harmonicContentDb.length; i++) m.harmonicContentDb[i] = this.harmonicContent[i];
    for (let i = 0; i < m.outputPeakDb.length; i++) m.outputPeakDb[i] = this.outputPeaks[i];
    m.oversampling = this.osActive;
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
      // Bands beyond the new count must not keep reporting stale meter
      // readings — getMeters publishes the full 3-slot arrays.
      for (let b = bandCount; b < EXCITER_MAX_BANDS; b++) {
        this.harmonicContent[b] = 0;
        this.outputPeaks[b] = -100;
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
    trashMode: boolean,
    amounts: SatAmounts,
    toneSlider: number,
    oversampling: boolean,
  ): void {
    const chL = bandChannels[0];
    // M/S channel modes deliver a SINGLE-band mono buffer (bandChannels
    // length 1). Aliasing chR to chL here would run saturation and the tone
    // filter over the SAME buffer twice (applyTone would even re-read the
    // already-processed L samples through the R one-pole state) — so every
    // R-side pass below is gated on a genuinely distinct second channel.
    const stereo = bandChannels.length >= 2;
    const chR = stereo ? bandChannels[1] : bandChannels[0];

    // Measure input energy for harmonic content meter
    let inEnergy = 0;
    for (let i = 0; i < bandFrames; i++) {
      inEnergy += chL[i] * chL[i];
    }

    if (oversampling && bandFrames > 0) {
      const osStateL = this.osStates[bandIdx][0];
      const osStateR = this.osStates[bandIdx][1];

      // Upsample 4x
      const osFrames = bandFrames * OS_FACTOR;
      this.upsample(chL, osStateL, bandFrames);
      if (stereo) this.upsample(chR, osStateR, bandFrames);

      // Process saturation at 4x rate
      this.applySaturation(osStateL.osBuffer, osFrames, trashMode, amounts);
      if (stereo) this.applySaturation(osStateR.osBuffer, osFrames, trashMode, amounts);

      // Apply tone at oversampled rate
      this.applyTone(osStateL.osBuffer, osStateR.osBuffer, osFrames, toneSlider, bandIdx, stereo);

      // Downsample 4x
      this.downsample(osStateL, chL, bandFrames);
      if (stereo) this.downsample(osStateR, chR, bandFrames);
    } else {
      // No oversampling: process directly
      this.applySaturation(chL, bandFrames, trashMode, amounts);
      if (stereo) this.applySaturation(chR, bandFrames, trashMode, amounts);
      this.applyTone(chL, chR, bandFrames, toneSlider, bandIdx, stereo);
    }

    // Measure harmonic content (ratio of output energy to input energy)
    let outEnergy = 0;
    for (let i = 0; i < bandFrames; i++) {
      outEnergy += chL[i] * chL[i];
    }
    if (inEnergy > 1e-10 && bandFrames > 0) {
      const ratio = outEnergy / inEnergy;
      this.harmonicContent[bandIdx] = 10 * Math.log10(Math.max(1e-10, ratio));
    } else {
      // Silent band: decay the meter toward 0 instead of freezing at the
      // last spoken value (a stale reading would show harmonics in silence).
      this.harmonicContent[bandIdx] *= 0.8;
    }

    // Measure output peak
    let peak = 0;
    for (let i = 0; i < bandFrames; i++) {
      const a = Math.abs(chL[i]);
      if (a > peak) peak = a;
    }
    this.outputPeaks[bandIdx] = peak > 1e-10 ? 20 * Math.log10(peak) : -100;
  }

  /**
   * Apply all active saturation/distortion types.
   * Saturation types are blended in parallel; distortion types
   * are applied in series.
   */
  private applySaturation(buf: Float32Array, frames: number, trashMode: boolean, a: SatAmounts): void {
    const hasSat = a.tubeAmt > 0 || a.tubeAsymAmt > 0 || a.warmAmt > 0 || a.tapeAmt > 0 || a.retroAmt > 0;
    const hasDist = trashMode && (a.odAmt > 0 || a.screamAmt > 0 || a.clipAmt > 0 || a.scratchAmt > 0);

    if (!hasSat && !hasDist) return;

    for (let i = 0; i < frames; i++) {
      let x = buf[i];
      let wet = 0;
      let blendCount = 0;

      // ── Saturation types (parallel blend) ──────────────

      if (a.tubeAmt > 0) {
        wet += tubeSaturation(x, 1 + a.tubeAmt * 2);
        blendCount++;
      }
      if (a.tubeAsymAmt > 0) {
        // Tube+ (biased): even-harmonic operating-point shift
        wet += tubeAsymSaturation(x, 1 + a.tubeAsymAmt * 2);
        blendCount++;
      }
      if (a.warmAmt > 0) {
        wet += warmSaturation(x, 1 + a.warmAmt * 1.5, a.warmAmt * 0.7);
        blendCount++;
      }
      if (a.tapeAmt > 0) {
        wet += tapeSaturation(x, 1 + a.tapeAmt * 2);
        blendCount++;
      }
      if (a.retroAmt > 0) {
        // Retro: asymmetric with gentle crossover distortion
        const d = x * (1 + a.retroAmt * 2);
        const pos = d > 0 ? fastTanh(d * 1.3) * 0.8 : fastTanh(d * 0.7) * 0.9;
        wet += pos;
        blendCount++;
      }

      if (blendCount > 0) {
        wet /= blendCount;
        const satBlend = Math.max(a.tubeAmt, a.tubeAsymAmt, a.warmAmt, a.tapeAmt, a.retroAmt);
        x = x * (1 - satBlend * 0.5) + wet * (satBlend * 0.5);
      }

      // ── Distortion types (series, trash mode only) ─────

      if (trashMode) {
        if (a.odAmt > 0) {
          const drive = 1 + a.odAmt * 5;
          x = softClip(x, drive) / Math.sqrt(drive);
        }
        if (a.screamAmt > 0) {
          const drive = 1 + a.screamAmt * 8;
          const d = x * drive;
          x = fastTanh(Math.tan(d * 0.3) * 0.8) * 0.7 * a.screamAmt + x * (1 - a.screamAmt);
        }
        if (a.clipAmt > 0) {
          const threshold = 1 - a.clipAmt * 0.8;
          x = hardClip(x, threshold);
        }
        if (a.scratchAmt > 0) {
          const bits = Math.max(2, 12 - a.scratchAmt * 10);
          const levels = Math.pow(2, bits);
          const quantized = Math.round(x * levels) / levels;
          x = quantized * a.scratchAmt + x * (1 - a.scratchAmt);
        }
      }

      buf[i] = sanitizeSample(x);
    }
  }

  /**
   * Apply tone shelving via one-pole crossover.
   * toneSlider: -1 = boost lows, +1 = boost highs.
   */
  private applyTone(
    chL: Float32Array,
    chR: Float32Array,
    frames: number,
    toneSlider: number,
    bandIdx: number,
    stereo: boolean,
  ): void {
    if (Math.abs(toneSlider) < 0.001) return;

    const lowGainDb = toneSlider < 0 ? -toneSlider * 6 : 0;
    const highGainDb = toneSlider > 0 ? toneSlider * 6 : 0;
    const lowGain = dbToLinear(lowGainDb);
    const highGain = dbToLinear(highGainDb);

    // One-pole crossover corner: 200 Hz, derived from the rate this code
    // ACTUALLY runs at — the oversampled path executes at 4× the session
    // rate, and the session rate itself varies (44.1/48/96 kHz). The old
    // hardcoded 0.98 was a near-transparent integrator (high = x − low ≈ 0):
    // the Tone knob moved level, not tone, and its behavior shifted with the
    // oversampling toggle and the session sample rate.
    const fsEffective = this.sampleRate * (this.osActive ? OS_FACTOR : 1);
    const alpha = 1 - Math.exp((-2 * Math.PI * EXCITER_TONE_CORNER_HZ) / fsEffective);

    let lowL = this.toneLowState[bandIdx * 2];
    let lowR = this.toneLowState[bandIdx * 2 + 1];

    for (let i = 0; i < frames; i++) {
      const sL = chL[i];
      lowL = lowL + alpha * (sL - lowL);
      chL[i] = sanitizeSample(lowL * lowGain + (sL - lowL) * highGain);

      // Mono (M/S single-band): chR aliases chL — running the R half would
      // re-filter the just-written L samples and pollute lowR.
      if (stereo) {
        const sR = chR[i];
        lowR = lowR + alpha * (sR - lowR);
        chR[i] = sanitizeSample(lowR * lowGain + (sR - lowR) * highGain);
      }
    }

    this.toneLowState[bandIdx * 2] = lowL;
    this.toneLowState[bandIdx * 2 + 1] = lowR;
  }

  // ── Oversampling (shared half-band FIR) ──────────────────

  private upsample(input: Float32Array, osState: OsChannelState, frames: number): void {
    osUpsample(input, osState, frames);
  }

  private downsample(osState: OsChannelState, output: Float32Array, frames: number): void {
    os_Downsample(osState, output, frames);
  }
}
