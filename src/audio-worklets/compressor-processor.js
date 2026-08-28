/**
 * Bus Compressor AudioWorkletProcessor — the real compressor the native
 * DynamicsCompressorNode could never be: selectable PEAK/RMS detector with a
 * SIDECHAIN high-pass (so a kick feeding the detector can carve the bass
 * without every sub note slamming the gain), soft-knee gain computer and
 * parallel MIX — all per-sample, zero latency, deterministic offline.
 *
 * Inputs:
 *   [0] — main audio (compressed)
 *   [1] — sidechain detector (optional; falls back to main when absent)
 *
 * The SC HPF filters ONLY the detector path — the main audio passes untouched.
 * Detector is stereo-linked (max of L/R). Gain smoothing applies ATTACK while
 * the gain dives and RELEASE while it recovers (one-pole on linear gain).
 *
 * Metering: posts { type: "gr", gr } (max gain reduction dB in the window,
 * ~20 Hz) using the same protocol as the look-ahead limiter.
 *
 * NOTE: served RAW to AudioWorklet.addModule() — plain JavaScript only.
 */
class CompressorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.gain = 1;
    this.rms = 0;       // smoothed squared level (RMS mode)
    this.postL1 = 0; this.postR1 = 0;  // one-pole HP stage 1 state (outputs)
    this.postL2 = 0; this.postR2 = 0;  // stage 2 state
    this.prevInL = 0; this.prevInR = 0; // stage 1 previous input
    this.prevL1 = 0; this.prevR1 = 0;  // stage 1 previous output (stage 2 input)
    this.grAccumulator = 0;
    this.grWindowStart = typeof globalThis.currentTime === "number" ? globalThis.currentTime : 0;
    this.postedGr = -1;
  }

  static get parameterDescriptors() {
    return [
      { name: "threshold", defaultValue: -18, minValue: -60, maxValue: 0, automationRate: "k-rate" },
      { name: "ratio", defaultValue: 3, minValue: 1, maxValue: 20, automationRate: "k-rate" },
      { name: "attack", defaultValue: 0.01, minValue: 0.001, maxValue: 0.5, automationRate: "k-rate" },
      { name: "release", defaultValue: 0.2, minValue: 0.02, maxValue: 1, automationRate: "k-rate" },
      { name: "knee", defaultValue: 6, minValue: 0, maxValue: 40, automationRate: "k-rate" },
      { name: "makeup", defaultValue: 1, minValue: 0, maxValue: 16, automationRate: "k-rate" },   // linear (wrapper converts dB)
      { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "detector", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },  // 0 = RMS, 1 = PEAK
      { name: "scHpf", defaultValue: 20, minValue: 20, maxValue: 500, automationRate: "k-rate" }, // Hz
    ];
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const outL = output[0];
    const outR = output.length > 1 && output[1] ? output[1] : null;

    const main = inputs[0];
    const mainL = main && main[0] && main[0].length ? main[0] : null;
    const mainR = main && main.length > 1 && main[1] && main[1].length ? main[1] : null;
    const side = inputs[1];
    const sideActive = !!(side && side[0] && side[0].length);
    const sideL = sideActive ? side[0] : null;
    const sideR = sideActive && side.length > 1 && side[1] && side[1].length ? side[1] : null;

    const len = outL.length;
    const sr = globalThis.sampleRate || 44100;
    const thresholdDb = parameters.threshold[0];
    const ratio = Math.max(1, parameters.ratio[0]);
    const slope = 1 - 1 / ratio;
    const knee = Math.max(0, parameters.knee[0]);
    const attackBlend = 1 - Math.exp(-1 / (sr * Math.max(0.001, parameters.attack[0])));
    const releaseBlend = 1 - Math.exp(-1 / (sr * Math.max(0.02, parameters.release[0])));
    const makeupLin = Math.max(0, parameters.makeup[0]);
    const mix = parameters.mix[0];
    const peakMode = parameters.detector[0] >= 0.5;
    const hpfHz = parameters.scHpf[0];
    const hpfOn = sideActive && hpfHz > 25;
    const dt = 1 / sr;
    const rc = hpfOn ? 1 / (2 * Math.PI * Math.max(20, hpfHz)) : 0;
    const hpA = hpfOn ? rc / (rc + dt) : 0;

    for (let i = 0; i < len; i++) {
      const l = mainL ? mainL[i] : 0;
      const r = mainR ? mainR[i] : l;

      // ---- detector source (sidechain when connected, else main) ----
      let dL = 0;
      let dR = 0;
      if (sideActive) {
        const sl = sideL ? sideL[i] : 0;
        const sr2 = sideR ? sideR[i] : sl;
        if (hpfOn) {
          // 2× cascaded one-pole highpass (12 dB/oct) on the detector path.
          const y1l = hpA * (this.postL1 + sl - this.prevInL);
          const y1r = hpA * (this.postR1 + sr2 - this.prevInR);
          const y2l = hpA * (this.postL2 + y1l - this.prevL1);
          const y2r = hpA * (this.postR2 + y1r - this.prevR1);
          this.prevInL = sl; this.prevInR = sr2;
          this.prevL1 = y1l; this.prevR1 = y1r;
          this.postL1 = y1l; this.postR1 = y1r;
          this.postL2 = y2l; this.postR2 = y2r;
          if (Math.abs(this.postL1) < 1e-20) this.postL1 = 0;
          if (Math.abs(this.postR1) < 1e-20) this.postR1 = 0;
          if (Math.abs(this.postL2) < 1e-20) this.postL2 = 0;
          if (Math.abs(this.postR2) < 1e-20) this.postR2 = 0;
          if (Math.abs(this.prevL1) < 1e-20) this.prevL1 = 0;
          if (Math.abs(this.prevR1) < 1e-20) this.prevR1 = 0;
          if (Math.abs(this.prevInL) < 1e-20) this.prevInL = 0;
          if (Math.abs(this.prevInR) < 1e-20) this.prevInR = 0;
          dL = y2l; dR = y2r;
          if (Math.abs(dL) < 1e-20) dL = 0;
          if (Math.abs(dR) < 1e-20) dR = 0;
        } else {
          dL = sl; dR = sr2;
        }
      } else {
        dL = l; dR = r;
      }

      const absL = dL < 0 ? -dL : dL;
      const absR = dR < 0 ? -dR : dR;
      const peak = absL > absR ? absL : absR;

      // ---- level measure ----
      let level;
      if (peakMode) {
        level = peak;
      } else {
        this.rms = this.rms + (peak * peak - this.rms) * 0.006; // ~8 ms average
        if (this.rms < 1e-20) this.rms = 0; // denormal guard
        level = Math.sqrt(this.rms);
      }

      // ---- gain computer (soft knee, dB domain) ----
      let target = 1;
      if (level > 1e-8) {
        const levelDb = 20 * Math.log10(level);
        const over = levelDb - thresholdDb;
        if (over > -knee / 2) {
          let gr;
          if (over >= knee / 2) gr = over * slope;
          else {
            const t = over + knee / 2;
            gr = (t * t * slope) / (2 * knee);
          }
          if (gr > 0) target = Math.pow(10, -gr / 20);
        }
      }

      // ---- gain smoothing: attack dives, release recovers ----
      this.gain = target < this.gain
        ? this.gain + (target - this.gain) * attackBlend
        : this.gain + (target - this.gain) * releaseBlend;
      if (Math.abs(this.gain) < 1e-20) this.gain = 0;
      else if (this.gain < 1e-10) this.gain = 0;

      const gl = this.gain * makeupLin;
      const wetL = l * gl;
      const wetR = r * gl;
      outL[i] = l * (1 - mix) + wetL * mix;
      if (outR) outR[i] = r * (1 - mix) + wetR * mix;

      const depth = 1 - this.gain;
      if (depth > this.grAccumulator) this.grAccumulator = depth;
    }

    // ---- metering ----
    const now = typeof globalThis.currentTime === "number" ? globalThis.currentTime : this.grWindowStart + len / sr;
    if (now - this.grWindowStart >= 0.05) {
      const grDb = this.grAccumulator > 1e-4 ? Math.min(24, -20 * Math.log10(Math.max(1e-4, 1 - this.grAccumulator))) : 0;
      this.grAccumulator = 0;
      this.grWindowStart = now;
      if (grDb !== this.postedGr) {
        this.postedGr = grDb;
        this.port.postMessage({ type: "gr", gr: grDb });
      }
    }

    return true;
  }
}

registerProcessor("compressor-processor", CompressorProcessor);
