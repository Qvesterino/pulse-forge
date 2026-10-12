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
import { syncedLfoHz } from "../../tempo-sync";

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
  /** Free-running LFO rate in Hz. Only used when `sync` is OFF. */
  motionRate: number;
  /** How far the LFO may pull TIME and FEEDBACK. 0 = motionless. */
  motionDepth: number;
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
  // MOTION ships DISABLED. A new control must not change the sound of a project
  // that never touched it, so the default depth is 0 and every render with an
  // untouched instance is bit-identical to the pre-motion build.
  motionRate: 0.6,
  motionDepth: 0,
};

/** Tempo-sync divisions, matching the kaskada `SYNC_RATIO` contract:
 *  off, 1/4, 1/8, 1/8T, 1/16, 1/16T. A synced delay is the BEAT length times
 *  the division, not the manual time scaled by it — so SYNC actually lands on
 *  the grid instead of near it. */
const SYNC_RATIOS = [0, 1, 0.5, 1 / 3, 0.25, 1 / 6] as const;

const TWO_PI = Math.PI * 2;

/**
 * MOTION — one sine LFO, two destinations.
 *
 * TIME takes the full swing and FEEDBACK a smaller one, so the delay reads as
 * a moving object rather than as a loudness effect. Both are MULTIPLICATIVE:
 * a percentage of the user's own setting, not an absolute offset, so the motion
 * stays proportional wherever the knob sits.
 *
 * TIME moves in OCTAVES, not milliseconds, which is what makes the warp musical
 * at both ends of a 20..2000 ms range. An additive ±40 ms is a huge sweep at
 * 40 ms and inaudible at 2 s; ±0.2 octaves is ±15 % everywhere, which is 6 ms of
 * flutter at the short end and 300 ms of drift at the long end.
 *
 * The magnitudes here are a design judgement, so they are measured rather than
 * asserted: `tests/spectral-motion.test.ts` renders a 2 s sweep and requires the
 * warp to be audible at DEPTH 1 and silent at DEPTH 0.
 */
const MOTION_TIME_OCTAVES = 0.2;
const MOTION_FEEDBACK_AMOUNT = 0.25;

/** Tone is a dB tilt; one-pole shelf corners at each end. */
const TONE_LP_HZ = 4000;
const TONE_HP_HZ = 200;

/** Smoothing time constant for continuous controls, in seconds. */
const SMOOTHING_TC = 0.02;
/** Shift moves across FFT bins; spread automation changes across several spectral frames. */
const SHIFT_SMOOTHING_TC = 0.03;
/** Mix-to-dry de-click window; the wet DSP is reset once this short fade completes. */
const MIX_CLOSE_SECONDS = 0.005;
const MIX_BYPASS_THRESHOLD = 1e-4;

/**
 * Log-spaced band resolution for the panel spectrum. 64 bands across the
 * display range is the most a 2 px-tall-per-pixel canvas can show anyway;
 * more would cost messages, not detail.
 */
export const SPECTRAL_BANDS = 64;

/** Display floor. 0 dBFS at 255, -84 dB at 0 — below this a band reads silent. */
const BAND_DB_FLOOR = -84;

/** First displayed frequency. The FOCUS minimum, so no control sits off-axis. */
const BAND_MIN_HZ = 20;
/** Preserve 18 dB of float headroom while containing corrupted extreme samples. */
const MAX_INPUT_SAMPLE = 8;

function sanitizeInputSample(sample: number): number {
  if (sample >= -MAX_INPUT_SAMPLE && sample <= MAX_INPUT_SAMPLE) return sample;
  if (!Number.isFinite(sample)) return 0;
  return sample < 0 ? -MAX_INPUT_SAMPLE : MAX_INPUT_SAMPLE;
}

