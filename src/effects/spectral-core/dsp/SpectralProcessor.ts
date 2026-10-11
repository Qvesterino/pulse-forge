/**
 * PORTAL — spectral delay / resonator processor.
 *
 * Stereo runs as two independent STFT paths: MID (L+R) and SIDE (L−R). The delay
 * length in SIDE is what makes the repeats open up in width instead of staying
 * glued in the centre, which is why a stereo spectral delay is not the mono one
 * played twice.
 *
 * MODES (one effect, three paths — ADR 0038, D3)
 *   DELAY      per-bin delay with feedback — the classic spectral delay
 *   RESONATOR  per-bin complex one-pole ringing around a focus band
 *   FREEZE     the analysed frame is held; only the delay feedback decays it
 *
 * SAFETY (ADR 0038, D5)
 *   The delay feedback is clamped contractive, per-bin magnitudes are clamped,
 *   and every frame is swept for non-finite values before it is resynthesised.
 *   A user who loses the audio graph has to reload the page, so the guards run
 *   even on the paths that cannot currently fail.
 *
 * Allocation-free after `prepare()`: every buffer is sized from `sampleRate` and
 * reused for the processor's whole life.
 */

import { ResonatorBank, type ResonatorParams } from "./resonator";
import { SpectralDelayBank, type SpectralDelayParams } from "./spectralDelay";
import { MAX_BLOCK, StftEngine, blockSmoothingCoefficient, clampBinMagnitude } from "./stft";

export const SPECTRAL_MODE_DELAY = 0;
export const SPECTRAL_MODE_RESONATOR = 1;
export const SPECTRAL_MODE_FREEZE = 2;

/** Default FFT size: 1024 bins the spectrum at ~21.5 Hz @ 44.1 kHz — fine enough
 *  to keep partials apart without an FFT the realtime thread cannot afford. */
export const DEFAULT_FFT_SIZE = 1024;

/** Parameters as stored on the effect instance. All fields optional on load. */
export interface SpectralParams {
  mode: number;
  time: number;
  sync: number;
  feedback: number;
  decay: number;
  resonance: number;
  focus: number;
  focusWidth: number;
  shift: number;
  diffuse: number;
  freeze: number;
  drive: number;
  tone: number;
  mix: number;
}

export const DEFAULT_SPECTRAL_PARAMS: SpectralParams = {
  mode: SPECTRAL_MODE_DELAY,
  time: 320,
  sync: 0,
  feedback: 0.55,
  decay: 0.5,
  resonance: 0.35,
  focus: 1200,
  focusWidth: 1,
  shift: 0,
  diffuse: 0.3,
  freeze: 0,
  drive: 0,
  tone: 0,
  mix: 0.35,
};

/** Tempo-sync divisions, matching the kaskada `SYNC_RATIO` contract:
 *  off, 1/4, 1/8, 1/8T, 1/16, 1/16T. A synced delay is the BEAT length times
 *  the division, not the manual time scaled by it — so SYNC actually lands on
 *  the grid instead of near it. */
const SYNC_RATIOS = [0, 1, 0.5, 1 / 3, 0.25, 1 / 6] as const;

/** Tone is a dB tilt; one-pole shelf corners at each end. */
const TONE_LP_HZ = 4000;
const TONE_HP_HZ = 200;

/** Smoothing time constant for MIX / TONE / DRIVE, in seconds. */
const SMOOTHING_TC = 0.02;

export interface SpectralMeters {
  /** Peak wet magnitude observed in the analysed spectrum this frame. */
  peak: number;
  /** Fraction of bins carrying energy. */
  activity: number;
  /** Delay length currently engaged, in seconds. */
  delaySec: number;
  /** Frames pushed through the engine — the soak harness reads this. */
  frames: number;
}

export class SpectralProcessor {
  private sampleRate = 44100;
  private fftSize = DEFAULT_FFT_SIZE;
  private ready = false;

