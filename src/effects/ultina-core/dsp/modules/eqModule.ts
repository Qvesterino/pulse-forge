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
// Ultina — EQ Module (TypeScript Reference)
//
// 12-band parametric EQ with static, dynamic, and sidechain
// modes. Supports mid/side processing, soft saturation, and
// band solo.
//
// Signal flow:
//   Input → [M/S or T/S separation] → 12 Biquad Bands → [recombine]
//         → [Soft Saturation] → Output
//
// Each band can operate in:
//   - static:    Fixed gain (traditional EQ)
//   - dynamic:   Gain reduces when signal at band freq exceeds threshold
//   - sidechain: Gain reduces when sidechain signal at band freq exceeds threshold
// ═══════════════════════════════════════════════════════════

import type { UltinaModuleProcessor, ModuleProcessorContext, ModuleProcessArgs } from "../ultinaProcessor.js";
import {
  type BiquadState,
  createBiquad,
  resetBiquad,
  clamp,
  setLowPass,
  setHighPass,
  setBell,
  setHighShelf,
  setLowShelf,
  setNotch,
  setBandPass,
  BiquadCoeffSmoother,
  processBiquadSmoothed,
  fastTanh,
  sanitizeSample,
  EnvelopeFollower,
  encodeMidSide,
  decodeMidSide,
} from "../primitives.js";
import { TransientSustainSeparator } from "../multiband.js";
import { MaskingMeter } from "../maskingMeter.js";

// ── Constants ───────────────────────────────────────────────

export const EQ_MAX_BANDS = 12;

/** EQ band shapes (matching parameter schema enum). */
const EQ_SHAPES = [
  "bell",
  "highShelf",
  "lowShelf",
  "highPass",
  "lowPass",
  "notch",
  "tilt",
  "bandPass",
  "flat",
  "dynamicBell",
  "dynamicShelf",
  "dynamicTilt",
] as const;

/** Band modes. */

// ── Band state ──────────────────────────────────────────────

interface EqBandState {
  /** Static EQ filter (always active for this band). */
  filter: BiquadState;
  /** Second filter for tilt shape (low-shelf + high-shelf pair). */
  filter2: BiquadState;
  /** Dynamic detection filter (band-pass at band freq for level detection). */
  detector: BiquadState;
  /**
   * Dynamic gain-shaping filter (band-pass applied to the MAIN signal).
   * The dynamic reduction is applied as out = x − BP(x)·(1−g), which
   * confines the cut to this band's frequency region instead of
   * attenuating the whole spectrum.
   */
  dynFilter: BiquadState;
  /**
   * Coefficient smoothers (zipper-noise prevention): knob drags and
   * automation redesign the biquads every block; without interpolation
   * the coefficient jumps click. ~10 ms linear ramp per transition.
   */
  filterSmooth: BiquadCoeffSmoother;
  filter2Smooth: BiquadCoeffSmoother;
  dynSmooth: BiquadCoeffSmoother;
  /** False until the first coefficient design — the first design snaps
   * (the band was silent, nothing to glide from); later changes ramp. */
  coeffsInit: boolean;
  /** Envelope follower for dynamic mode. */
  envelope: EnvelopeFollower;
  /** Current smoothed dynamic gain reduction (dB, always ≤ 0). */
  currentGainDb: number;
  /** Whether coefficients need recalculation. */
  dirty: boolean;
  /** Cached parameter values to detect changes. */
  cachedFreq: number;
  cachedGain: number;
  cachedQ: number;
  cachedShape: number;
  /** Cached dynamic envelope params to detect changes. */
  cachedAttackMs: number;
  cachedReleaseMs: number;
}

// ── Module meters ───────────────────────────────────────────

export interface EqMeters {
  /** Per-band output level (dB). */
  bandLevels: number[];
  /** Per-band gain reduction for dynamic bands (dB, positive = reduction). */
  bandGainReduction: number[];
  /** Masking data (when masking meter enabled). */
  masking: number[] | null;
}

// ── EQ Module ───────────────────────────────────────────────

