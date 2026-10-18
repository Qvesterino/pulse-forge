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
 *   - k-rate controls are de-clicked internally: MIX/LEVEL/SIBILANCE glide
 *     per sample (8 ms), LO/HI/Q/FOCUS/STEREO glide per block (15 ms)
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

// De-click time constants. A k-rate AudioParam jumps at a block boundary; the
// processor glides the audible consequences instead of stepping them.
//  - gains (mix / level / sibilance): per-sample one-pole, 8 ms
//  - layout (lo/hi/q/shift/stereo): per-block one-pole, 15 ms — coefficient
//    moves are audible, so they are interpolated across render quanta.
const GAIN_SMOOTH_SEC = 0.008;
const LAYOUT_SMOOTH_SEC = 0.015;

/** Snap a smoothed value once it is indistinguishable from the target, so a
 *  layout glide stops rebuilding the filterbank forever. */
function snapTo(value, target, eps) {
  return Math.abs(value - target) <= eps ? target : value;
}

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
    // Numeric layout fingerprint (NOT a string): comparing numbers is
    // allocation-free, while the previous template/toFixed comparison built
    // seven short-lived strings on every render quantum. `stereo` has its own
    // pan fingerprint because it does not touch the coefficient banks.
    this.lastBands = -1;
    this.lastLoFreq = NaN;
    this.lastHiFreq = NaN;
    this.lastQ = NaN;
    this.lastShift = NaN;
    this.lastPanBands = -1;
    this.lastStereo = NaN;

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

    // Second, complete filterbank used only while a BANDS change crossfades.
    // The old bank keeps processing (so its state stays coherent); the new
    // bank starts from the shared band states and fades in over ~25 ms.
    // Nothing is allocated on the render path: the bank exists for the life
    // of the processor and is swapped in when the fade completes.
    this.carCoeffsB = new Float64Array(VOC_MAX_BANDS * 5);
    this.modCoeffsB = new Float64Array(VOC_MAX_BANDS * 5);
    this.carrierStateB = Array.from({ length: VOC_MAX_BANDS * 2 }, makeBiquadState);
    this.modStateB = Array.from({ length: VOC_MAX_BANDS * 2 }, makeBiquadState);
    this.envB = new Float64Array(VOC_MAX_BANDS * 2);
    this.panLB = new Float64Array(VOC_MAX_BANDS);
    this.panRB = new Float64Array(VOC_MAX_BANDS);
    this.fadeActive = false;
    this.fadeWarm = false;
    this.warmPos = 0;
    this.warmLen = 1;
    this.fadePos = 0;
    this.fadeLen = 1;
    this.fadeInv = 1;
    this.fadeOldBands = VOC_MAX_BANDS;
    this.fadeNewBands = VOC_MAX_BANDS;
    this.fadeOldGain = 1.6 / Math.sqrt(VOC_MAX_BANDS);
    this.fadeNewGain = 1.6 / Math.sqrt(VOC_MAX_BANDS);
    this.bankSumL = 0;
    this.bankSumR = 0;

    // Smoothed control state. Initialized from the first render block, so a
    // restored preset or a start-at-non-default automation value does not fade
    // in from the constructor defaults.
    this.layoutInit = false;
    this.loFreqSmooth = 120;
    this.hiFreqSmooth = 7000;
    this.qSmooth = 4;
    this.shiftSmooth = 0;
    this.stereoSmooth = 0.6;
    this.gainInit = false;
    this.mixSmooth = 1;
    this.levelSmooth = 1;
    this.sibSmooth = 0.35;
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

  /** Write both coefficient banks for a layout into the supplied arrays. */
  buildLayout(carCoeffs, modCoeffs, bands, loFreq, hiFreq, q, shift) {
    const ratio = hiFreq / loFreq;
    const shiftRatio = Math.pow(2, shift / 12);
    for (let b = 0; b < VOC_MAX_BANDS; b++) {
      const t = bands > 1 ? Math.min(1, b / (bands - 1)) : 0;
      const f0 = loFreq * Math.pow(ratio, t);
      // Bands beyond the active count mirror the last frequency: their state
      // is never read (the loop stops at `bands`), so the values are inert.
      this.setBandpass(carCoeffs, b, f0, q);
      // Positive formant shift raises the modulator's spectral envelope: a
      // modulator peak at f excites the carrier band at f * shiftRatio, so
      // analyze each carrier band at the corresponding lower modulator center.
      this.setBandpass(modCoeffs, b, clamp(f0 / shiftRatio, 20, this.sr * 0.45), q);
    }
  }

  /** Rebuild the live coefficient banks for a layout. */
  rebuildLayout(bands, loFreq, hiFreq, q, shift) {
    this.buildLayout(this.carCoeffs, this.modCoeffs, bands, loFreq, hiFreq, q, shift);
    this.lastBands = bands;
    this.lastLoFreq = loFreq;
    this.lastHiFreq = hiFreq;
    this.lastQ = q;
    this.lastShift = shift;
  }

  /** Write the equal-power band fan into the supplied pan arrays. */
  buildPan(panL, panR, bands, stereo) {
    for (let b = 0; b < VOC_MAX_BANDS; b++) {
      const pan = bands > 1 ? (b / (bands - 1)) * 2 - 1 : 0;
      const angle = ((pan + 1) * Math.PI) / 4;
      const gl = Math.cos(angle);
      const gr = Math.sin(angle);
      panL[b] = 1 + (gl - 1) * stereo;
      panR[b] = 1 + (gr - 1) * stereo;
    }
  }

  /** Rebuild the live pan fan. Separated from the coefficient banks because
   *  STEREO and BANDS change the fan without changing any biquad. */
  rebuildPan(bands, stereo) {
    this.buildPan(this.panL, this.panR, bands, stereo);
    this.lastPanBands = bands;
    this.lastStereo = stereo;
  }

  /** Begin a click-free BANDS change. The old bank keeps its coefficients and
   *  state; the new bank shares the states of bands that already exist and
   *  starts the rest at zero, then the two outputs crossfade. */
  startBandCrossfade(newBands, loFreq, hiFreq, q, shift, stereo) {
    const oldBands = this.lastBands > 0 ? this.lastBands : newBands;
    this.fadeOldBands = oldBands;
    this.fadeNewBands = newBands;
    this.fadeOldGain = 1.6 / Math.sqrt(oldBands);
    this.fadeNewGain = 1.6 / Math.sqrt(newBands);
    this.buildLayout(this.carCoeffsB, this.modCoeffsB, newBands, loFreq, hiFreq, q, shift);
    this.buildPan(this.panLB, this.panRB, newBands, stereo);

    // Start the new bank from zero state, not by copying the old band states:
    // BANDS changes the band CENTRES (b/(bands-1)), so the old state belongs to
    // a different transfer function. A silent 20 ms warm-up lets the new bank
    // settle before any of it is faded into the output.
    for (let b = 0; b < VOC_MAX_BANDS * 2; b++) {
      const dstCar = this.carrierStateB[b];
      const dstMod = this.modStateB[b];
      dstCar.x1 = dstCar.x2 = dstCar.y1 = dstCar.y2 = 0;
      dstMod.x1 = dstMod.x2 = dstMod.y1 = dstMod.y2 = 0;
      this.envB[b] = 0;
    }

    this.fadeWarm = true;
    this.warmPos = 0;
    this.warmLen = Math.max(1, Math.round(0.02 * this.sr));
    this.fadePos = 0;
    this.fadeLen = Math.max(1, Math.round(0.025 * this.sr));
    this.fadeInv = 1 / this.fadeLen;
    this.fadeActive = true;
    // The live bank is still the old one, but the target is now the new count.
    // Marking it here suppresses a second crossfade on the next block; a newer
    // BANDS value that arrives mid-fade starts another fade after this one.
    this.lastBands = newBands;
  }

  /** Swap in the newly built bank. Reuses the old bank's allocations for the
   *  next crossfade, so repeated BANDS changes allocate nothing. */
  finishBandCrossfade(loFreq, hiFreq, q, shift, stereo) {
    let swap = this.carCoeffs;
    this.carCoeffs = this.carCoeffsB;
    this.carCoeffsB = swap;
    swap = this.modCoeffs;
    this.modCoeffs = this.modCoeffsB;
    this.modCoeffsB = swap;
    swap = this.carrierState;
    this.carrierState = this.carrierStateB;
    this.carrierStateB = swap;
    swap = this.modState;
    this.modState = this.modStateB;
    this.modStateB = swap;
    swap = this.env;
    this.env = this.envB;
    this.envB = swap;
    swap = this.panL;
    this.panL = this.panLB;
    this.panLB = swap;
    swap = this.panR;
    this.panR = this.panRB;
    this.panRB = swap;
    this.fadeActive = false;
    this.lastBands = this.fadeNewBands;
    this.lastLoFreq = loFreq;
    this.lastHiFreq = hiFreq;
    this.lastQ = q;
    this.lastShift = shift;
    this.lastPanBands = this.fadeNewBands;
    this.lastStereo = stereo;
  }

  /** Render one bank for one sample; the un-scaled band sum lands in
   *  `bankSumL/R`. Used for the live bank and, during a BANDS crossfade, for
   *  both banks. Kept free of allocation and of shared post-processing. */
  renderBankSample(
    carLv,
    carRv,
    modLv,
    modRv,
    attCoef,
    relCoef,
    bands,
    carCoeffs,
    modCoeffs,
    carrierState,
    modState,
    env,
    panL,
    panR,
  ) {
    let sumL = 0;
    let sumR = 0;
    for (let b = 0; b < bands; b++) {
      const cIdx = b * 2;

      // Carrier band at f0 (L/R).
      const carBandL = this.biquad(carLv, carCoeffs, b, carrierState[cIdx]);
      const carBandR = this.biquad(carRv, carCoeffs, b, carrierState[cIdx + 1]);

      // Modulator band mapped inversely to carrier f0 — positive shift moves
      // a modulator peak upward onto a higher-frequency carrier band.
      const modBandL = this.biquad(modLv, modCoeffs, b, modState[cIdx]);
      const modBandR = this.biquad(modRv, modCoeffs, b, modState[cIdx + 1]);

      // Envelope follower per channel (asymmetric attack/release).
      const absL = Math.abs(modBandL);
      const absR = Math.abs(modBandR);
      const envL = env[cIdx];
      const envR = env[cIdx + 1];
      const nextL = absL > envL ? attCoef * envL + (1 - attCoef) * absL : relCoef * envL + (1 - relCoef) * absL;
      const nextR = absR > envR ? attCoef * envR + (1 - attCoef) * absR : relCoef * envR + (1 - relCoef) * absR;
      env[cIdx] = nextL < 1e-20 ? 0 : nextL;
      env[cIdx + 1] = nextR < 1e-20 ? 0 : nextR;

      sumL += carBandL * nextL * panL[b];
      sumR += carBandR * nextR * panR[b];
    }
    this.bankSumL = sumL;
    this.bankSumR = sumR;
  }

  /** One biquad pass (direct form I). */
  biquad(x, bank, index, s) {
    const base = index * 5;
    const y = bank[base] * x + bank[base + 2] * s.x2 - bank[base + 3] * s.y1 - bank[base + 4] * s.y2;
    s.x2 = s.x1;
    s.x1 = x;
    s.y2 = s.y1;
    // Denormal flush — 32 biquad states recirculating on silence stall here.
    s.y1 = y > -1e-20 && y < 1e-20 ? 0 : y;
    return s.y1;
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

    // Glide the coefficient-moving controls across render quanta. A k-rate
    // AudioParam jumps at a block boundary; applying a new biquad bank in one
    // step is a coefficient discontinuity (audible on Q/FOCUS/BAND moves).
    // BANDS is discrete and intentionally immediate; STEREO only rebuilds the
    // pan fan.
    const layoutCoef = 1 - Math.exp(-len / (this.sr * LAYOUT_SMOOTH_SEC));
    if (!this.layoutInit) {
      this.layoutInit = true;
      this.loFreqSmooth = loFreq;
      this.hiFreqSmooth = hiFreq;
      this.qSmooth = q;
      this.shiftSmooth = shift;
      this.stereoSmooth = stereo;
    } else {
      this.loFreqSmooth = snapTo(this.loFreqSmooth + (loFreq - this.loFreqSmooth) * layoutCoef, loFreq, 0.01);
      this.hiFreqSmooth = snapTo(this.hiFreqSmooth + (hiFreq - this.hiFreqSmooth) * layoutCoef, hiFreq, 0.01);
      this.qSmooth = snapTo(this.qSmooth + (q - this.qSmooth) * layoutCoef, q, 1e-3);
      this.shiftSmooth = snapTo(this.shiftSmooth + (shift - this.shiftSmooth) * layoutCoef, shift, 1e-3);
      this.stereoSmooth = snapTo(this.stereoSmooth + (stereo - this.stereoSmooth) * layoutCoef, stereo, 1e-4);
    }

    if (this.fadeActive) {
      // Keep the incoming bank aligned with a simultaneous LO/HI/Q/FOCUS or
      // STEREO glide. The outgoing bank stays frozen at its fade-start state.
      this.buildLayout(
        this.carCoeffsB,
        this.modCoeffsB,
        this.fadeNewBands,
        this.loFreqSmooth,
        this.hiFreqSmooth,
        this.qSmooth,
        this.shiftSmooth,
      );
      this.buildPan(this.panLB, this.panRB, this.fadeNewBands, this.stereoSmooth);
    } else if (bands !== this.lastBands) {
      if (this.lastBands < 0) {
        // First render block: there is no old bank to fade from.
        this.rebuildLayout(bands, this.loFreqSmooth, this.hiFreqSmooth, this.qSmooth, this.shiftSmooth);
        this.rebuildPan(bands, this.stereoSmooth);
      } else {
        // BANDS is the one discrete layout control: crossfade two complete
        // banks instead of dropping seven/eight bands in one sample.
        this.startBandCrossfade(
          bands,
          this.loFreqSmooth,
          this.hiFreqSmooth,
          this.qSmooth,
          this.shiftSmooth,
          this.stereoSmooth,
        );
      }
    } else {
      if (
        this.loFreqSmooth !== this.lastLoFreq ||
        this.hiFreqSmooth !== this.lastHiFreq ||
        this.qSmooth !== this.lastQ ||
        this.shiftSmooth !== this.lastShift
      ) {
        this.rebuildLayout(bands, this.loFreqSmooth, this.hiFreqSmooth, this.qSmooth, this.shiftSmooth);
      }
      if (bands !== this.lastPanBands || this.stereoSmooth !== this.lastStereo) {
        this.rebuildPan(bands, this.stereoSmooth);
      }
    }

    // No modulator wired — pass the carrier through 1:1. The node reports
    // `degraded` so a half-wired vocoder reads as audible-carrier, not
    // silent mystery. The sibilance filter state is cleared so a later
    // reconnect starts from zero instead of replaying the last tail.
    if (!modL) {
      this.sibLp[0] = 0;
      this.sibLp[1] = 0;
      this.sibHp[0] = 0;
      this.sibHp[1] = 0;
      this.sibHpPrev[0] = 0;
      this.sibHpPrev[1] = 0;
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
    // Per-sample gain glide (MIX / LEVEL / SIBILANCE). The first block adopts
    // the current values so preset recall and restored automation do not fade.
    const gainCoef = 1 - Math.exp(-1 / (this.sr * GAIN_SMOOTH_SEC));
    if (!this.gainInit) {
      this.gainInit = true;
      this.mixSmooth = mix;
      this.levelSmooth = levelLin;
      this.sibSmooth = sibilance;
    }

    for (let i = 0; i < len; i++) {
      // Non-finite input must not reach the recursive filter/envelope state:
      // one NaN sample latches every biquad (y1/y2) and envelope follower and
      // silences the plugin for the rest of its life. The graph boundary is the
      // cheapest place to stop that class (same guard as kaskada/skrutka), and
      // it also covers a short input array (undefined reads) safely.
      let carLv = carL ? carL[i] : 0;
      let carRv = carR ? carR[i] : carLv;
      let modLv = modL ? modL[i] : 0;
      let modRv = modR ? modR[i] : modLv;
      if (!Number.isFinite(carLv)) carLv = 0;
      if (!Number.isFinite(carRv)) carRv = 0;
      if (!Number.isFinite(modLv)) modLv = 0;
      if (!Number.isFinite(modRv)) modRv = 0;

      // De-zipper MIX / LEVEL / SIBILANCE. Steady-state endpoints stay exact:
      // mix 0 keeps the dry path bit-identical and mix 1 mutes it exactly.
      this.mixSmooth += (mix - this.mixSmooth) * gainCoef;
      this.levelSmooth += (levelLin - this.levelSmooth) * gainCoef;
      this.sibSmooth += (sibilance - this.sibSmooth) * gainCoef;

      let sumL = 0;
      let sumR = 0;

      if (this.fadeActive) {
        this.renderBankSample(
          carLv,
          carRv,
          modLv,
          modRv,
          attCoef,
          relCoef,
          this.fadeOldBands,
          this.carCoeffs,
          this.modCoeffs,
          this.carrierState,
          this.modState,
          this.env,
          this.panL,
          this.panR,
        );
        const oldL = this.bankSumL * this.fadeOldGain;
        const oldR = this.bankSumR * this.fadeOldGain;
        this.renderBankSample(
          carLv,
          carRv,
          modLv,
          modRv,
          attCoef,
          relCoef,
          this.fadeNewBands,
          this.carCoeffsB,
          this.modCoeffsB,
          this.carrierStateB,
          this.modStateB,
          this.envB,
          this.panLB,
          this.panRB,
        );
        const newL = this.bankSumL * this.fadeNewGain;
        const newR = this.bankSumR * this.fadeNewGain;
        if (this.fadeWarm) {
          // Warm-up: the new bank runs silently so its filters and envelopes
          // settle; only the old bank is audible.
          sumL = oldL;
          sumR = oldR;
          if (++this.warmPos >= this.warmLen) this.fadeWarm = false;
        } else {
          let t = this.fadePos * this.fadeInv;
          if (t > 1) t = 1;
          // Smoothstep: no slope discontinuity at either end of the fade.
          const mixB = t * t * (3 - 2 * t);
          sumL = oldL + (newL - oldL) * mixB;
          sumR = oldR + (newR - oldR) * mixB;
          this.fadePos++;
        }
      } else {
        this.renderBankSample(
          carLv,
          carRv,
          modLv,
          modRv,
          attCoef,
          relCoef,
          bands,
          this.carCoeffs,
          this.modCoeffs,
          this.carrierState,
          this.modState,
          this.env,
          this.panL,
          this.panR,
        );
        sumL = this.bankSumL * bandGain;
        sumR = this.bankSumR * bandGain;
      }

      // Sibilance: high-passed modulator straight to the output so unvoiced
      // consonants cut through the filterbank.
      //
      // One-pole HP = input − one-pole LP, computed in the stable direct form
      //   hp[n] = (1 − c)·(hp[n−1] + lp[n] − lp[n−1])
      // (the same chain vinyl-processor.js uses for its hiss/tone trims).
      // The previous recurrence fed back the OUTPUT without subtracting the
      // previous LP input, which is not a high-pass: it passed DC and 60 Hz at
      // ~0.52 and boosted the top octave, so the "sibilance" layer leaked
      // low-mid modulator content into the wet signal.
      //
      // The chain runs even when SIBILANCE is 0 (the output contribution is
      // multiplied by the knob): a gated-off chain froze its state, so
      // re-enabling the knob replayed the stale tail as a click.
      this.sibLp[0] += (modLv - this.sibLp[0]) * sibLpCoef;
      this.sibHp[0] = (1 - sibHpCoef) * (this.sibHp[0] + this.sibLp[0] - this.sibHpPrev[0]);
      this.sibHpPrev[0] = this.sibLp[0];
      this.sibLp[1] += (modRv - this.sibLp[1]) * sibLpCoef;
      this.sibHp[1] = (1 - sibHpCoef) * (this.sibHp[1] + this.sibLp[1] - this.sibHpPrev[1]);
      this.sibHpPrev[1] = this.sibLp[1];
      if (this.sibLp[0] > -1e-20 && this.sibLp[0] < 1e-20) this.sibLp[0] = 0;
      if (this.sibLp[1] > -1e-20 && this.sibLp[1] < 1e-20) this.sibLp[1] = 0;
      if (this.sibHp[0] > -1e-20 && this.sibHp[0] < 1e-20) this.sibHp[0] = 0;
      if (this.sibHp[1] > -1e-20 && this.sibHp[1] < 1e-20) this.sibHp[1] = 0;
      sumL += this.sibHp[0] * this.sibSmooth * 0.8;
      sumR += this.sibHp[1] * this.sibSmooth * 0.8;

      sumL *= this.levelSmooth;
      sumR *= this.levelSmooth;

      outL[i] = carLv * (1 - this.mixSmooth) + sumL * this.mixSmooth;
      if (outR) outR[i] = carRv * (1 - this.mixSmooth) + sumR * this.mixSmooth;
    }

    // The new bank is warm after the fade; swap it in at the block boundary
    // (mid-block swaps would add a branch to every sample for no benefit).
    if (this.fadeActive && !this.fadeWarm && this.fadePos >= this.fadeLen) {
      this.finishBandCrossfade(this.loFreqSmooth, this.hiFreqSmooth, this.qSmooth, this.shiftSmooth, this.stereoSmooth);
    }

    return true;
  }
}

registerProcessor("vocoder-processor", VocoderProcessor);
