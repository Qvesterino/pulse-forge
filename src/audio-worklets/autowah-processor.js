/**
 * Autowah AudioWorkletProcessor — envelope follower drives a Chamberlin SVF's
 * cutoff frequency per-sample. Playing harder opens the filter; the release
 * tail closes it gradually. This is a SINGLE worklet combining detection and
 * filtering — truly zero-delay (no port messaging, no control-rate polling).
 *
 * The envelope is asymmetric: fast attack tracks the transient, slower
 * release closes the filter gradually. Sensitivity pre-gains the detector
 * so quiet signals can still reach the maxFreq ceiling.
 *
 * Filter: Chamberlin SVF (proven stable across 20–20 kHz) in BP or LP mode
 * with resonance (damping q) for that vocal "wah" quality.
 *
 * NOTE: served RAW to AudioWorklet.addModule() — plain JavaScript only.
 */
class AutowahProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.env = 0;
    this.lpL = 0; this.bpL = 0;
    this.lpR = 0; this.bpR = 0;
  }

  static get parameterDescriptors() {
    return [
      { name: "minFreq", defaultValue: 300, minValue: 100, maxValue: 2000, automationRate: "k-rate" },
      { name: "maxFreq", defaultValue: 2500, minValue: 500, maxValue: 8000, automationRate: "k-rate" },
      { name: "resonance", defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "attack", defaultValue: 0.01, minValue: 0.001, maxValue: 0.1, automationRate: "k-rate" },
      { name: "release", defaultValue: 0.15, minValue: 0.05, maxValue: 1, automationRate: "k-rate" },
      { name: "sensitivity", defaultValue: 1.5, minValue: 0.5, maxValue: 3, automationRate: "k-rate" },
      { name: "mode", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" }, // 0=BP 1=LP
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

    const minF = parameters.minFreq[0];
    const maxF = Math.max(minF + 50, parameters.maxFreq[0]);
    const res = Math.max(0, Math.min(1, parameters.resonance[0]));
    const atkBlend = 1 - Math.exp(-1 / (sr * Math.max(0.001, parameters.attack[0])));
    const relBlend = 1 - Math.exp(-1 / (sr * Math.max(0.05, parameters.release[0])));
    const sens = parameters.sensitivity[0];
    const bpMode = parameters.mode[0] < 0.5;
    const mix = parameters.mix[0];
    const q = 2 - 2 * res; // damping: 2 = max damping, 0 = self-osc

    const clampVal = 8;

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;

      // ---- Envelope follower ----
      const peak = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r);
      const driven = Math.tanh(peak * sens);
      this.env = driven > this.env
        ? this.env + (driven - this.env) * atkBlend
        : this.env + (driven - this.env) * relBlend;
      if (this.env < 1e-20) this.env = 0;

      // ---- Envelope → cutoff frequency ----
      const fc = minF + this.env * (maxF - minF);

      // ---- Chamberlin SVF (cutoff moves per-sample) ----
      const f = 2 * Math.sin(Math.PI * Math.min(fc, sr * 0.24) / sr);

      // Left
      const hpL = l - this.lpL - q * this.bpL;
      this.bpL += f * hpL;
      this.lpL += f * this.bpL;
      if (this.bpL > clampVal) this.bpL = clampVal; else if (this.bpL < -clampVal) this.bpL = -clampVal;
      if (this.lpL > clampVal) this.lpL = clampVal; else if (this.lpL < -clampVal) this.lpL = -clampVal;

      // Right
      const hpR = r - this.lpR - q * this.bpR;
      this.bpR += f * hpR;
      this.lpR += f * this.bpR;
      if (this.bpR > clampVal) this.bpR = clampVal; else if (this.bpR < -clampVal) this.bpR = -clampVal;
      if (this.lpR > clampVal) this.lpR = clampVal; else if (this.lpR < -clampVal) this.lpR = -clampVal;

      // Mode select
      let fL, fR;
      if (bpMode) { fL = this.bpL; fR = this.bpR; }
      else { fL = this.lpL; fR = this.lpR; }

      outL[i] = l * (1 - mix) + fL * mix;
      if (outR) outR[i] = r * (1 - mix) + fR * mix;
    }
    return true;
  }
}

registerProcessor("autowah-processor", AutowahProcessor);
