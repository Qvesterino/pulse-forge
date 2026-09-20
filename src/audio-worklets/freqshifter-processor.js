/**
 * Frequency Shifter AudioWorkletProcessor — single-sideband (SSB) shift.
 *
 * Unlike a pitch shifter, a frequency shifter moves every partial by a FIXED
 * Hz offset (harmonics stop being harmonic) — the classic unearthly metallic
 * drift for percussion and drones (Bode-style).
 *
 * Implementation: two 8-stage first-order allpass cascades whose pole
 * frequencies interleave (Bristow-Johnson style matched pair), PER CHANNEL —
 * the wet path keeps a real stereo image instead of collapsing to mono. The
 * branches are phase-quadrature across ~150 Hz…8 kHz; quadrature mixing with
 * a complex oscillator at the shift frequency yields the SSB. Coefficients
 * derive from the pole frequencies and the context sample rate, and |c| < 1
 * always — the cascade cannot blow up.
 *
 * Pro modules beyond the shift itself:
 *   - `side`    UPPER / LOWER / BOTH sideband select (the Bode signature)
 *   - `fine`    ±50 Hz detune for dialling beating partials
 *   - `lfoRate`/`lfoDepth` sweep the shift (animated metallic drift)
 *   - `spread`  opposite shift direction per channel (wide stereo field)
 *   - `feedback` short delay loop around the shifter (kosmische sequences)
 *   - `drive`   soft saturation into the shift stage
 *   - `tone`    wet lowpass to tame aliasing hash at extreme shifts
 *
 * `shift` holds the classic behaviour: at 0 with depth/feedback/drive at 0
 * the allpass pair is magnitude-flat, so shift 0 ≈ passthrough.
 * `mix: 0` is a bit-exact dry copy.
 *
 * Determinism: LFO phase starts at 0 on construction and every other state
 * is zero-initialised — two renders of the same document are bit-identical
 * (offline parity), matching the ringMod/vinyl precedent.
 *
 * NOTE: served as part of core-worklet.js — plain JavaScript only.
 */
const BRANCH_A_POLES = [75, 150, 300, 600, 1200, 2400, 4800, 7500];
const BRANCH_B_POLES = [250, 500, 1000, 2000, 3000, 4000, 6000, 8000];
const FS_STAGES = 8;

function fsRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Read a k-rate parameter defensively (missing → fallback). */
function fsPv(parameters, name, fallback) {
  const p = parameters[name];
  if (!p || p.length === 0) return fallback;
  const v = p[0];
  return Number.isFinite(v) ? v : fallback;
}

function fsClamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Fast tanh approximation (Padé 3/2) — smooth saturation without libm cost. */
function fsSoftSat(x) {
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

class FreqShiftProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sr = globalThis.sampleRate || 44100;
    this.sr = sr;
    // Decorrelated dither seed per instance (only used to break the L/R
    // symmetry of the feedback loop start; renders stay deterministic).
    const seed = (options && options.processorOptions && options.processorOptions.seed) || 1;
    this.rng = fsRng(seed);
    const coefFor = (poleHz) => {
      const t = Math.tan((Math.PI * poleHz) / sr);
      return (t - 1) / (t + 1); // |c| < 1 for any positive pole frequency
    };
    this.coeffsA = BRANCH_A_POLES.map(coefFor);
    this.coeffsB = BRANCH_B_POLES.map(coefFor);
    // Per-channel allpass state: [stage * 2 + 0/1] for xPrev/yPrev.
    // A shared (mono) state would collapse the wet image — each channel
    // keeps its own so stereo sources stay stereo through the shifter.
    this.stateAL = new Float64Array(FS_STAGES * 2);
    this.stateAR = new Float64Array(FS_STAGES * 2);
    this.stateBL = new Float64Array(FS_STAGES * 2);
    this.stateBR = new Float64Array(FS_STAGES * 2);
    this.phaseL = 0;
    this.phaseR = 0;
    this.lfoPhase = 0;
    // Feedback delay (per channel), sized for the 100 ms max at any rate.
    this.fbLen = Math.ceil(sr * 0.11);
    this.fbL = new Float32Array(this.fbLen);
    this.fbR = new Float32Array(this.fbLen);
    this.fbPos = 0;
    // Wet tone one-pole LP state (per channel).
    this.toneLpL = 0;
    this.toneLpR = 0;
  }

  static get parameterDescriptors() {
    return [
      { name: "shift", defaultValue: 0, minValue: -1000, maxValue: 1000, automationRate: "k-rate" },
      { name: "fine", defaultValue: 0, minValue: -50, maxValue: 50, automationRate: "k-rate" },
      { name: "side", defaultValue: 0, minValue: 0, maxValue: 2, automationRate: "k-rate" },
      { name: "lfoRate", defaultValue: 0.1, minValue: 0.01, maxValue: 10, automationRate: "k-rate" },
      { name: "lfoDepth", defaultValue: 0, minValue: 0, maxValue: 500, automationRate: "k-rate" },
      { name: "feedback", defaultValue: 0, minValue: 0, maxValue: 0.9, automationRate: "k-rate" },
      { name: "delayTime", defaultValue: 30, minValue: 1, maxValue: 100, automationRate: "k-rate" },
      { name: "drive", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "tone", defaultValue: 16000, minValue: 500, maxValue: 16000, automationRate: "k-rate" },
      { name: "spread", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  allpassBranch(state, coeffs, x) {
    // First-order allpass per stage: y[n] = c·x[n] + x[n−1] − c·y[n−1].
    let out = x;
    for (let s = 0; s < coeffs.length; s++) {
      const c = coeffs[s];
      const xPrev = state[s * 2];
      const yPrev = state[s * 2 + 1];
      const y = c * out + xPrev - c * yPrev;
      state[s * 2] = out;
      state[s * 2 + 1] = y;
      out = y;
    }
    return out;
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

    const shift = fsClamp(fsPv(parameters, "shift", 0), -1000, 1000);
    const fine = fsClamp(fsPv(parameters, "fine", 0), -50, 50);
    const side = Math.round(fsClamp(fsPv(parameters, "side", 0), 0, 2));
    const lfoRate = fsClamp(fsPv(parameters, "lfoRate", 0.1), 0.01, 10);
    const lfoDepth = fsClamp(fsPv(parameters, "lfoDepth", 0), 0, 500);
    const feedback = fsClamp(fsPv(parameters, "feedback", 0), 0, 0.9);
    const delayMs = fsClamp(fsPv(parameters, "delayTime", 30), 1, 100);
    const drive = fsClamp(fsPv(parameters, "drive", 0), 0, 1);
    const toneHz = fsClamp(fsPv(parameters, "tone", 16000), 500, 16000);
    const spread = fsClamp(fsPv(parameters, "spread", 0), 0, 1);
    const mix = fsClamp(fsPv(parameters, "mix", 1), 0, 1);

    // Mix 0 is a bit-exact dry copy (no DSP touched).
    if (mix <= 0) {
      for (let i = 0; i < len; i++) {
        outL[i] = inL ? inL[i] : 0;
        if (outR) outR[i] = inR ? inR[i] : outL[i];
      }
      return true;
    }

    const driveK = 1 + drive * 4;
    const toneCoef = 1 - Math.exp((-2 * Math.PI * toneHz) / sr);
    const delaySamples = Math.max(1, Math.min(this.fbLen - 1, ((delayMs / 1000) * sr) | 0));
    const lfoStep = (2 * Math.PI * lfoRate) / sr;
    // Spread crossfades the right channel from following the shift to
    // opposing it — the classic wide frequency-shifted field.
    const shiftRBase = shift * (1 - 2 * spread);
    const dryMix = 1 - mix;

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;

      // LFO sweep (shared phase — both channels breathe together; spread
      // only flips the carrier direction, never the sweep).
      this.lfoPhase += lfoStep;
      if (this.lfoPhase > 2 * Math.PI) this.lfoPhase -= 2 * Math.PI;
      const sweep = Math.sin(this.lfoPhase) * lfoDepth;

      // Feedback taps (linear-interpolated short delay per channel).
      const readPos = (this.fbPos - delaySamples + this.fbLen * 2) % this.fbLen;
      const rIdx = Math.floor(readPos);
      const rFrac = readPos - rIdx;
      const fbL = this.fbL[rIdx] * (1 - rFrac) + this.fbL[(rIdx + 1) % this.fbLen] * rFrac;
      const fbR = this.fbR[rIdx] * (1 - rFrac) + this.fbR[(rIdx + 1) % this.fbLen] * rFrac;

      // Per-channel SSB. Quadrature branches stay per-channel so the wet
      // image is real stereo; the carrier oscillator runs opposite
      // directions when spread is up.
      const feedL = l + fbL * feedback;
      const feedR = r + fbR * feedback;
      const drivenL = drive > 0.001 ? fsSoftSat(feedL * driveK) / (1 + drive * 0.6) : feedL;
      const drivenR = drive > 0.001 ? fsSoftSat(feedR * driveK) / (1 + drive * 0.6) : feedR;

      const xaL = this.allpassBranch(this.stateAL, this.coeffsA, drivenL);
      const xbL = this.allpassBranch(this.stateBL, this.coeffsB, drivenL);
      const xaR = this.allpassBranch(this.stateAR, this.coeffsA, drivenR);
      const xbR = this.allpassBranch(this.stateBR, this.coeffsB, drivenR);

      const shiftL = shift + fine + sweep;
      const shiftR = shiftRBase + fine + sweep;
      this.phaseL += (-2 * Math.PI * shiftL) / sr;
      this.phaseR += (-2 * Math.PI * shiftR) / sr;
      if (this.phaseL > 2 * Math.PI) this.phaseL -= 2 * Math.PI;
      else if (this.phaseL < -2 * Math.PI) this.phaseL += 2 * Math.PI;
      if (this.phaseR > 2 * Math.PI) this.phaseR -= 2 * Math.PI;
      else if (this.phaseR < -2 * Math.PI) this.phaseR += 2 * Math.PI;
      const cosL = Math.cos(this.phaseL);
      const sinL = Math.sin(this.phaseL);
      const cosR = Math.cos(this.phaseR);
      const sinR = Math.sin(this.phaseR);

      // UPPER: xa·cos − xb·sin ··· LOWER: xa·cos + xb·sin ··· BOTH: xa·cos.
      // (BOTH = (upper + lower) / 2 — the ring-mod-ish shimmer without
      // suppressing either sideband.)
      let wetL;
      let wetR;
      if (side === 1) {
        wetL = xaL * cosL + xbL * sinL;
        wetR = xaR * cosR + xbR * sinR;
      } else if (side === 2) {
        wetL = xaL * cosL;
        wetR = xaR * cosR;
      } else {
        wetL = xaL * cosL - xbL * sinL;
        wetR = xaR * cosR - xbR * sinR;
      }

      // Wet tone trim (one-pole LP per channel).
      this.toneLpL += (wetL - this.toneLpL) * toneCoef;
      this.toneLpR += (wetR - this.toneLpR) * toneCoef;

      // Feedback write (post-tone wet feeds the loop).
      this.fbL[this.fbPos] = this.toneLpL;
      this.fbR[this.fbPos] = this.toneLpR;
      this.fbPos = (this.fbPos + 1) % this.fbLen;

      outL[i] = l * dryMix + this.toneLpL * mix;
      if (outR) outR[i] = r * dryMix + this.toneLpR * mix;
    }
    return true;
  }
}

registerProcessor("freqshift-processor", FreqShiftProcessor);
