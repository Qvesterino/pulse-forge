/**
 * Stock EQ AudioWorkletProcessor — 6-band decramped equalizer.
 *
 * Serial cascade HP → lowshelf → 2× peaking → highshelf → LP, but the
 * cramp-prone bands use topologies that are exact by construction instead
 * of raw RBJ cookbook sections:
 *
 *  - Shelves are PARALLEL form: lowshelf y = x + g·LP(x),
 *    highshelf y = x + g·(x − LP(x)) with 2-pole Butterworth LP prototypes.
 *    At DC and Nyquist the LP is exactly 1 / 0, so both shelf ends land
 *    precisely on 0 dB and ±G — the classic RBJ shelf droop near Nyquist
 *    (a +12 dB air shelf reading +7 dB at 20 kHz) cannot happen.
 *  - Peaking bands are RBJ with bilinear Q pre-correction
 *    Q' = Q·(π·fc/fs)/sin(π·fc/fs), the first-order inverse of the bilinear
 *    bandwidth warp — the presence peak keeps its center AND its width.
 *  - HP/LP are plain RBJ (their centers are exact by design; shelves and
 *    bells were the cramp offenders, not the pass filters).
 *
 * Controls glide per block (~3 ms one-pole toward the k-rate target) and
 * coefficients are recomputed per block in float64 — automation never
 * zippers and never clicks. Stereo channels carry independent states.
 * Deterministic: no PRNG, all states start at zero.
 *
 * NOTE: served RAW to AudioWorklet.addModule() — plain JavaScript only.
 */
const EQ_SMOOTH_TC = 0.003;
const BUTTER_Q = 0.7071067811865475;

/** 2-pole Butterworth lowpass prototype (normalized, a0 = 1). */
function lpProto(fc, sr) {
  const w0 = (2 * Math.PI * fc) / sr;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * BUTTER_Q);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cos) / 2 / a0,
    b1: (1 - cos) / a0,
    b2: (1 - cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** RBJ highpass (normalized, a0 = 1). */
function hpProto(fc, sr) {
  const w0 = (2 * Math.PI * fc) / sr;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * BUTTER_Q);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cos) / 2 / a0,
    b1: -(1 + cos) / a0,
    b2: (1 + cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** RBJ peaking with caller-supplied (possibly pre-corrected) Q. */
function peakProto(fc, gdb, q, sr) {
  const A = Math.pow(10, gdb / 40);
  const w0 = (2 * Math.PI * fc) / sr;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const a0 = 1 + alpha / A;
  return {
    b0: (1 + alpha * A) / a0,
    b1: (-2 * cos) / a0,
    b2: (1 - alpha * A) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha / A) / a0,
  };
}

/**
 * Inverse of the bilinear bandwidth warp: a peaking band designed with Q'
 * measures Q at fc. → 1 far below Nyquist, ≈ 1.05 at 8 kHz/48 kHz,
 * ≈ 1.21 at 16 kHz/48 kHz.
 */
function decrampedQ(q, fc, sr) {
  const x = (Math.PI * fc) / sr;
  const s = Math.sin(x);
  if (s < 1e-6) return q;
  return (q * x) / s;
}

class EqProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.init = false;
    this.hp = 20;
    this.lp = 20000;
    this.lsF = 120;
    this.lsG = 0;
    this.lmF = 400;
    this.lmG = 0;
    this.lmQ = 1;
    this.hmF = 2500;
    this.hmG = 0;
    this.hmQ = 1;
    this.hsF = 6000;
    this.hsG = 0;
    // 6 DF-I biquads × 4 states (x1, x2, y1, y2) per channel.
    this.sL = new Float64Array(24);
    this.sR = new Float64Array(24);
  }

  static get parameterDescriptors() {
    return [
      { name: "hpFreq", defaultValue: 20, minValue: 20, maxValue: 1000, automationRate: "k-rate" },
      { name: "lpFreq", defaultValue: 20000, minValue: 2000, maxValue: 20000, automationRate: "k-rate" },
      { name: "lowShelfFreq", defaultValue: 120, minValue: 40, maxValue: 500, automationRate: "k-rate" },
      { name: "lowShelfGain", defaultValue: 0, minValue: -15, maxValue: 15, automationRate: "k-rate" },
      { name: "lowMidFreq", defaultValue: 400, minValue: 80, maxValue: 2000, automationRate: "k-rate" },
      { name: "lowMidGain", defaultValue: 0, minValue: -15, maxValue: 15, automationRate: "k-rate" },
      { name: "lowMidQ", defaultValue: 1, minValue: 0.3, maxValue: 8, automationRate: "k-rate" },
      { name: "highMidFreq", defaultValue: 2500, minValue: 500, maxValue: 8000, automationRate: "k-rate" },
      { name: "highMidGain", defaultValue: 0, minValue: -15, maxValue: 15, automationRate: "k-rate" },
      { name: "highMidQ", defaultValue: 1, minValue: 0.3, maxValue: 8, automationRate: "k-rate" },
      { name: "highShelfFreq", defaultValue: 6000, minValue: 1500, maxValue: 16000, automationRate: "k-rate" },
      { name: "highShelfGain", defaultValue: 0, minValue: -15, maxValue: 15, automationRate: "k-rate" },
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

    const P = parameters;
    if (!this.init) {
      this.hp = P.hpFreq[0];
      this.lp = P.lpFreq[0];
      this.lsF = P.lowShelfFreq[0];
      this.lsG = P.lowShelfGain[0];
      this.lmF = P.lowMidFreq[0];
      this.lmG = P.lowMidGain[0];
      this.lmQ = P.lowMidQ[0];
      this.hmF = P.highMidFreq[0];
      this.hmG = P.highMidGain[0];
      this.hmQ = P.highMidQ[0];
      this.hsF = P.highShelfFreq[0];
      this.hsG = P.highShelfGain[0];
      this.init = true;
    }
    const k = 1 - Math.exp(-len / (EQ_SMOOTH_TC * sr));
    this.hp += (this.clampNum(P.hpFreq[0], 20, 1000) - this.hp) * k;
    this.lp += (this.clampNum(P.lpFreq[0], 2000, 20000) - this.lp) * k;
    this.lsF += (this.clampNum(P.lowShelfFreq[0], 40, 500) - this.lsF) * k;
    this.lsG += (this.clampNum(P.lowShelfGain[0], -15, 15) - this.lsG) * k;
    this.lmF += (this.clampNum(P.lowMidFreq[0], 80, 2000) - this.lmF) * k;
    this.lmG += (this.clampNum(P.lowMidGain[0], -15, 15) - this.lmG) * k;
    this.lmQ += (this.clampNum(P.lowMidQ[0], 0.3, 8) - this.lmQ) * k;
    this.hmF += (this.clampNum(P.highMidFreq[0], 500, 8000) - this.hmF) * k;
    this.hmG += (this.clampNum(P.highMidGain[0], -15, 15) - this.hmG) * k;
    this.hmQ += (this.clampNum(P.highMidQ[0], 0.3, 8) - this.hmQ) * k;
    this.hsF += (this.clampNum(P.highShelfFreq[0], 1500, 16000) - this.hsF) * k;
    this.hsG += (this.clampNum(P.highShelfGain[0], -15, 15) - this.hsG) * k;

    // Block-rate coefficients (controls glide on ~3 ms, never step audibly).
    const C = {
      hp: hpProto(this.hp, sr),
      lp: lpProto(this.lp, sr),
      lsLp: lpProto(this.lsF, sr),
      hsLp: lpProto(this.hsF, sr),
      lm: peakProto(this.lmF, this.lmG, decrampedQ(this.lmQ, this.lmF, sr), sr),
      hm: peakProto(this.hmF, this.hmG, decrampedQ(this.hmQ, this.hmF, sr), sr),
      lsG: Math.pow(10, this.lsG / 20) - 1,
      hsG: Math.pow(10, this.hsG / 20) - 1,
    };

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;
      outL[i] = this.runChannel(this.sL, C, l);
      if (outR) outR[i] = this.runChannel(this.sR, C, r);
    }
    this.flushTiny(this.sL);
    this.flushTiny(this.sR);
    return true;
  }

  clampNum(v, lo, hi) {
    if (!Number.isFinite(v)) return lo;
    return v < lo ? lo : v > hi ? hi : v;
  }

  /** Direct-form I biquad step; states live at st[o..o+3]. */
  df1(st, o, c, x) {
    const y = c.b0 * x + c.b1 * st[o] + c.b2 * st[o + 1] - c.a1 * st[o + 2] - c.a2 * st[o + 3];
    st[o + 1] = st[o];
    st[o] = x;
    st[o + 3] = st[o + 2];
    st[o + 2] = y;
    return y;
  }

  runChannel(st, C, x) {
    // State slots: 0 HP, 4 lowshelf-LP, 8 lowmid-peak, 12 highmid-peak,
    // 16 highshelf-LP, 20 LP.
    let v = this.df1(st, 0, C.hp, x);
    const lsT = this.df1(st, 4, C.lsLp, v);
    v = v + C.lsG * lsT;
    v = this.df1(st, 8, C.lm, v);
    v = this.df1(st, 12, C.hm, v);
    const hsT = this.df1(st, 16, C.hsLp, v);
    v = v + C.hsG * (v - hsT);
    v = this.df1(st, 20, C.lp, v);
    return v;
  }

  flushTiny(st) {
    for (let i = 0; i < st.length; i++) {
      const v = st[i];
      if (v < 1e-20 && v > -1e-20) st[i] = 0;
    }
  }
}

export function createEqProcessor() {
  return new EqProcessor();
}

registerProcessor("eq-processor", EqProcessor);
