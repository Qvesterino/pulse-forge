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
//   Opto:   LA-2A school — slow electro-optical attack, long
//           program-dependent release, gentle ratio, soft knee
//   FET:    1176 school — 20 µs attack, aggressive ratio, and a
//           gain-reduction-proportional saturation "bite"
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
  processBiquadChannel,
  type BiquadState,
} from "../primitives.js";
import {
  MultibandProcessor,
} from "../multiband.js";
import {
  OS_FACTOR,
  OS_LATENCY_SAMPLES,
  type OsChannelState,
  createOsChannelState,
  resetOsChannelState,
  upsample as osUpsample,
  downsample as os_Downsample,
} from "../oversampler.js";
import { DryDelayMixer } from "../dryDelay.js";
import {
  channelModeFromValue,
  type BandCount,
  type CrossoverMode,
} from "../../contracts/channelModes.js";

// ── Constants ───────────────────────────────────────────────

export const COMP_MAX_BANDS = 3;

/** Comp mode enum values. */
const COMP_MODES = ["punch", "modern", "vintage", "opto", "fet"] as const;
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
  /** Opto-mode photocell memory (0..1) — slows release under sustained GR. */
  optoMemory: number;
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

  // Per-band detector HPF (comp.detectorHpfHz) — filters each band's own
  // detection signal so low-frequency energy does not trigger compression.
  // Two cascaded 2-pole stages = 24 dB/oct, so a 120 Hz setting really
  // rejects a 60 Hz rumble (a single 2-pole only manages −12 dB there,
  // which still crosses the threshold). Inactive at the 20 Hz default;
  // has no effect while an external sidechain drives the detector
  // (comp.sidechainHpfHz covers that path).
  private detHpf: BiquadState[][] = [];
  private detHpfBufs: Float32Array[] = [];

  // Reused per-block scratch (audio thread — no fresh arrays in process())
  private scChannelsWrap: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  private bandThresholdDbBuf: number[] = [0, 0, 0];

  // Dry buffer for mix
  private dryL: Float32Array = new Float32Array(0);
  private dryR: Float32Array = new Float32Array(0);

  // Latency-compensated dry/wet mixing (see dsp/dryDelay.ts): the wet path
  // carries the crossover + oversampler group delay; delaying the dry copy
  // by the same amount keeps mix < 100 % phase-coherent and delta listen
  // free of a delayed-copy echo.
  private dryDelay = new DryDelayMixer();

  // HQ oversampling of the gain-application path (quality mode 2). The
  // detector and envelope smoothing stay at base rate — only the per-sample
  // gain multiply runs at 4×, cleaning the residual modulation products of
  // deep ratio + fast attack settings. Off in tracking/mix modes: default
  // behavior and CPU are unchanged.
  private osStates: OsChannelState[][] = [];
  private bandGainBufs: Float64Array[] = [];
  private osActive = false;

  // Meter state
  private gainReduction: number[] = new Array(COMP_MAX_BANDS).fill(0);
  private outputLevels: number[] = new Array(COMP_MAX_BANDS).fill(-100);
  private autoMakeupDb = 0;
  private autoMakeupSmoother = new OnePoleSmoother();
  private pooledMeters: CompMeters | null = null;

  // Cached config
  private cachedBandCount = -1;
  private cachedXover1 = -1;
  private cachedXover2 = -1;

  prepare(ctx: ModuleProcessorContext): void {
    this.sampleRate = ctx.sampleRate;
    this.maxBlockSize = ctx.maxBlockSize;

    this.ensureBuffers(this.maxBlockSize);
    this.scHpf = createBiquad(2);

    this.detHpf = [];
    this.detHpfBufs = [];
    for (let i = 0; i < COMP_MAX_BANDS; i++) {
      this.detHpf.push([createBiquad(1), createBiquad(1)]);
      this.detHpfBufs.push(new Float32Array(this.maxBlockSize));
    }

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
        optoMemory: 0,
      });
      this.bands[i].peakEnv.prepare(10, 100, this.sampleRate);
      this.bands[i].rmsDetector.prepare(10, this.sampleRate);
    }

    this.autoMakeupSmoother.setTimeConstant(50, this.sampleRate);
    this.multiband.prepare(this.sampleRate, 2, this.maxBlockSize, 1);
    this.dryDelay.prepare(this.maxBlockSize);
    // prepare() rebuilds crossover filters; invalidate cached split values.
    this.cachedBandCount = -1;
    this.cachedXover1 = -1;
    this.cachedXover2 = -1;

    // Oversampler state per band and channel + base-rate gain scratch.
    this.osStates = [];
    this.bandGainBufs = [];
    for (let b = 0; b < COMP_MAX_BANDS; b++) {
      this.osStates.push([
        createOsChannelState(this.maxBlockSize * OS_FACTOR),
        createOsChannelState(this.maxBlockSize * OS_FACTOR),
      ]);
      // Float64: the per-sample gain must keep double precision — a float32
      // scratch here would round the multiply and shift every output sample.
      this.bandGainBufs.push(new Float64Array(this.maxBlockSize));
    }
    this.osActive = false;
  }

  process(args: ModuleProcessArgs): void {
    const { channels, frameCount, sidechain, params, ctx } = args;

    if (channels.length < 2) return;

    const enabled = (params["comp.enabled"] ?? 0) >= 0.5;
    if (!enabled) return;

    // HQ quality mode oversamples the gain-application path (see field docs).
    this.osActive = ctx.qualityMode >= 2;

    this.ensureBuffers(frameCount);

    // Read parameters
    const mode = COMP_MODES[Math.round(clamp(params["comp.mode"] ?? 1, 0, COMP_MODES.length - 1))];
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
    const detHpfHz = clamp(params["comp.detectorHpfHz"] ?? 20, 20, 1000);
    const bandCount = Math.round(clamp(params["comp.bandCount"] ?? 1, 1, 3)) as BandCount;
    // Clamp like the exciter/transient/clipper/density modules: the hybrid
    // FIR crossover designs its sinc from an unclamped fc = freq/sr — a
    // value above Nyquist yields a degenerate filter.
    const xover1 = clamp(params["comp.crossoverHz1"] ?? 250, 20, 20000);
    const xover2 = clamp(params["comp.crossoverHz2"] ?? 2500, 20, 20000);
    const channelModeRaw = Math.round(clamp(params["comp.channelMode"] ?? 0, 0, 4));
    const channelMode = channelModeFromValue(channelModeRaw);
    const deltaListen = (params["comp.delta"] ?? 0) >= 0.5;

    // Apply mode-specific adjustments
    const { effectiveAttack, effectiveRelease, effectiveRatio, effectiveKneeDb } =
      this.applyMode(mode, attackMs, releaseMs, ratio, kneeDb);

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
      const scChannels = this.scChannelsWrap;
      scChannels[0] = this.scHpfBufferL;
      scChannels[1] = this.scHpfBufferR;
      processBiquad(this.scHpf, scChannels, frameCount);
      detectSource = scChannels;
    }

    // Prepare per-band params (reused array — audio thread)
    const bandThresholdDb = this.bandThresholdDbBuf;
    bandThresholdDb[0] = params["comp.band0.thresholdDb"] ?? thresholdDb;
    bandThresholdDb[1] = params["comp.band1.thresholdDb"] ?? thresholdDb;
    bandThresholdDb[2] = params["comp.band2.thresholdDb"] ?? thresholdDb;

    // Detector HPF for the internal (per-band) detection path. When an
    // external sidechain drives the detector, comp.sidechainHpfHz already
    // filters that source, so this stays off to avoid double filtering.
    const scActive = scEnabled && sidechain && sidechain.length >= 2;
    const detHpfActive =
      detHpfHz > 20.5 && !scActive && this.detHpf.length === COMP_MAX_BANDS;
    if (detHpfActive) {
      for (let b = 0; b < COMP_MAX_BANDS; b++) {
        for (const stage of this.detHpf[b]) {
          setHighPass(stage.coeffs, detHpfHz, 0.707, this.sampleRate);
        }
      }
    }

    // Process through multiband
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
          effectiveKneeDb,
          detectionMode,
          autoRelease,
          mode,
          detHpfActive,
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

    // FET mode: gain-reduction-proportional bite — deeper compression
    // drives the FET harder into saturation (the 1176 "all buttons in"
    // character). Scales from the smoothed per-band GR meters.
    if (mode === "fet") {
      let avgGr = 0;
      for (let b = 0; b < bandCount; b++) {
        avgGr += this.gainReduction[b];
      }
      avgGr /= Math.max(1, bandCount);
      const bite = clamp(avgGr / 10, 0, 1) * 0.25;
      if (bite > 0.001) {
        for (let ch = 0; ch < 2; ch++) {
          const data = channels[ch];
          for (let i = 0; i < frameCount; i++) {
            const x = data[i];
            const sat = fastTanh(x * 1.7) / 1.7;
            data[i] = sanitizeSample(x * (1 - bite) + sat * bite);
          }
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

    // Mix dry/wet — the dry copy is delayed by the wet path's current
    // latency so the two signals stay phase-aligned (delta uses the same
    // delayed copy: delta = processed − input, without a delayed echo).
    const mix = mixPercent / 100;
    this.dryDelay.process(
      channels,
      this.dryL,
      this.dryR,
      frameCount,
      this.currentLatencySamples(),
      mix,
      deltaListen,
    );

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
      band.optoMemory = 0;
    }
    this.gainReduction.fill(0);
    this.outputLevels.fill(-100);
    this.autoMakeupDb = 0;
    this.autoMakeupSmoother.reset(0);
    this.multiband.reset();
    this.dryDelay.reset();
    for (const bandStates of this.osStates) {
      for (const s of bandStates) resetOsChannelState(s);
    }
    resetBiquad(this.scHpf);
    for (const stages of this.detHpf) {
      for (const stage of stages) resetBiquad(stage);
    }
  }

  getMeters(): CompMeters {
    if (!this.pooledMeters) {
      this.pooledMeters = {
        gainReduction: new Array(this.gainReduction.length).fill(0),
        outputLevels: new Array(this.outputLevels.length).fill(0),
        autoMakeupDb: 0,
      };
    }
    const m = this.pooledMeters;
    // POOLED snapshot (audio thread — getMeters runs at meter cadence inside
    // UltinaProcessor.getMeters). The next call overwrites every field;
    // postMessage clones, direct readers must copy immediately.
    for (let i = 0; i < m.gainReduction.length; i++) m.gainReduction[i] = this.gainReduction[i];
    for (let i = 0; i < m.outputLevels.length; i++) m.outputLevels[i] = this.outputLevels[i];
    m.autoMakeupDb = this.autoMakeupDb;
    return m;
  }

  /** Hybrid crossover group delay (samples). */
  getLatency(): number {
    return this.currentLatencySamples();
  }

  /** Current wet-path latency: crossover + HQ oversampler when active. */
  private currentLatencySamples(): number {
    let lat = this.multiband.getCrossoverLatency();
    if (this.osActive) lat += OS_LATENCY_SAMPLES;
    return lat;
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
    for (let b = 0; b < this.detHpfBufs.length; b++) {
      if (this.detHpfBufs[b].length < requiredSize) {
        this.detHpfBufs[b] = new Float32Array(requiredSize);
      }
    }
  }

  private applyMode(
    mode: CompMode,
    attackMs: number,
    releaseMs: number,
    ratio: number,
    kneeDb: number,
  ): { effectiveAttack: number; effectiveRelease: number; effectiveRatio: number; effectiveKneeDb: number } {
    switch (mode) {
      case "punch":
        return {
          effectiveAttack: attackMs * 0.5, // Faster attack
          effectiveRelease: releaseMs * 0.7,
          effectiveRatio: ratio * 1.15, // Slightly more aggressive
          effectiveKneeDb: kneeDb,
        };
      case "vintage":
        return {
          effectiveAttack: attackMs * 2.0, // Slower attack
          effectiveRelease: releaseMs * 1.5,
          // Clamp to ≥1: the ratio knob at 1–1.17 would otherwise invert
          // the slope and turn compression into upward gain.
          effectiveRatio: Math.max(1, ratio * 0.85), // Gentler
          effectiveKneeDb: kneeDb,
        };
      case "opto":
        // LA-2A school: electro-optical cell — attack never faster than
        // ~8 ms, release stretched well past the knob, gentle slope, and
        // a soft knee even when the knee knob is closed.
        return {
          effectiveAttack: clamp(attackMs * 1.5, 8, 40),
          effectiveRelease: clamp(releaseMs * 2.5, 50, 2000),
          effectiveRatio: Math.max(1, ratio * 0.8),
          effectiveKneeDb: Math.max(kneeDb, 6),
        };
      case "fet":
        // 1176 school: 20 µs–1 ms attack window (the real unit's range),
        // ratio pushed harder, release capped near the unit's 1.1 s max.
        return {
          effectiveAttack: clamp(attackMs * 0.05, 0.02, 1),
          effectiveRelease: clamp(releaseMs * 0.8, 5, 1100),
          effectiveRatio: clamp(ratio * 1.3, 1, 20),
          effectiveKneeDb: kneeDb,
        };
      case "modern":
      default:
        return {
          effectiveAttack: attackMs,
          effectiveRelease: releaseMs,
          effectiveRatio: ratio,
          effectiveKneeDb: kneeDb,
        };
    }
  }

  private updateMultiband(bandCount: BandCount, xover1: number, xover2: number): void {
    if (this.cachedBandCount !== bandCount) {
      this.multiband.setBandCount(bandCount);
      this.cachedBandCount = bandCount;
      // Bands beyond the new count must not keep reporting stale
      // GR/level readings — getMeters publishes the full 3-slot arrays.
      for (let b = bandCount; b < COMP_MAX_BANDS; b++) {
        this.gainReduction[b] = 0;
        this.outputLevels[b] = -100;
      }
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
    mode: CompMode,
    detHpfActive: boolean,
  ): void {
    const band = this.bands[bandIdx];
    const gainBuf = this.bandGainBufs[bandIdx];

    // Update attack/release coefficients
    band.attackCoef = smoothCoef(attackMs, this.sampleRate);
    band.releaseCoef = smoothCoef(releaseMs, this.sampleRate);
    // Auto-release fast coefficient — constant for the whole block, so it
    // is computed once here instead of calling Math.exp per sample below.
    const autoReleaseFastCoef = autoRelease
      ? smoothCoef(releaseMs * 0.2, this.sampleRate)
      : 0;
    // Opto photocell memory coefficient (~600 ms tau), also block-constant.
    const optoMemCoef = mode === "opto" ? smoothCoef(600, this.sampleRate) : 0;

    // Detect on sidechain if provided, otherwise on the band's own signal
    let detectCh = sidechainSource ? (sidechainSource[0] ?? channels[0]) : channels[0];
    if (!sidechainSource && detHpfActive) {
      // Filter the band's detection signal through the detector HPF so
      // low-frequency energy does not trigger compression of this band.
      // processBiquadChannel avoids the [buf] wrapper allocation the
      // array-taking helper would need per band per block.
      const buf = this.detHpfBufs[bandIdx];
      buf.set(channels[0].subarray(0, frameCount));
      processBiquadChannel(this.detHpf[bandIdx][0], buf, 0, frameCount);
      processBiquadChannel(this.detHpf[bandIdx][1], buf, 0, frameCount);
      detectCh = buf;
    }

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
          const s1 = Math.abs(detectCh[i] ?? channels[0][i]);
          // Parabolic 3-point true-peak interpolation needs x[i-1] and x[i+1].
          // The next sample does not exist at a block boundary; the old code
          // fabricated s2 = 0 there, which read as a cliff edge and produced
          // a small false peak once per maxBlockSize (a periodic 375 Hz
          // artifact at a 128-frame quantum). At the boundary use the raw
          // peak — no interpolation — and let the envelope follower smooth.
          if (i + 1 >= frameCount) {
            detected = band.peakEnv.process(s1);
            band.prevDetected = s1;
            break;
          }
          const s0 = Math.abs(band.prevDetected);
          const s2 = Math.abs(detectCh[i + 1] ?? channels[0][i + 1]);
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

      // ── Auto-release / opto program dependence ──
      let releaseCoef = band.releaseCoef;
      if (mode === "opto") {
        // Opto cell memory: sustained gain reduction heats the photocell
        // and progressively slows the release; the memory decays with a
        // ~600 ms tau once the material stops compressing.
        const target = clamp(band.gainReductionDb / 10, 0, 1);
        band.optoMemory += (target - band.optoMemory) * optoMemCoef;
        releaseCoef = band.releaseCoef / (1 + band.optoMemory * 3);
      } else if (autoRelease) {
        // Faster release when GR is high (program-dependent)
        const grFraction = clamp(band.gainReductionDb / 12, 0, 1);
        releaseCoef = band.releaseCoef * (1 - grFraction) + autoReleaseFastCoef * grFraction;
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

      // Store the per-sample linear gain; application happens below
      // (direct at base rate, or oversampled in HQ quality mode).
      gainBuf[i] = dbToLinear(-band.gainReductionDb);
    }

    // ── Apply gain ──
    if (this.osActive && frameCount > 0) {
      // 4× oversampled application: upsample the band, multiply by the
      // base-rate gain (zero-order hold — the smoothed GR moves far slower
      // than one base sample, so the hold adds no meaningful modulation
      // product), downsample back. The detector stays at base rate.
      const osStateL = this.osStates[bandIdx][0];
      const osStateR = this.osStates[bandIdx][1];
      const stereo = channels.length >= 2;
      osUpsample(channels[0], osStateL, frameCount);
      if (stereo) osUpsample(channels[1], osStateR, frameCount);
      const osFrames = frameCount * OS_FACTOR;
      for (let k = 0; k < osFrames; k++) {
        const g = gainBuf[k >> 2];
        osStateL.osBuffer[k] *= g;
        if (stereo) osStateR.osBuffer[k] *= g;
      }
      os_Downsample(osStateL, channels[0], frameCount);
      if (stereo) os_Downsample(osStateR, channels[1], frameCount);
    } else {
      for (let i = 0; i < frameCount; i++) {
        const gainLinear = gainBuf[i];
        for (let ch = 0; ch < channels.length; ch++) {
          channels[ch][i] = sanitizeSample(channels[ch][i] * gainLinear);
        }
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
