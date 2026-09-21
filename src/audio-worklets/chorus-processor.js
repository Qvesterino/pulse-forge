/**
 * Chorus AudioWorkletProcessor — multi-voice modulated delay in true stereo.
 *
 * VOICES (2–4): each voice has its OWN delay buffer, base time (12/18/24/29
 * ms), LFO phase and pan (±0.3 / ±0.6 constant-power). Voice 1 leans left,
 * voice 2 right, voices 3/4 harden outward. `spread` offsets each voice's
 * rate (voice n runs at rate·(1 + 0.4·spread·n/(voices−1))) and scales the
 * 1↔2 crossfeed.
 *
 * FEEDBACK: each voice's delayed output recirculates into its own buffer
 * (read-before-write, bounded ≤ 0.85 — damped modulated delays tolerate
 * more than a bare comb).
 *
 * LFO SHAPE: 0 = sine, 1 = triangle, 2 = sample-and-hold (seeded mulberry32
 * re-rolled every half base period — deterministic per instance).
 *
 * Reads use cubic-hermite interpolation. Depth maps 0..1 → 1..9 ms exactly
 * like the legacy graph, so stored presets keep their musical meaning.
 *
 * NOTE: served RAW to AudioWorklet.addModule() — plain JavaScript only.
 */
const CHORUS_RING = 16384; // 85 ms @192 kHz — covers 29 ms base + 9 ms depth
const CHORUS_BASE_MS = [12, 18, 24, 29];
const CHORUS_PANS = [-0.3, 0.3, -0.6, 0.6];
const CHORUS_MAX_VOICES = 4;

function chorusRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class ChorusProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.bufs = Array.from({ length: CHORUS_MAX_VOICES }, () => new Float32Array(CHORUS_RING));
    this.writeIdx = 0;
    this.phases = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
    // S&H: one held value per voice, re-rolled every half base period.
    this.shValues = [0, 0, 0, 0];
    this.shCount = 0;
    const seed = (options && options.processorOptions && options.processorOptions.seed) || 1;
    this.rng = chorusRng(seed);
  }

  static get parameterDescriptors() {
    return [
      { name: "rate", defaultValue: 0.6, minValue: 0.1, maxValue: 8, automationRate: "k-rate" },
      { name: "depth", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "spread", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "mix", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "feedback", defaultValue: 0, minValue: 0, maxValue: 0.85, automationRate: "k-rate" },
      { name: "voices", defaultValue: 2, minValue: 2, maxValue: 4, automationRate: "k-rate" },
      // 0 = sine, 1 = triangle, 2 = sample-and-hold
      { name: "lfoShape", defaultValue: 0, minValue: 0, maxValue: 2, automationRate: "k-rate" },
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
    const feedback = Math.max(0, Math.min(0.85, parameters.feedback ? parameters.feedback[0] : 0));
    const voices = Math.max(2, Math.min(4, Math.round(parameters.voices ? parameters.voices[0] : 2)));
    const lfoShape = Math.round(parameters.lfoShape ? parameters.lfoShape[0] : 0);

    // Legacy depth law: 1 ms + depth·8 ms of LFO excursion.
    const depthSamples = ((0.001 + depth01 * 0.008) * sr) / 2;
    const stepBase = (2 * Math.PI * rate) / sr;
    const cross = 0.3 * spread;

    // S&H re-roll countdown (block-rate check, half base period per roll).
    this.shCount -= len;
    if (this.shCount <= 0) {
      for (let v = 0; v < CHORUS_MAX_VOICES; v++) this.shValues[v] = this.rng() * 2 - 1;
      this.shCount = Math.max(64, Math.round(sr / (rate * 2)));
    }

    const shapeLfo = (v, phase) => {
      if (lfoShape === 1) {
        const p = (phase / (2 * Math.PI)) % 1;
        return 1 - 4 * Math.abs(p - 0.5);
      }
      if (lfoShape === 2) return this.shValues[v];
      return Math.sin(phase);
    };

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;

      let wetL = 0;
      let wetR = 0;
      let delayed1 = 0;
      let delayed2 = 0;
      for (let v = 0; v < voices; v++) {
        const step = stepBase * (1 + (0.4 * spread * v) / Math.max(1, voices - 1));
        this.phases[v] += step;
        if (this.phases[v] > 2 * Math.PI) this.phases[v] -= 2 * Math.PI;
        const lfo = shapeLfo(v, this.phases[v]);
        const base = (CHORUS_BASE_MS[v] / 1000) * sr;
        const buf = this.bufs[v];
        // Read BEFORE write: the delayed tap feeds back into the write.
        const delayed = this.readCubic(buf, this.writeIdx - (base + depthSamples * (1 + lfo)));
        if (v === 0) delayed1 = delayed;
        if (v === 1) delayed2 = delayed;
        const inV = v === 0 ? l : r;
        const written = inV + delayed * feedback;
        buf[this.writeIdx] = written > 1.5 ? 1.5 : written < -1.5 ? -1.5 : written;
        // Constant-power pan.
        const pan = CHORUS_PANS[v];
        const theta = ((pan + 1) * Math.PI) / 4;
        wetL += delayed * Math.cos(theta);
        wetR += delayed * Math.sin(theta);
      }
      // Voice-sum normalization: N voices carry ~√N more energy — scale to
      // the 2-voice reference loudness.
      const norm = Math.sqrt(2 / voices);
      wetL *= norm;
      wetR *= norm;
      // Voice 1↔2 crossfeed (spread-scaled) keeps mono sources blooming.
      if (cross > 0) {
        wetL += cross * delayed2;
        wetR += cross * delayed1;
      }

      this.writeIdx++;
      if (this.writeIdx >= CHORUS_RING) this.writeIdx = 0;

      outL[i] = l * (1 - mix) + wetL * mix;
      if (outR) outR[i] = r * (1 - mix) + wetR * mix;
    }

    // Denormal guard on every voice buffer.
    for (const buf of this.bufs) {
      if (Math.abs(buf[this.writeIdx]) < 1e-20) buf[this.writeIdx] = 0;
    }

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
