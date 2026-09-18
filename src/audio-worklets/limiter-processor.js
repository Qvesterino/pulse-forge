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
 * Latency: exactly `lookahead` samples (reported by the TS wrapper via
 * getLatencySec for the engine's PDC). The oversampled detector uses past
 * samples only, so it adds no latency. Metering posts `{ type: "gr", gr }`
 * messages (gain reduction in dB) roughly every 50 ms.
 *
 * NOTE: this file is served RAW to AudioWorklet.addModule() via
 * `new URL(...)` — it must stay plain JavaScript with no imports and no
 * TypeScript syntax.
 */
// 4× true-peak polyphase bank: Blackman-windowed sinc prototype, decomposed
// into 4 phases of 16 taps, DC-normalized per phase. Sample-rate independent
// (cutoff is defined relative to the input Nyquist), so one shared table.
const TP_PHASES = 4;
const TP_TAPS = 16;
const TP_TABLE = (() => {
  const prototype = new Float64Array(TP_PHASES * TP_TAPS);
  const center = (prototype.length - 1) / 2;
  for (let n = 0; n < prototype.length; n++) {
    const x = (n - center) / TP_PHASES;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * n) / (prototype.length - 1)) +
      0.08 * Math.cos((4 * Math.PI * n) / (prototype.length - 1));
    prototype[n] = sinc * w;
  }
  const phases = [];
  for (let p = 0; p < TP_PHASES; p++) {
    const taps = new Float32Array(TP_TAPS);
    let sum = 0;
    for (let j = 0; j < TP_TAPS; j++) {
      taps[j] = prototype[j * TP_PHASES + p];
      sum += taps[j];
    }
    const inv = sum !== 0 ? 1 / sum : 1;
    for (let j = 0; j < TP_TAPS; j++) taps[j] *= inv;
    phases.push(taps);
  }
  return phases;
})();
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
    const cap = 1 << Math.ceil(Math.log2(0.03 * sr + 256));
    this.cap = cap;
    this.delayL = new Float32Array(cap);
    this.delayR = new Float32Array(cap);
    this.linked = new MaxDeque(cap);
    this.leftPeak = new MaxDeque(cap);
    this.rightPeak = new MaxDeque(cap);
    this.step = 0;
    this.gainL = 1;
    this.gainR = 1;
    // True-peak detector history: last 16 input samples per channel,
    // each with its own write position (a shared counter would interleave
    // the two channels into the same slots and corrupt both histories).
    this.histL = new Float32Array(TP_TAPS);
    this.histR = new Float32Array(TP_TAPS);
    this.histPosL = 0;
    this.histPosR = 0;
    this.tpOut = 0;
    this.postedGr = -1;
    this.grAccumulator = 0;
    this.grWindowStart = typeof globalThis.currentTime === "number" ? globalThis.currentTime : 0;
  }

  static get parameterDescriptors() {
    return [
      { name: "threshold", defaultValue: -6, minValue: -24, maxValue: 0, automationRate: "k-rate" },
      { name: "ceiling", defaultValue: -1, minValue: -12, maxValue: 0, automationRate: "k-rate" },
      { name: "release", defaultValue: 0.12, minValue: 0.01, maxValue: 1, automationRate: "k-rate" },
      { name: "lookahead", defaultValue: 0.005, minValue: 0.001, maxValue: 0.02, automationRate: "k-rate" },
      { name: "link", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
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

    const ceilingDb = parameters.ceiling[0];
    const ceilingLin = Math.pow(10, ceilingDb / 20);
    const thresholdDb = parameters.threshold[0];
    const releaseSec = parameters.release[0];
    const laSamples = Math.max(1, Math.min(this.cap - 2, Math.round(parameters.lookahead[0] * sr)));
    const link = parameters.link[0];
    const mix = parameters.mix[0];
    const perChannel = outR !== null && link < 0.999;
    const attackCoef = 1 - Math.exp(-1 / (sr * 0.0005));

    let blockGrDb = 0;

    for (let i = 0; i < len; i++, this.step++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;
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
          const gDb = Math.min(0, Math.min(1, over / 3) * (ceilingDb - peakDb));
          targetLinked = Math.pow(10, gDb / 20);
        }
      }
      let targetL = targetLinked;
      let targetR = targetLinked;
      if (perChannel) {
        const applyKnee = (peak) => {
          if (peak <= 1e-8) return 1;
          const peakDb = 20 * Math.log10(peak);
          const over = peakDb - thresholdDb;
          if (over <= 0) return 1;
          const gDb = Math.min(0, Math.min(1, over / 3) * (ceilingDb - peakDb));
          return Math.pow(10, gDb / 20);
        };
        const gl = applyKnee(this.leftPeak.front(windowStart));
        const gr2 = applyKnee(this.rightPeak.front(windowStart));
        targetL = link * targetLinked + (1 - link) * gl;
        targetR = link * targetLinked + (1 - link) * gr2;
      }

      // Gain smoothing: fast dive (the look-ahead already paid for it),
      // program-dependent recovery — deeper recent reduction releases slower,
      // so kick-driven material does not pump on every hit.
      this.gainL = this.smoothGain(this.gainL, targetL, sr, releaseSec, attackCoef);
      this.gainR = this.smoothGain(this.gainR, targetR, sr, releaseSec, attackCoef);
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

      outL[i] = mix * wetL + (1 - mix) * this.delayL[readIdx];
      if (outR) outR[i] = mix * wetR + (1 - mix) * this.delayR[readIdx];

      const depth = 1 - (this.gainL < this.gainR ? this.gainL : this.gainR);
      if (depth > this.grAccumulator) this.grAccumulator = depth;
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
    let v = newest;
    if (v < 1e-20 && v > -1e-20) v = 0;
    hist[pos & (TP_TAPS - 1)] = v;
    const nextPos = (pos + 1) & 0xfffffff; // monotone counter, exact in float64
    let peak = 0;
    for (let p = 0; p < TP_PHASES; p++) {
      const taps = TP_TABLE[p];
      let acc = 0;
      // taps[j] weights the j-th oldest sample (metering.ts convention):
      // newest sits at nextPos - 1, oldest at nextPos - TP_TAPS.
      for (let j = 0; j < TP_TAPS; j++) {
        acc += taps[j] * hist[(nextPos - TP_TAPS + j) & (TP_TAPS - 1)];
      }
      if (acc < 0) acc = -acc;
      if (acc > peak) peak = acc;
    }
    this.tpOut = peak;
    return nextPos;
  }

  smoothGain(current, target, sr, releaseSec, attackCoef) {
    if (target < current) return target + (current - target) * (1 - attackCoef);
    const depth = 1 - current;
    const effRelease = Math.max(0.002, releaseSec * (0.35 + 0.65 * Math.min(1, depth * 4)));
    const rc = 1 - Math.exp(-1 / (sr * effRelease));
    return current + (target - current) * rc;
  }
}

registerProcessor("limiter-processor", LimiterProcessor);
