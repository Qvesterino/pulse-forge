/**
 * Tape Saturation AudioWorkletProcessor — hysteresis memory, 4× oversampled.
 *
 * Model: y[n] = tanh(drive * x[n] + hysteresis * y[n-1]).
 * The feedback term is the classic memory: the flux left by the previous
 * sample biases the next. drive 0 → unity, hysteresis 0 → plain tanh.
 *
 * The nonlinear stage runs at 4× the base rate behind a 33-tap
 * Blackman-windowed sinc anti-image / anti-alias pair (cutoff π/4, i.e. the
 * base Nyquist). Without it the tanh harmonics above Nyquist fold straight
 * back into the audible band as inharmonic grit — e.g. a driven 7 kHz tone
 * grows phantom content at 13 kHz and 1 kHz (the folded 5th/7th harmonics).
 * With 4× oversampling those harmonics live below the 4× Nyquist and the
 * decimation filter removes them before they can fold.
 *
 * Rate-invariant hysteresis: at 4× the memory spans a quarter base sample,
 * so the feedback coefficient is raised to h^0.25 — the decay time constant
 * (and therefore the tape feel) matches the legacy base-rate loop.
 *
 * Latency: both FIR stages are linear-phase with 16 samples of group delay
 * at 4×, i.e. 32 @4× = exactly 8 base samples. The dry path is delayed by
 * the same 8 samples, so partial mixes never comb against themselves.
 * Reported via getLatencySec in the TS wrapper for the engine's PDC.
 *
 * Post: one-pole low-pass (tone) + output makeup at the base rate.
 *
 * NOTE: served RAW to AudioWorklet.addModule() — plain JavaScript only.
 */
const TAPE_OS = 4;
const TAPE_FIR_LEN = 33;
const TAPE_FIR_DELAY_4X = 16; // (33 - 1) / 2
const TAPE_BASE_LATENCY = (TAPE_FIR_DELAY_4X * 2) / TAPE_OS; // 8 base samples

// FIR kernel shared by the up/down stages: Blackman-windowed sinc at
// cutoff π/4 (base Nyquist expressed at the 4× rate). The upsampler carries
// DC gain 4 (compensates zero-stuffing), the downsampler DC gain 1.
const TAPE_KERNEL = (() => {
  const taps = new Float32Array(TAPE_FIR_LEN);
  const M = (TAPE_FIR_LEN - 1) / 2;
  const wc = Math.PI / 4;
  let sum = 0;
  for (let n = 0; n < TAPE_FIR_LEN; n++) {
    const k = n - M;
    const sinc = k === 0 ? 1 : Math.sin(wc * k) / (wc * k);
    const a = (2 * Math.PI * n) / (TAPE_FIR_LEN - 1);
    const w = 0.42 - 0.5 * Math.cos(a) + 0.08 * Math.cos(2 * a);
    taps[n] = sinc * w;
    sum += taps[n];
  }
  const up = new Float32Array(TAPE_FIR_LEN);
  const down = new Float32Array(TAPE_FIR_LEN);
  for (let n = 0; n < TAPE_FIR_LEN; n++) {
    up[n] = (taps[n] / sum) * TAPE_OS;
    down[n] = taps[n] / sum;
  }
  return { up, down };
})();

class TapeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.prevL = 0;
    this.prevR = 0;
    this.lpL = 0;
    this.lpR = 0;
    // Oversampling state, per channel: FIR histories (newest at index 0)
    // plus a 4-sample dry delay line for mix alignment.
    this.upL = new Float32Array(TAPE_FIR_LEN);
    this.upR = new Float32Array(TAPE_FIR_LEN);
    this.downL = new Float32Array(TAPE_FIR_LEN);
    this.downR = new Float32Array(TAPE_FIR_LEN);
    this.dryL = new Float32Array(TAPE_BASE_LATENCY);
    this.dryR = new Float32Array(TAPE_BASE_LATENCY);
    this.dryIdx = 0;
  }

  static get parameterDescriptors() {
    return [
      { name: "drive", defaultValue: 0.4, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "hysteresis", defaultValue: 0.3, minValue: 0, maxValue: 0.95, automationRate: "k-rate" },
      { name: "tone", defaultValue: 6500, minValue: 500, maxValue: 12000, automationRate: "k-rate" },
      { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "output", defaultValue: 0, minValue: -12, maxValue: 12, automationRate: "k-rate" },
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

    const drive = parameters.drive[0];
    const hyst = Math.max(0, Math.min(0.95, parameters.hysteresis[0]));
    const tone = parameters.tone[0];
    const mix = parameters.mix[0];
    const outDb = parameters.output[0];

    const driveGain = 1 + drive * 14;
    const outGain = Math.pow(10, outDb / 20);
    // Hysteresis memory runs at 4×: preserve the decay time constant.
    const hEff = Math.pow(hyst, 1 / TAPE_OS);
    const alpha = 1 - Math.exp((-2 * Math.PI * tone) / sr);

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;

      const wetL = this.oversampledTape(this.upL, this.downL, l, driveGain, hEff, true);
      const wetR = this.oversampledTape(this.upR, this.downR, r, driveGain, hEff, false);

      // Tone: one-pole low-pass post-saturation, at the base rate as before.
      this.lpL += alpha * (wetL - this.lpL);
      this.lpR += alpha * (wetR - this.lpR);
      if (Math.abs(this.lpL) < 1e-20) this.lpL = 0;
      if (Math.abs(this.lpR) < 1e-20) this.lpR = 0;

      // Latency-aligned dry (4 base samples behind the input).
      const dryL = this.dryL[this.dryIdx];
      const dryR = this.dryR[this.dryIdx];
      this.dryL[this.dryIdx] = l;
      this.dryR[this.dryIdx] = r;
      this.dryIdx++;
      if (this.dryIdx >= TAPE_BASE_LATENCY) this.dryIdx = 0;

      outL[i] = (dryL * (1 - mix) + this.lpL * mix) * outGain;
      if (outR) outR[i] = (dryR * (1 - mix) + this.lpR * mix) * outGain;
    }

    // Denormal guard for the FIR histories.
    this.flushTiny(this.upL);
    this.flushTiny(this.upR);
    this.flushTiny(this.downL);
    this.flushTiny(this.downR);

    return true;
  }

  /**
   * One base-rate sample through the 4× stage: zero-stuff → anti-image FIR
   * → tanh hysteresis loop at 4× → anti-alias FIR → decimate. Returns the
   * wet sample at the base rate. `left` selects the channel hysteresis
   * memory (prevL / prevR).
   *
   * Decimation takes phase 0 — the phase on which fresh input enters — so
   * the cascade lands exactly on its 16-@4× group delay (4 base samples),
   * matching the dry delay line. Any other phase would skew dry/wet by a
   * fractional sample and comb partial mixes at the top octave.
   */
  oversampledTape(upHist, downHist, x, driveGain, hEff, left) {
    let prev = left ? this.prevL : this.prevR;
    let last = 0;
    for (let k = 0; k < TAPE_OS; k++) {
      // Zero-stuff: the input sample enters on phase 0, zeros on 1..3.
      upHist.copyWithin(1, 0, TAPE_FIR_LEN - 1);
      upHist[0] = k === 0 ? x : 0;
      let u = 0;
      for (let j = 0; j < TAPE_FIR_LEN; j++) u += upHist[j] * TAPE_KERNEL.up[j];
      const y = Math.tanh(driveGain * u + hEff * prev);
      prev = y;
      downHist.copyWithin(1, 0, TAPE_FIR_LEN - 1);
      downHist[0] = y;
      if (k === 0) {
        let d = 0;
        for (let j = 0; j < TAPE_FIR_LEN; j++) d += downHist[j] * TAPE_KERNEL.down[j];
        last = d;
      }
    }
    if (Math.abs(prev) < 1e-20) prev = 0;
    if (left) this.prevL = prev;
    else this.prevR = prev;
    return last;
  }

  flushTiny(buf) {
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      if (v < 1e-20 && v > -1e-20) buf[i] = 0;
    }
  }
}

export function createTapeProcessor() {
  return new TapeProcessor();
}

registerProcessor("tape-processor", TapeProcessor);
