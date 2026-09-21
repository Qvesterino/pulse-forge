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
      // TZF: inverts the wet polarity — with a short base delay the notch
      // sweeps THROUGH zero (through-zero flanging) instead of stopping at
      // the dry signal.
      { name: "invert", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
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
    const invert = (parameters.invert ? parameters.invert[0] : 0) >= 0.5 ? -1 : 1;

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

      // Read from ring buffer with cubic-hermite interpolation (smooth
      // fractional LFO sweeps — linear steps zipper at slow rates)
      const readL = this.writeIdx - delayLSamples;
      const readR = this.writeIdx - delayRSamples;
      const wetL = this.readCubic(this.bufL, readL);
      const wetR = this.readCubic(this.bufR, readR);

      // Zero-delay feedback: wet signal feeds back into the buffer NOW.
      // TZF invert flips the wet polarity both in the loop and at the mix
      // tap — the classic through-zero notch sweep.
      this.bufL[this.writeIdx] = l + wetL * invert * feedback;
      this.bufR[this.writeIdx] = r + wetR * invert * feedback;
      this.writeIdx = (this.writeIdx + 1) & FLANGER_MASK;

      outL[i] = l * (1 - mix) + wetL * invert * mix;
      if (outR) outR[i] = r * (1 - mix) + wetR * invert * mix;
    }

    // Denormal guard
    if (Math.abs(this.bufL[this.writeIdx]) < 1e-20) this.bufL[this.writeIdx] = 0;
    if (Math.abs(this.bufR[this.writeIdx]) < 1e-20) this.bufR[this.writeIdx] = 0;

    return true;
  }

  readCubic(buf, position) {
    const idx = Math.floor(position);
    const frac = position - idx;
    const i0 = (idx - 1) & FLANGER_MASK;
    const i1 = idx & FLANGER_MASK;
    const i2 = (idx + 1) & FLANGER_MASK;
    const i3 = (idx + 2) & FLANGER_MASK;
    const y0 = buf[i0];
    const y1 = buf[i1];
    const y2 = buf[i2];
    const y3 = buf[i3];
    // Catmull-Rom form of cubic Hermite.
    const c0 = y1;
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * frac + c2) * frac + c1) * frac + c0;
  }
}

registerProcessor("flanger-processor", FlangerProcessor);