  private engineMid: StftEngine;
  private engineSide: StftEngine;
  private delayMid: SpectralDelayBank;
  private delaySide: SpectralDelayBank;
  private resoMid: ResonatorBank;
  private resoSide: ResonatorBank;

  /** Per-path sample-domain scratch, allocated once and reused every block. */
  private readonly scratchMid: Float32Array;
  private readonly scratchSide: Float32Array;
  private dryDelayL = new Float32Array(0);
  private dryDelayR = new Float32Array(0);
  private dryDelayMask = 0;
  private dryWrite = 0;
  private readonly dryScratchL = new Float32Array(MAX_BLOCK);
  private readonly dryScratchR = new Float32Array(MAX_BLOCK);

  private readonly params: SpectralParams = { ...DEFAULT_SPECTRAL_PARAMS };

  /** Pre-allocated delay parameter frame — see `delayParams`. */
  private readonly delayScratch: SpectralDelayParams = {
    timeSec: 0.2,
    feedback: 0,
    decay: 0.5,
    shiftSemitones: 0,
    diffuse: 0,
    freeze: 0,
  };

  /** Pre-allocated resonator parameter frame — mutated per frame, never rebuilt. */
  private readonly resoScratch: ResonatorParams = {
    resonance: 0,
    focusHz: 1200,
    focusWidthOct: 1,
  };

  private syncBpm = 120;

  // Smoothed controls so a slider sweep never steps the output.
  private mixSmooth = DEFAULT_SPECTRAL_PARAMS.mix;
  private toneSmooth = DEFAULT_SPECTRAL_PARAMS.tone;
  private driveSmooth = DEFAULT_SPECTRAL_PARAMS.drive;

  // Tone filter state, one pair per path.
  private lpStateMid = 0;
  private hpStateMid = 0;
  private lpStateSide = 0;
  private hpStateSide = 0;

  private readonly meters: SpectralMeters = { peak: 0, activity: 0, delaySec: 0, frames: 0 };

  constructor() {
    this.engineMid = new StftEngine(44100, { fftSize: DEFAULT_FFT_SIZE });
    this.engineSide = new StftEngine(44100, { fftSize: DEFAULT_FFT_SIZE });
    this.delayMid = new SpectralDelayBank(this.engineMid.binCount, 44100, this.engineMid.hop);
    this.delaySide = new SpectralDelayBank(this.engineSide.binCount, 44100, this.engineSide.hop);
    this.resoMid = new ResonatorBank(this.engineMid.binCount, 44100);
    this.resoSide = new ResonatorBank(this.engineSide.binCount, 44100);
    this.scratchMid = new Float32Array(MAX_BLOCK);
    this.scratchSide = new Float32Array(MAX_BLOCK);
    this.installFrameCallbacks();
    this.allocateDryDelay();
  }

  /**
   * (Re)build the engines for a context. Safe to call again when the sample
   * rate changes — the whole state is rebuilt, so there is nothing to migrate.
   *
   * CALL THIS AFTER `setParams` on the first run. `reset()` seeds the smoothed
   * MIX from the current parameter value, so an effect that boots with MIX
   * already at 1 starts wet from sample 0 instead of ramping up through 20 ms of
   * audible dry. Nothing breaks if the order is wrong — the smoothing still
   * converges — but the effect audibly fades in on every context load.
   */
  prepare(sampleRate: number, fftSize: number = DEFAULT_FFT_SIZE): void {
    this.sampleRate = sampleRate;
    this.fftSize = fftSize;
    this.engineMid = new StftEngine(sampleRate, { fftSize });
    this.engineSide = new StftEngine(sampleRate, { fftSize });
    const bins = this.engineMid.binCount;
    this.delayMid = new SpectralDelayBank(bins, sampleRate, this.engineMid.hop);
    this.delaySide = new SpectralDelayBank(bins, sampleRate, this.engineSide.hop);
    this.resoMid = new ResonatorBank(bins, sampleRate);
    this.resoSide = new ResonatorBank(bins, sampleRate);
    this.installFrameCallbacks();
    this.allocateDryDelay();
    this.reset();
  }

