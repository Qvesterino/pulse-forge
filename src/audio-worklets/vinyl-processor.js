/**
 * Vinyl / Lo-Fi AudioWorkletProcessor — one AGE knob, four degradations.
 *
 *  - crackle: seeded random impulse stream through a bandpass (dust pops)
 *  - wow: slow sine (0.7 Hz) modulating a delay-line read (pitch wobble)
 *  - flutter: faster jitter (11 Hz) layered on the same delay
 *  - year: 1920…2020 — band-limit + level contour (older = thinner, noisier)
 *
 * `amount` is the master macro (0 = bypass-clean, 1 = full 78 RPM); the
 * individual params scale their share of it. The RNG is seeded per instance
 * (processorOptions.seed = hash of the effect instance id) so renders are
 * deterministic — the offline-parity contract holds.
 *
 * NOTE: served as part of core-worklet.js — plain JavaScript only.
 */
function vinylRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class VinylProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sr = globalThis.sampleRate || 44100;
    this.sr = sr;
    const seed = (options && options.processorOptions && options.processorOptions.seed) || 1;
    this.rng = vinylRng(seed);

    // Wow/flutter delay line (max 10 ms of wobble depth).
    this.delayLen = Math.ceil(sr * 0.01);
    this.delay = new Float32Array(this.delayLen);
    this.delayPos = 0;

    // Crackle impulse state.
    this.crackleCountdown = 0;
    this.crackleEnv = 0;

    // One-pole filters for the year band-limit contour.
    this.lpState = 0;
    this.hpState = 0;
    this.hpPrev = 0;
  }

  static get parameterDescriptors() {
    return [
      { name: "amount", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "crackle", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "wow", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "year", defaultValue: 0.8, minValue: 0, maxValue: 1, automationRate: "k-rate" }, // 0=2020 1=1920
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
    const sr = this.sr;

    const amount = parameters.amount[0];
    const crackleAmount = parameters.crackle[0] * amount;
    const wowAmount = parameters.wow[0] * amount;
    const year = parameters.year[0];
    const mix = parameters.mix[0];

    // Year contour: 0 (2020) = nearly full band; 1 (1920) = telephone-thin.
    const lpCoef = 1 - Math.exp((-2 * Math.PI * (9000 - year * 7500)) / sr);
    const hpCoef = 1 - Math.exp((-2 * Math.PI * (120 + year * 700)) / sr);
    const wowDepth = wowAmount * (sr * 0.0006); // up to ~0.6 ms
    const crackleRate = crackleAmount * (sr * 0.004); // avg impulses per sample

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;

      // Wow + flutter via a modulated delay-line read.
      const wowMod =
        Math.sin((2 * Math.PI * 0.7 * this.delayPos) / sr) * wowDepth +
        Math.sin((2 * Math.PI * 11 * this.delayPos) / sr) * wowDepth * 0.25;
      const readPos = (this.delayPos - 1 - Math.abs(wowMod) + this.delayLen) % this.delayLen;
      const i0 = Math.floor(readPos);
      const frac = readPos - i0;
      const i1 = (i0 + 1) % this.delayLen;
      const wetL = this.delay[i0] * (1 - frac) + this.delay[i1] * frac;
      this.delay[this.delayPos] = l;
      this.delayPos = (this.delayPos + 1) % this.delayLen;

      // Crackle: exponential-decay impulses from the seeded RNG.
      if (this.crackleCountdown <= 0 && this.rng() < crackleRate * 40) {
        this.crackleEnv = 0.15 + this.rng() * 0.85;
        this.crackleCountdown = Math.max(1, Math.round(sr * 0.002 + this.rng() * sr * 0.05));
      }
      const crackle = this.crackleEnv * (this.rng() * 2 - 1) * crackleAmount * 0.5;
      if (this.crackleCountdown > 0) {
        this.crackleEnv *= 0.92;
        this.crackleCountdown -= 1;
      }

      // Year band-limit on the sum (one-pole LP + one-pole HP cascade).
      const summed = wetL + crackle;
      this.lpState += (summed - this.lpState) * lpCoef;
      this.hpPrev = this.hpState;
      this.hpState = this.lpState - this.hpPrev * (1 - hpCoef);
      const shaped = this.hpState;

      const dust = (this.rng() * 2 - 1) * amount * 0.004;

      outL[i] = l * (1 - mix) + (shaped + dust) * mix;
      if (outR) outR[i] = r * (1 - mix) + (shaped + dust) * mix;
    }
    return true;
  }
}

registerProcessor("vinyl-processor", VinylProcessor);
