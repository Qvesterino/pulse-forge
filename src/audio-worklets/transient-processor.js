class TransientProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.envelope = 0;
    this.fast = 0;
    this.slow = 0;
  }

  static get parameterDescriptors() {
    return [
      { name: "attack", defaultValue: 0.25, minValue: -1, maxValue: 1, automationRate: "k-rate" },
      { name: "sustain", defaultValue: 0, minValue: -1, maxValue: 1, automationRate: "k-rate" },
      { name: "sensitivity", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "output", defaultValue: 0, minValue: -24, maxValue: 24, automationRate: "k-rate" },
    ];
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;
    const sr = globalThis.sampleRate || 44100;
    const attack = parameters.attack;
    const sustain = parameters.sustain;
    const sensitivity = parameters.sensitivity;
    const mix = parameters.mix;
    const outputDb = parameters.output;
    const channels = Math.min(input.length, output.length);
    for (let i = 0; i < output[0].length; i++) {
      let peak = 0;
      for (let ch = 0; ch < channels; ch++) peak = Math.max(peak, Math.abs(input[ch][i] || 0));
      const fastCoef = Math.exp(-1 / (sr * 0.004));
      const slowCoef = Math.exp(-1 / (sr * 0.08));
      this.fast = fastCoef * this.fast + (1 - fastCoef) * peak;
      this.slow = slowCoef * this.slow + (1 - slowCoef) * peak;
      if (Math.abs(this.fast) < 1e-20) this.fast = 0;
      if (Math.abs(this.slow) < 1e-20) this.slow = 0;
      const transient = Math.max(-1, Math.min(1, (this.fast - this.slow) * (3 + sensitivity * 9)));
      const shape = Math.max(0.1, 1 + transient * (attack.length > 1 ? attack[i] : attack[0]) + (this.slow * (sustain.length > 1 ? sustain[i] : sustain[0])));
      const wet = mix.length > 1 ? mix[i] : mix[0];
      const gain = Math.pow(10, (outputDb.length > 1 ? outputDb[i] : outputDb[0]) / 20);
      for (let ch = 0; ch < channels; ch++) output[ch][i] = input[ch][i] * (1 + (shape - 1) * wet) * gain;
    }
    return true;
  }
}

registerProcessor("transient-processor", TransientProcessor);
