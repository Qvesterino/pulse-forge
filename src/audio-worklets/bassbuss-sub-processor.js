/**
 * BassBuss Sub-Osc AudioWorkletProcessor — one octave DOWN generator.
 *
 * Takes an already-lowpassed signal, detects zero crossings, and emits a
 * square at HALF the input frequency (÷2 octave below), then rounds it into
 * a sine-ish blob with a one-pole LP. Classic sub-octave synth trick: the
 * divider holds each half-wave twice as long, so a 55 Hz bass becomes a
 * 27.5 Hz fundamental.
 *
 * - `amount` 0..1: wet gain of the sub voice (mixed by the host factory).
 * - Mono-sums L+R first (sub is mono by definition — bass keeps its power
 *   in the center).
 * - Hysteresis on the zero-crossing detector (±0.01) stops double-triggers
 *   on noisy waveforms.
 * - Deterministic: no RNG.
 *
 * NOTE: served as part of core-worklet.js — plain JavaScript only.
 */
class BassBussSubProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.lastSign = 0;
    this.halfPeriod = 0; // samples since last crossing
    this.subLevel = 1; // ±1 square state — must start non-zero or the ÷2
    // negation stays at zero forever.
    this.lp = 0;
  }

  static get parameterDescriptors() {
    return [{ name: "amount", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" }];
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
    const amount = Math.max(0, Math.min(1, parameters.amount ? parameters.amount[0] : 0));
    // Sub voice LP corner scales mildly with amount — deeper = rounder.
    const lpCoef = 1 - Math.exp((-2 * Math.PI * (120 + amount * 60)) / sr);
    const HYST = 0.01;

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;
      const mono = (l + r) * 0.5;

      // Zero-crossing detect with hysteresis — flip the ÷2 state ONLY on
      // UPWARD crossings: a full input period then yields one toggle, i.e.
      // the sub square runs at HALF the input frequency.
      const sign = mono > HYST ? 1 : mono < -HYST ? -1 : this.lastSign;
      if (this.lastSign < 0 && sign > 0 && this.halfPeriod > 16) {
        this.subLevel = -this.subLevel;
        this.halfPeriod = 0;
      } else {
        this.halfPeriod++;
      }
      this.lastSign = sign;

      // Round the square into a sine-ish blob (LP scales with frequency so
      // high notes keep some definition, low notes stay round).
      this.lp += lpCoef * (this.subLevel - this.lp);
      if (Math.abs(this.lp) < 1e-20) this.lp = 0;

      const sub = amount > 0.001 ? this.lp * amount : 0;
      outL[i] = sub;
      if (outR) outR[i] = sub;
    }
    return true;
  }
}

registerProcessor("bassbuss-sub-processor", BassBussSubProcessor);
