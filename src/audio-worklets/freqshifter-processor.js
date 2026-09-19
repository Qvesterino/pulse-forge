/**
 * Frequency Shifter AudioWorkletProcessor — single-sideband (SSB) shift.
 *
 * Unlike a pitch shifter, a frequency shifter moves every partial by a FIXED
 * Hz offset (harmonics stop being harmonic) — the classic unearthly metallic
 * drift for percussion and drones.
 *
 * Implementation: two 8-stage first-order allpass cascades whose pole
 * frequencies interleave (Bristow-Johnson style matched pair). The branches
 * are phase-quadrature across ~150 Hz…8 kHz; quadrature mixing with a complex
 * oscillator at the shift frequency yields the SSB. Coefficients derive from
 * the pole frequencies and the context sample rate, and |c| < 1 always — the
 * cascade cannot blow up.
 *
 * NOTE: served as part of core-worklet.js — plain JavaScript only.
 */
const BRANCH_A_POLES = [75, 150, 300, 600, 1200, 2400, 4800, 7500];
const BRANCH_B_POLES = [250, 500, 1000, 2000, 3000, 4000, 6000, 8000];

class FreqShiftProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.srRef = globalThis.sampleRate || 44100;
    const coefFor = (poleHz) => {
      const t = Math.tan((Math.PI * poleHz) / this.srRef);
      return (t - 1) / (t + 1); // |c| < 1 for any positive pole frequency
    };
    this.coeffsA = BRANCH_A_POLES.map(coefFor);
    this.coeffsB = BRANCH_B_POLES.map(coefFor);
    this.stateA = new Float64Array(BRANCH_A_POLES.length * 2);
    this.stateB = new Float64Array(BRANCH_B_POLES.length * 2);
    this.phase = 0;
  }

  static get parameterDescriptors() {
    return [
      { name: "shift", defaultValue: 0, minValue: -1000, maxValue: 1000, automationRate: "k-rate" },
      { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  allpassBranch(state, coeffs, x) {
    // First-order allpass per stage: y[n] = c·x[n] + x[n−1] − c·y[n−1].
    let out = x;
    for (let s = 0; s < coeffs.length; s++) {
      const c = coeffs[s];
      const xPrev = state[s * 2];
      const yPrev = state[s * 2 + 1];
      const y = c * out + xPrev - c * yPrev;
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
    const sr = this.srRef;

    const shift = parameters.shift[0];
    const mix = parameters.mix[0];
    const phaseInc = (-2 * Math.PI * shift) / sr;

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;

      // Quadrature pair: the two branches are 90° apart in the audio band.
      const xa = this.allpassBranch(this.stateA, this.coeffsA, l);
      const xb = this.allpassBranch(this.stateB, this.coeffsB, l);
      const cosW = Math.cos(this.phase);
      const sinW = Math.sin(this.phase);
      this.phase += phaseInc;
      if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
      if (this.phase < -2 * Math.PI) this.phase += 2 * Math.PI;

      // SSB: real part of (quadrature pair) × complex carrier.
      const wet = xa * cosW - xb * sinW;

      outL[i] = l * (1 - mix) + wet * mix;
      if (outR) outR[i] = r * (1 - mix) + wet * mix;
    }
    return true;
  }
}

registerProcessor("freqshift-processor", FreqShiftProcessor);
