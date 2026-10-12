/**
 * Look-ahead Brickwall Limiter AudioWorkletProcessor.
 *
 * Signal path: a stereo-linked TRUE-PEAK detector feeds a monotonic
 * max-deque over the look-ahead window. Each input sample is 4× oversampled
 * through a Blackman-sinc polyphase bank (same proven kernel as the
 * metering true-peak estimator) and the detector sees
 * max(sample peak, intersample peak) — a ceiling-exceeding transient
 * BETWEEN samples still pulls gain down, so the brickwall holds for true
 * peak, not just sample peak. Material without intersample overshoot
 * behaves bit-identically to the legacy sample-peak detector.
 * The window maximum is the loudest (true) peak that will reach the output
 * within `lookahead` seconds, so the gain smoothing always has time to
 * react BEFORE the transient arrives — that is what makes this a true
 * look-ahead limiter instead of the native DynamicsCompressorNode.
 * A final safety clamp at the ceiling catches any rounding residue.
 *
 * Program-dependent release: deeper recent gain reduction lengthens the
 * release time, which keeps sustained material from pumping on every beat.
 *
 * Latency: the integer sample count rounded from `lookahead` seconds, plus
 * the fixed 32-sample output correction window and (in 2× Studio HQ mode) the
 * measured FIR oversampler latency. The TS wrapper reports this for PDC.
 * Metering posts `{ type: "gr", gr }` messages roughly every 50 ms.
 *
 * NOTE: scripts/build-core-worklets.mjs bundles this entry and its pure DSP
 * helper into the self-contained AudioWorklet module served by addModule().
 */
import { LimiterOversampler2x } from "./limiter-oversampler.js";

// ITU-R BS.1770-5 Annex 2 order-48, 4× true-peak interpolator. Keep this
// coefficient table identical to src/audio-engine/metering.ts so limiter
// correction, offline analysis, and post-encode reports use the same estimator.
const TP_PHASES = 4;
const TP_TAPS = 12;
// Hold one extra 32-sample window after the main limiter. This lets the
// output-side detector see the reconstructed waveform before it is emitted.
const POST_TP_DELAY_SAMPLES = 32;
const POST_TP_MARGIN_DB = 0.1;
function clampLink(value) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}
const TP_TABLE = [
  new Float32Array([
    0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125, -0.0594482421875, 0.1373291015625, 0.97216796875,
    -0.102294921875, 0.047607421875, -0.026611328125, 0.014892578125, -0.00830078125,
  ]),
  new Float32Array([
    -0.0291748046875, 0.029296875, -0.0517578125, 0.089111328125, -0.16650390625, 0.465087890625, 0.77978515625,
    -0.2003173828125, 0.1015625, -0.0582275390625, 0.0330810546875, -0.0189208984375,
  ]),
  new Float32Array([
    -0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625, -0.2003173828125, 0.77978515625, 0.465087890625,
    -0.16650390625, 0.089111328125, -0.0517578125, 0.029296875, -0.0291748046875,
  ]),
  new Float32Array([
    -0.00830078125, 0.014892578125, -0.026611328125, 0.047607421875, -0.102294921875, 0.97216796875, 0.1373291015625,
    -0.0594482421875, 0.033203125, -0.0196533203125, 0.010986328125, 0.001708984375,
  ]),
];
class MaxDeque {
  constructor(capacity) {
    // Float64 keeps absolute step counters exact far beyond int32; indices are
    // only ever compared/evicted relatively so monotonic growth is safe.
    this.idx = new Float64Array(capacity);
    this.val = new Float32Array(capacity);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }

  push(value, absIdx) {
    const cap = this.val.length;
    while (this.count > 0) {
      const back = (this.tail - 1 + cap) % cap;
      if (this.val[back] <= value) {
        this.tail = back;
        this.count--;
      } else break;
    }
    this.idx[this.tail] = absIdx;
    this.val[this.tail] = value;
    this.tail = (this.tail + 1) % cap;
    this.count++;
  }