export class EqModuleProcessor implements UltinaModuleProcessor {
  private sampleRate = 44100;
  private maxBlockSize = 512;
  private bands: EqBandState[] = [];

  /**
   * Precomputed per-band parameter key strings — building
   * `eq.band${i}.xxx` templates per band per block creates 150+
   * transient strings on the audio path.
   */
  private bandKeys: Array<{
    enabled: string;
    freqHz: string;
    gainDb: string;
    q: string;
    shape: string;
    mode: string;
    dynamicRangeDb: string;
    dynamicThresholdDb: string;
    sidechainEnabled: string;
    dynamicAttackMs: string;
    dynamicReleaseMs: string;
    dynamicRatio: string;
    dynamicKneeDb: string;
  }> = [];
  private soloKeys: string[] = [];
  private bandLevels: number[] = new Array(EQ_MAX_BANDS).fill(-100);
  private bandGainReduction: number[] = new Array(EQ_MAX_BANDS).fill(0);
  private maskingData: number[] | null = null;
  private pooledMeters: EqMeters | null = null;

  // M/S processing buffers
  private midBuffer: Float32Array = new Float32Array(0);
  private sideBuffer: Float32Array = new Float32Array(0);
  // Reused M/S wrappers (audio thread — see the M/S branch of process())
  private singleChannelWrap: Float32Array[] = [new Float32Array(0)];
  private scWrap: Float32Array[] = [new Float32Array(0)];
  private tempL: Float32Array = new Float32Array(0);
  private tempR: Float32Array = new Float32Array(0);
  /** Per-sample dynamic-gain trajectory (pass 1 → pass 2 of dynamic bands). */
  private dynGainBuf: Float32Array = new Float32Array(0);

  // Transient/sustain separation (channel modes 3/4 — the schema and
  // MODULE_SUPPORTS_TRANSIENT_SUSTAIN advertise these; the band banks below
  // process only the selected component, mirroring the structure of
  // MultibandProcessor.process's T/S branch).
  private tsSeparator = new TransientSustainSeparator();
  private transientBufs: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  private sustainBufs: Float32Array[] = [new Float32Array(0), new Float32Array(0)];

  // Masking meter (per-band bandpass analysis)
  private maskingMeter = new MaskingMeter();

  prepare(ctx: ModuleProcessorContext): void {
    this.sampleRate = ctx.sampleRate;
    this.maxBlockSize = ctx.maxBlockSize;

    // Allocate M/S buffers (sized for max block)
    this.ensureBuffers(this.maxBlockSize);

    // Initialize bands
    this.bands = [];
    this.bandKeys = [];
    this.soloKeys = [];
    for (let i = 0; i < EQ_MAX_BANDS; i++) {
      const p = `eq.band${i}`;
      this.bandKeys.push({
        enabled: `${p}.enabled`,
        freqHz: `${p}.freqHz`,
        gainDb: `${p}.gainDb`,
        q: `${p}.q`,
        shape: `${p}.shape`,
        mode: `${p}.mode`,
        dynamicRangeDb: `${p}.dynamicRangeDb`,
        dynamicThresholdDb: `${p}.dynamicThresholdDb`,
        sidechainEnabled: `${p}.sidechainEnabled`,
        dynamicAttackMs: `${p}.dynamicAttackMs`,
        dynamicReleaseMs: `${p}.dynamicReleaseMs`,
        dynamicRatio: `${p}.dynamicRatio`,
        dynamicKneeDb: `${p}.dynamicKneeDb`,
      });
      this.soloKeys.push(`${p}.solo`);
      this.bands.push({
        filter: createBiquad(2),
        filter2: createBiquad(2),
        detector: createBiquad(2),
        dynFilter: createBiquad(2),
        coeffsInit: false,
        filterSmooth: new BiquadCoeffSmoother(),
        filter2Smooth: new BiquadCoeffSmoother(),
        dynSmooth: new BiquadCoeffSmoother(),
        envelope: new EnvelopeFollower(),
        currentGainDb: 0,
        dirty: true,
        cachedFreq: -1,
        cachedGain: 0,
        cachedQ: 0,
        cachedShape: -1,
        cachedAttackMs: -1,
        cachedReleaseMs: -1,
      });
      this.bands[i].envelope.prepare(15, 150, this.sampleRate);
      this.bands[i].filterSmooth.setTimeConstant(10, this.sampleRate);
      this.bands[i].filter2Smooth.setTimeConstant(10, this.sampleRate);
      this.bands[i].dynSmooth.setTimeConstant(10, this.sampleRate);
    }

    this.maskingMeter.prepare(this.sampleRate, this.maxBlockSize);
    this.tsSeparator.prepare(this.sampleRate);
  }

