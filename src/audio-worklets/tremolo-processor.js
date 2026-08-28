/**
 * Tremolo AudioWorkletProcessor — amplitude modulation via LFO.
 *
 * Two modes:
 *   0 = AM  (both channels scaled equally — classic tremolo)
 *   1 = Auto-Pan (LFO pans between L and R instead of changing gain)
 *
 * Shape parameter morphs between sine (0) and square (1) LFO waveform for
 * harder rhythmic gating feel.
 *
 * NOTE: served RAW to AudioWorklet.addModule() — plain JavaScript only.
 */
class TremoloProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.lfoPhase = 0;
    this.gainL = 1;
    this.gainR = 1;
  }

  static get parameterDescriptors() {
    return [
      { name: "rate", defaultValue: 5, minValue: 0.1, maxValue: 20, automationRate: "k-rate" },
      { name: "depth", defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "shape", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" }, // 0=sine 1=square
      { name: "mode", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" }, // 0=AM 1=auto-pan
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

    const rate = parameters.rate[0];
    const depth = parameters.depth[0];
    const shape = parameters.shape[0];
    const autoPan = parameters.mode[0] >= 0.5;
    const mix = parameters.mix[0];
    const phaseRate = (2 * Math.PI * rate) / sr;

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;

      // LFO sine, morphed toward square by `shape`
      const raw = Math.sin(this.lfoPhase);
      const shaped = raw * (1 - shape) + (raw >= 0 ? 1 : -1) * shape;
      // Normalize to 0..1 for depth modulation (1 = full signal, 0 = ducked)
      const lfo = (shaped + 1) * 0.5;

      let gainL = 1;
      let gainR = 1;
      if (autoPan) {
        // Auto-pan: LFO pans between channels (depth controls width)
        const pan = shaped * depth;
        gainL = 1 - Math.max(0, pan);
        gainR = 1 + Math.min(0, pan);
      } else {
        // AM tremolo: gain oscillates between (1-depth) and 1
        const g = 1 - depth * (1 - lfo);
        gainL = g;
        gainR = g;
      }

      this.gainL += (gainL - this.gainL) * 0.5; // light smoothing for click-free param changes
      this.gainR += (gainR - this.gainR) * 0.5;
      if (Math.abs(this.gainL) < 1e-20) this.gainL = 0;
      if (Math.abs(this.gainR) < 1e-20) this.gainR = 0;

      outL[i] = l * (1 - mix) + l * this.gainL * mix;
      if (outR) outR[i] = r * (1 - mix) + r * this.gainR * mix;

      this.lfoPhase += phaseRate;
      if (this.lfoPhase > 2 * Math.PI) this.lfoPhase -= 2 * Math.PI;
    }
    return true;
  }
}

registerProcessor("tremolo-processor", TremoloProcessor);
