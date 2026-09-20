/**
 * Vocoder AudioWorkletProcessor — classic analysis/synthesis filterbank.
 *
 * Routing (matches the existing sidechain precedent):
 *   input[0] — CARRIER   (the signal that gets sculpted; usually a synth/pad)
 *   input[1] — MODULATOR (the signal that sculpts; a vocal or beat track,
 *              wired via `EffectInstance.sidechainTrackId`)
 *
 * Signal path per band:
 *   1. carrier runs through a 2-pole bandpass at f0[i]
 *   2. modulator runs through its own bandpass at f0[i] / 2^(shift/12)
 *   3. a per-band envelope follower tracks the modulator band
 *   4. output += carrierBand × envelope
 *
 * That is amplitude-transfer vocoding: the carrier keeps its own timbre, but
 * its amplitude envelope across the band set is replaced by the modulator's —
 * the classic robot/choir sound.
 *
 * Pro features beyond the basic 16-band engine:
 *   - `bands`  8 / 12 / 16 log-spaced bands (loFreq…hiFreq)
 *   - `shift`  formant shift −24…+24 st: the modulator spectrum maps onto
 *              carrier bands at the shifted frequencies
 *   - `sibilance` unvoiced passthrough: high-passed modulator mixed straight
 *              into the output so consonants survive the filterbank
 *   - `stereo` equal-power band fan across the stereo field
 *   - `attack`/`release` envelope ballistics, `q` band sharpness, `level`
 *
 * Determinism: pure per-sample DSP with zero randomness — live and offline
 * renders are bit-identical by construction (no seed needed).
 *
 * Fallback: without a modulator connected the carrier passes through 1:1
 * (the node wrapper reports `degraded`), so a half-wired vocoder is audible
 * instead of silent.
 *
 * NOTE: served as part of core-worklet.js — plain JavaScript only.
 */

const VOC_MAX_BANDS = 16;

/** One 2-pole RBJ bandpass biquad state. */
function makeBiquadState() {
  return { x1: 0, x2: 0, y1: 0, y2: 0 };
}

