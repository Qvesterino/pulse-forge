/**
 * Envelope Follower AudioWorkletProcessor.
 *
 * Per-sample asymmetric peak detector (attack/release smoothing) driving a
 * normalized 0..1 control signal on its output. Sensitivity pre-drives the
 * rectified peak through tanh so hot sources saturate instead of blowing the
 * control range past unity. The engine routes this output through a depth
 * Gain into native AudioParams (track volume / pan) exactly like an LFO.
 *
 * Detector input always taps the SOURCE track's PRE-FX/pre-gain point, which
 * keeps self-hosted followers feedback-free.
 *
 * NOTE: served RAW to AudioWorklet.addModule() — plain JavaScript only.
 */
class EnvFollowerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.env = 0;
  }

  static get parameterDescriptors() {
    return [
      { name: "attack", defaultValue: 0.012, minValue: 0.001, maxValue: 1, automationRate: "k-rate" },
      { name: "release", defaultValue: 0.18, minValue: 0.01, maxValue: 3, automationRate: "k-rate" },
      { name: "sensitivity", defaultValue: 1.5, minValue: 0.2, maxValue: 3, automationRate: "k-rate" },
    ];
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const out = output[0];
    const input = inputs[0];
    const inL = input && input[0] && input[0].length ? input[0] : null;
    const inR = input && input.length > 1 && input[1] && input[1].length ? input[1] : null;
    const sr = globalThis.sampleRate || 44100;
    const atkBlend = 1 - Math.exp(-1 / (sr * Math.max(0.001, parameters.attack[0])));
    const relBlend = 1 - Math.exp(-1 / (sr * Math.max(0.01, parameters.release[0])));
    const sens = Math.max(0.2, Math.min(3, parameters.sensitivity[0]));

    for (let i = 0; i < out.length; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;
      const peak = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r);
      const driven = Math.tanh(peak * sens);
      this.env = driven > this.env
        ? this.env + (driven - this.env) * atkBlend
        : this.env + (driven - this.env) * relBlend;
      if (this.env < 1e-20) this.env = 0; // denormal guard for long silences
      out[i] = this.env;
    }
    return true;
  }
}

registerProcessor("envfollower-processor", EnvFollowerProcessor);