export interface SpectralMeters {
  /** Sample rate used to build the log-spaced bands; the UI uses it for its axis. */
  sampleRate: number;
  /** Peak wet magnitude observed in the analysed spectrum this frame. */
  peak: number;
  /** Fraction of bins carrying energy. */
  activity: number;
  /** Delay length currently engaged, in seconds. */
  delaySec: number;
  /** Frames pushed through the engine — the soak harness reads this. */
  frames: number;
  /** Effective, smoothed spectral shift in semitones. */
  shiftSemitones: number;
  /**
   * Log-spaced magnitudes of the spectrum AS ANALYSED, 0..255. This is the
   * panel's reference trace: what arrived at the device this frame.
   */
  bandsIn: Uint8Array;
  /**
   * Log-spaced magnitudes of the spectrum AFTER the mode ran, 0..255. The
   * panel draws this over `bandsIn`, so the gap between them IS the effect —
   * the feedback tail, the resonance swell, the frozen bed.
   *
   * Both are computed from the processor's own bins. A panel that re-derived
   * either one host-side would draw a spectrum the audio is not producing.
   */
  bandsOut: Uint8Array;
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
  private mixCloseStart = 0;
  private mixCloseTotalSamples = 0;
  private mixCloseRemainingSamples = 0;
  private wetStateCleared = true;
  private toneSmooth = DEFAULT_SPECTRAL_PARAMS.tone;
  private driveSmooth = DEFAULT_SPECTRAL_PARAMS.drive;
  private shiftSmooth = DEFAULT_SPECTRAL_PARAMS.shift;
  private timeSmooth = DEFAULT_SPECTRAL_PARAMS.time;
  private feedbackSmooth = DEFAULT_SPECTRAL_PARAMS.feedback;
  private decaySmooth = DEFAULT_SPECTRAL_PARAMS.decay;
  private resonanceSmooth = DEFAULT_SPECTRAL_PARAMS.resonance;
  private focusSmooth = DEFAULT_SPECTRAL_PARAMS.focus;
  private focusWidthSmooth = DEFAULT_SPECTRAL_PARAMS.focusWidth;
  private diffuseSmooth = DEFAULT_SPECTRAL_PARAMS.diffuse;

  /**
   * MOTION state.
   *
   * The phase advances once per BLOCK, keyed to the samples actually rendered,
   * not per STFT frame. That matters for a reason that is easy to get wrong:
   * `delayParams()` is called once for MID and once for SIDE per frame, so an
   * accumulator advanced inside it would run at double speed and — worse — the
   * two paths could read different values and pull the stereo image apart. One
   * value per block makes both paths read the same number by construction.
   *
   * 375 Hz of update against a 0.05–8 Hz LFO is a staircase nobody can hear.
   */
  private motionRateSmooth = DEFAULT_SPECTRAL_PARAMS.motionRate;
  private motionDepthSmooth = DEFAULT_SPECTRAL_PARAMS.motionDepth;
  private motionPhase = 0;
  /** Sine output, -1..1. Read by both paths; never recomputed per path. */
  private motionValue = 0;
  /** Multipliers derived from motionValue, computed once per block. */
  private motionTimeScale = 1;
  private motionFeedbackScale = 1;

  // Tone filter state, one pair per path.
  private lpStateMid = 0;
  private hpStateMid = 0;
  private lpStateSide = 0;
  private hpStateSide = 0;

  private readonly meters: SpectralMeters = {
    sampleRate: 44100,
    peak: 0,
    activity: 0,
    delaySec: 0,
    frames: 0,
    shiftSemitones: 0,
    bandsIn: new Uint8Array(SPECTRAL_BANDS),
    bandsOut: new Uint8Array(SPECTRAL_BANDS),
  };

  /** First bin of each band, plus a terminating edge. Built once in prepare(). */
  private readonly bandStart = new Int32Array(SPECTRAL_BANDS + 1);

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
    this.meters.sampleRate = sampleRate;
    this.engineMid = new StftEngine(sampleRate, { fftSize });
    this.engineSide = new StftEngine(sampleRate, { fftSize });
    const bins = this.engineMid.binCount;
    this.delayMid = new SpectralDelayBank(bins, sampleRate, this.engineMid.hop);
    this.delaySide = new SpectralDelayBank(bins, sampleRate, this.engineSide.hop);
    this.resoMid = new ResonatorBank(bins, sampleRate);
    this.resoSide = new ResonatorBank(bins, sampleRate);
    this.buildBandEdges(bins);
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

