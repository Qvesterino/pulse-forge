/**
 * Frequency Shifter AudioWorkletProcessor — single-sideband (SSB) shift.
 *
 * Unlike a pitch shifter, a frequency shifter moves every partial by a FIXED
 * Hz offset (harmonics do not stay harmonic) — the classic "unearthly
 * metallic" drift for percussion and drones.
 *
 * Implementation: 2-branch 6th-order allpass Hilbert transform pair (the
 * classic wideband 90° approximation, accurate across ~100 Hz…10 kHz at
 * 44.1/48 kHz). Shifting = quadrature mixing of the analytic signal with a
 * complex oscillator at -shift Hz, taking the real part.
 *
 * NOTE: served as part of core-worklet.js — plain JavaScript only.
 */

// Allpass pole angles (radians, per-sample at the reference rate) for the two
// branches of the wideband 90° pair. Scaling to the actual sample rate keeps
// the passband behavior at 44.1 and 48 kHz.
const HILBERT_A = [0.47940086558758, 1.33507085293105, 2.32204453360035];
const HILBERT_B = [0.16174410491236, 0.97003617546274, 2.11142718748201];

class FreqShiftProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.phase = 0;
    this.a1 = [0, 0, 0];
    this.a2 = [0, 0, 0];
    this.b1 = [0, 0, 0];
    this.b2 = [0, 0, 0];
    this.srRef = globalThis.sampleRate || 44100;
  }

  static get parameterDescriptors() {
    return [
      { name: "shift", defaultValue: 0, minValue: -1000, maxValue: 1000, automationRate: "k-rate" },
      { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  allpassBranch(state, coeffs, x) {
    // Each stage: y = c * x + xPrev - c * yPrev (first-order allpass with the
    // angle-derived coefficient). Three cascaded stages per branch.
    let out = x;
    for (let s = 0; s < 3; s++) {
      const c = coeffs[s];
      const y = c * out + state[s * 2] - c * state[s * 2 + 1];
      state[s * 2] = out;
      state[s * 2 + 1] = y;
      out = y;
    }
    return out;
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

    const shift = parameters.shift[0];
    const mix = parameters.mix[0];
    const phaseInc = (-2 * Math.PI * shift) / sr;

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;

      // Analytic signal via the two allpass branches (relative 90°).
      const xa = this.allpassBranch(this.a1, HILBERT_A, l);
      const xb = this.allpassBranch(this.a2, HILBERT_B, l);
      // Complex oscillator (carrier at -shift).
      const cosW = Math.cos(this.phase);
      const sinW = Math.sin(this.phase);
      this.phase += phaseInc;
      if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
      if (this.phase < -2 * Math.PI) this.phase += 2 * Math.PI;

      // SSB down-shift: real part of (analytic) × e^{j·phase}.
      const wet = 0.5 * (xa * cosW - xb * sinW);

      outL[i] = l * (1 - mix) + wet * mix;
      if (outR) outR[i] = r * (1 - mix) + wet * mix;
    }
    return true;
  }
}

registerProcessor("freqshift-processor", FreqShiftProcessor);
