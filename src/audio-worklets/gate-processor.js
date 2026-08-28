class GateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.envelope = 0;
    this.gain = 0;
    this.holdSamples = 0;
  }

  static get parameterDescriptors() {
    return [
      { name: "threshold", defaultValue: -36, minValue: -80, maxValue: 0, automationRate: "k-rate" },
      { name: "attack", defaultValue: 0.002, minValue: 0.0001, maxValue: 0.5, automationRate: "k-rate" },
      { name: "hold", defaultValue: 0.02, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "release", defaultValue: 0.08, minValue: 0.001, maxValue: 2, automationRate: "k-rate" },
      { name: "range", defaultValue: -48, minValue: -80, maxValue: 0, automationRate: "k-rate" },
      { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;
    const sr = globalThis.sampleRate || 44100;
    const channels = Math.min(input.length, output.length);
    for (let i = 0; i < output[0].length; i++) {
      let peak = 0;
      for (let ch = 0; ch < channels; ch++) peak = Math.max(peak, Math.abs(input[ch][i] || 0));
      const threshold = parameters.threshold.length > 1 ? parameters.threshold[i] : parameters.threshold[0];
      const attack = parameters.attack.length > 1 ? parameters.attack[i] : parameters.attack[0];
      const hold = parameters.hold.length > 1 ? parameters.hold[i] : parameters.hold[0];
      const release = parameters.release.length > 1 ? parameters.release[i] : parameters.release[0];
      const range = parameters.range.length > 1 ? parameters.range[i] : parameters.range[0];
      const mix = parameters.mix.length > 1 ? parameters.mix[i] : parameters.mix[0];
      const envCoef = Math.exp(
        -1 / (sr * (peak > this.envelope ? Math.max(0.0001, attack) : Math.max(0.001, release))),
      );
      this.envelope = envCoef * this.envelope + (1 - envCoef) * peak;
      if (Math.abs(this.envelope) < 1e-20) this.envelope = 0;
      if (20 * Math.log10(Math.max(this.envelope, 1e-7)) >= threshold)
        this.holdSamples = Math.max(this.holdSamples, Math.round(hold * sr));
      else this.holdSamples = Math.max(0, this.holdSamples - 1);
      const target = this.holdSamples > 0 ? 1 : Math.pow(10, range / 20);
      const step =
        target > this.gain
          ? 1 / Math.max(1, sr * Math.max(0.0001, attack))
          : 1 / Math.max(1, sr * Math.max(0.001, release));
      this.gain += (target - this.gain) * Math.min(1, step);
      if (Math.abs(this.gain) < 1e-20) this.gain = 0;
      for (let ch = 0; ch < channels; ch++) output[ch][i] = input[ch][i] * (1 + (this.gain - 1) * mix);
    }
    return true;
  }
}

registerProcessor("gate-processor", GateProcessor);