  process(args: ModuleProcessArgs): void {
    const { channels, frameCount, sidechain, params } = args;

    if (channels.length < 2) return;

    // Ensure temp buffers are large enough for this block
    this.ensureBuffers(frameCount);

    // Read module-level parameters
    const enabled = (params["eq.enabled"] ?? 0) >= 0.5;
    if (!enabled) return;

    const channelMode = Math.round(params["eq.channelMode"] ?? 0);
    const softSat = (params["eq.softSaturation"] ?? 0) >= 0.5;
    const maskingEnabled = (params["eq.maskingMeterEnabled"] ?? 0) >= 0.5;
    const sidechainEnabled = (params["eq.sidechainEnabled"] ?? 0) >= 0.5;

    // Check for solo'd bands
    let soloBand = -1;
    for (let i = 0; i < EQ_MAX_BANDS; i++) {
      if ((params[this.soloKeys[i]] ?? 0) >= 0.5) {
        soloBand = i;
        break;
      }
    }

    // Handle M/S modes
    const useMidSide = channelMode === 1 || channelMode === 2; // mid or side only

    if (useMidSide) {
      // Encode to M/S
      encodeMidSide(channels[0], channels[1], frameCount, this.midBuffer, this.sideBuffer);

      // Process on the selected channel (mid or side) — reused wrappers,
      // refreshed each block (the buffers are reallocated by ensureBuffers)
      const targetBuffer = this.singleChannelWrap;
      targetBuffer[0] = channelMode === 1 ? this.midBuffer : this.sideBuffer;
      let targetSidechain: Float32Array[] | null = null;
      if (sidechainEnabled && sidechain) {
        this.scWrap[0] = sidechain[0];
        targetSidechain = this.scWrap;
      }

      this.processBands(targetBuffer, frameCount, targetSidechain, params, soloBand, maskingEnabled);
      this.applySoftSat(targetBuffer, frameCount, softSat);

      // Decode back to L/R
      decodeMidSide(this.midBuffer, this.sideBuffer, frameCount, channels[0], channels[1]);
    } else if (channelMode === 3 || channelMode === 4) {
      // Transient/sustain: separate BOTH channels, process ONLY the selected
      // component through the band banks (independent filter-state slots per
      // channel — processing [targetL] then [targetR] through the same banks
      // would let L's filter tail seed R), then recombine.
      for (let ch = 0; ch < 2; ch++) {
        this.tsSeparator.separate(channels[ch], frameCount, this.transientBufs[ch], this.sustainBufs[ch], ch);
      }
      const target = channelMode === 3 ? this.transientBufs : this.sustainBufs;
      const other = channelMode === 3 ? this.sustainBufs : this.transientBufs;
      this.processBands(target, frameCount, sidechainEnabled ? sidechain : null, params, soloBand, maskingEnabled);
      this.applySoftSat(target, frameCount, softSat);
      for (let ch = 0; ch < 2; ch++) {
        const t = target[ch];
        const o = other[ch];
        const out = channels[ch];
        for (let i = 0; i < frameCount; i++) {
          out[i] = t[i] + o[i];
        }
      }
    } else {
      // Stereo (process both channels)
      this.processBands(channels, frameCount, sidechainEnabled ? sidechain : null, params, soloBand, maskingEnabled);
      this.applySoftSat(channels, frameCount, softSat);
    }
  }