  /** Steady algorithm latency in seconds — reported, never hidden (ADR 0038). */
  latencySeconds(): number {
    return this.engineMid.latencySeconds();
  }

  latencySamples(): number {
    return this.engineMid.latencySamples();
  }

  getMeters(): SpectralMeters {
    return { ...this.meters };
  }

  /** Ring allocation — the soak harness asserts this never changes. */
  ringFrames(): number {
    return this.delayMid.ringFrames;
  }

  /**
   * Overlap-add normaliser diagnostic from the MID path. For Hann windows at
   * 75 % overlap this settles around 1.5 (the squared-Hann sum) and must never
   * sit far below 1 — a value there is the signature of a normaliser being reset
   * mid-flight, which divides the output by window power it never accumulated.
   */
  stftNormPeak(): number {
    return this.engineMid.normStats.normPeak;
  }

  get fftSizeUsed(): number {
    return this.fftSize;
  }

  reset(): void {
    this.engineMid.reset();
    this.engineSide.reset();
    this.delayMid.reset();
    this.delaySide.reset();
    this.resoMid.reset();
    this.resoSide.reset();
    this.dryDelayL.fill(0);
    this.dryDelayR.fill(0);
    this.dryScratchL.fill(0);
    this.dryScratchR.fill(0);
    this.dryWrite = 0;
    this.mixSmooth = clamp01(this.params.mix);
    this.toneSmooth = this.params.tone;
    this.driveSmooth = clamp01(this.params.drive);
    this.lpStateMid = 0;
    this.hpStateMid = 0;
    this.lpStateSide = 0;
    this.hpStateSide = 0;
    this.meters.peak = 0;
    this.meters.activity = 0;
    this.meters.delaySec = 0;
    this.meters.frames = 0;
    this.ready = true;
  }

  /** Apply a full parameter frame. Non-finite values are ignored, not fatal. */
  setParams(next: Partial<SpectralParams>): void {
    const target = this.params as unknown as Record<string, number>;
    for (const [k, v] of Object.entries(next)) {
      if (typeof v === "number" && Number.isFinite(v)) target[k] = v;
    }
  }

  /** Tempo change — re-derives a synced delay time on the next block. */
  setBpm(bpm: number, _when?: number): void {
    if (Number.isFinite(bpm) && bpm > 0) this.syncBpm = bpm;
  }

  /**
   * Process one stereo block. `blockLen` must not exceed `MAX_BLOCK`.
   */
  process(left: Float32Array, right: Float32Array, outL: Float32Array, outR: Float32Array, blockLen: number): void {
    if (!this.ready || blockLen <= 0) return;
    const n = Math.min(blockLen, MAX_BLOCK);
    this.delayDry(left, right, n);

    const mixK = blockSmoothingCoefficient(n, SMOOTHING_TC, this.sampleRate);
    const mixTarget = clamp01(this.params.mix);
    this.toneSmooth += (this.params.tone - this.toneSmooth) * mixK;
    this.driveSmooth += (clamp01(this.params.drive) - this.driveSmooth) * mixK;

    // Fully closed = pure passthrough, decided on the TARGET mix rather than
    // the smoothed one: a knob dragged to zero must bypass immediately and
    // bit-exactly, not ring out over the smoothing time. Smoothing governs how
    // the control ENTERS the effect, never how it leaves it.
    //
    // This is also checklist §1 — the phaser shipped with a silent wet chain
    // because its bypass path was never exercised. Here it additionally has to
    // be bit-exact, so the test can pin it to the sample.
    if (mixTarget <= 1e-4) {
      this.mixSmooth = 0;
      outL.set(this.dryScratchL.subarray(0, n));
      outR.set(this.dryScratchR.subarray(0, n));
      return;
    }
    this.mixSmooth += (mixTarget - this.mixSmooth) * mixK;

    for (let i = 0; i < n; i++) {
      const l = left[i];
      const r = right[i];
      this.scratchMid[i] = (l + r) * 0.5;
      this.scratchSide[i] = (l - r) * 0.5;
    }

    const n2 = this.effectiveDelaySeconds();
    this.engineMid.processBlock(this.scratchMid, n, this.scratchMid);
    this.engineSide.processBlock(this.scratchSide, n, this.scratchSide);

    const wetMid = this.scratchMid;
    const wetSide = this.scratchSide;

    const mix = this.mixSmooth;
    const lpCoef = toneCoef(TONE_LP_HZ, n, this.sampleRate);
    const hpCoef = toneCoef(TONE_HP_HZ, n, this.sampleRate);
    const drive = this.driveSmooth;
    const tone = this.toneSmooth;

    for (let i = 0; i < n; i++) {
      const wetM = this.toneAndDrive(wetMid[i], drive, tone, lpCoef, hpCoef, true);
      const wetS = this.toneAndDrive(wetSide[i], drive, tone, lpCoef, hpCoef, false);

      const dryL = this.dryScratchL[i]!;
      const dryR = this.dryScratchR[i]!;
      const dryM = (dryL + dryR) * 0.5;
      const dryS = (dryL - dryR) * 0.5;
      const mid = dryM * (1 - mix) + wetM * mix;
      const side = dryS * (1 - mix) + wetS * mix;

      outL[i] = mid + side;
      outR[i] = mid - side;
    }

    const dm = this.delayMid.getMeters();
    this.meters.peak = dm.peak;
    this.meters.activity = dm.activity;
    this.meters.delaySec = n2;
    this.meters.frames = this.engineMid.frameCount;
  }

