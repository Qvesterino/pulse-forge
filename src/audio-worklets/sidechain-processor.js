/**
 * Sidechain Compressor AudioWorkletProcessor — runs on the audio rendering thread.
 *
 * Replaces the old setInterval + AnalyserNode approach which:
 * 1. Did not work during OfflineAudioContext rendering (setInterval doesn't fire)
 * 2. Ran envelope follower at only 100 Hz (coarse for transients)
 *
 * This processor runs the envelope follower at audio rate (per-sample),
 * providing precise ducking in both realtime and offline contexts.
 *
 * Inputs:
 *   [0] — main audio (the signal to be ducked)
 *   [1] — sidechain audio (the detector signal)
 *
 * AudioParams:
 *   threshold  — dB threshold for envelope detection (-60..0, default -18)
 *   ratio      — compression ratio (1..20, default 4)
 *   attack     — attack time in seconds (0.001..0.5, default 0.005)
 *   release    — release time in seconds (0.02..1, default 0.2)
 *   amount     — ducking depth (0..1, default 1)
 *   splitFreq  — multiband crossover Hz (0 = full-band legacy, 1–500 = low-only ducking)
 *
 * When splitFreq > 10 Hz a 2-pole Butterworth LP/HP crossover isolates the
 * low band; only the low band receives gain reduction, the high band passes
 * through untouched. The LP+HP sum is unity (high = input − low).
 *
 * NOTE: this file is served RAW to AudioWorklet.addModule() via
 * `new URL("./sidechain-processor.js", import.meta.url)` — it must stay
 * plain JavaScript with no imports and no TypeScript syntax.
 */
const SQRT2 = 1.4142135623730951;

class SidechainProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.env = 0;
    // 2-pole Butterworth LP state (per channel: L, R).
    this.lpL = { x1: 0, x2: 0, y1: 0, y2: 0 };
    this.lpR = { x1: 0, x2: 0, y1: 0, y2: 0 };
    // Pre-computed coefficients (recalculated when splitFreq changes).
    this.lpB0 = 0;
    this.lpB1 = 0;
    this.lpB2 = 0;
    this.lpA1 = 0;
    this.lpA2 = 0;
    this.lastSplitFreq = -1;
  }

  static get parameterDescriptors() {
    return [
      { name: "threshold", defaultValue: -18, minValue: -60, maxValue: 0, automationRate: "k-rate" },
      { name: "ratio", defaultValue: 4, minValue: 1, maxValue: 20, automationRate: "k-rate" },
      { name: "attack", defaultValue: 0.005, minValue: 0.001, maxValue: 0.5, automationRate: "k-rate" },
      { name: "release", defaultValue: 0.2, minValue: 0.02, maxValue: 1, automationRate: "k-rate" },
      { name: "amount", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "splitFreq", defaultValue: 0, minValue: 0, maxValue: 500, automationRate: "k-rate" },
    ];
  }

  /**
   * Recompute 2-pole Butterworth LP coefficients for a given cutoff frequency.
   * Only recalculated when splitFreq changes (typically once per block).
   */
  updateLPCoefficients(f) {
    const K = Math.tan((Math.PI * f) / (globalThis.sampleRate || 44100));
    const K2 = K * K;
    const a0 = 1 + SQRT2 * K + K2;
    this.lpB0 = K2 / a0;
    this.lpB1 = (2 * K2) / a0;
    this.lpB2 = K2 / a0;
    this.lpA1 = (2 * (K2 - 1)) / a0;
    this.lpA2 = (1 - SQRT2 * K + K2) / a0;
  }

  /**
   * Single-sample 2-pole Butterworth LP. Must be called per channel with its
   * own state (x1, x2, y1, y2 passed by reference).
   */
  lpFilter(x, state) {
    const y = this.lpB0 * x + this.lpB1 * state.x1 + this.lpB2 * state.x2 - this.lpA1 * state.y1 - this.lpA2 * state.y2;
    state.x2 = state.x1;
    state.x1 = x;
    state.y2 = state.y1;
    state.y1 = y;
    // FTZ: flush tiny filter state to avoid denormal penalty on long silence
    if (Math.abs(state.x1) < 1e-20) state.x1 = 0;
    if (Math.abs(state.x2) < 1e-20) state.x2 = 0;
    if (Math.abs(state.y1) < 1e-20) state.y1 = 0;
    if (Math.abs(state.y2) < 1e-20) state.y2 = 0;
    if (Math.abs(y) < 1e-20) return 0;
    return y;
  }

  process(inputs, outputs, parameters) {
    const main = inputs[0];
    const sidechain = inputs[1];
    const output = outputs[0];

    // If no sidechain input connected, pass through unchanged.
    if (!sidechain || !sidechain[0] || !sidechain[0].length) {
      if (main && main[0] && output && output[0]) {
        for (let ch = 0; ch < Math.min(main.length, output.length); ch++) {
          output[ch].set(main[ch]);
        }
      }
      return true;
    }

    if (!main || !main[0] || !output || !output[0]) return true;

    const threshold = parameters.threshold;
    const ratio = parameters.ratio;
    const attack = parameters.attack;
    const release = parameters.release;
    const amount = parameters.amount;
    const splitFreq = parameters.splitFreq[0];

    const sidechainLen = sidechain[0].length;
    const mainLen = main[0].length;
    const len = Math.min(mainLen, sidechainLen);
    const sr = globalThis.sampleRate ?? 44100;
    const splitActive = splitFreq > 10;

    if (splitActive && splitFreq !== this.lastSplitFreq) {
      this.updateLPCoefficients(splitFreq);
      this.lastSplitFreq = splitFreq;
    }

    for (let i = 0; i < len; i++) {
      const sidePeak = Math.abs(sidechain[0][i]);

      const thresh = threshold.length > 1 ? threshold[i] : threshold[0];
      const rat = ratio.length > 1 ? ratio[i] : ratio[0];
      const att = attack.length > 1 ? attack[i] : attack[0];
      const rel = release.length > 1 ? release[i] : release[0];
      const amt = amount.length > 1 ? amount[i] : amount[0];

      // Asymmetric envelope follower (per-sample).
      const attCoef = Math.exp(-1 / (sr * Math.max(0.001, att)));
      const relCoef = Math.exp(-1 / (sr * Math.max(0.001, rel)));
      this.env =
        sidePeak > this.env
          ? attCoef * this.env + (1 - attCoef) * sidePeak
          : relCoef * this.env + (1 - relCoef) * sidePeak;
      if (Math.abs(this.env) < 1e-20) this.env = 0;

      // Gain reduction.
      const envDb = 20 * Math.log10(Math.max(this.env, 1e-7));
      const threshDb = 20 * Math.log10(Math.max(Math.pow(10, thresh / 20), 1e-7));
      const overDb = Math.max(0, envDb - threshDb);
      const reductionDb = overDb * (1 - 1 / Math.max(1, rat));
      const reduction = Math.pow(10, -reductionDb / 20);
      const gain = Math.max(0, 1 - amt * (1 - reduction));

      if (splitActive) {
        // 2-pole Butterworth crossover: low band gets ducked, high band passes.
        for (let ch = 0; ch < Math.min(main.length, output.length); ch++) {
          const x = main[ch][i];
          const st = ch === 0 ? this.lpL : this.lpR;
          const low = this.lpFilter(x, st);
          const high = x - low;
          output[ch][i] = low * gain + high;
        }
      } else {
        for (let ch = 0; ch < Math.min(main.length, output.length); ch++) {
          output[ch][i] = main[ch][i] * gain;
        }
      }
    }

    // Handle remaining samples if sidechain is shorter (pass through).
    for (let i = len; i < mainLen; i++) {
      for (let ch = 0; ch < Math.min(main.length, output.length); ch++) {
        output[ch][i] = main[ch][i];
      }
    }

    return true;
  }
}

registerProcessor("sidechain-processor", SidechainProcessor);
