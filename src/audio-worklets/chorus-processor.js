/**
 * Chorus AudioWorkletProcessor — two modulated delay voices in true stereo.
 *
 * Voice 1 (12 ms base) feeds the LEFT channel, voice 2 (18 ms base) feeds
 * the RIGHT channel, with a small crossfeed so mono sources still bloom.
 * Each voice has its own sine LFO; `spread` offsets voice 2's rate
 * (rate × (1 + 0.4·spread), i.e. the legacy 1.4× at spread = 1) and scales
 * the crossfeed, so spread = 0 is tight/mono-compatible and spread = 1 is
 * the wide legacy character.
 *
 * Reads use cubic-hermite interpolation (the native DelayNode graph it
 * replaces steps the delay time per render quantum); modulation depth maps
 * 0..1 → 1..9 ms exactly like the legacy graph, so stored presets keep
 * their musical meaning.
 *
 * Deterministic: LFO phases start at fixed offsets, no PRNG anywhere.
 *
 * NOTE: served RAW to AudioWorklet.addModule() — plain JavaScript only.
 */
const CHORUS_RING = 16384; // 85 ms @192 kHz — covers 18 ms base + 9 ms depth
const CHORUS_BASE_L_MS = 12;
const CHORUS_BASE_R_MS = 18;

class ChorusProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufL = new Float32Array(CHORUS_RING);
    this.bufR = new Float32Array(CHORUS_RING);
    this.writeIdx = 0;
    this.phase1 = 0;
    this.phase2 = Math.PI / 2;
  }

  static get parameterDescriptors() {
    return [
      { name: "rate", defaultValue: 0.6, minValue: 0.1, maxValue: 8, automationRate: "k-rate" },
      { name: "depth", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "spread", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "mix", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" },
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

    const rate = Math.max(0.1, Math.min(8, parameters.rate[0]));
    const depth01 = Math.max(0, Math.min(1, parameters.depth[0]));
    const spread = Math.max(0, Math.min(1, parameters.spread[0]));
    const mix = Math.max(0, Math.min(1, parameters.mix[0]));

    // Legacy depth law: 1 ms + depth·8 ms of LFO excursion.
    const depthSamples = ((0.001 + depth01 * 0.008) * sr) / 2;
    const baseL = (CHORUS_BASE_L_MS / 1000) * sr;
    const baseR = (CHORUS_BASE_R_MS / 1000) * sr;
    const rate2 = rate * (1 + 0.4 * spread);
    const step1 = (2 * Math.PI * rate) / sr;
    const step2 = (2 * Math.PI * rate2) / sr;
    const cross = 0.3 * spread;

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;

      const lfo1 = Math.sin(this.phase1);
      const lfo2 = Math.sin(this.phase2);
      this.phase1 += step1;
      this.phase2 += step2;
      if (this.phase1 > 2 * Math.PI) this.phase1 -= 2 * Math.PI;
      if (this.phase2 > 2 * Math.PI) this.phase2 -= 2 * Math.PI;

      // Delay times ride a raised-cosine (never negative, no wrap clicks).
      const dL = baseL + depthSamples * (1 + lfo1);
      const dR = baseR + depthSamples * (1 + lfo2);

      this.bufL[this.writeIdx] = l;
      this.bufR[this.writeIdx] = r;
      const v1 = this.readCubic(this.bufL, this.writeIdx - dL);
      const v2 = this.readCubic(this.bufR, this.writeIdx - dR);
      this.writeIdx++;
      if (this.writeIdx >= CHORUS_RING) this.writeIdx = 0;

      const wetL = v1 + cross * v2;
      const wetR = v2 + cross * v1;
      outL[i] = l * (1 - mix) + wetL * mix;
      if (outR) outR[i] = r * (1 - mix) + wetR * mix;
    }

    // Denormal guard
    if (Math.abs(this.bufL[this.writeIdx]) < 1e-20) this.bufL[this.writeIdx] = 0;
    if (Math.abs(this.bufR[this.writeIdx]) < 1e-20) this.bufR[this.writeIdx] = 0;

    return true;
  }

  readCubic(buf, position) {
    const idx = Math.floor(position);
    const frac = position - idx;
    const i0 = (((idx - 1) % CHORUS_RING) + CHORUS_RING) % CHORUS_RING;
    const i1 = (((idx + 0) % CHORUS_RING) + CHORUS_RING) % CHORUS_RING;
    const i2 = (((idx + 1) % CHORUS_RING) + CHORUS_RING) % CHORUS_RING;
    const i3 = (((idx + 2) % CHORUS_RING) + CHORUS_RING) % CHORUS_RING;
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

export function createChorusProcessor() {
  return new ChorusProcessor();
}

registerProcessor("chorus-processor", ChorusProcessor);
