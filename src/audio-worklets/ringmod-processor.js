/**
 * Ring Modulator AudioWorkletProcessor — signal × carrier sine.
 *
 * True ring modulation (bipolar multiply): output contains only the sum and
 * difference sidebands of the input against the carrier — the carrier itself
 * cancels. `feedback` routes a scaled copy of the output back into the carrier
 * phase, producing the classic metallic "ring" growl at low carrier rates.
 *
 * NOTE: served as part of core-worklet.js — plain JavaScript only.
 */
class RingModProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.phase = 0;
    this.lastOut = 0;
  }

  static get parameterDescriptors() {
    return [
      { name: "frequency", defaultValue: 220, minValue: 0.1, maxValue: 2000, automationRate: "k-rate" },
      { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "feedback", defaultValue: 0, minValue: 0, maxValue: 0.9, automationRate: "k-rate" },
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

    const freq = parameters.frequency[0];
    const mix = parameters.mix[0];
    const feedback = parameters.feedback[0];
    const phaseInc = (2 * Math.PI * freq) / sr;

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;
      const mod = Math.sin(this.phase + this.lastOut * feedback * Math.PI);
      this.phase += phaseInc;
      if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;

      let wetL = l * mod;
      let wetR = r * mod;
      // Denormal guard — long quiet tails can stall some engines otherwise.
      if (Math.abs(wetL) < 1e-20) wetL = 0;
      if (Math.abs(wetR) < 1e-20) wetR = 0;
      this.lastOut = wetL;

      outL[i] = l * (1 - mix) + wetL * mix;
      if (outR) outR[i] = r * (1 - mix) + wetR * mix;
    }
    return true;
  }
}

registerProcessor("ringmod-processor", RingModProcessor);