  reset(): void {
    for (const band of this.bands) {
      resetBiquad(band.filter);
      resetBiquad(band.filter2);
      resetBiquad(band.detector);
      resetBiquad(band.dynFilter);
      band.coeffsInit = false;
      band.envelope.reset();
      band.currentGainDb = 0;
      band.dirty = true;
    }
    this.bandLevels.fill(-100);
    this.bandGainReduction.fill(0);
    this.maskingData = null;
    this.maskingMeter.reset();
    this.tsSeparator.reset();
  }

  getMeters(): EqMeters {
    if (!this.pooledMeters) {
      this.pooledMeters = {
        bandLevels: new Array(this.bandLevels.length).fill(0),
        bandGainReduction: new Array(this.bandGainReduction.length).fill(0),
        masking: this.maskingData ? new Array(this.maskingData.length).fill(0) : null,
      };
    }
    const m = this.pooledMeters;
    // POOLED snapshot (audio thread — getMeters runs at meter cadence inside
    // UltinaProcessor.getMeters). The next call overwrites every field;
    // postMessage clones, direct readers must copy immediately.
    for (let i = 0; i < m.bandLevels.length; i++) m.bandLevels[i] = this.bandLevels[i];
    for (let i = 0; i < m.bandGainReduction.length; i++) m.bandGainReduction[i] = this.bandGainReduction[i];
    if (this.maskingData) {
      if (!m.masking || m.masking.length !== this.maskingData.length) {
        m.masking = new Array(this.maskingData.length).fill(0);
      }
      for (let i = 0; i < m.masking.length; i++) m.masking[i] = this.maskingData[i];
    } else {
      m.masking = null;
    }
    return m;
  }

  // ── Internal helpers ───────────────────────────────────────

  private ensureBuffers(requiredSize: number): void {
    if (this.midBuffer.length < requiredSize) {
      this.midBuffer = new Float32Array(requiredSize);
      this.sideBuffer = new Float32Array(requiredSize);
      this.tempL = new Float32Array(requiredSize);
      this.tempR = new Float32Array(requiredSize);
      this.dynGainBuf = new Float32Array(requiredSize);
    }
    if (this.transientBufs[0].length < requiredSize) {
      this.transientBufs = [new Float32Array(requiredSize), new Float32Array(requiredSize)];
      this.sustainBufs = [new Float32Array(requiredSize), new Float32Array(requiredSize)];
    }
  }

  // ── Internal processing ────────────────────────────────────