  /** Max value among entries with idx >= minIdx. */
  front(minIdx) {
    const cap = this.val.length;
    while (this.count > 0 && this.idx[this.head] < minIdx) {
      this.head = (this.head + 1) % cap;
      this.count--;
    }
    return this.count > 0 ? this.val[this.head] : 0;
  }
}

class LimiterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = globalThis.sampleRate || 44100;
    // Enough room for the maximum 20 ms lookahead and output correction at
    // 2×, with headroom for the monotonic-deque window.
    const cap = 1 << Math.ceil(Math.log2(0.045 * sr + 512));
    this.cap = cap;
    this.delayL = new Float32Array(cap);
    this.delayR = new Float32Array(cap);
    this.linked = new MaxDeque(cap);
    this.leftPeak = new MaxDeque(cap);
    this.rightPeak = new MaxDeque(cap);
    this.step = 0;
    this.gainL = 1;
    this.gainR = 1;
    // True-peak detector history: last 12 input samples per channel,
    // each with its own write position (a shared counter would interleave
    // the two channels into the same slots and corrupt both histories).
    this.histL = new Float32Array(TP_TAPS);
    this.histR = new Float32Array(TP_TAPS);
    this.histPosL = 0;
    this.histPosR = 0;
    this.tpOut = 0;
    this.postDelayL = new Float32Array(cap);
    this.postDelayR = new Float32Array(cap);
    this.postPeak = new MaxDeque(cap);
    this.postHistL = new Float64Array(TP_TAPS);
    this.postHistR = new Float64Array(TP_TAPS);
    this.postHistPosL = 0;
    this.postHistPosR = 0;
    this.postCorrectionGain = 1;
    this.postedGr = -1;
    this.grAccumulator = 0;
    this.grWindowStart = typeof globalThis.currentTime === "number" ? globalThis.currentTime : 0;
    this.oversampler = new LimiterOversampler2x();
    this.oversampleSilence = new Float32Array(2048);
  }

  static get parameterDescriptors() {
    return [
      { name: "threshold", defaultValue: -6, minValue: -24, maxValue: 0, automationRate: "k-rate" },
      { name: "ceiling", defaultValue: -1, minValue: -24, maxValue: 0, automationRate: "k-rate" },
      { name: "release", defaultValue: 0.12, minValue: 0.01, maxValue: 2, automationRate: "k-rate" },
      { name: "lookahead", defaultValue: 0.005, minValue: 0.001, maxValue: 0.02, automationRate: "k-rate" },
      { name: "link", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "transientLink", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "releaseLink", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "character", defaultValue: 0, minValue: 0, maxValue: 2, automationRate: "k-rate" },
      { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "oversample", defaultValue: 1, minValue: 1, maxValue: 2, automationRate: "k-rate" },
      // Live monitor only: emit aligned input-minus-limited output so users can
      // hear what the limiter removes. It is never stored in project state.
      { name: "deltaListen", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  /** Soft-knee gain curve — a method so the render path allocates nothing. */
  applyKneeGain(peak, thresholdDb, ceilingDb, kneeWidthDb) {
    if (peak <= 1e-8) return 1;
    const peakDb = 20 * Math.log10(peak);
    const over = peakDb - thresholdDb;
    if (over <= 0) return 1;
    const gDb = Math.min(0, Math.min(1, over / kneeWidthDb) * (ceilingDb - peakDb));
    return Math.pow(10, gDb / 20);
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const outL = output[0];
    const outR = output.length > 1 && output[1] ? output[1] : null;
    const input = inputs[0];
    const inL = input && input[0] && input[0].length ? input[0] : null;
    const inR = input && input.length > 1 && input[1] && input[1].length ? input[1] : null;
    const len = outL.length;
    const sr = globalThis.sampleRate || 44100;
    const requestedOversample = parameters.oversample?.[0] ?? 1;
    const factor = Number.isFinite(requestedOversample) && requestedOversample >= 1.5 ? 2 : 1;
    const processingRate = sr * factor;
    const processingFrames = len * factor;
    const sourceL = inL ?? this.oversampleSilence;
    const sourceR = inR ?? inL ?? this.oversampleSilence;
    const processInL = factor === 2 ? this.oversampler.upsample(sourceL, len, 0) : inL;
    const processInR = factor === 2 ? this.oversampler.upsample(sourceR, len, 1) : inR;
    const postCorrectionDelay = POST_TP_DELAY_SAMPLES * factor;

    const ceilingDb = parameters.ceiling[0];
    const ceilingLin = Math.pow(10, ceilingDb / 20);
    const postCorrectionCeiling = ceilingLin * Math.pow(10, -POST_TP_MARGIN_DB / 20);
    const thresholdDb = parameters.threshold[0];
    const releaseSec = parameters.release[0];
    const character = Math.round(Math.min(2, Math.max(0, parameters.character[0])));
    const kneeWidthDb = character === 1 ? 1.5 : character === 2 ? 4.5 : 3;
    const releaseScale = character === 1 ? 0.75 : character === 2 ? 1.25 : 1;
    const attackMs = character === 1 ? 0.35 : character === 2 ? 1.2 : 0.5;
    const laSamples = Math.max(1, Math.min(this.cap - 2, Math.round(parameters.lookahead[0] * processingRate)));
    // `link` remains as a compatibility ceiling for older effect instances
    // and direct worklet users. New master controls use separate link stages.
    const legacyLink = clampLink(parameters.link[0]);
    const transientLink = Math.min(legacyLink, clampLink(parameters.transientLink[0]));
    const releaseLink = Math.min(legacyLink, clampLink(parameters.releaseLink[0]));
    const mix = parameters.mix[0];
    const deltaListen = parameters.deltaListen?.[0] > 0.5;
    const perChannel = outR !== null && (transientLink < 0.999 || releaseLink < 0.999);
    const attackCoef = 1 - Math.exp(-1 / (processingRate * attackMs * 0.001));
    const postCorrectionAttackCoef = 1 - Math.exp(-1 / (processingRate * 0.00005));

    let blockGrDb = 0;

    // Soft-knee gain for the per-channel path — the per-block arrow closure
    // still allocated a fresh function object every render quantum; the knee
    // math now lives in a method taking the (k-rate) thresholds.
    const applyKnee = (peak) => this.applyKneeGain(peak, thresholdDb, ceilingDb, kneeWidthDb);

    for (let i = 0; i < processingFrames; i++, this.step++) {
      const l = processInL ? processInL[i] : 0;
      const r = processInR ? processInR[i] : l;
      const s = this.step;
      const w = s % this.cap;
      this.delayL[w] = l;
      this.delayR[w] = r;

      const absL = l < 0 ? -l : l;
      const absR = r < 0 ? -r : r;
      // True-peak detector: the loudest of the sample peak and the 4×
      // oversampled intersample peaks. Silent history at start-up reads 0,
      // so the first 16 samples behave like the legacy detector.
      // (Peak is copied to a local BEFORE the R call — the step reports
      // through a shared scratch field to stay allocation-free.)
      this.histPosL = this.truePeakStep(this.histL, this.histPosL, l);
      const tpL = this.tpOut;
      this.histPosR = this.truePeakStep(this.histR, this.histPosR, r);
      const tpR = this.tpOut;
      const detL = absL > tpL ? absL : tpL;
      const detR = absR > tpR ? absR : tpR;
      const linked = detL > detR ? detL : detR;
      const windowStart = s - laSamples;
      this.linked.push(linked, s);
      if (perChannel) {
        this.leftPeak.push(detL, s);
        this.rightPeak.push(detR, s);
      }
      const peakLinked = this.linked.front(windowStart);

      // Target gain: soft knee over `threshold`, full limiting pins output to
      // the ceiling. k ramps the reduction in across the first 3 dB above
      // threshold so quiet material never hard-clips.
      let targetLinked = 1;
      if (peakLinked > 1e-8) {
        const peakDb = 20 * Math.log10(peakLinked);
        const over = peakDb - thresholdDb;
        if (over > 0) {
          const gDb = Math.min(0, Math.min(1, over / kneeWidthDb) * (ceilingDb - peakDb));
          targetLinked = Math.pow(10, gDb / 20);
        }
      }
      let targetL = targetLinked;
      let targetR = targetLinked;
      if (perChannel) {
        const gl = applyKnee(this.leftPeak.front(windowStart));
        const gr2 = applyKnee(this.rightPeak.front(windowStart));
        const linkL = targetLinked < this.gainL ? transientLink : releaseLink;
        const linkR = targetLinked < this.gainR ? transientLink : releaseLink;
        targetL = linkL * targetLinked + (1 - linkL) * gl;
        targetR = linkR * targetLinked + (1 - linkR) * gr2;
      }

      // Gain smoothing: fast dive (the look-ahead already paid for it),
      // program-dependent recovery — deeper recent reduction releases slower,
      // so kick-driven material does not pump on every hit.
      this.gainL = this.smoothGain(this.gainL, targetL, processingRate, releaseSec, attackCoef, releaseScale);
      this.gainR = this.smoothGain(this.gainR, targetR, processingRate, releaseSec, attackCoef, releaseScale);
      if (Math.abs(this.gainL) < 1e-20) this.gainL = 0;
      if (Math.abs(this.gainR) < 1e-20) this.gainR = 0;

      const readIdx = (((s - laSamples) % this.cap) + this.cap) % this.cap;
      let wetL = this.delayL[readIdx] * this.gainL;
      let wetR = this.delayR[readIdx] * this.gainR;
      // Safety clamp — guarantees the brickwall promise even at extreme input.
      if (wetL > ceilingLin) wetL = ceilingLin;
      else if (wetL < -ceilingLin) wetL = -ceilingLin;
      if (wetR > ceilingLin) wetR = ceilingLin;
      else if (wetR < -ceilingLin) wetR = -ceilingLin;

      const preCorrectionL = mix * wetL + (1 - mix) * this.delayL[readIdx];
      const preCorrectionR = mix * wetR + (1 - mix) * this.delayR[readIdx];
      this.postDelayL[w] = preCorrectionL;
      this.postDelayR[w] = preCorrectionR;

      let postTarget = 1;
      if (mix >= 0.999) {
        this.postHistPosL = this.truePeakStep(this.postHistL, this.postHistPosL, this.postDelayL[w]);
        const postPeakL = this.tpOut;
        this.postHistPosR = this.truePeakStep(this.postHistR, this.postHistPosR, this.postDelayR[w]);
        const postPeakR = this.tpOut;
        this.postPeak.push(postPeakL > postPeakR ? postPeakL : postPeakR, s);
        const postWindowPeak = this.postPeak.front(s - postCorrectionDelay);
        if (postWindowPeak > postCorrectionCeiling) postTarget = postCorrectionCeiling / postWindowPeak;
        this.postCorrectionGain = this.smoothGain(
          this.postCorrectionGain,
          postTarget,
          processingRate,
          releaseSec,
          postCorrectionAttackCoef,
        );
      } else {
        this.postCorrectionGain = 1;
      }

      const postReadIdx = (((s - postCorrectionDelay) % this.cap) + this.cap) % this.cap;
      const correctionGain = mix >= 0.999 ? this.postCorrectionGain : 1;
      let finalL = this.postDelayL[postReadIdx] * correctionGain;
      let finalR = this.postDelayR[postReadIdx] * correctionGain;
      if (mix >= 0.999) {
        if (finalL > postCorrectionCeiling) finalL = postCorrectionCeiling;
        else if (finalL < -postCorrectionCeiling) finalL = -postCorrectionCeiling;
        if (finalR > postCorrectionCeiling) finalR = postCorrectionCeiling;
        else if (finalR < -postCorrectionCeiling) finalR = -postCorrectionCeiling;
      }
      if (deltaListen) {
        // Subtract aligned dry from the final limited path. At 2×, both are
        // subtracted before the same decimation filter so timing and tone stay
        // matched in the monitor signal.
        const dryReadIdx = (((s - laSamples - postCorrectionDelay) % this.cap) + this.cap) % this.cap;
        finalL = this.delayL[dryReadIdx] - finalL;
        finalR = this.delayR[dryReadIdx] - finalR;
      }
      if (factor === 1) {
        outL[i] = finalL;
        if (outR) outR[i] = finalR;
      } else {
        this.oversampler.processBufferL[i] = finalL;
        this.oversampler.processBufferR[i] = finalR;
      }

      const depth = Math.max(1 - (this.gainL < this.gainR ? this.gainL : this.gainR), 1 - correctionGain);
      if (depth > this.grAccumulator) this.grAccumulator = depth;
    }

    if (factor === 2) {
      const downL = this.oversampler.downsample(this.oversampler.processBufferL, len, 0);
      const downR = this.oversampler.downsample(this.oversampler.processBufferR, len, 1);
      for (let i = 0; i < len; i++) {
        outL[i] = downL[i];
        if (outR) outR[i] = downR[i];
      }
    }

    // Metering: post gain reduction ~20x/sec at most.
    const now = typeof globalThis.currentTime === "number" ? globalThis.currentTime : this.grWindowStart + len / sr;
    if (now - this.grWindowStart >= 0.05) {
      const grDb =
        this.grAccumulator > 1e-4 ? Math.min(24, -20 * Math.log10(Math.max(1e-4, 1 - this.grAccumulator))) : 0;
      this.grAccumulator = 0;
      this.grWindowStart = now;
      if (grDb !== this.postedGr) {
        this.postedGr = grDb;
        this.port.postMessage({ type: "gr", gr: grDb });
      }
    }

    return true;
  }

  /**
   * One true-peak detector step: push the newest sample into the channel
   * history, then run the 4 oversampled phases. Reports the loudest absolute
   * value across phases through `this.tpOut` and returns the advanced write
   * position (both allocation-free; the caller stores the position back and
   * copies the peak before stepping the other channel).
   */
  truePeakStep(hist, pos, newest) {
    const sample = Number.isFinite(newest) ? newest : 0;
    hist[pos % TP_TAPS] = Math.abs(sample) < 1e-20 ? 0 : sample;
    const nextPos = pos + 1;
    let peak = Math.abs(sample);
    const base = nextPos - TP_TAPS;
    for (let p = 0; p < TP_PHASES; p++) {
      const taps = TP_TABLE[p];
      let acc = 0;
      for (let j = 0; j < TP_TAPS; j++) {
        const sourceIndex = base + j;
        if (sourceIndex >= 0) acc += hist[sourceIndex % TP_TAPS] * taps[j];
      }
      const value = Math.abs(acc);
      if (value > peak) peak = value;
    }
    this.tpOut = peak;
    return nextPos;
  }

  smoothGain(current, target, sr, releaseSec, attackCoef, releaseScale = 1) {
    if (target < current) return target + (current - target) * (1 - attackCoef);
    const depth = 1 - current;
    const effRelease = Math.max(0.002, releaseSec * releaseScale * (0.35 + 0.65 * Math.min(1, depth * 4)));
    const rc = 1 - Math.exp(-1 / (sr * effRelease));
    return current + (target - current) * rc;
  }
}

registerProcessor("limiter-processor", LimiterProcessor);
