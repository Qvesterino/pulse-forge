/**
 * Ducking Delay AudioWorkletProcessor — delay whose wet tail ducks under dry.
 *
 * Signal path: dry input drives a per-sample peak envelope follower
 * (attack/release). When dry is loud, the wet delayed signal is ducked
 * via `duckGain` so repeats sit behind the beat and bloom in gaps.
 * Delay itself is a classic feedback delay with one-pole damping LP in
 * the loop (tone 500–8000 Hz) and cubic-hermite-interpolated ring buffer.
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

class DuckingDelayProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Ring sized from the runtime sample rate: the 1000 ms max delay must
    // fit with interpolation headroom (131072 ≈ 2.9 s @44.1k but only
    // 0.68 s @192k — keep the pow2 size for mask indexing).
    const sr = globalThis.sampleRate || 44100;
    this.bufSize = DUCK_BUF_SIZE;
    while (this.bufSize < Math.ceil(sr * 1.05)) this.bufSize *= 2;
    this.bufMask = this.bufSize - 1;
    this.bufL = new Float32Array(this.bufSize);
    this.bufR = new Float32Array(this.bufSize);
    this.writeIdx = 0;
    this.env = 0;
    this.dampL = 0;
    this.dampR = 0;
    this.hpfL = 0; // loop-HPF LP state (hp = x − lp)
    this.hpfR = 0;
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
      // Declared so the node wrapper's writes land (the knobs shipped in
      // definitions.ts but were silently dropped before this — undeclared
      // params never materialize in the runtime's `parameters` bag).
      { name: "pingpong", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "loopHpfHz", defaultValue: 40, minValue: 20, maxValue: 400, automationRate: "k-rate" },
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
    const pingpong = (parameters.pingpong ? parameters.pingpong[0] : 0) >= 0.5;
    const loopHpfHz = Math.max(20, Math.min(400, parameters.loopHpfHz ? parameters.loopHpfHz[0] : 40));

    const delaySamples = (delayMs * sr) / 1000;
    const toneAlpha = 1 - Math.exp((-2 * Math.PI * tone) / sr);
    const hpfAlpha = Math.exp((-2 * Math.PI * loopHpfHz) / sr);
    const threshLin = Math.pow(10, threshDb / 20);
    const atkCoef = Math.exp(-1 / (sr * atkSec));
    const relCoef = Math.exp(-1 / (sr * relSec));

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;

      // Envelope follower on dry (peak stereo)
      const peak = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r);
      this.env =
        peak > this.env ? atkCoef * this.env + (1 - atkCoef) * peak : relCoef * this.env + (1 - relCoef) * peak;
      if (Math.abs(this.env) < 1e-20) this.env = 0;

      // Duck gain: 1 when dry below thresh, 1-duckAmt when dry loud
      let duckGain = 1;
      if (duckAmt > 0.001 && this.env > threshLin) {
        const over = (this.env - threshLin) / Math.max(1e-6, 1 - threshLin);
        duckGain = 1 - duckAmt * Math.min(1, over);
        if (duckGain < 0) duckGain = 0;
      }

      // Delay read with cubic-hermite interpolation (cleaner repeats on
      // bright material — linear steps smear transients in the tail)
      const readPos = this.writeIdx - delaySamples;
      const delayedL = this.readCubic(this.bufL, readPos);
      const delayedR = this.readCubic(this.bufR, readPos);

      // Damping LP on feedback path, then loop HPF (anti-mud): one-pole LP
      // state per channel, hp = x − lp.
      this.dampL += toneAlpha * (delayedL - this.dampL);
      this.dampR += toneAlpha * (delayedR - this.dampR);
      this.hpfL += (delayedL - this.hpfL) * (1 - hpfAlpha);
      this.hpfR += (delayedR - this.hpfR) * (1 - hpfAlpha);
      if (Math.abs(this.dampL) < 1e-20) this.dampL = 0;
      if (Math.abs(this.dampR) < 1e-20) this.dampR = 0;
      if (Math.abs(this.hpfL) < 1e-20) this.hpfL = 0;
      if (Math.abs(this.hpfR) < 1e-20) this.hpfR = 0;
      const dampL = this.dampL - this.hpfL;
      const dampR = this.dampR - this.hpfR;

      const wetL = dampL * duckGain;
      const wetR = dampR * duckGain;

      outL[i] = l * (1 - mix) + wetL * mix;
      if (outR) outR[i] = r * (1 - mix) + wetR * mix;

      // Feedback write (feedback not ducked — tail preserves, only output
      // ducks). Ping-pong crossfeeds: each write receives 0.7× the OTHER
      // channel's loop content — the tail bounces L↔R. The crossfeed matrix
      // lifts the symmetric loop eigenvalue to fb·1.7, so ping-pong caps the
      // loop feedback at 0.99/1.7 (bare mode safely reaches 0.9; uncapped the
      // matrix hits 1.53 at the knob max and diverges).
      const fbLoop = pingpong ? Math.min(feedback, 0.99 / 1.7) : feedback;
      let wL = l + dampL * fbLoop;
      let wR = r + dampR * fbLoop;
      if (pingpong) {
        wL += dampR * fbLoop * 0.7;
        wR += dampL * fbLoop * 0.7;
      }
      if (Math.abs(wL) < 1e-20) wL = 0;
      if (Math.abs(wR) < 1e-20) wR = 0;
      this.bufL[this.writeIdx] = wL;
      this.bufR[this.writeIdx] = wR;
      this.writeIdx = (this.writeIdx + 1) & this.bufMask;
    }
    return true;
  }

  readCubic(buf, position) {
    const idx = Math.floor(position);
    const frac = position - idx;
    const m = this.bufMask;
    const i0 = (idx - 1) & m;
    const i1 = idx & m;
    const i2 = (idx + 1) & m;
    const i3 = (idx + 2) & m;
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

registerProcessor("ducking-delay-processor", DuckingDelayProcessor);