  /** Allocate the source path used to line up dry with the streaming STFT. */
  private allocateDryDelay(): void {
    const latency = this.engineMid.latencySamples();
    let ringLength = 1;
    while (ringLength <= latency) ringLength <<= 1;
    this.dryDelayL = new Float32Array(ringLength);
    this.dryDelayR = new Float32Array(ringLength);
    this.dryDelayMask = ringLength - 1;
    this.dryWrite = 0;
  }

  /** Push the source into a fixed ring and read the sample aligned to the wet path. */
  private delayDry(left: Float32Array, right: Float32Array, frames: number): void {
    const latency = this.engineMid.latencySamples();
    const mask = this.dryDelayMask;
    for (let i = 0; i < frames; i++) {
      const write = this.dryWrite & mask;
      this.dryDelayL[write] = left[i]!;
      this.dryDelayR[write] = right[i]!;
      const read = (this.dryWrite - latency) & mask;
      this.dryScratchL[i] = this.dryDelayL[read]!;
      this.dryScratchR[i] = this.dryDelayR[read]!;
      this.dryWrite++;
    }
  }

  /** Resolve MODE to one of the three paths, defaulting defensively. */
  private currentMode(): number {
    const m = this.params.mode;
    if (!Number.isFinite(m)) return SPECTRAL_MODE_DELAY;
    const r = Math.round(m);
    return r < 0 || r > 2 ? SPECTRAL_MODE_DELAY : r;
  }

  /**
   * Resolve TIME against SYNC. With SYNC off the manual time is used as-is; with
   * a division selected the delay becomes exactly one beat times that division,
   * so it lands on the grid instead of near it.
   */
  private effectiveDelaySeconds(): number {
    const syncIndex = this.params.sync | 0;
    const ratio = SYNC_RATIOS[syncIndex] ?? 0;
    if (ratio > 0) {
      const beatSec = 60 / Math.max(1, this.syncBpm);
      return clampRange(beatSec * ratio, 0.02, 2);
    }
    return clampRange(this.params.time / 1000, 0.02, 2);
  }

