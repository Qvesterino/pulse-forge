/**
 * Vowel / Formant Filter AudioWorkletProcessor — 3× peaking cascade.
 *
 * Five vowels (0=A,1=E,2=I,3=O,4=U) each defined by three formant
 * centre frequencies. The `vowel` AudioParam (0..4) interpolates logarithmically
 * between neighbours, resonance scales Q and peak gain. Three RBJ peaking
 * biquads in series give the classic "ah→ee→oo" morph. Coefficients are
 * refreshed once per render quantum (k-rate vowel) — enough for LFOs at
 * beat rates, cheap enough for 128-sample blocks.
 *
 * Mix 0 = dry, 1 = fully filtered. FTZ flush <1e-20 on all state.
 *
 * NOTE: served RAW to AudioWorklet.addModule() — plain JavaScript only.
 */
// Formant centre frequencies (Hz) for 5 vowels: A, E, I, O, U (male, Hillenbrand approx).
const VOWEL_FREQS = [
  [860, 1220, 2500], // A
  [560, 1840, 2580], // E
  [300, 2320, 3000], // I
  [600, 900, 2400], // O
  [320, 800, 2300], // U
];

class VowelProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 3 filters × 2 channels state
    this.x1 = [
      [0, 0],
      [0, 0],
      [0, 0],
    ];
    this.x2 = [
      [0, 0],
      [0, 0],
      [0, 0],
    ];
    this.y1 = [
      [0, 0],
      [0, 0],
      [0, 0],
    ];
    this.y2 = [
      [0, 0],
      [0, 0],
      [0, 0],
    ];
    // coefficients per filter: b0,b1,b2,a1,a2
    this.b0 = [1, 1, 1];
    this.b1 = [0, 0, 0];
    this.b2 = [0, 0, 0];
    this.a1 = [0, 0, 0];
    this.a2 = [0, 0, 0];
    this.lastVowel = -1;
    this.lastRes = -1;
    // Glide targets (the active coefficients chase these).
    this.tB0 = [1, 1, 1];
    this.tB1 = [0, 0, 0];
    this.tB2 = [0, 0, 0];
    this.tA1 = [0, 0, 0];
    this.tA2 = [0, 0, 0];
  }

  static get parameterDescriptors() {
    return [
      { name: "vowel", defaultValue: 0, minValue: 0, maxValue: 4, automationRate: "k-rate" },
      { name: "resonance", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" },
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

    const vowel = Math.max(0, Math.min(4, parameters.vowel[0]));
    const res = Math.max(0, Math.min(1, parameters.resonance[0]));
    const mix = Math.max(0, Math.min(1, parameters.mix[0]));

    // Recompute TARGET biquad coeffs when vowel or resonance moved. The
    // ACTIVE coefficients GLIDE toward the targets (~4 ms one-pole) — an
    // instantaneous coefficient step inside a recursing biquad is an
    // audible zipper on automated vowel sweeps.
    if (vowel !== this.lastVowel || res !== this.lastRes) {
      this.lastVowel = vowel;
      this.lastRes = res;
      const idx = Math.floor(vowel);
      const frac = vowel - idx;
      const i0 = Math.max(0, Math.min(4, idx));
      const i1 = Math.max(0, Math.min(4, idx + 1));
      const f0 = VOWEL_FREQS[i0];
      const f1 = VOWEL_FREQS[i1];
      // resonance -> Q 3.5..9, gain 7..15 dB
      const Q = 3.5 + res * 5.5;
      const gainDb = 7 + res * 8;
      for (let f = 0; f < 3; f++) {
        // log-interpolate frequency for musical morph
        const freq = Math.exp((1 - frac) * Math.log(f0[f]) + frac * Math.log(f1[f]));
        const fc = Math.max(20, Math.min(sr * 0.48, freq));
        const A = Math.pow(10, gainDb / 40);
        const w0 = (2 * Math.PI * fc) / sr;
        const cosw0 = Math.cos(w0);
        const sinw0 = Math.sin(w0);
        const alpha = sinw0 / (2 * Q);
        const b0 = 1 + alpha * A;
        const b1 = -2 * cosw0;
        const b2 = 1 - alpha * A;
        const a0 = 1 + alpha / A;
        const a1 = -2 * cosw0;
        const a2 = 1 - alpha / A;
        // normalize by a0 → glide targets
        this.tB0[f] = b0 / a0;
        this.tB1[f] = b1 / a0;
        this.tB2[f] = b2 / a0;
        this.tA1[f] = a1 / a0;
        this.tA2[f] = a2 / a0;
      }
    }
    // Coefficient glide (block-rate is enough — targets only move k-rate).
    {
      const g = 1 - Math.exp(-1 / (0.004 * sr));
      for (let f = 0; f < 3; f++) {
        this.b0[f] += (this.tB0[f] - this.b0[f]) * g;
        this.b1[f] += (this.tB1[f] - this.b1[f]) * g;
        this.b2[f] += (this.tB2[f] - this.b2[f]) * g;
        this.a1[f] += (this.tA1[f] - this.a1[f]) * g;
        this.a2[f] += (this.tA2[f] - this.a2[f]) * g;
      }
    }

    for (let i = 0; i < len; i++) {
      let l = inL ? inL[i] : 0;
      let r = inR ? inR[i] : l;
      let wetL = l;
      let wetR = r;
      for (let f = 0; f < 3; f++) {
        const b0 = this.b0[f],
          b1 = this.b1[f],
          b2 = this.b2[f],
          a1 = this.a1[f],
          a2 = this.a2[f];
        // Left
        let yL = b0 * wetL + b1 * this.x1[f][0] + b2 * this.x2[f][0] - a1 * this.y1[f][0] - a2 * this.y2[f][0];
        this.x2[f][0] = this.x1[f][0];
        this.x1[f][0] = wetL;
        this.y2[f][0] = this.y1[f][0];
        this.y1[f][0] = yL;
        if (Math.abs(this.x1[f][0]) < 1e-20) this.x1[f][0] = 0;
        if (Math.abs(this.x2[f][0]) < 1e-20) this.x2[f][0] = 0;
        if (Math.abs(this.y1[f][0]) < 1e-20) this.y1[f][0] = 0;
        if (Math.abs(this.y2[f][0]) < 1e-20) this.y2[f][0] = 0;
        if (Math.abs(yL) < 1e-20) yL = 0;
        wetL = yL;
        // Right
        let yR = b0 * wetR + b1 * this.x1[f][1] + b2 * this.x2[f][1] - a1 * this.y1[f][1] - a2 * this.y2[f][1];
        this.x2[f][1] = this.x1[f][1];
        this.x1[f][1] = wetR;
        this.y2[f][1] = this.y1[f][1];
        this.y1[f][1] = yR;
        if (Math.abs(this.x1[f][1]) < 1e-20) this.x1[f][1] = 0;
        if (Math.abs(this.x2[f][1]) < 1e-20) this.x2[f][1] = 0;
        if (Math.abs(this.y1[f][1]) < 1e-20) this.y1[f][1] = 0;
        if (Math.abs(this.y2[f][1]) < 1e-20) this.y2[f][1] = 0;
        if (Math.abs(yR) < 1e-20) yR = 0;
        wetR = yR;
      }
      outL[i] = l * (1 - mix) + wetL * mix;
      if (outR) outR[i] = r * (1 - mix) + wetR * mix;
    }
    return true;
  }
}

registerProcessor("vowel-processor", VowelProcessor);