  private processBands(
    channels: Float32Array[],
    frameCount: number,
    sidechain: Float32Array[] | null,
    params: Record<string, number>,
    soloBand: number,
    maskingEnabled: boolean,
  ): void {
    // ── Early skip: no band enabled and nothing soloed ──
    // "EQ on, all bands off" is the most common resting state — the
    // full 12-band loop (param reads, coefficient checks, meter decay)
    // is pure waste there. Passthrough + meter decay only.
    if (soloBand < 0) {
      let anyEnabled = false;
      for (let i = 0; i < EQ_MAX_BANDS; i++) {
        if ((params[this.bandKeys[i].enabled] ?? 0) >= 0.5) {
          anyEnabled = true;
          break;
        }
      }
      if (!anyEnabled) {
        for (let i = 0; i < EQ_MAX_BANDS; i++) {
          this.bandLevels[i] = this.bandLevels[i] * 0.8 + -100 * 0.2;
          this.bandGainReduction[i] = this.bandGainReduction[i] * 0.8;
        }
        this.maskingData = null;
        return;
      }
    }

    for (let bandIdx = 0; bandIdx < EQ_MAX_BANDS; bandIdx++) {
      const band = this.bands[bandIdx];
      const keys = this.bandKeys[bandIdx];

      const bandEnabled = (params[keys.enabled] ?? 0) >= 0.5;
      // Skipped bands decay their level meter toward the floor so a
      // disabled band never shows a frozen, stale reading.
      if (!bandEnabled && soloBand < 0) {
        this.bandLevels[bandIdx] = this.bandLevels[bandIdx] * 0.8 + -100 * 0.2;
        this.bandGainReduction[bandIdx] = this.bandGainReduction[bandIdx] * 0.8;
        continue;
      }

      // If a band is soloed, only process that band
      if (soloBand >= 0 && bandIdx !== soloBand) {
        this.bandLevels[bandIdx] = this.bandLevels[bandIdx] * 0.8 + -100 * 0.2;
        this.bandGainReduction[bandIdx] = this.bandGainReduction[bandIdx] * 0.8;
        continue;
      }

      const freq = params[keys.freqHz] ?? 1000;
      // Defensive clamp: the schema bounds gainDb to ±18, but a hostile
      // automation source that bypassed every clamp would overflow
      // A = 10^(gain/40) to Inf → NaN coefficients → silenced band.
      const gain = clamp(params[keys.gainDb] ?? 0, -24, 24);
      const q = params[keys.q] ?? 1;
      const shape = Math.round(params[keys.shape] ?? 0);
      const mode = Math.round(params[keys.mode] ?? 0);
      const dynRange = params[keys.dynamicRangeDb] ?? 6;
      const dynThreshold = params[keys.dynamicThresholdDb] ?? -24;
      const bandSidechain = (params[keys.sidechainEnabled] ?? 0) >= 0.5;
      const dynAttack = params[keys.dynamicAttackMs] ?? 15;
      const dynRelease = params[keys.dynamicReleaseMs] ?? 150;
      // Clamp like compModule: a ratio ≤ 0 makes the slope 1-1/ratio ±Inf,
      // saturating the dynamic-band gain reduction and silencing the band.
      const dynRatio = clamp(params[keys.dynamicRatio] ?? 3, 1, 20);
      const dynKnee = params[keys.dynamicKneeDb] ?? 0;

      // Update filter coefficients if parameters changed
      if (
        band.cachedFreq !== freq ||
        band.cachedGain !== gain ||
        band.cachedQ !== q ||
        band.cachedShape !== shape ||
        band.dirty
      ) {
        this.updateBandCoefficients(band, freq, gain, q, shape);
        band.cachedFreq = freq;
        band.cachedGain = gain;
        band.cachedQ = q;
        band.cachedShape = shape;
        band.dirty = false;
      }

      // Update envelope follower attack/release if changed
      if (band.cachedAttackMs !== dynAttack || band.cachedReleaseMs !== dynRelease) {
        band.envelope.setAttack(dynAttack, this.sampleRate);
        band.envelope.setRelease(dynRelease, this.sampleRate);
        band.cachedAttackMs = dynAttack;
        band.cachedReleaseMs = dynRelease;
      }

      // Determine if this band uses dynamic or sidechain processing
      const isDynamic = mode === 1 || shape >= 9; // dynamicBell/Shelf/Tilt
      const isSidechain = mode === 2 && bandSidechain && sidechain;

      if (isDynamic || isSidechain) {
        // Dynamic/sidechain processing
        this.processDynamicBand(
          band,
          channels,
          frameCount,
          freq,
          q,
          dynRange,
          dynThreshold,
          dynRatio,
          dynKnee,
          dynAttack,
          dynRelease,
          isSidechain ? sidechain! : null,
        );
      } else {
        // Static EQ processing (coefficient-smoothed)
        processBiquadSmoothed(band.filter, band.filterSmooth, channels, frameCount);
        if (band.cachedShape === 6) {
          processBiquadSmoothed(band.filter2, band.filter2Smooth, channels, frameCount);
        }
      }

      // Measure band output level
      this.measureBandLevel(band, channels, frameCount, bandIdx);
    }

    // Module-output sanitize: ONE pass after the band chain. The filter
    // cascades stay hot/sanitize-free (their states are guarded once per
    // block by the primitives) — this is the only place the EQ output
    // needs cleaning.
    for (let ch = 0; ch < channels.length; ch++) {
      const data = channels[ch];
      for (let i = 0; i < frameCount; i++) {
        data[i] = sanitizeSample(data[i]);
      }
    }

    // Masking meter
    if (maskingEnabled && sidechain) {
      this.computeMasking(channels, sidechain, frameCount);
    } else {
      this.maskingData = null;
    }
  }

