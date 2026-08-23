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
 *   threshold — dB threshold for envelope detection (-60..0, default -18)
 *   ratio     — compression ratio (1..20, default 4)
 *   attack    — attack time in seconds (0.001..0.5, default 0.005)
 *   release   — release time in seconds (0.02..1, default 0.2)
 *   amount    — ducking depth (0..1, default 1)
 *
 * NOTE: this file is served RAW to AudioWorklet.addModule() via
 * `new URL("./sidechain-processor.js", import.meta.url)` — it must stay
 * plain JavaScript with no imports and no TypeScript syntax.
 */
class SidechainProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.env = 0;
  }

  static get parameterDescriptors() {
    return [
      { name: "threshold", defaultValue: -18, minValue: -60, maxValue: 0, automationRate: "k-rate" },
      { name: "ratio", defaultValue: 4, minValue: 1, maxValue: 20, automationRate: "k-rate" },
      { name: "attack", defaultValue: 0.005, minValue: 0.001, maxValue: 0.5, automationRate: "k-rate" },
      { name: "release", defaultValue: 0.2, minValue: 0.02, maxValue: 1, automationRate: "k-rate" },
      { name: "amount", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  process(inputs, outputs, parameters) {
    const main = inputs[0];
    const sidechain = inputs[1];
    const output = outputs[0];

    // If no sidechain input connected, pass through unchanged
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

    const sidechainLen = sidechain[0].length;
    const mainLen = main[0].length;
    const len = Math.min(mainLen, sidechainLen);
    const sr = globalThis.sampleRate ?? 44100;

    for (let i = 0; i < len; i++) {
      // Read sidechain peak (use channel 0)
      const peak = Math.abs(sidechain[0][i]);

      // Parameters (constant or per-sample)
      const thresh = threshold.length > 1 ? threshold[i] : threshold[0];
      const rat = ratio.length > 1 ? ratio[i] : ratio[0];
      const att = attack.length > 1 ? attack[i] : attack[0];
      const rel = release.length > 1 ? release[i] : release[0];
      const amt = amount.length > 1 ? amount[i] : amount[0];

      // Compute time constants from seconds
      const attackCoef = Math.exp(-1 / (sr * Math.max(0.001, att)));
      const releaseCoef = Math.exp(-1 / (sr * Math.max(0.001, rel)));

      // Asymmetric envelope follower (per-sample!)
      this.env = peak > this.env
        ? attackCoef * this.env + (1 - attackCoef) * peak
        : releaseCoef * this.env + (1 - releaseCoef) * peak;

      // Compute gain reduction
      const envDb = 20 * Math.log10(Math.max(this.env, 1e-7));
      const threshDb = 20 * Math.log10(Math.max(Math.pow(10, thresh / 20), 1e-7));
      const overDb = Math.max(0, envDb - threshDb);
      const reductionDb = overDb * (1 - 1 / Math.max(1, rat));
      const reduction = Math.pow(10, -reductionDb / 20);
      const gain = Math.max(0, 1 - amt * (1 - reduction));

      // Apply to all main channels
      for (let ch = 0; ch < Math.min(main.length, output.length); ch++) {
        output[ch][i] = main[ch][i] * gain;
      }
    }

    // Handle remaining samples if sidechain is shorter (pass through)
    for (let i = len; i < mainLen; i++) {
      for (let ch = 0; ch < Math.min(main.length, output.length); ch++) {
        output[ch][i] = main[ch][i];
      }
    }

    return true;
  }
}

registerProcessor("sidechain-processor", SidechainProcessor);
