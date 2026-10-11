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

import { ResonatorBank } from "./resonator";
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

  private readonly params: SpectralParams = { ...DEFAULT_SPECTRAL_PARAMS };

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
  }

  /**
   * (Re)build the engines for a context. Safe to call again when the sample
   * rate changes — the whole state is rebuilt, so there is nothing to migrate.
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

    const mixK = blockSmoothingCoefficient(n, SMOOTHING_TC, this.sampleRate);
    this.mixSmooth += (clamp01(this.params.mix) - this.mixSmooth) * mixK;
    this.toneSmooth += (this.params.tone - this.toneSmooth) * mixK;
    this.driveSmooth += (clamp01(this.params.drive) - this.driveSmooth) * mixK;

    // Fully closed = pure passthrough. A delay effect that is shut should also
    // cost nothing — checklist §1 is the phaser that shipped with a silent wet
    // chain because the bypass path was never exercised.
    if (this.mixSmooth <= 1e-4) {
      outL.set(left.subarray(0, n));
      outR.set(right.subarray(0, n));
      return;
    }

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
      const l = left[i];
      const r = right[i];

      const wetM = this.toneAndDrive(wetMid[i], drive, tone, lpCoef, hpCoef, true);
      const wetS = this.toneAndDrive(wetSide[i], drive, tone, lpCoef, hpCoef, false);

      const dryM = (l + r) * 0.5;
      const dryS = (l - r) * 0.5;
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
      const next = (isMid ? this.lpStateMid : this.lpStateSide) + (v - (isMid ? this.lpStateMid : this.lpStateSide)) * c;
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
    const focus = this.params.focus;
    const focusWidth = this.params.focusWidth;

    if (mode === SPECTRAL_MODE_RESONATOR) {
      // The resonator IS the effect here: the delay ring still receives the
      // spectrum so switching back to DELAY mid-flight has a tail to work with,
      // but its feedback is closed so it cannot colour the resonant output.
      delay.process(re, im, binCount, this.delayParams(0, false), this.sampleRate, this.engineMid.hop);
      reso.process(re, im, binCount, { resonance, focusHz: focus, focusWidthOct: focusWidth }, 1);
      clampBinMagnitude(re, im, binCount);
      return;
    }

    const freeze = mode === SPECTRAL_MODE_FREEZE ? true : this.params.freeze >= 0.5;
    delay.process(re, im, binCount, this.delayParams(this.effectiveDelaySeconds(), freeze), this.sampleRate, this.engineMid.hop);

    if (mode === SPECTRAL_MODE_FREEZE) {
      // A held frame alone is a static noise bed; the resonator's ringing is
      // what makes it sound alive once the input stops feeding it.
      reso.process(re, im, binCount, { resonance: resonance * 0.7, focusHz: focus, focusWidthOct: focusWidth }, 0.6);
    }
    clampBinMagnitude(re, im, binCount);
  }

  /** Build the delay-bank parameter frame from the live controls. */
  private delayParams(delaySec: number, frozen: boolean): SpectralDelayParams {
    return {
      timeSec: delaySec,
      feedback: frozen ? clamp01(this.params.feedback) * 0.85 : clamp01(this.params.feedback),
      decay: clamp01(this.params.decay),
      shiftSemitones: clampRange(this.params.shift, -24, 24),
      diffuse: clamp01(this.params.diffuse),
      freeze: frozen ? 1 : 0,
      seed: 0,
    };
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
