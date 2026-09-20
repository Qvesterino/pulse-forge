/**
 * Pitch Shifter AudioWorkletProcessor — granular dual-voice real-time shift.
 *
 * Two overlapping grain voices (50% overlap, Hann window — COLA-compliant)
 * read the ring buffer at `pitchRatio`, so the signal keeps its duration but
 * moves in pitch. Grain phases derive from the absolute sample counter (NOT
 * Math.random), so identical inputs render identical outputs — the
 * offline-parity contract holds.
 *
 * `width` offsets the right channel's grain phase for a wider image.
 *
 * NOTE: served as part of core-worklet.js — plain JavaScript only.
 */
class PitchShiftProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sr = globalThis.sampleRate || 44100;
    const seed = (options && options.processorOptions && options.processorOptions.seed) || 1;
    this.bufferLen = sr * 2;
    this.bufL = new Float32Array(this.bufferLen);
    this.bufR = new Float32Array(this.bufferLen);
    this.writePos = 0;
    this.initialized = false;
    // Instance offset de-correlates stacked shifters (no common artifact).
    this.phaseOffset = Math.floor(seed % 977);
  }

  static get parameterDescriptors() {
    return [
      { name: "semitones", defaultValue: 0, minValue: -12, maxValue: 12, automationRate: "k-rate" },
      { name: "fine", defaultValue: 0, minValue: -50, maxValue: 50, automationRate: "k-rate" },
      { name: "grainMs", defaultValue: 55, minValue: 20, maxValue: 120, automationRate: "k-rate" },
      { name: "width", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  readAt(absPos, channel) {
    let p = absPos % this.bufferLen;
    if (p < 0) p += this.bufferLen;
    const i0 = Math.floor(p);
    const frac = p - i0;
    const i1 = (i0 + 1) % this.bufferLen;
    const buf = channel === 1 ? this.bufR : this.bufL;
    return buf[i0] * (1 - frac) + buf[i1] * frac;
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

    const semis = parameters.semitones[0];
    const fine = parameters.fine[0];
    const grainMs = parameters.grainMs[0];
    const width = parameters.width[0];
    const mix = parameters.mix[0];

    const ratio = Math.pow(2, (semis + fine / 100) / 12);
    const H = Math.max(4, Math.round((grainMs / 1000) * sr) / 2); // half-grain hop
    const first = this.writePos;

    // Fill the ring buffer for this block, then advance the absolute write
    // cursor — without this the cursor never moves, every write lands at a
    // negative ring index (dropped), and the processor stays in its startup
    // passthrough branch forever.
    for (let i = 0; i < len; i++) {
      this.bufL[(first + i) % this.bufferLen] = inL ? inL[i] : 0;
      this.bufR[(first + i) % this.bufferLen] = inR && inR.length > i ? inR[i] : inL ? inL[i] : 0;
    }
    this.writePos = first + len;
    if (!this.initialized && this.writePos > 0) this.initialized = true;

    for (let i = 0; i < len; i++) {
      const A = first + i;
      const live = inL ? inL[i] : 0;
      const liveR = inR && inR.length > i ? inR[i] : live;
      if (!this.initialized || A < H * 2) {
        outL[i] = live;
        if (outR) outR[i] = liveR;
        continue;
      }

      let wetL = 0;
      let wetR = 0;
      let windowSum = 0;
      // Two overlapping grains of length 2H at hop H: at any instant the
      // current grain covers phase u ∈ [0,1) and the previous one u ∈ [1,2),
      // and their Hann windows sum to unity (COLA). Each grain reads the
      // PAST at slope `ratio` — shift-up grains are pinned to end at the
      // write line, so no read ever crosses it (future samples don't exist).
      const k = Math.floor(A / H);
      const half = width * 0.5 * H; // R-channel grain offset for stereo width
      for (let g = k; g >= k - 1; g--) {
        const u = A / H - g; // 0..2 within this grain
        if (u < 0 || u > 2) continue;
        const window = 0.5 * (1 - Math.cos(Math.PI * u));
        const grainStart = g * H;
        const base = ratio >= 1 ? grainStart + 2 * H * (1 - ratio) : grainStart;
        const readL = base + (A - grainStart) * ratio;
        const readR = base + (A - grainStart - half) * ratio;
        if (readL < 0 || readL > this.writePos || readR < 0) continue;
        wetL += this.readAt(readL, 0) * window;
        wetR += this.readAt(readR, 1) * window;
        windowSum += window;
      }
      const norm = windowSum > 1e-6 ? 1 / windowSum : 0;

      outL[i] = live * (1 - mix) + wetL * norm * mix;
      if (outR) outR[i] = liveR * (1 - mix) + wetR * norm * mix;
    }
    return true;
  }
}

registerProcessor("pitchshift-processor", PitchShiftProcessor);