  /**
   * Map the display range onto FFT bins, once per context.
   *
   * Log-spaced, because that is how the panel draws it and how ears judge
   * spectra. The top band stops at the last real bin — Nyquist itself carries
   * no energy for a real signal, so letting a band own only bin `binCount-1`
   * would paint a permanently empty column on the right edge.
   */
  private buildBandEdges(bins: number): void {
    // Two different quantities, and conflating them silently collapses the
    // whole trace: Nyquist is the top FREQUENCY (24 kHz at 48 k), while
    // `binWidth` is how many Hz one FFT bin covers (46.9 Hz here). Using the
    // bin width as the top frequency mapped every band under 47 Hz and left the
    // entire first 63 bands reading bin 1.
    const nyquist = this.sampleRate * 0.5;
    const binWidth = nyquist / Math.max(1, bins - 1);
    const span = nyquist / BAND_MIN_HZ;
    for (let b = 0; b <= SPECTRAL_BANDS; b++) {
      const hz = BAND_MIN_HZ * Math.pow(span, b / SPECTRAL_BANDS);
      const bin = Math.round(hz / binWidth);
      // Bin 0 is the DC bin; a band starting there would show a permanent
      // offset from any DC blocker. Bins are also forced monotonic, because a
      // narrow high band can round to the same bin as its neighbour.
      const clamped = Math.max(1, Math.min(bins - 1, bin));
      this.bandStart[b] = b === 0 ? clamped : Math.max(clamped, this.bandStart[b - 1]!);
    }
    this.bandStart[SPECTRAL_BANDS] = bins - 1;
  }

