/**
 * Stutter AudioWorkletProcessor — BPM-synced loop-repeat effect.
 *
 * A circular delay buffer of exactly one loop cycle (16 × division at the
 * current BPM). The output reads from ONE LOOP BEHIND, so you hear the
 * PREVIOUS cycle's audio. A gate pattern (from EffectInstance.steps) mutes
 * sub-steps of the delayed loop, creating rhythmic gaps in the repeated
 * content. Because the underlying beat pattern is repetitive, hearing the
 * same gated segments each cycle creates the classic "stutter" feel.
 *
 * Transport sync: `syncBpm` updates BPM (loopSamples recomputed);
 * `onTransportStarted` re-anchors the gate phase to the musical grid.
 * Default anchor (0, 0) makes offline renders deterministic.
 *
 * Buffer: 2^18 samples (262144 ≈ 5.9 s @ 44.1 kHz) — large enough for all
 * reasonable loop lengths at any BPM above 60.
 *
 * NOTE: served RAW to AudioWorklet.addModule() — plain JavaScript only.
 */
const STUT_BUF_SIZE = 262144; // 2^18
const STUT_MASK = STUT_BUF_SIZE - 1;
const STUT_DIV_BEATS = [4, 2, 1, 0.5, 0.25, 0.125];

class StutterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufL = new Float32Array(STUT_BUF_SIZE);
    this.bufR = new Float32Array(STUT_BUF_SIZE);
    this.writeIdx = 0;
    this.phase = 0;
    this.bpm = 120;
    this.gateSteps = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    this.port.onmessage = (event) => {
      const d = event.data || {};
      if (d.type === "pattern" && Array.isArray(d.steps) && d.steps.length > 0) {
        this.gateSteps = d.steps.map((v) => Math.min(1, Math.max(0, Number(v) || 0)));
      } else if (d.type === "align") {
        const stepBeats = STUT_DIV_BEATS[Math.max(0, Math.min(5, Math.round(this.divValue ?? 4)))];
        this.phase = Math.floor((d.phase || 0) / stepBeats) * stepBeats;
      } else if (d.type === "bpm") {
        this.bpm = Math.max(20, Math.min(300, d.bpm || 120));
      }
    };
  }

  static get parameterDescriptors() {
    return [
      { name: "division", defaultValue: 4, minValue: 0, maxValue: 5, automationRate: "k-rate" },
      { name: "mix", defaultValue: 0.8, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "feedback", defaultValue: 0, minValue: 0, maxValue: 0.7, automationRate: "k-rate" },
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

    const divIdx = Math.max(0, Math.min(5, Math.round(parameters.division[0])));
    this.divValue = divIdx;
    const mix = parameters.mix[0];
    const feedback = Math.max(0, Math.min(0.7, parameters.feedback[0]));
    const stepBeats = STUT_DIV_BEATS[divIdx];
    const phaseRate = this.bpm / (60 * sr);

    const loopSamples = Math.min(STUT_BUF_SIZE - 1, Math.max(1, Math.round(16 * stepBeats * (60 / this.bpm) * sr)));

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;

      // Read from one loop behind (before writing current sample)
      const readIdx = (this.writeIdx - loopSamples + STUT_BUF_SIZE) & STUT_MASK;
      const delayedL = this.bufL[readIdx];
      const delayedR = this.bufR[readIdx];

      // Gate phase
      this.phase += phaseRate;
      const stepIdx = Math.floor(this.phase / stepBeats) % this.gateSteps.length;
      const gate = this.gateSteps[stepIdx] || 0;

      // Write with feedback
      let wL = l + delayedL * gate * feedback;
      let wR = r + delayedR * gate * feedback;
      if (Math.abs(wL) < 1e-20) wL = 0;
      if (Math.abs(wR) < 1e-20) wR = 0;
      this.bufL[this.writeIdx] = wL;
      this.bufR[this.writeIdx] = wR;
      this.writeIdx = (this.writeIdx + 1) & STUT_MASK;

      // Output: gated delayed signal
      const gatedL = delayedL * gate;
      const gatedR = delayedR * gate;
      outL[i] = l * (1 - mix) + gatedL * mix;
      if (outR) outR[i] = r * (1 - mix) + gatedR * mix;
    }
    return true;
  }
}

registerProcessor("stutter-processor", StutterProcessor);
