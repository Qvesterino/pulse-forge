/**
 * Flanger AudioWorkletProcessor — per-sample modulated delay with zero-delay
 * feedback (TPT: feedback feeds back within the same sample, not one render
 * quantum late like native DelayNode loops).
 *
 * L/R have independent LFO phases (spread controls the offset) for stereo
 * width. An invert switch enables through-zero-style flanging character.
 *
 * Delay ring buffer is power-of-2 sized for mask indexing (base + depth max
 * 30 ms, at 48 kHz = 1440 samples → 2048 buffer).
 *
 * NOTE: served RAW to AudioWorklet.addModule() — plain JavaScript only.
 */
const FLANGER_DIVISOR = 2048;
const FLANGER_MASK = FLANGER_DIVISOR - 1;

class FlangerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufL = new Float32Array(FLANGER_DIVISOR);
    this.bufR = new Float32Array(FLANGER_DIVISOR);
    this.writeIdx = 0;
    this.lfoPhaseL = 0;
    this.lfoPhaseR = Math.PI * (2 / 3); // 120° offset for stereo width
    this.gain = 1;
  }

  static get parameterDescriptors() {
    return [
      { name: "rate", defaultValue: 0.5, minValue: 0.05, maxValue: 10, automationRate: "k-rate" },
      { name: "depth", defaultValue: 3, minValue: 0, maxValue: 10, automationRate: "k-rate" }, // ms
      { name: "base", defaultValue: 5, minValue: 0.5, maxValue: 20, automationRate: "k-rate" }, // ms
      { name: "feedback", defaultValue: 0.4, minValue: 0, maxValue: 0.95, automationRate: "k-rate" },
      { name: "spread", defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "mix", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" },
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

    const rate = parameters.rate[0];
    const depthSec = Math.max(0, parameters.depth[0]) / 1000;
    const baseSec = Math.max(0.0005, parameters.base[0]) / 1000;
    const feedback = Math.max(0, Math.min(0.95, parameters.feedback[0]));
    const spread = parameters.spread[0];
    const mix = parameters.mix[0];

    const lfoRateRad = (2 * Math.PI * rate) / sr;
    const depthSamples = depthSec * sr;
    const baseSamples = baseSec * sr;
    const spreadOffset = spread * Math.PI;

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;

      // LFO → delay times per channel
      const lfoL = Math.sin(this.lfoPhaseL);
      const lfoR = Math.sin(this.lfoPhaseR);
      this.lfoPhaseL += lfoRateRad;
      this.lfoPhaseR += lfoRateRad;
      // Wrap phases
      if (this.lfoPhaseL > 2 * Math.PI) this.lfoPhaseL -= 2 * Math.PI;
      if (this.lfoPhaseR > 2 * Math.PI) this.lfoPhaseR -= 2 * Math.PI;

      const delayLSamples = baseSamples + depthSamples * (0.5 + 0.5 * lfoL);
      const delayRSamples = baseSamples + depthSamples * (0.5 + 0.5 * lfoR);

      // Read from ring buffer with linear interpolation
      const readL = this.writeIdx - delayLSamples;
      const readR = this.writeIdx - delayRSamples;
      const wetL = this.readLinear(this.bufL, readL);
      const wetR = this.readLinear(this.bufR, readR);

      // Zero-delay feedback: wet signal feeds back into the buffer NOW
      this.bufL[this.writeIdx] = l + wetL * feedback;
      this.bufR[this.writeIdx] = r + wetR * feedback;
      this.writeIdx = (this.writeIdx + 1) & FLANGER_MASK;

      outL[i] = l * (1 - mix) + wetL * mix;
      if (outR) outR[i] = r * (1 - mix) + wetR * mix;
    }

    // Denormal guard
    if (Math.abs(this.bufL[this.writeIdx]) < 1e-20) this.bufL[this.writeIdx] = 0;
    if (Math.abs(this.bufR[this.writeIdx]) < 1e-20) this.bufR[this.writeIdx] = 0;

    return true;
  }

  readLinear(buf, position) {
    const idx0 = Math.floor(position);
    const frac = position - idx0;
    const i0 = idx0 & FLANGER_MASK;
    const i1 = (idx0 + 1) & FLANGER_MASK;
    return buf[i0] * (1 - frac) + buf[i1] * frac;
  }
}

registerProcessor("flanger-processor", FlangerProcessor);