  /**
   * Collapse the current bins into `out`. Energy mean, not peak: a single hot
   * bin would make a narrow resonance look like broadband noise, and the whole
   * point of the trace is to show which band is actually ringing.
   */
  private reduceBands(re: Float64Array, im: Float64Array, out: Uint8Array): void {
    const start = this.bandStart;
    for (let b = 0; b < SPECTRAL_BANDS; b++) {
      const from = start[b]!;
      const to = Math.max(start[b + 1]!, from + 1);
      let sum = 0;
      for (let k = from; k < to; k++) {
        const r = re[k]!;
        const m = im[k]!;
        sum += r * r + m * m;
      }
      const mean = Math.sqrt(sum / (to - from));
      // The FFT is UNNORMALISED: a 0.5-amplitude sine lands at ~N/4 in its bin,
      // which is 1024/4 = 256 — 48 dB above the 0 dBFS this window assumes and
      // enough to clamp every loud band to 255. Dividing by `fftSize` puts the
      // trace back on a 0 dBFS scale, so FOCUS depth and drive actually read.
      const amplitude = mean / this.fftSize;
      // dB, then a fixed 0..255 window. A per-frame normalising meter would
      // always look full and never compare between two frames.
      const db = 20 * Math.log10(amplitude > 1e-12 ? amplitude : 1e-12);
      const norm = (db - BAND_DB_FLOOR) / -BAND_DB_FLOOR;
      out[b] = Number.isFinite(norm) ? Math.max(0, Math.min(255, Math.round(norm * 255))) : 0;
    }
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
    this.mixCloseStart = 0;
    this.mixCloseTotalSamples = 0;
    this.mixCloseRemainingSamples = 0;
    this.wetStateCleared = true;
    this.toneSmooth = this.params.tone;
    this.driveSmooth = clamp01(this.params.drive);
    this.shiftSmooth = clampRange(this.params.shift, -24, 24);
    this.timeSmooth = clampRange(this.params.time, 20, 2000);
    this.feedbackSmooth = clamp01(this.params.feedback);
    this.decaySmooth = clamp01(this.params.decay);
    this.resonanceSmooth = clamp01(this.params.resonance);
    this.focusSmooth = clampRange(this.params.focus, 20, 18000);
    this.focusWidthSmooth = clampRange(this.params.focusWidth, 0.1, 4);
    this.diffuseSmooth = clamp01(this.params.diffuse);
    // Phase 0 means sin(0) = 0, so a freshly prepared instance starts exactly at
    // the user's TIME and FEEDBACK and drifts away from it. Seeding any other
    // phase would make the very first block jump to a delay the user never asked
    // for — the audible equivalent of a preset that lands on the wrong value.
    this.motionRateSmooth = clampRange(this.params.motionRate, 0.05, 8);
    this.motionDepthSmooth = clamp01(this.params.motionDepth);
    this.motionPhase = 0;
    this.motionValue = 0;
    this.motionTimeScale = 1;
    this.motionFeedbackScale = 1;
    this.lpStateMid = 0;
    this.hpStateMid = 0;
    this.lpStateSide = 0;
    this.hpStateSide = 0;
    this.meters.peak = 0;
    this.meters.activity = 0;
    this.meters.delaySec = 0;
    this.meters.frames = 0;
    this.meters.shiftSemitones = this.shiftSmooth;
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
    const mixTarget = clamp01(this.params.mix);
    const closingMix = mixTarget <= MIX_BYPASS_THRESHOLD;
    if (!closingMix) {
      this.mixCloseStart = 0;
      this.mixCloseTotalSamples = 0;
      this.mixCloseRemainingSamples = 0;
    } else if (this.mixCloseRemainingSamples === 0 && this.mixSmooth > MIX_BYPASS_THRESHOLD) {
      this.mixCloseStart = this.mixSmooth;
      this.mixCloseTotalSamples = Math.max(1, Math.round(this.sampleRate * MIX_CLOSE_SECONDS));
      this.mixCloseRemainingSamples = this.mixCloseTotalSamples;
    }
    const wetPathActive = !closingMix || this.mixCloseRemainingSamples > 0;
    this.captureInputBlock(left, right, n, wetPathActive);

    const mixK = blockSmoothingCoefficient(n, SMOOTHING_TC, this.sampleRate);
    this.toneSmooth += (this.params.tone - this.toneSmooth) * mixK;
    this.driveSmooth += (clamp01(this.params.drive) - this.driveSmooth) * mixK;
    const shiftTarget = clampRange(this.params.shift, -24, 24);
    const shiftK = blockSmoothingCoefficient(n, SHIFT_SMOOTHING_TC, this.sampleRate);
    this.shiftSmooth += (shiftTarget - this.shiftSmooth) * shiftK;
    this.timeSmooth = smoothLog(this.timeSmooth, this.params.time, mixK, 20, 2000);
    this.feedbackSmooth += (clamp01(this.params.feedback) - this.feedbackSmooth) * mixK;
    this.decaySmooth += (clamp01(this.params.decay) - this.decaySmooth) * mixK;
    this.resonanceSmooth += (clamp01(this.params.resonance) - this.resonanceSmooth) * mixK;
    this.focusSmooth = smoothLog(this.focusSmooth, this.params.focus, mixK, 20, 18000);
    this.focusWidthSmooth = smoothLog(this.focusWidthSmooth, this.params.focusWidth, mixK, 0.1, 4);
    this.diffuseSmooth += (clamp01(this.params.diffuse) - this.diffuseSmooth) * mixK;
    this.meters.shiftSemitones = this.shiftSmooth;

    // MOTION — advanced once per block, before either path reads the value.
    this.motionRateSmooth = smoothLog(
      this.motionRateSmooth,
      clampRange(this.params.motionRate, 0.05, 8),
      mixK,
      0.05,
      8,
    );
    this.motionDepthSmooth += (clamp01(this.params.motionDepth) - this.motionDepthSmooth) * mixK;
    this.advanceMotion(n);

    // A live MIX close gets a short sample-ramped exit so a phase/spectral
    // discontinuity cannot click. Once it reaches the threshold, stop the STFT
    // and clear only wet state; the independent dry delay keeps running and
    // remains bit-exact at MIX 0. A cold instance at MIX 0 takes this path
    // immediately without allocating or processing the wet graph.
    if (!wetPathActive) {
      this.mixSmooth = 0;
      if (!this.wetStateCleared) this.clearWetState();
      outL.set(this.dryScratchL.subarray(0, n));
      outR.set(this.dryScratchR.subarray(0, n));
      return;
    }
    if (!closingMix) this.mixSmooth += (mixTarget - this.mixSmooth) * mixK;
    this.wetStateCleared = false;

    const n2 = this.effectiveDelaySeconds();
    this.engineMid.processBlock(this.scratchMid, n, this.scratchMid);
    this.engineSide.processBlock(this.scratchSide, n, this.scratchSide);

    const wetMid = this.scratchMid;
    const wetSide = this.scratchSide;

    const lpCoef = toneCoef(TONE_LP_HZ, n, this.sampleRate);
    const hpCoef = toneCoef(TONE_HP_HZ, n, this.sampleRate);
    const drive = this.driveSmooth;
    const tone = this.toneSmooth;

    for (let i = 0; i < n; i++) {
      const wetM = this.toneAndDrive(wetMid[i], drive, tone, lpCoef, hpCoef, true);
      const wetS = this.toneAndDrive(wetSide[i], drive, tone, lpCoef, hpCoef, false);

      let mix = this.mixSmooth;
      if (closingMix && this.mixCloseRemainingSamples > 0) {
        const progress = 1 - (this.mixCloseRemainingSamples - 1) / this.mixCloseTotalSamples;
        const eased = progress * progress * (3 - 2 * progress);
        mix = this.mixCloseStart * (1 - eased);
        this.mixCloseRemainingSamples--;
        this.mixSmooth = mix;
      }

      const dryL = this.dryScratchL[i]!;
      const dryR = this.dryScratchR[i]!;
      const dryM = (dryL + dryR) * 0.5;
      const dryS = (dryL - dryR) * 0.5;
      const mid = dryM * (1 - mix) + wetM * mix;
      const side = dryS * (1 - mix) + wetS * mix;

      outL[i] = mid + side;
      outR[i] = mid - side;
    }

    if (closingMix && this.mixCloseRemainingSamples === 0) {
      this.mixSmooth = 0;
      this.clearWetState();
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

  /** Clear frozen wet history after MIX closes, without disturbing the live dry delay. */
  private clearWetState(): void {
    this.engineMid.reset();
    this.engineSide.reset();
    this.delayMid.reset();
    this.delaySide.reset();
    this.resoMid.reset();
    this.resoSide.reset();
    this.lpStateMid = 0;
    this.hpStateMid = 0;
    this.lpStateSide = 0;
    this.hpStateSide = 0;
    this.wetStateCleared = true;
  }

  /**
   * Advance the MOTION LFO by the samples just rendered and publish the two
   * multipliers this block will use.
   *
   * Deterministic by construction: the phase is a pure accumulator over
   * rendered samples, there is no RNG and no clock read, so an offline render
   * of the same length produces the same samples as a live one. That is the
   * NEW-EFFECT-CHECKLIST §7 contract, and it is why the phase lives on the
   * processor instead of being sampled from the host.
   *
   * SYNC selects the rate the same way it selects the delay length: with a
   * division chosen, the motion runs on the grid and `motionRate` is inert;
   * with SYNC off the free-running Hz knob applies. One knob, one meaning —
   * "put it on the grid" — rather than two SYNC dials meaning different things.
   */
  private advanceMotion(frames: number): void {
    const hz = syncedLfoHz(this.syncBpm, this.params.sync, this.motionRateSmooth);
    const depth = this.motionDepthSmooth;
    if (depth <= 0 || hz <= 0 || this.sampleRate <= 0) {
      // Below the audible floor the scales are exactly 1, which keeps a
      // motionless render bit-identical rather than merely close to it.
      this.motionValue = 0;
      this.motionTimeScale = 1;
      this.motionFeedbackScale = 1;
      return;
    }

    // Phase BEFORE the output, so a block that starts at phase 0 emits 0 and
    // the first frame sits on the user's own setting.
    this.motionValue = Math.sin(this.motionPhase * TWO_PI);
    this.motionPhase += (hz * frames) / this.sampleRate;
    if (this.motionPhase >= 1) this.motionPhase -= Math.floor(this.motionPhase);

    const swing = this.motionValue * depth;
    this.motionTimeScale = Math.pow(2, swing * MOTION_TIME_OCTAVES);
    this.motionFeedbackScale = 1 + swing * MOTION_FEEDBACK_AMOUNT;
  }

  /** Sanitize once, then feed the aligned dry ring and (when active) both STFT paths. */
  private captureInputBlock(left: Float32Array, right: Float32Array, frames: number, feedWet: boolean): void {
    const latency = this.engineMid.latencySamples();
    const mask = this.dryDelayMask;
    for (let i = 0; i < frames; i++) {
      const l = sanitizeInputSample(left[i]!);
      const r = sanitizeInputSample(right[i]!);
      const write = this.dryWrite & mask;
      this.dryDelayL[write] = l;
      this.dryDelayR[write] = r;
      const read = (this.dryWrite - latency) & mask;
      this.dryScratchL[i] = this.dryDelayL[read]!;
      this.dryScratchR[i] = this.dryDelayR[read]!;
      if (feedWet) {
        this.scratchMid[i] = (l + r) * 0.5;
        this.scratchSide[i] = (l - r) * 0.5;
      }
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
   * Resolve TIME against SYNC, then apply MOTION.
   *
   * With SYNC off the manual time is used as-is; with a division selected the
   * delay becomes exactly one beat times that division, so it lands on the grid
   * instead of near it. The MOTION warp is applied afterwards and to whichever
   * base won, so the LFO moves the delay the user actually hears — a synced
   * delay warps around the beat, it does not get replaced by the warp.
   */
  private effectiveDelaySeconds(): number {
    const syncIndex = this.params.sync | 0;
    const ratio = SYNC_RATIOS[syncIndex] ?? 0;
    const base = ratio > 0 ? (60 / Math.max(1, this.syncBpm)) * ratio : this.timeSmooth / 1000;
    return clampRange(base * this.motionTimeScale, 0.02, 2);
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
   * smoothed controls and current discrete mode at frame time, so a knob
   * change needs no re-installation.
   */
  private installFrameCallbacks(): void {
    // `primary` marks the MID path. SIDE is the width channel; driving the
    // panel from it too would cost the same work for a trace that has to read
    // as one spectrum, and the two would fight each other frame to frame.
    this.engineMid.onFrame((re, im, binCount) =>
      this.processFrame(re, im, binCount, this.delayMid, this.resoMid, true),
    );
    this.engineSide.onFrame((re, im, binCount) =>
      this.processFrame(re, im, binCount, this.delaySide, this.resoSide, false),
    );
  }

  /**
   * One spectral frame: panel telemetry either side of the mode dispatch, so
   * the panel can draw the effect rather than a picture of its inputs.
   */
  private processFrame(
    re: Float64Array,
    im: Float64Array,
    binCount: number,
    delay: SpectralDelayBank,
    reso: ResonatorBank,
    primary: boolean,
  ): void {
    if (primary) this.reduceBands(re, im, this.meters.bandsIn);
    this.runMode(re, im, binCount, delay, reso);
    if (primary) this.reduceBands(re, im, this.meters.bandsOut);
  }

  /** Mode dispatch, then the shared magnitude ceiling. */
  private runMode(
    re: Float64Array,
    im: Float64Array,
    binCount: number,
    delay: SpectralDelayBank,
    reso: ResonatorBank,
  ): void {
    const mode = this.currentMode();
    const resonance = this.resonanceSmooth;
    const rp = this.resoScratch;
    rp.resonance = resonance;
    rp.focusHz = this.focusSmooth;
    rp.focusWidthOct = this.focusWidthSmooth;

    if (mode === SPECTRAL_MODE_RESONATOR) {
      // The resonator IS the effect here: the delay ring still receives the
      // fresh spectrum, but its delayed read must never become an extra hidden
      // hop of latency or contaminate the resonator mode with DELAY's SHIFT.
      delay.process(re, im, binCount, this.delayParams(0, false), this.sampleRate, this.engineMid.hop, true);
      reso.process(re, im, binCount, rp, 1);
      clampBinMagnitude(re, im, binCount);
      return;
    }

    reso.clearPhaseHistory();

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
    // FEEDBACK takes the smaller share of the LFO: enough that the tail breathes
    // with the warp, not enough that the tail length becomes the dominant thing
    // you hear. Clamped to the unit range here so a deep warp cannot smuggle an
    // out-of-range value past the host-side reporting into the bank.
    p.feedback = clampRange(this.feedbackSmooth * this.motionFeedbackScale * (frozen ? 0.85 : 1), 0, 1);
    p.decay = this.decaySmooth;
    p.shiftSemitones = this.shiftSmooth;
    p.diffuse = this.diffuseSmooth;
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

function smoothLog(current: number, target: number, coefficient: number, lo: number, hi: number): number {
  const fromValue = clampRange(current, lo, hi);
  const toValue = clampRange(target, lo, hi);
  if (fromValue === toValue) return toValue;
  const from = Math.log(fromValue);
  const to = Math.log(toValue);
  return Math.exp(from + (to - from) * coefficient);
}

/** One-pole smoothing coefficient for a corner frequency, applied per block. */
function toneCoef(cutoffHz: number, blockLen: number, sampleRate: number): number {
  if (!(cutoffHz > 0)) return 1;
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return blockSmoothingCoefficient(blockLen, tau, sampleRate);
}