  private updateBandCoefficients(band: EqBandState, freq: number, gainDb: number, q: number, shape: number): void {
    // Set the main filter based on shape
    const sr = this.sampleRate;

    // For dynamic shapes, use the base shape (bell/shelf/tilt) with 0 dB static gain
    const effectiveGain = shape >= 9 ? 0 : gainDb; // Dynamic shapes start at 0 dB
    // Dynamic shapes map to their static base shape — EXCEPT dynamicTilt
    // (11): its process path runs the tilt PAIR (filter + filter2, see
    // processDynamicBand), so it must take the "tilt" design. Mapping it to
    // base "lowShelf" never designed filter2, leaving whatever coefficients
    // a previous shape-6 tilt configuration left behind baked into the band.
    const effectiveShape = shape === 11 ? 6 : shape >= 9 ? shape - 9 : shape; // Map to base shape
    const baseShape = EQ_SHAPES[effectiveShape] ?? "bell";

    switch (baseShape) {
      case "bell":
        setBell(band.filter.coeffs, freq, effectiveGain, q, sr);
        break;
      case "highShelf":
        setHighShelf(band.filter.coeffs, freq, effectiveGain, q, sr);
        break;
      case "lowShelf":
        setLowShelf(band.filter.coeffs, freq, effectiveGain, q, sr);
        break;
      case "highPass":
        setHighPass(band.filter.coeffs, freq, q, sr);
        break;
      case "lowPass":
        setLowPass(band.filter.coeffs, freq, q, sr);
        break;
      case "notch":
        setNotch(band.filter.coeffs, freq, q, sr);
        break;
      case "tilt": {
        const halfGain = effectiveGain * 0.5;
        setLowShelf(band.filter.coeffs, freq, -halfGain, q * 0.7, sr);
        setHighShelf(band.filter2.coeffs, freq, halfGain, q * 0.7, sr);
        band.filter2Smooth.setTarget(band.filter2.coeffs);
        break;
      }
      case "bandPass":
        setBandPass(band.filter.coeffs, freq, q, sr);
        break;
      case "flat":
        // Flat = no filtering
        band.filter.coeffs.b0 = 1;
        band.filter.coeffs.b1 = 0;
        band.filter.coeffs.b2 = 0;
        band.filter.coeffs.a1 = 0;
        band.filter.coeffs.a2 = 0;
        break;
      default:
        setBell(band.filter.coeffs, freq, effectiveGain, q, sr);
    }

    // Glide the active coefficients toward the freshly designed set —
    // stepping them directly is the zipper/click heard during drags.
    band.filterSmooth.setTarget(band.filter.coeffs);

    // Set detector filter (band-pass at the band frequency for level detection)
    // Use a proper band-pass filter (constant 0 dB peak gain) for narrow detection
    setBandPass(band.detector.coeffs, freq, q * 2, sr);

    // Dynamic gain-shaping filter — same center frequency, bandwidth
    // matched to the band's own Q so the cut width follows the UI.
    setBandPass(band.dynFilter.coeffs, freq, q, sr);
    band.dynSmooth.setTarget(band.dynFilter.coeffs);

    // First design of this band: jump straight to the target — the band
    // has been silent, so there is nothing audible to glide from, and
    // an immediate full effect keeps from-scratch runs deterministic.
    // Subsequent (live) changes ramp — that is the zipper fix.
    if (!band.coeffsInit) {
      band.filterSmooth.snap();
      band.filter2Smooth.snap();
      band.dynSmooth.snap();
      band.coeffsInit = true;
    }
  }