/** Read a k-rate parameter defensively (missing → fallback). */
function pv(parameters, name, fallback) {
  const p = parameters[name];
  if (!p || p.length === 0) return fallback;
  const v = p[0];
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

class VocoderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sr = globalThis.sampleRate || 44100;

    // Coefficient banks: [b0, b1, b2, a1, a2] per band, carrier + modulator.
    // The modulator band for carrier f0 sits at f0 / 2^(shift/12), so a
    // positive shift maps each modulator resonance onto a higher carrier band.
    this.carCoeffs = new Float64Array(VOC_MAX_BANDS * 5);
    this.modCoeffs = new Float64Array(VOC_MAX_BANDS * 5);
    this.lastLayout = "";

    // Per-band filter state, indexed [band * 2 + channel].
    this.carrierState = Array.from({ length: VOC_MAX_BANDS * 2 }, makeBiquadState);
    this.modState = Array.from({ length: VOC_MAX_BANDS * 2 }, makeBiquadState);

    // Envelope followers per band per channel.
    this.env = new Float64Array(VOC_MAX_BANDS * 2);

    // Sibilance: 1-pole LP→HP on the modulator (per channel).
    this.sibLp = [0, 0];
    this.sibHp = [0, 0];
    this.sibHpPrev = [0, 0];

    // Equal-power pan gains, precomputed per band on layout change.
    this.panL = new Float64Array(VOC_MAX_BANDS);
    this.panR = new Float64Array(VOC_MAX_BANDS);
  }

  static get parameterDescriptors() {
    return [
      { name: "bands", defaultValue: 16, minValue: 8, maxValue: VOC_MAX_BANDS, automationRate: "k-rate" },
      { name: "loFreq", defaultValue: 120, minValue: 60, maxValue: 500, automationRate: "k-rate" },
      { name: "hiFreq", defaultValue: 7000, minValue: 2000, maxValue: 12000, automationRate: "k-rate" },
      { name: "q", defaultValue: 4, minValue: 1, maxValue: 16, automationRate: "k-rate" },
      { name: "attack", defaultValue: 0.004, minValue: 0.001, maxValue: 0.2, automationRate: "k-rate" },
      { name: "release", defaultValue: 0.06, minValue: 0.005, maxValue: 1, automationRate: "k-rate" },
      { name: "shift", defaultValue: 0, minValue: -24, maxValue: 24, automationRate: "k-rate" },
      { name: "sibilance", defaultValue: 0.35, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "stereo", defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "level", defaultValue: 0, minValue: -24, maxValue: 12, automationRate: "k-rate" },
      { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  /** Write RBJ bandpass coefficients (b0, b1=0, b2, a1, a2) at `index`. */
  setBandpass(bank, index, f0, q) {
    const sr = this.sr;
    const w0 = (2 * Math.PI * clamp(f0, 20, sr * 0.45)) / sr;
    const alpha = Math.sin(w0) / (2 * Math.max(0.5, q));
    const a0 = 1 + alpha;
    const base = index * 5;
    bank[base] = alpha / a0;
    bank[base + 1] = 0;
    bank[base + 2] = -alpha / a0;
    bank[base + 3] = (-2 * Math.cos(w0)) / a0;
    bank[base + 4] = (1 - alpha) / a0;
  }

  /** Rebuild both coefficient banks + pan table for a layout. */
  rebuildLayout(bands, loFreq, hiFreq, q, shift, stereo) {
    const ratio = hiFreq / loFreq;
    const shiftRatio = Math.pow(2, shift / 12);
    for (let b = 0; b < VOC_MAX_BANDS; b++) {
      const t = bands > 1 ? Math.min(1, b / (bands - 1)) : 0;
      const f0 = loFreq * Math.pow(ratio, t);
      // Bands beyond the active count mirror the last frequency: their state
      // is never read (the loop stops at `bands`), so the values are inert.
      this.setBandpass(this.carCoeffs, b, f0, q);
      // Positive formant shift raises the modulator's spectral envelope: a
      // modulator peak at f excites the carrier band at f * shiftRatio, so
      // analyze each carrier band at the corresponding lower modulator center.
      this.setBandpass(this.modCoeffs, b, clamp(f0 / shiftRatio, 20, this.sr * 0.45), q);

      // Equal-power fan across the stereo field, blended toward mono by
      // `stereo` (0 = every band centred, 1 = full L→R fan).
      const pan = bands > 1 ? (b / (bands - 1)) * 2 - 1 : 0;
      const angle = ((pan + 1) * Math.PI) / 4;
      const gl = Math.cos(angle);
      const gr = Math.sin(angle);
      this.panL[b] = 1 + (gl - 1) * stereo;
      this.panR[b] = 1 + (gr - 1) * stereo;
    }
    this.lastLayout = `${bands}|${loFreq.toFixed(1)}|${hiFreq.toFixed(1)}|${q.toFixed(2)}|${shift.toFixed(2)}|${stereo.toFixed(2)}`;
  }

  /** One biquad pass (direct form I). */
  biquad(x, bank, index, s) {
    const base = index * 5;
    const y = bank[base] * x + bank[base + 2] * s.x2 - bank[base + 3] * s.y1 - bank[base + 4] * s.y2;
    s.x2 = s.x1;
    s.x1 = x;
    s.y2 = s.y1;
    s.y1 = y;
    return y;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const carrier = inputs[0];
    const modulator = inputs[1];

    if (!output || !output[0]) return true;

    const outL = output[0];
    const outR = output.length > 1 ? output[1] : null;
    const carL = carrier && carrier[0] && carrier[0].length ? carrier[0] : null;
    const carR = carrier && carrier.length > 1 && carrier[1] && carrier[1].length ? carrier[1] : null;
    const modL = modulator && modulator[0] && modulator[0].length ? modulator[0] : null;
    const modR = modulator && modulator.length > 1 && modulator[1] && modulator[1].length ? modulator[1] : null;
    const len = outL.length;

    // --- Defensive parameter reads ---
    const bands = Math.round(clamp(pv(parameters, "bands", 16), 8, VOC_MAX_BANDS));
    const loFreq = clamp(pv(parameters, "loFreq", 120), 60, 500);
    const hiFreq = clamp(pv(parameters, "hiFreq", 7000), 2000, 12000);
    const q = clamp(pv(parameters, "q", 4), 1, 16);
    const attack = clamp(pv(parameters, "attack", 0.004), 0.001, 0.2);
    const release = clamp(pv(parameters, "release", 0.06), 0.005, 1);
    const shift = clamp(pv(parameters, "shift", 0), -24, 24);
    const sibilance = clamp(pv(parameters, "sibilance", 0.35), 0, 1);
    const stereo = clamp(pv(parameters, "stereo", 0.6), 0, 1);
    const levelLin = Math.pow(10, clamp(pv(parameters, "level", 0), -24, 12) / 20);
    const mix = clamp(pv(parameters, "mix", 1), 0, 1);

    // Rebuild the filterbank only when the layout actually changes.
    const layout = `${bands}|${loFreq.toFixed(1)}|${hiFreq.toFixed(1)}|${q.toFixed(2)}|${shift.toFixed(2)}|${stereo.toFixed(2)}`;
    if (layout !== this.lastLayout) {
      this.rebuildLayout(bands, loFreq, hiFreq, q, shift, stereo);
    }

    // No modulator wired — pass the carrier through 1:1. The node reports
    // `degraded` so a half-wired vocoder reads as audible-carrier, not
    // silent mystery.
    if (!modL) {
      for (let i = 0; i < len; i++) {
        const l = carL ? carL[i] : 0;
        outL[i] = l;
        if (outR) outR[i] = carR ? carR[i] : l;
      }
      return true;
    }

    const attCoef = Math.exp(-1 / (this.sr * Math.max(0.0005, attack)));
    const relCoef = Math.exp(-1 / (this.sr * Math.max(0.0005, release)));
    // Sibilance HP: one-pole LP at 4 kHz feeding a 500 Hz HP (band ~4k+).
    const sibLpCoef = 1 - Math.exp((-2 * Math.PI * 4000) / this.sr);
    const sibHpCoef = 1 - Math.exp((-2 * Math.PI * 500) / this.sr);
    // Many bands sum; scale by 1/sqrt(n) keeps the level sane across counts.
    const bandGain = 1.6 / Math.sqrt(bands);
    const dryMix = 1 - mix;

    for (let i = 0; i < len; i++) {
      const carLv = carL ? carL[i] : 0;
      const carRv = carR ? carR[i] : carLv;
      const modLv = modL ? modL[i] : 0;
      const modRv = modR ? modR[i] : modLv;

      let sumL = 0;
      let sumR = 0;

      for (let b = 0; b < bands; b++) {
        const cIdx = b * 2;

        // Carrier band at f0 (L/R).
        const carBandL = this.biquad(carLv, this.carCoeffs, b, this.carrierState[cIdx]);
        const carBandR = this.biquad(carRv, this.carCoeffs, b, this.carrierState[cIdx + 1]);

        // Modulator band mapped inversely to carrier f0 — positive shift moves
        // a modulator peak upward onto a higher-frequency carrier band.
        const modBandL = this.biquad(modLv, this.modCoeffs, b, this.modState[cIdx]);
        const modBandR = this.biquad(modRv, this.modCoeffs, b, this.modState[cIdx + 1]);

        // Envelope follower per channel (asymmetric attack/release).
        const absL = Math.abs(modBandL);
        const absR = Math.abs(modBandR);
        const envL = this.env[cIdx];
        const envR = this.env[cIdx + 1];
        const nextL = absL > envL ? attCoef * envL + (1 - attCoef) * absL : relCoef * envL + (1 - relCoef) * absL;
        const nextR = absR > envR ? attCoef * envR + (1 - attCoef) * absR : relCoef * envR + (1 - relCoef) * absR;
        this.env[cIdx] = nextL < 1e-20 ? 0 : nextL;
        this.env[cIdx + 1] = nextR < 1e-20 ? 0 : nextR;

        sumL += carBandL * nextL * this.panL[b];
        sumR += carBandR * nextR * this.panR[b];
      }

      sumL *= bandGain;
      sumR *= bandGain;

      // Sibilance: high-passed modulator straight to the output so unvoiced
      // consonants cut through the filterbank.
      if (sibilance > 0.001) {
        this.sibLp[0] += (modLv - this.sibLp[0]) * sibLpCoef;
        this.sibHpPrev[0] = this.sibHp[0];
        this.sibHp[0] = this.sibLp[0] - this.sibHpPrev[0] * (1 - sibHpCoef);
        this.sibLp[1] += (modRv - this.sibLp[1]) * sibLpCoef;
        this.sibHpPrev[1] = this.sibHp[1];
        this.sibHp[1] = this.sibLp[1] - this.sibHpPrev[1] * (1 - sibHpCoef);
        sumL += this.sibHp[0] * sibilance * 0.8;
        sumR += this.sibHp[1] * sibilance * 0.8;
      }

      sumL *= levelLin;
      sumR *= levelLin;

      outL[i] = carLv * dryMix + sumL * mix;
      if (outR) outR[i] = carRv * dryMix + sumR * mix;
    }

    return true;
  }
}

registerProcessor("vocoder-processor", VocoderProcessor);
