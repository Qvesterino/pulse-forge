/**
 * Reverb FDN AudioWorkletProcessor — 4× comb + 2× allpass diffuse network.
 *
 * Replaces the old ConvolverNode IR path with a parametric FDN tail.
 * Decay = RT60 in seconds (0.1–6), damping = lowpass in feedback loop
 * (500–12000 Hz), diffusion = allpass feedback (0–1). Predelay is kept
 * as an external DelayNode in the registry factory (like before), so this
 * processor is 100% wet and mix is handled outside via mixBus.
 *
 * Comb delays are prime numbers at 48k (1557, 1617, 1491, 1422) scaled to
 * the actual sample rate. Feedback per comb is computed as pow(10,
 * -3*delayMs/(decay*1000)) to hit -60 dB after `decay` seconds.
 * This keeps RT60 consistent when delay lengths change with sample rate.
 *
 * 4 combs in parallel (stereo: L/R with ±1% detune for width), summed,
 * then 2 allpass diffusers in series (delays 556 & 441 samples).
 * Denormal guard <1e-20 on all feedback state.
 *
 * NOTE: served RAW to AudioWorklet.addModule() — plain JavaScript only.
 */
const REVERB_COMB_DELAYS = [1557, 1617, 1491, 1422]; // samples at 48k
const ALLPASS_DELAYS = [556, 441];

class ReverbProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Comb feedback cache — recomputed only when decay/sample rate change.
    this.combFeedback = [0.7, 0.7, 0.7, 0.7];
    this.combFeedbackCacheDecay = -1;
    this.combFeedbackCacheSr = 0;
    const maxComb = Math.max(...REVERB_COMB_DELAYS) + 1024;
    const size = 1 << Math.ceil(Math.log2(maxComb * 2));
    this.size = size;
    this.mask = size - 1;
    // 4 combs × 2 channels
    this.combBufs = Array.from({ length: 4 }, () => [new Float32Array(size), new Float32Array(size)]);
    this.combIdx = [0, 0, 0, 0];
    this.combDampL = [0, 0, 0, 0];
    this.combDampR = [0, 0, 0, 0];
    // 2 allpass × 2 channels
    const apSize = 2048;
    this.apSize = apSize;
    this.apMask = apSize - 1;
    this.apBufs = Array.from({ length: 2 }, () => [new Float32Array(apSize), new Float32Array(apSize)]);
    this.apIdx = [0, 0];
    // Output tone LP state (per channel) — separate from the in-loop damping.
    this.outLpL = 0;
    this.outLpR = 0;
  }

  static get parameterDescriptors() {
    return [
      { name: "decay", defaultValue: 1.8, minValue: 0.1, maxValue: 6, automationRate: "k-rate" },
      { name: "damping", defaultValue: 6000, minValue: 500, maxValue: 12000, automationRate: "k-rate" },
      { name: "diffusion", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "tone", defaultValue: 6000, minValue: 500, maxValue: 12000, automationRate: "k-rate" },
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
    if (!inL && !inR) {
      for (let i = 0; i < outL.length; i++) {
        outL[i] = 0;
        if (outR) outR[i] = 0;
      }
      return true;
    }
    const len = outL.length;
    const sr = globalThis.sampleRate || 44100;
    const decay = Math.max(0.1, Math.min(6, parameters.decay[0]));
    // DAMPING shapes the feedback loop (how fast the TAIL loses highs);
    // TONE is the output brightness — two distinct filters now, they used
    // to collapse into one (min of both) which wasted a knob.
    const dampingFreq = Math.max(500, Math.min(12000, parameters.damping ? parameters.damping[0] : 6000));
    const diffusion = Math.max(0, Math.min(1, parameters.diffusion ? parameters.diffusion[0] : 0.5));
    const toneFreq = Math.max(500, Math.min(12000, parameters.tone ? parameters.tone[0] : 9000));
    const dampAlpha = 1 - Math.exp((-2 * Math.PI * dampingFreq) / sr);
    const toneAlpha = 1 - Math.exp((-2 * Math.PI * toneFreq) / sr);

    // Precompute per-comb feedback gains for RT60 = decay. Cached — the old
    // per-block `.map` (+closure) was avoidable garbage on the audio thread;
    // recompute only when decay or sample rate actually changes.
    if (this.combFeedbackCacheDecay !== decay || this.combFeedbackCacheSr !== sr) {
      this.combFeedback = REVERB_COMB_DELAYS.map((d) => {
        const ms = ((d * sr) / 48000 / sr) * 1000; // delay in ms at current sr (d scaled)
        const g = Math.pow(10, (-3 * ms) / (decay * 1000));
        return Math.min(0.98, g);
      });
      this.combFeedbackCacheDecay = decay;
      this.combFeedbackCacheSr = sr;
    }
    const combFeedback = this.combFeedback;

    const apFeedback = 0.3 + diffusion * 0.4; // 0.3..0.7

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;
      const inputMono = (l + r) * 0.5;

      // Parallel combs
      let sumL = 0;
      let sumR = 0;
      for (let c = 0; c < 4; c++) {
        const delaySamples = (REVERB_COMB_DELAYS[c] * sr) / 48000;
        const fb = combFeedback[c];
        // Read with linear interp, ±1% stereo detune
        const detuneL = 1 - 0.01 * (c % 2 === 0 ? 1 : -1) * 0.5;
        const detuneR = 1 + 0.01 * (c % 2 === 0 ? 1 : -1) * 0.5;
        const readL = this.readComb(c, 0, delaySamples * detuneL);
        const readR = this.readComb(c, 1, delaySamples * detuneR);
        // Damping LP in feedback loop
        this.combDampL[c] += dampAlpha * (readL - this.combDampL[c]);
        this.combDampR[c] += dampAlpha * (readR - this.combDampR[c]);
        if (Math.abs(this.combDampL[c]) < 1e-20) this.combDampL[c] = 0;
        if (Math.abs(this.combDampR[c]) < 1e-20) this.combDampR[c] = 0;
        const dampL = this.combDampL[c];
        const dampR = this.combDampR[c];
        // Write input + feedback * damped
        const wL = inputMono + dampL * fb;
        const wR = inputMono + dampR * fb;
        this.writeComb(c, 0, wL);
        this.writeComb(c, 1, wR);
        sumL += dampL;
        sumR += dampR;
      }
      sumL *= 0.25;
      sumR *= 0.25;

      // Two allpass diffusers in series
      let apL = this.processAllpass(0, 0, sumL, ALLPASS_DELAYS[0], apFeedback);
      let apR = this.processAllpass(0, 1, sumR, ALLPASS_DELAYS[0], apFeedback);
      apL = this.processAllpass(1, 0, apL, ALLPASS_DELAYS[1], apFeedback);
      apR = this.processAllpass(1, 1, apR, ALLPASS_DELAYS[1], apFeedback);

      outL[i] = this.outLpL = this.outLpL + toneAlpha * (apL - this.outLpL);
      if (outR) outR[i] = this.outLpR = this.outLpR + toneAlpha * (apR - this.outLpR);
      if (Math.abs(this.outLpL) < 1e-20) this.outLpL = 0;
      if (Math.abs(this.outLpR) < 1e-20) this.outLpR = 0;
    }
    return true;
  }

  readComb(combIdx, ch, delaySamples) {
    const idx = this.combIdx[combIdx];
    const pos = idx - delaySamples;
    const i0 = Math.floor(pos) & this.mask;
    const i1 = (i0 + 1) & this.mask;
    const frac = pos - Math.floor(pos);
    const buf = this.combBufs[combIdx][ch];
    return buf[i0] * (1 - frac) + buf[i1] * frac;
  }

  writeComb(combIdx, ch, value) {
    const buf = this.combBufs[combIdx][ch];
    const idx = this.combIdx[combIdx] & this.mask;
    buf[idx] = value;
    if (ch === 1) this.combIdx[combIdx] = (this.combIdx[combIdx] + 1) & this.mask;
  }

  processAllpass(apIdx, ch, input, delaySamples, feedback) {
    const buf = this.apBufs[apIdx][ch];
    let idx = this.apIdx[apIdx];
    const readPos = idx - delaySamples;
    const i0 = Math.floor(readPos) & this.apMask;
    const i1 = (i0 + 1) & this.apMask;
    const frac = readPos - Math.floor(readPos);
    const delayed = buf[i0] * (1 - frac) + buf[i1] * frac;
    const output = -feedback * input + delayed;
    const writeVal = input + feedback * delayed;
    buf[idx & this.apMask] = writeVal;
    if (ch === 1) this.apIdx[apIdx] = (this.apIdx[apIdx] + 1) & this.apMask;
    if (Math.abs(output) < 1e-20) return 0;
    return output;
  }
}

registerProcessor("reverb-processor", ReverbProcessor);
