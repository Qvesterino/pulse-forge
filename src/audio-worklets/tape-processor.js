/**
 * Tape Saturation AudioWorkletProcessor — hysteresis memory.
 *
 * Model: y[n] = tanh(drive * x[n] + hysteresis * y[n-1]).
 * The feedback term is the classic memory: the flux left by the previous
 * sample biases the next. drive 0 → unity, hysteresis 0 → plain tanh.
 *
 * Post: one-pole low-pass (tone) + output makeup.
 *
 * NOTE: served RAW to AudioWorklet.addModule() — plain JavaScript only.
 */
class TapeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.prevL = 0;
    this.prevR = 0;
    this.lpL = 0;
    this.lpR = 0;
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
    const hyst = parameters.hysteresis[0];
    const tone = parameters.tone[0];
    const mix = parameters.mix[0];
    const outDb = parameters.output[0];

    const driveGain = 1 + drive * 14;
    const outGain = Math.pow(10, outDb / 20);
    const alpha = 1 - Math.exp(-2 * Math.PI * tone / sr);

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;

      // Hysteresis stage — per channel with memory.
      const wetL = Math.tanh(driveGain * l + hyst * this.prevL);
      const wetR = Math.tanh(driveGain * r + hyst * this.prevR);
      this.prevL = wetL;
      this.prevR = wetR;
      if (Math.abs(this.prevL) < 1e-20) this.prevL = 0;
      if (Math.abs(this.prevR) < 1e-20) this.prevR = 0;

      // Tone: one-pole low-pass post-saturation.
      this.lpL += alpha * (wetL - this.lpL);
      this.lpR += alpha * (wetR - this.lpR);
      if (Math.abs(this.lpL) < 1e-20) this.lpL = 0;
      if (Math.abs(this.lpR) < 1e-20) this.lpR = 0;

      const tonedL = this.lpL;
      const tonedR = this.lpR;

      outL[i] = (l * (1 - mix) + tonedL * mix) * outGain;
      if (outR) outR[i] = (r * (1 - mix) + tonedR * mix) * outGain;
    }
    return true;
  }
}

registerProcessor("tape-processor", TapeProcessor);
