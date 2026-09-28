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
    this.rms = 0;
    // de-ess band-pass state (2× HP + 2× LP one-poles, per channel)
    this.bpHpIn1L = 0;
    this.bpHpIn1R = 0;
    this.bpHp1L = 0;
    this.bpHp1R = 0;
    this.bpHpIn2L = 0;
    this.bpHpIn2R = 0;
    this.bpHp2L = 0;
    this.bpHp2R = 0;
    this.bpLp1L = 0;
    this.bpLp1R = 0;
    this.bpLp2L = 0;
    this.bpLp2R = 0; // smoothed squared level (RMS mode)
    this.postL1 = 0;
    this.postR1 = 0; // one-pole HP stage 1 state (outputs)
    this.postL2 = 0;
    this.postR2 = 0; // stage 2 state
    this.prevInL = 0;
    this.prevInR = 0; // stage 1 previous input
    this.prevL1 = 0;
    this.prevR1 = 0; // stage 1 previous output (stage 2 input)
    this.grAccumulator = 0;
    this.densitySmoothed = 0;
    this.grWindowStart = typeof globalThis.currentTime === "number" ? globalThis.currentTime : 0;
    this.postedGr = -1;
  }

  static get parameterDescriptors() {
    return [
      { name: "threshold", defaultValue: -18, minValue: -60, maxValue: 0, automationRate: "k-rate" },
      { name: "ratio", defaultValue: 3, minValue: 1, maxValue: 20, automationRate: "k-rate" },
      { name: "attack", defaultValue: 0.01, minValue: 0.0002, maxValue: 0.5, automationRate: "k-rate" },
      { name: "release", defaultValue: 0.2, minValue: 0.02, maxValue: 2, automationRate: "k-rate" },
      { name: "knee", defaultValue: 6, minValue: 0, maxValue: 40, automationRate: "k-rate" },
      { name: "makeup", defaultValue: 1, minValue: 0, maxValue: 16, automationRate: "k-rate" }, // linear (wrapper converts dB)
      { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "detector", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" }, // 0 = RMS, 1 = PEAK
      { name: "scHpf", defaultValue: 20, minValue: 20, maxValue: 500, automationRate: "k-rate" }, // Hz
      // DE-ESS mode: 0 = scHpf high-pass detector (kick-carve style),
      // 1 = band-pass detector centered at scBandHz (sibilance band) —
      // gain reduction triggers only on the 4–10 kHz energy, the classic
      // wideband de-esser architecture.
      { name: "scMode", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "scBandHz", defaultValue: 6500, minValue: 2000, maxValue: 12000, automationRate: "k-rate" }, // Hz
      // AUTO RELEASE: program-dependent — the release time-constant shortens
      // when the input peaks arrive densely (fast program), relaxes on
      // sparse material.
      { name: "autoRelease", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
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
    const attackBlend = 1 - Math.exp(-1 / (sr * Math.max(0.0002, parameters.attack[0])));
    const releaseBlend = 1 - Math.exp(-1 / (sr * Math.max(0.02, parameters.release[0])));
    const makeupLin = Math.max(0, parameters.makeup[0]);
    const mix = parameters.mix[0];
    const peakMode = parameters.detector[0] >= 0.5;
    const hpfHz = parameters.scHpf[0];
    const autoRel = (parameters.autoRelease ? parameters.autoRelease[0] : 0) >= 0.5;
    // Program density: energy of the INPUT first-difference vs energy of the
    // input (transient-rich signals have high diff/total). Smoothed per
    // block; drives a 0.3×–1× multiplier on the release blend.
    let diffEnergy = 0;
    let totEnergy = 0;
    {
      const prevInL = this.prevInL;
      const prevInR = this.prevInR;
      const p0 = mainL ? mainL[0] : prevInL;
      const p1 = mainR ? mainR[0] : prevInR;
      diffEnergy += (p0 - prevInL) ** 2 + (p1 - prevInR) ** 2;
      totEnergy += p0 * p0 + p1 * p1;
    }
    const hpfOn = sideActive && hpfHz > 25;
    const dt = 1 / sr;
    const rc = hpfOn ? 1 / (2 * Math.PI * Math.max(20, hpfHz)) : 0;
    const hpA = hpfOn ? rc / (rc + dt) : 0;

    // ---- DE-ESS band-pass detector (applies to the MAIN signal too — the
    // sibilance band is measured on the program itself unless an explicit
    // sidechain source overrides it). Band = cascaded 12 dB/oct HP at
    // bandHz/1.8 + 12 dB/oct LP at bandHz*1.8 → ~1.5-octave skirt.
    const deEss = (parameters.scMode ? parameters.scMode[0] : 0) >= 0.5;
    const bandHz = Math.max(2000, Math.min(12000, parameters.scBandHz ? parameters.scBandHz[0] : 6500));
    const bpHpA = deEss ? 1 / (1 + 2 * Math.PI * (bandHz / 1.8) * dt) : 0;
    const bpLpA = deEss ? Math.exp(-2 * Math.PI * (bandHz * 1.8) * dt) : 0;

    for (let i = 0; i < len; i++) {
      const l = mainL ? mainL[i] : 0;
      const r = mainR ? mainR[i] : l;

      // ---- detector source (sidechain when connected, else main) ----
      let dL = 0;
      let dR = 0;
      if (deEss) {
        // Band-passed PROGRAM detector (an explicit sidechain input still
        // wins — routing an external de-ess trigger is a valid use).
        if (!sideActive) {
          // 2× cascaded one-pole HP (the scHpf differencing idiom
          // y = a·(y₁ + x − x₁); each stage carries its OWN previous input)
          // then 2× one-pole LP, per channel.
          const h1l = bpHpA * (this.bpHp1L + l - this.bpHpIn1L);
          const h1r = bpHpA * (this.bpHp1R + r - this.bpHpIn1R);
          this.bpHpIn1L = l;
          this.bpHpIn1R = r;
          this.bpHp1L = h1l;
          this.bpHp1R = h1r;
          const h2l = bpHpA * (this.bpHp2L + h1l - this.bpHpIn2L);
          const h2r = bpHpA * (this.bpHp2R + h1r - this.bpHpIn2R);
          this.bpHpIn2L = h1l;
          this.bpHpIn2R = h1r;
          this.bpHp2L = h2l;
          this.bpHp2R = h2r;
          const p1l = bpLpA * this.bpLp1L + (1 - bpLpA) * h2l;
          const p1r = bpLpA * this.bpLp1R + (1 - bpLpA) * h2r;
          this.bpLp1L = p1l;
          this.bpLp1R = p1r;
          const p2l = bpLpA * this.bpLp2L + (1 - bpLpA) * p1l;
          const p2r = bpLpA * this.bpLp2R + (1 - bpLpA) * p1r;
          this.bpLp2L = p2l;
          this.bpLp2R = p2r;
          dL = Math.abs(p2l) < 1e-15 ? 0 : p2l;
          dR = Math.abs(p2r) < 1e-15 ? 0 : p2r;
        } else {
          const sl = sideL ? sideL[i] : 0;
          const sr2 = sideR ? sideR[i] : sl;
          dL = sl;
          dR = sr2;
        }
      } else if (sideActive) {
        const sl = sideL ? sideL[i] : 0;
        const sr2 = sideR ? sideR[i] : sl;
        if (hpfOn) {
          // 2× cascaded one-pole highpass (12 dB/oct) on the detector path.
          const y1l = hpA * (this.postL1 + sl - this.prevInL);
          const y1r = hpA * (this.postR1 + sr2 - this.prevInR);
          const y2l = hpA * (this.postL2 + y1l - this.prevL1);
          const y2r = hpA * (this.postR2 + y1r - this.prevR1);
          this.prevInL = sl;
          this.prevInR = sr2;
          this.prevL1 = y1l;
          this.prevR1 = y1r;
          this.postL1 = y1l;
          this.postR1 = y1r;
          this.postL2 = y2l;
          this.postR2 = y2r;
          if (Math.abs(this.postL1) < 1e-20) this.postL1 = 0;
          if (Math.abs(this.postR1) < 1e-20) this.postR1 = 0;
          if (Math.abs(this.postL2) < 1e-20) this.postL2 = 0;
          if (Math.abs(this.postR2) < 1e-20) this.postR2 = 0;
          if (Math.abs(this.prevL1) < 1e-20) this.prevL1 = 0;
          if (Math.abs(this.prevR1) < 1e-20) this.prevR1 = 0;
          if (Math.abs(this.prevInL) < 1e-20) this.prevInL = 0;
          if (Math.abs(this.prevInR) < 1e-20) this.prevInR = 0;
          dL = y2l;
          dR = y2r;
          if (Math.abs(dL) < 1e-20) dL = 0;
          if (Math.abs(dR) < 1e-20) dR = 0;
        } else {
          dL = sl;
          dR = sr2;
        }
      } else {
        dL = l;
        dR = r;
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
      if (autoRel) {
        const d = (mainL ? mainL[i] : 0) - (mainL && i > 0 ? mainL[i - 1] : 0);
        const dd = (mainR ? mainR[i] : 0) - (mainR && i > 0 ? mainR[i - 1] : 0);
        diffEnergy += d * d + dd * dd;
        const xv = mainL ? mainL[i] : 0;
        totEnergy += xv * xv;
      }
      // releaseBlendEff: dense transients shorten recovery (down to 0.3×),
      // smooth program relaxes it back to the knob's value.
      const releaseBlendEff = autoRel ? releaseBlend * (1 + 2.3 * Math.min(1, this.densitySmoothed)) : releaseBlend;
      this.gain =
        target < this.gain
          ? this.gain + (target - this.gain) * attackBlend
          : this.gain + (target - this.gain) * releaseBlendEff;
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

    // ---- program density smoothing (for the next block's autoRelease) ----
    if (autoRel) {
      const density = diffEnergy / Math.max(totEnergy, 1e-9);
      this.densitySmoothed = 0.9 * this.densitySmoothed + 0.1 * Math.min(1, density * 4);
    } else {
      this.densitySmoothed = 0;
    }

    // ---- metering ----
    const now = typeof globalThis.currentTime === "number" ? globalThis.currentTime : this.grWindowStart + len / sr;
    if (now - this.grWindowStart >= 0.05) {
      const grDb =
        this.grAccumulator > 1e-4 ? Math.min(24, -20 * Math.log10(Math.max(1e-4, 1 - this.grAccumulator))) : 0;
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
