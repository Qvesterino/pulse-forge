/**
 * Step Gate (trance gate) AudioWorkletProcessor — rhythmically gates the
 * input on an editable 8/16/32-step pattern, synced to the transport grid.
 *
 * Phase model: the processor advances a continuous PHASE IN BEATS
 * (phase += bpm / (60·sr) per sample). The main thread re-anchors the phase
 * on transport starts ({ type: "align", time, phase }) — the anchor snaps to
 * the nearest step boundary so the pattern always sits on the musical grid —
 * and on BPM changes ({ type: "bpm", bpm }). Beat-phase stays continuous
 * across BPM changes (only the beat RATE changes), so no re-anchor needed.
 * Default anchor (phase 0 at time 0) makes offline renders deterministic.
 *
 * Pattern arrives via port: { type: "pattern", steps: [...] } with 8/16/32
 * values in 0..1 (gate open amount); the array length IS the pattern length.
 *
 * Params (k-rate): division (index 0..5 → 1/1..1/32 step length), depth
 * (0..1 gate depth), smooth (0..1 → 0.5 ms..40 ms edge smoothing), mix.
 *
 * NOTE: served RAW to AudioWorklet.addModule() — plain JavaScript only.
 */
const GATE_DIVISION_BEATS = [4, 2, 1, 0.5, 0.25, 0.125];

class StepGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.steps = [1, 0];
    this.phase = 0; // beats since anchor
    this.bpm = 120;
    this.gain = 1;
    this.port.onmessage = (event) => {
      const d = event.data || {};
      if (d.type === "pattern" && Array.isArray(d.steps) && d.steps.length > 0) {
        this.steps = d.steps.map((v) => Math.min(1, Math.max(0, Number(v) || 0)));
      } else if (d.type === "align") {
        const stepBeats = GATE_DIVISION_BEATS[Math.max(0, Math.min(GATE_DIVISION_BEATS.length - 1, Math.round(this.divisionValue ?? 4)))];
        // Snap DOWN to the nearest step boundary of the transport grid.
        this.phase = Math.floor((d.phase || 0) / stepBeats) * stepBeats;
      } else if (d.type === "bpm") {
        this.bpm = Math.max(20, Math.min(300, d.bpm || 120));
      }
    };
  }

  static get parameterDescriptors() {
    return [
      { name: "division", defaultValue: 4, minValue: 0, maxValue: 5, automationRate: "k-rate" },
      { name: "depth", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "smooth", defaultValue: 0.15, minValue: 0, maxValue: 1, automationRate: "k-rate" },
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
    this.divisionValue = parameters.division[0]; // align handler snaps with the latest grid

    const stepBeats = GATE_DIVISION_BEATS[Math.max(0, Math.min(GATE_DIVISION_BEATS.length - 1, Math.round(parameters.division[0])))];
    const depth = parameters.depth[0];
    const mix = parameters.mix[0];
    const smoothValue = Math.max(0, Math.min(1, parameters.smooth[0]));
    const smoothTime = 0.0005 + smoothValue * smoothValue * 0.04; // 0.5 ms .. 40 ms
    const smoothBlend = 1 - Math.exp(-1 / (sr * smoothTime));
    const phaseRate = this.bpm / (60 * sr);
    const steps = this.steps;
    const length = steps.length;

    for (let i = 0; i < len; i++) {
      this.phase += phaseRate;
      const raw = this.phase / stepBeats;
      const index = ((Math.floor(raw) % length) + length) % length;
      const open = steps[index] || 0;
      const target = 1 - depth * (1 - open);
      this.gain += (target - this.gain) * smoothBlend;
      if (this.gain < 1e-10) this.gain = 0;

      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;
      outL[i] = l * (1 - mix + this.gain * mix);
      if (outR) outR[i] = r * (1 - mix + this.gain * mix);
    }
    return true;
  }
}

registerProcessor("stepgate-processor", StepGateProcessor);
