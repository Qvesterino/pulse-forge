/**
 * Tape Stop / Spin AudioWorkletProcessor — varispeed on a live stream.
 *
 * The write head records the incoming signal at 1.0× into a ring buffer at
 * all times. The read head's rate eases between 1.0 and 0 with the selected
 * curve, so pitch drops (or rises on catch-up) exactly like a turntable
 * platter losing (or regaining) power.
 *
 * Modes:
 *   0 = STOP  — engaged ramps the read rate to 0 (audio slows to silence)
 *   1 = SPIN  — engaged ramps the read rate to 0 while the transport keeps
 *               writing; disengaging winds the tape back up through the
 *               material it skipped (backlog-capped catch-up)
 *
 * Backlog is clamped: if the read head falls more than ~75% of the buffer
 * behind the write head, it snaps forward — a stalled tape must never replay
 * half a minute of stale audio after release.
 *
 * NOTE: served as part of core-worklet.js — plain JavaScript only.
 */
class TapeStopProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sr = globalThis.sampleRate || 44100;
    // 4 s stereo ring buffer — covers the longest ramp (8 s stop keeps the
    // last 4 s of material readable, which is the audibly relevant window).
    this.bufferLen = sr * 4;
    this.bufL = new Float32Array(this.bufferLen);
    this.bufR = new Float32Array(this.bufferLen);
    this.writePos = 0;
    this.readPos = 0;
    this.rate = 1;
    this.initialized = false;
  }

  static get parameterDescriptors() {
    return [
      { name: "engaged", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "time", defaultValue: 1, minValue: 0.1, maxValue: 8, automationRate: "k-rate" },
      { name: "curve", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" }, // 0=exp 1=lin
      { name: "spin", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" }, // 0=stop 1=spin(rev)
      { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  readSample(pos) {
    const len = this.bufferLen;
    let p = pos % len;
    if (p < 0) p += len;
    const i0 = Math.floor(p);
    const frac = p - i0;
    const i1 = (i0 + 1) % len;
    return this.bufL[i0] * (1 - frac) + this.bufL[i1] * frac;
  }

  readSampleR(pos) {
    const len = this.bufferLen;
    let p = pos % len;
    if (p < 0) p += len;
    const i0 = Math.floor(p);
    const frac = p - i0;
    const i1 = (i0 + 1) % len;
    return this.bufR[i0] * (1 - frac) + this.bufR[i1] * frac;
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

    const engaged = parameters.engaged[0] >= 0.5;
    const time = Math.max(0.1, parameters.time[0]);
    const linear = parameters.curve[0] >= 0.5;
    const spin = parameters.spin[0] >= 0.5;
    const mix = parameters.mix[0];

    const targetRate = engaged ? 0 : 1;
    const backlog = this.writePos - this.readPos;
    // Catch-up: on release, wind through the skipped material faster than
    // real time (capped) so the read head returns to the live edge.
    const catchUp = !engaged && backlog > sr * 0.25 ? Math.min(4, 1 + backlog / (time * sr)) : 1;
    const rateTarget = targetRate * catchUp;
    // Per-sample easing coefficient for the selected curve.
    const blocks = time * sr;
    const coef = linear ? 1 / blocks : 1 - Math.exp(-5 / blocks);

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;

      // Write at tape speed (1.0×) — the transport never slows, only the head.
      this.bufL[this.writePos % this.bufferLen] = l;
      this.bufR[this.writePos % this.bufferLen] = r;
      this.writePos += 1;

      // Rate easing toward the target (exponential or linear per sample).
      if (linear) {
        const step = 1 / blocks;
        this.rate += Math.sign(rateTarget - this.rate) * Math.min(step, Math.abs(rateTarget - this.rate));
      } else {
        this.rate += (rateTarget - this.rate) * coef;
      }
      if (Math.abs(this.rate) < 1e-4) this.rate = engaged ? this.rate : 0;

      // Spin mode reads backwards off the stalled tape (classic slipmat rev).
      const spinDir = spin && engaged ? -1 : 1;
      if (this.writePos - this.readPos > this.bufferLen * 0.75) {
        this.readPos = this.writePos - this.bufferLen * 0.75;
      }
      if (!this.initialized) {
        this.readPos = Math.max(0, this.writePos - 1);
        this.initialized = true;
      }

      const readL = this.readSample(this.readPos);
      const readR = this.readSampleR(this.readPos);
      this.readPos += this.rate * spinDir;
      if (this.readPos < 0) this.readPos = 0;

      outL[i] = l * (1 - mix) + readL * mix;
      if (outR) outR[i] = r * (1 - mix) + readR * mix;
    }
    return true;
  }
}

registerProcessor("tapestop-processor", TapeStopProcessor);
