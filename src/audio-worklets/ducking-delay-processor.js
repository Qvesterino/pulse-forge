/**
 * Ducking Delay AudioWorkletProcessor — delay whose wet tail ducks under dry.
 *
 * Signal path: dry input drives a per-sample peak envelope follower
 * (attack/release). When dry is loud, the wet delayed signal is ducked
 * via `duckGain` so repeats sit behind the beat and bloom in gaps.
 * Delay itself is a classic feedback delay with one-pole damping LP in
 * the loop (tone 500–8000 Hz) and linear-interpolated ring buffer.
 *
 * Buffer: 131072 samples (2^17 ≈ 2.9 s @44.1k) covers 1 s max delay.
 * Denormal guard <1e-20 on envelope and damp state.
 *
 * Params: time 30–1000 ms, feedback 0–0.9, tone, duckAmount 0–1,
 * duckThresh −60..0 dB, duckAttack 0.001–0.5 s, duckRelease 0.02–1 s, mix.
 *
 * NOTE: served RAW to AudioWorklet.addModule() — plain JavaScript only.
 */
const DUCK_BUF_SIZE = 131072;
const DUCK_MASK = DUCK_BUF_SIZE - 1;

class DuckingDelayProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufL = new Float32Array(DUCK_BUF_SIZE);
    this.bufR = new Float32Array(DUCK_BUF_SIZE);
    this.writeIdx = 0;
    this.env = 0;
    this.dampL = 0;
    this.dampR = 0;
  }

  static get parameterDescriptors() {
    return [
      { name: "time", defaultValue: 375, minValue: 30, maxValue: 1000, automationRate: "k-rate" },
      { name: "feedback", defaultValue: 0.35, minValue: 0, maxValue: 0.9, automationRate: "k-rate" },
      { name: "tone", defaultValue: 4000, minValue: 500, maxValue: 8000, automationRate: "k-rate" },
      { name: "duckAmount", defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "duckThresh", defaultValue: -24, minValue: -60, maxValue: 0, automationRate: "k-rate" },
      { name: "duckAttack", defaultValue: 0.005, minValue: 0.001, maxValue: 0.5, automationRate: "k-rate" },
      { name: "duckRelease", defaultValue: 0.18, minValue: 0.02, maxValue: 1, automationRate: "k-rate" },
      { name: "mix", defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: "k-rate" },
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

    const delayMs = Math.max(30, Math.min(1000, parameters.time[0]));
    const feedback = Math.max(0, Math.min(0.9, parameters.feedback[0]));
    const tone = Math.max(500, Math.min(8000, parameters.tone[0]));
    const duckAmt = Math.max(0, Math.min(1, parameters.duckAmount[0]));
    const threshDb = Math.max(-60, Math.min(0, parameters.duckThresh[0]));
    const atkSec = Math.max(0.001, parameters.duckAttack[0]);
    const relSec = Math.max(0.02, parameters.duckRelease[0]);
    const mix = Math.max(0, Math.min(1, parameters.mix[0]));

    const delaySamples = delayMs * sr / 1000;
    const toneAlpha = 1 - Math.exp(-2 * Math.PI * tone / sr);
    const threshLin = Math.pow(10, threshDb / 20);
    const atkCoef = Math.exp(-1 / (sr * atkSec));
    const relCoef = Math.exp(-1 / (sr * relSec));

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;

      // Envelope follower on dry (peak stereo)
      const peak = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r);
      this.env = peak > this.env
        ? atkCoef * this.env + (1 - atkCoef) * peak
        : relCoef * this.env + (1 - relCoef) * peak;
      if (Math.abs(this.env) < 1e-20) this.env = 0;

      // Duck gain: 1 when dry below thresh, 1-duckAmt when dry loud
      let duckGain = 1;
      if (duckAmt > 0.001 && this.env > threshLin) {
        const over = (this.env - threshLin) / Math.max(1e-6, 1 - threshLin);
        duckGain = 1 - duckAmt * Math.min(1, over);
        if (duckGain < 0) duckGain = 0;
      }

      // Delay read with linear interpolation
      const readPos = this.writeIdx - delaySamples;
      const delayedL = this.readLinear(this.bufL, readPos);
      const delayedR = this.readLinear(this.bufR, readPos);

      // Damping LP on feedback path
      this.dampL += toneAlpha * (delayedL - this.dampL);
      this.dampR += toneAlpha * (delayedR - this.dampR);
      if (Math.abs(this.dampL) < 1e-20) this.dampL = 0;
      if (Math.abs(this.dampR) < 1e-20) this.dampR = 0;
      const dampL = this.dampL;
      const dampR = this.dampR;

      const wetL = dampL * duckGain;
      const wetR = dampR * duckGain;

      outL[i] = l * (1 - mix) + wetL * mix;
      if (outR) outR[i] = r * (1 - mix) + wetR * mix;

      // Feedback write (feedback not ducked — tail preserves, only output ducks)
      let wL = l + dampL * feedback;
      let wR = r + dampR * feedback;
      if (Math.abs(wL) < 1e-20) wL = 0;
      if (Math.abs(wR) < 1e-20) wR = 0;
      this.bufL[this.writeIdx] = wL;
      this.bufR[this.writeIdx] = wR;
      this.writeIdx = (this.writeIdx + 1) & DUCK_MASK;
    }
    return true;
  }

  readLinear(buf, position) {
    const idx0 = Math.floor(position);
    const frac = position - idx0;
    const i0 = idx0 & DUCK_MASK;
    const i1 = (idx0 + 1) & DUCK_MASK;
    return buf[i0] * (1 - frac) + buf[i1] * frac;
  }
}

registerProcessor("ducking-delay-processor", DuckingDelayProcessor);