  /**
   * Compute compressor gain reduction (dB) using threshold, ratio, and knee.
   *
   * Implements the standard feed-forward compressor gain computer
   * with optional soft knee:
   *
   *   For input level x_db:
   *     - If x_db < threshold - knee/2:  reduction = 0 dB
   *     - If x_db > threshold + knee/2:  reduction = -(x_db - threshold) * (1 - 1/ratio)
   *     - In knee zone: quadratic interpolation
   *
   * The result is clamped to [-dynRangeDb, 0].
   *
   * @returns signed gain in dB (always ≤ 0; negative = attenuation)
   */
  private computeGainReduction(
    inputDb: number,
    thresholdDb: number,
    ratio: number,
    kneeDb: number,
    dynRangeDb: number,
  ): number {
    // Below threshold (no knee) → no reduction
    if (inputDb <= thresholdDb - kneeDb * 0.5) {
      return 0;
    }

    let gainReduction: number;
    const slope = 1 - 1 / ratio; // 0 at ratio=1, →1 at ratio=∞

    if (kneeDb > 0 && inputDb < thresholdDb + kneeDb * 0.5) {
      // Soft knee: quadratic interpolation in the knee zone
      const kneeBottom = thresholdDb - kneeDb * 0.5;
      const x = inputDb - kneeBottom;
      // Quadratic: reduction grows smoothly from 0
      gainReduction = (slope * (x * x)) / (2 * kneeDb);
    } else {
      // Hard knee: above threshold
      gainReduction = slope * (inputDb - thresholdDb);
    }

    // Convert to negative dB (actual gain offset), clamp to max range
    return Math.max(-dynRangeDb, -gainReduction);
  }

  private processDynamicBand(
    band: EqBandState,
    channels: Float32Array[],
    frameCount: number,
    _freq: number,
    _q: number,
    dynRangeDb: number,
    thresholdDb: number,
    ratio: number,
    kneeDb: number,
    attackMs: number,
    releaseMs: number,
    sidechain: Float32Array[] | null,
  ): void {
    // First apply the static portion of the filter (coefficient-smoothed)
    processBiquadSmoothed(band.filter, band.filterSmooth, channels, frameCount);
    if (band.cachedShape === 11) {
      processBiquadSmoothed(band.filter2, band.filter2Smooth, channels, frameCount);
    }

    // Detect level at the band frequency using the detector filter
    // For sidechain mode, detect on the sidechain signal
    const detectSource = sidechain ?? channels;
    const numCh = Math.min(detectSource.length, 2);

    // Compute attack/release smoothing coefficients for gain reduction
    // Using per-sample exponential smoother
    const attackCoef = attackMs > 0 ? 1 - Math.exp(-1 / ((attackMs / 1000) * this.sampleRate)) : 1;
    const releaseCoef = releaseMs > 0 ? 1 - Math.exp(-1 / ((releaseMs / 1000) * this.sampleRate)) : 1;

    // Process detector filter on each channel's data to extract band energy
    for (let ch = 0; ch < numCh; ch++) {
      const src = detectSource[ch];
      const tempBuf = ch === 0 ? this.tempL : this.tempR;
      // Plain copy loop — subarray() allocates a view object per dynamic
      // band per channel per block on the audio thread.
      for (let i = 0; i < frameCount; i++) {
        tempBuf[i] = src[i];
      }

      // Apply detector filter (band-pass at band freq)
      const { b0, b1, b2, a1, a2 } = band.detector.coeffs;
      let z1 = band.detector.z1[ch];
      let z2 = band.detector.z2[ch];
      for (let i = 0; i < frameCount; i++) {
        const x = tempBuf[i];
        const y = b0 * x + z1;
        z1 = b1 * x - a1 * y + z2;
        z2 = b2 * x - a2 * y;
        tempBuf[i] = y;
      }
      band.detector.z1[ch] = z1;
      band.detector.z2[ch] = z2;
      // Non-finite state guard (see processBiquadChannel).
      if (!Number.isFinite(z1) || !Number.isFinite(z2)) {
        band.detector.z1[ch] = 0;
        band.detector.z2[ch] = 0;
      }
    }

    // Stereo-linked detection: use max envelope across channels
    // For each sample, feed the max detector output to the envelope follower
    let gainReduction = band.currentGainDb;

    // Pass 1 (per sample): detection + gain smoothing. The per-sample
    // bandAmount trajectory is stored so attack/release ramps within
    // the block shape the output correctly.
    for (let i = 0; i < frameCount; i++) {
      // Max-detector across channels (stereo link)
      let maxAbs = 0;
      for (let ch = 0; ch < numCh; ch++) {
        const val = Math.abs(ch === 0 ? this.tempL[i] : this.tempR[i]);
        if (val > maxAbs) maxAbs = val;
      }

      // Follow envelope
      const detected = band.envelope.process(maxAbs);
      const detectedDb = 20 * Math.log10(Math.max(1e-10, detected));

      // Compute target gain reduction using compressor gain computer
      const targetReduction = this.computeGainReduction(detectedDb, thresholdDb, ratio, kneeDb, dynRangeDb);

      // Smooth the gain reduction (attack for gain increasing, release
      // for gain decreasing). targetReduction is ≤ 0; when it's more
      // negative than current, we're compressing (attack).
      const coef = targetReduction < gainReduction ? attackCoef : releaseCoef;
      gainReduction += coef * (targetReduction - gainReduction);
      band.currentGainDb = gainReduction;

      this.dynGainBuf[i] = 1 - Math.pow(10, gainReduction / 20);
    }

    // Pass 2 (per channel): apply the reduction BAND-LIMITED to this
    // band's frequency region:
    //   out = x − BP(x)·(1 − g)
    // At the band center the band content is scaled by g; away from the
    // band the band-pass output vanishes and the signal passes through.
    // This is what makes it a dynamic EQ rather than a broadband
    // compressor keyed on band energy.
    const numOutCh = Math.min(channels.length, 2);
    // Sample-outer loop: the dynFilter coefficient interpolation must
    // advance once per sample (both channels share the trajectory).
    for (let i = 0; i < frameCount; i++) {
      const c = band.dynSmooth.tick();
      const bandAmount = this.dynGainBuf[i];
      for (let ch = 0; ch < numOutCh; ch++) {
        const data = channels[ch];
        const x = data[i];
        const bp = c.b0 * x + band.dynFilter.z1[ch];
        band.dynFilter.z1[ch] = c.b1 * x - c.a1 * bp + band.dynFilter.z2[ch];
        band.dynFilter.z2[ch] = c.b2 * x - c.a2 * bp;
        data[i] = sanitizeSample(x - bp * bandAmount);
      }
    }

    // Store gain reduction for meters (positive value = amount of reduction)
    const bandIdx = this.bands.indexOf(band);
    if (bandIdx >= 0) {
      this.bandGainReduction[bandIdx] = -band.currentGainDb;
    }
    // Non-finite state guard for the dynamic band-pass above (its state is
    // written per sample directly into band.dynFilter).
    for (let ch = 0; ch < numOutCh; ch++) {
      if (!Number.isFinite(band.dynFilter.z1[ch]) || !Number.isFinite(band.dynFilter.z2[ch])) {
        band.dynFilter.z1[ch] = 0;
        band.dynFilter.z2[ch] = 0;
      }
    }
  }

