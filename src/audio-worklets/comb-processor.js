/**
 * Comb Filter AudioWorkletProcessor — static delay with feedback.
 *
 * Feedback comb: y[n] = x[n] + fb * damp(lowpass(y[n-D])).
 * D is the tunable delay (0.5–60 ms, ~20 Hz–2 kHz fundamental).
 * Positive feedback resonates at harmonics (metallic), negative at odd
 * harmonics (hollow). Damp is a one-pole lowpass in the feedback loop
 * that tames highs so the tail doesn't shriek — 500 Hz (dark) .. 12000 Hz (bright).
 *
 * Ring buffer is power-of-2 (8192 ≈ 170 ms @48k) with cubic-hermite interpolation
 * for fractional delays. Deterministic live==offline (no random, phase reset
 * to zero per context). Denormal guard flushes tiny state.
 *
 * NOTE: served RAW to AudioWorklet.addModule() — plain JavaScript only.
 */
const COMB_SIZE = 8192;
const COMB_MASK = COMB_SIZE - 1;

class CombProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufL = new Float32Array(COMB_SIZE);
    this.bufR = new Float32Array(COMB_SIZE);
    this.writeIdx = 0;
    this.dampL = 0;
    this.dampR = 0;
  }

  static get parameterDescriptors() {
    return [
      { name: "delayMs", defaultValue: 12, minValue: 0.5, maxValue: 60, automationRate: "k-rate" },
      { name: "feedback", defaultValue: 0.5, minValue: -0.95, maxValue: 0.95, automationRate: "k-rate" },
      { name: "damp", defaultValue: 6500, minValue: 500, maxValue: 12000, automationRate: "k-rate" },
      { name: "mix", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      // STEREO SPREAD: the right channel reads at (1 + 0.35·spread)× the
      // delay — the L/R notches separate, turning the metallic mono comb
      // into a wide stereo resonator.
      { name: "spread", defaultValue: 0.25, minValue: 0, maxValue: 1, automationRate: "k-rate" },
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

    const delayMs = Math.max(0.5, Math.min(60, parameters.delayMs[0]));
    const feedback = Math.max(-0.95, Math.min(0.95, parameters.feedback[0]));
    const dampFreq = Math.max(500, Math.min(12000, parameters.damp[0]));
    const mix = Math.max(0, Math.min(1, parameters.mix[0]));
    const spread = Math.max(0, Math.min(1, parameters.spread ? parameters.spread[0] : 0.25));

    const delaySamples = (delayMs * sr) / 1000;
    const dampAlpha = 1 - Math.exp((-2 * Math.PI * dampFreq) / sr);

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;

      const readPos = this.writeIdx - delaySamples;
      const delayedL = this.readCubic(this.bufL, readPos);
      // Spread: the right channel reads proportionally DEEPER into the
      // buffer — its notches land at different frequencies than the left's.
      const readPosR = this.writeIdx - delaySamples * (1 + 0.35 * spread);
      const delayedR = this.readCubic(this.bufR, readPosR);

      // Damp in feedback loop (one-pole lowpass)
      this.dampL += dampAlpha * (delayedL - this.dampL);
      this.dampR += dampAlpha * (delayedR - this.dampR);
      if (Math.abs(this.dampL) < 1e-20) this.dampL = 0;
      if (Math.abs(this.dampR) < 1e-20) this.dampR = 0;
      const wetL = this.dampL;
      const wetR = this.dampR;

      // Write feedback comb into buffer (input + feedback*wet)
      let wL = l + feedback * wetL;
      let wR = r + feedback * wetR;
      if (Math.abs(wL) < 1e-20) wL = 0;
      if (Math.abs(wR) < 1e-20) wR = 0;
      this.bufL[this.writeIdx] = wL;
      this.bufR[this.writeIdx] = wR;
      this.writeIdx = (this.writeIdx + 1) & COMB_MASK;

      outL[i] = l * (1 - mix) + wetL * mix;
      if (outR) outR[i] = r * (1 - mix) + wetR * mix;
    }
    return true;
  }

  readCubic(buf, position) {
    const idx = Math.floor(position);
    const frac = position - idx;
    const i0 = (idx - 1) & COMB_MASK;
    const i1 = idx & COMB_MASK;
    const i2 = (idx + 1) & COMB_MASK;
    const i3 = (idx + 2) & COMB_MASK;
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

registerProcessor("comb-processor", CombProcessor);