  /** Drive + tone on one path, in the sample domain after resynthesis. */
  private toneAndDrive(
    x: number,
    drive: number,
    toneDb: number,
    lpCoef: number,
    hpCoef: number,
    isMid: boolean,
  ): number {
    let v = x;
    if (drive > 1e-4) {
      const k = 1 + drive * 8;
      v = Math.tanh(v * k) / k;
    }
    if (toneDb < -1e-3) {
      const c = lpCoef * Math.min(1, -toneDb / 24);
      const next =
        (isMid ? this.lpStateMid : this.lpStateSide) + (v - (isMid ? this.lpStateMid : this.lpStateSide)) * c;
      if (isMid) this.lpStateMid = next;
      else this.lpStateSide = next;
      v = next;
    } else if (toneDb > 1e-3) {
      const c = hpCoef * Math.min(1, toneDb / 24);
      const state = isMid ? this.hpStateMid : this.hpStateSide;
      const next = state + (v - state) * c;
      if (isMid) this.hpStateMid = next;
      else this.hpStateSide = next;
      v = v - next;
    }
    return Number.isFinite(v) ? v : 0;
  }

  /**
   * Install the per-frame spectral callbacks once. They read the live
   * parameters at frame time, so a knob change needs no re-installation.
   */
  private installFrameCallbacks(): void {
    this.engineMid.onFrame((re, im, binCount) => this.processFrame(re, im, binCount, this.delayMid, this.resoMid));
    this.engineSide.onFrame((re, im, binCount) => this.processFrame(re, im, binCount, this.delaySide, this.resoSide));
  }

  /** One spectral frame: mode dispatch, then the shared magnitude ceiling. */
  private processFrame(
    re: Float64Array,
    im: Float64Array,
    binCount: number,
    delay: SpectralDelayBank,
    reso: ResonatorBank,
  ): void {
    const mode = this.currentMode();
    const resonance = clamp01(this.params.resonance);
    const rp = this.resoScratch;
    rp.resonance = resonance;
    rp.focusHz = this.params.focus;
    rp.focusWidthOct = this.params.focusWidth;

    if (mode === SPECTRAL_MODE_RESONATOR) {
      // The resonator IS the effect here: the delay ring still receives the
      // fresh spectrum, but its delayed read must never become an extra hidden
      // hop of latency or contaminate the resonator mode with DELAY's SHIFT.
      delay.process(re, im, binCount, this.delayParams(0, false), this.sampleRate, this.engineMid.hop, true);
      reso.process(re, im, binCount, rp, 1);
      clampBinMagnitude(re, im, binCount);
      return;
    }

    const freeze = mode === SPECTRAL_MODE_FREEZE ? true : this.params.freeze >= 0.5;
    delay.process(
      re,
      im,
      binCount,
      this.delayParams(this.effectiveDelaySeconds(), freeze),
      this.sampleRate,
      this.engineMid.hop,
    );

    if (mode === SPECTRAL_MODE_FREEZE) {
      // A held frame alone is a static noise bed; the resonator's ringing is
      // what makes it sound alive once the input stops feeding it.
      rp.resonance = resonance * 0.7;
      reso.process(re, im, binCount, rp, 0.6);
    }
    clampBinMagnitude(re, im, binCount);
  }

  /**
   * Build the delay-bank parameter frame from the live controls.
   *
   * Returns a PRE-ALLOCATED object, mutated in place: this runs once per frame
   * per path (344 times a second each at 44.1 kHz), and handing the bank a fresh
   * literal would be an allocation on the audio thread — exactly the per-block
   * churn the soak's heap assertion exists to catch.
   */
  private delayParams(delaySec: number, frozen: boolean): SpectralDelayParams {
    const p = this.delayScratch;
    p.timeSec = delaySec;
    p.feedback = clamp01(this.params.feedback) * (frozen ? 0.85 : 1);
    p.decay = clamp01(this.params.decay);
    p.shiftSemitones = clampRange(this.params.shift, -24, 24);
    p.diffuse = clamp01(this.params.diffuse);
    p.freeze = frozen ? 1 : 0;
    return p;
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampRange(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/** One-pole smoothing coefficient for a corner frequency, applied per block. */
function toneCoef(cutoffHz: number, blockLen: number, sampleRate: number): number {
  if (!(cutoffHz > 0)) return 1;
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return blockSmoothingCoefficient(blockLen, tau, sampleRate);
}