  private measureBandLevel(_band: EqBandState, channels: Float32Array[], frameCount: number, bandIdx: number): void {
    // Simple peak measurement on channel 0
    let peak = 0;
    for (let i = 0; i < frameCount; i++) {
      const abs = Math.abs(channels[0][i]);
      if (abs > peak) peak = abs;
    }
    const db = 20 * Math.log10(Math.max(1e-10, peak));
    // Smooth the meter
    this.bandLevels[bandIdx] = this.bandLevels[bandIdx] * 0.9 + db * 0.1;
  }

  private applySoftSat(channels: Float32Array[], frameCount: number, enabled: boolean): void {
    if (!enabled) return;

    for (let ch = 0; ch < channels.length; ch++) {
      const data = channels[ch];
      for (let i = 0; i < frameCount; i++) {
        const x = data[i];
        // Soft saturation: blend dry with tanh
        const saturated = fastTanh(x * 2.0) * 0.5;
        data[i] = sanitizeSample(x * 0.85 + saturated * 0.15);
      }
    }
  }

  private computeMasking(channels: Float32Array[], sidechain: Float32Array[], frameCount: number): void {
    const result = this.maskingMeter.analyze(channels[0], sidechain[0] ?? channels[0], frameCount);
    this.maskingData = result.levels;
  }
}
