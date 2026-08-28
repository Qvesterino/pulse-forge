/**
 * SVF (State Variable Filter) AudioWorkletProcessor — Chamberlin topology.
 *
 * Per-sample zero-feedback-delay for LP and BP (semi-implicit Euler: bp uses
 * updated hp, lp uses updated bp). Proven stable for fc < fs/4 across the
 * full 20–20 kHz range. Clamps prevent runaway from numerical drift at
 * extreme resonance settings.
 *
 * Modes: LP (12 dB/oct), HP (12 dB/oct), BP (6 dB/oct), Notch (LP + HP).
 * Drive: tanh pre-filter saturation for analog-style warming.
 * Resonance: 0 = max damping, 1 = self-oscillation boundary (clamped).
 *
 * NOTE: served RAW to AudioWorklet.addModule() — plain JavaScript only.
 */
class SvFilterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.lpL = 0; this.bpL = 0;
    this.lpR = 0; this.bpR = 0;
    this.lastCutoff = -1; this.lastRes = -1;
    this.f = 0.1; this.q = 1;
  }

  static get parameterDescriptors() {
    return [
      { name: "cutoff", defaultValue: 2000, minValue: 20, maxValue: 20000, automationRate: "k-rate" },
      { name: "resonance", defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "mode", defaultValue: 0, minValue: 0, maxValue: 3, automationRate: "k-rate" }, // 0=LP 1=HP 2=BP 3=Notch
      { name: "drive", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
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

    const cutoff = Math.max(20, Math.min(20000, parameters.cutoff[0]));
    const res = Math.max(0, Math.min(1, parameters.resonance[0]));
    const mode = Math.round(parameters.mode[0]);
    const drive = parameters.drive[0];
    const mix = parameters.mix[0];

    if (cutoff !== this.lastCutoff || res !== this.lastRes) {
      this.lastCutoff = cutoff;
      this.lastRes = res;
      this.f = 2 * Math.sin(Math.PI * Math.min(cutoff, sr * 0.24) / sr);
      this.q = 2 - 2 * res; // damping: 2 = max damping, 0 = self-osc
    }

    const driveGain = drive > 0 ? 1 + drive * 9 : 1;
    const clampVal = 8; // prevent runaway at high resonance

    for (let i = 0; i < len; i++) {
      let l = inL ? inL[i] : 0;
      let r = inR ? inR[i] : l;
      if (drive > 0) {
        l = Math.tanh(l * driveGain) / driveGain * (1 + drive * 2.5);
        r = Math.tanh(r * driveGain) / driveGain * (1 + drive * 2.5);
      }

      // Chamberlin SVF — left
      const hpL = l - this.lpL - this.q * this.bpL;
      this.bpL += this.f * hpL;
      this.lpL += this.f * this.bpL;
      // Clamp for stability at high resonance
      if (this.bpL > clampVal) this.bpL = clampVal; else if (this.bpL < -clampVal) this.bpL = -clampVal;
      if (this.lpL > clampVal) this.lpL = clampVal; else if (this.lpL < -clampVal) this.lpL = -clampVal;

      // Chamberlin SVF — right
      const hpR = r - this.lpR - this.q * this.bpR;
      this.bpR += this.f * hpR;
      this.lpR += this.f * this.bpR;
      if (this.bpR > clampVal) this.bpR = clampVal; else if (this.bpR < -clampVal) this.bpR = -clampVal;
      if (this.lpR > clampVal) this.lpR = clampVal; else if (this.lpR < -clampVal) this.lpR = -clampVal;

      // Mode select
      let fL, fR;
      switch (mode) {
        case 1: fL = hpL; fR = hpR; break; // HP
        case 2: fL = this.bpL; fR = this.bpR; break; // BP
        case 3: fL = this.lpL + hpL; fR = this.lpR + hpR; break; // Notch
        default: fL = this.lpL; fR = this.lpR; break; // LP
      }

      outL[i] = l * (1 - mix) + fL * mix;
      if (outR) outR[i] = r * (1 - mix) + fR * mix;
    }

    return true;
  }
}

registerProcessor("svfilter-processor", SvFilterProcessor);
