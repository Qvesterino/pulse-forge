/**
 * SKRUTKA (skrutka) AudioWorkletProcessor — frequency-dependent phase
 * dispersion ("disperser").
 *
 * A linear, phase-only effect: no gain rides on the frequency axis, so a
 * steady tone passes at the same level while its PHASE is warped. Broadband
 * events (kick/snare/808 attacks) read the warp as a frequency-dependent
 * arrival time — the modern "throw / gulp" transient character no EQ,
 * saturation or transient shaper can produce (they move amplitude, not
 * arrival).
 *
 * Two cascaded stages, both all-pass:
 *
 * 1. DISPERSION — LONG stage: 8 identical 2nd-order all-pass sections whose
 *    poles sit at `focusHz` with radius `r = 0.15 + 0.83·dispersion` (up to
 *    0.98). Group delay peaks at FOCUS and grows with `dispersion`
 *    (≈ 0.2 ms at 0 → ≈ 6-11 ms at 1 depending on FOCUS, measured by the
 *    SKRUTKA curve module); everything around the focus arrives later than
 *    everything else, which smears the attack or, at high settings, turns it
 *    into a short chirp. The pole angle is the ONLY focus mechanism — a
 *    plain AudioParam, so automating FOCUS sweeps the hump in the render
 *    timeline natively.
 * 2. PUNCH — SHORT stage: 3 identical 2nd-order all-pass sections on a
 *    0.93·|punch| radius, whose CENTER the sign chooses: positive delays the
 *    BODY band (FOCUS / 3.5) so the click leads — a harder, forward attack;
 *    negative delays the CLICK band (FOCUS × 3.5) so the transient sinks
 *    into the body — a softer, "sucked" attack. The center flips at zero,
 *    where the radius is ~0 (a plain short delay), so gliding THROUGH zero
 *    is inaudible. `punch = 0` skips the stage bit-exactly.
 *
 * SPREAD shifts the FOCUS pole angle per channel (L × (1 − 0.12·spread),
 * R × (1 + 0.12·spread)), so the dispersed band decorrelates in stereo;
 * `spread = 0` renders L and R bit-identically (mono-safe by construction).
 *
 * Parameter surface: plain AudioParams (M2 pattern, zenit-m2-nodes.ts) — no
 * port messages, so offline automation is native `setValueAtTime` state and
 * live == offline parity holds automatically. All smoothing uses per-sample
 * time constants applied at block rate with the block-length correction
 * (NEW-EFFECT-CHECKLIST §4). No RNG — deterministic. Every filter state is
 * flushed below 1e-20 before it is stored (checklist §4 denormal trap).
 *
 * `mix = 0` is a bit-exact dry passthrough (`dry · 1 + wet · 0`).
 *
 * Served as its own lazy bundle: public/skrutka-worklet.js
 * (scripts/build-skrutka-worklet.mjs). Plain JavaScript only.
 */

const LONG_SECTIONS = 8; // 2nd-order all-pass sections in the DISPERSION stage
const PUNCH_SECTIONS = 3; // 2nd-order all-pass sections in the PUNCH stage
const R_FLOOR = 0.15; // pole radius at dispersion = 0
const R_RANGE = 0.83; // radius span (floor + span = 0.98 at dispersion = 1)
const R_MAX = 0.985; // hard stability ceiling
const PUNCH_R_MAX = 0.93; // punch pole radius at |punch| = 1
const PUNCH_BAND_RATIO = 3.5; // punch center = focus / ratio (positive) or × ratio (negative)
const PUNCH_FOCUS_MAX_HZ = 6000; // punch center ceiling
const SPREAD_OFFSET = 0.12; // per-channel focus offset fraction at spread = 1
const FOCUS_MIN_HZ = 40; // descriptor floor (kept authoritative here too)
const FOCUS_ABS_MAX_HZ = 6000; // hard ceiling regardless of sample rate
const SMOOTH_TAU_S = 0.03; // parameter glide time constant
const DENORM = 1e-20; // state flush threshold

/** 2nd-order all-pass state block for one channel (DISPERSION stage). */
function makeLongState() {
  return {
    x1: new Float64Array(LONG_SECTIONS),
    x2: new Float64Array(LONG_SECTIONS),
    y1: new Float64Array(LONG_SECTIONS),
    y2: new Float64Array(LONG_SECTIONS),
  };
}

/** 2nd-order all-pass state block for one channel (PUNCH stage). */
function makePunchState() {
  return {
    x1: new Float64Array(PUNCH_SECTIONS),
    x2: new Float64Array(PUNCH_SECTIONS),
    y1: new Float64Array(PUNCH_SECTIONS),
    y2: new Float64Array(PUNCH_SECTIONS),
  };
}

class SkrutkaProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "dispersion", minValue: 0, maxValue: 1, defaultValue: 0.35 },
      { name: "punch", minValue: -1, maxValue: 1, defaultValue: 0 },
      { name: "focusHz", minValue: 40, maxValue: 4000, defaultValue: 220 },
      { name: "spread", minValue: 0, maxValue: 1, defaultValue: 0 },
      { name: "mix", minValue: 0, maxValue: 1, defaultValue: 1 },
      { name: "output", minValue: -18, maxValue: 12, defaultValue: 0 },
    ];
  }

  constructor() {
    super();
    // Per-channel filter state (L, R).
    this.longState = [makeLongState(), makeLongState()];
    this.punchState = [makePunchState(), makePunchState()];
    // Smoothed parameter mirrors, starting at the descriptor defaults so a
    // context that never writes a param renders the declared default.
    this.sm = {
      dispersion: 0.35,
      punch: 0,
      focusHz: 220,
      spread: 0,
      mix: 1,
      output: 0,
    };
    // The FIRST block adopts the incoming values exactly (a project saved
    // with mix = 0 must render bit-exact dry from sample 0); only parameter
    // CHANGES after that glide.
    this.primed = false;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const inL = input && input[0] && input[0].length ? input[0] : null;
    const inR = input && input.length > 1 && input[1] && input[1].length ? input[1] : null;
    const outL = output[0];
    const outR = output.length > 1 && output[1] ? output[1] : null;
    const len = outL.length;
    const sr = globalThis.sampleRate || 44100;

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const target = {
      dispersion: clamp(parameters.dispersion[0], 0, 1),
      punch: clamp(parameters.punch[0], -1, 1),
      focusHz: clamp(parameters.focusHz[0], FOCUS_MIN_HZ, 4000),
      spread: clamp(parameters.spread[0], 0, 1),
      mix: clamp(parameters.mix[0], 0, 1),
      output: clamp(parameters.output[0], -18, 12),
    };

    // Block-rate application of a per-SAMPLE one-pole: the coefficient must
    // absorb the block length or the glide runs ~128× slow (checklist §4).
    const smoothCoef = 1 - Math.exp(-len / (SMOOTH_TAU_S * sr));
    const sm = this.sm;
    if (!this.primed) {
      this.primed = true;
      sm.dispersion = target.dispersion;
      sm.punch = target.punch;
      sm.focusHz = target.focusHz;
      sm.spread = target.spread;
      sm.mix = target.mix;
      sm.output = target.output;
    } else {
      sm.dispersion += smoothCoef * (target.dispersion - sm.dispersion);
      sm.punch += smoothCoef * (target.punch - sm.punch);
      sm.focusHz += smoothCoef * (target.focusHz - sm.focusHz);
      sm.spread += smoothCoef * (target.spread - sm.spread);
      sm.mix += smoothCoef * (target.mix - sm.mix);
      sm.output += smoothCoef * (target.output - sm.output);
    }

    // DISPERSION coefficients: one shared biquad pair per channel (all 8
    // sections are identical — the cascade multiplies the group-delay hump).
    const fL = clamp(sm.focusHz * (1 - SPREAD_OFFSET * sm.spread), FOCUS_MIN_HZ, FOCUS_ABS_MAX_HZ);
    const fR = clamp(sm.focusHz * (1 + SPREAD_OFFSET * sm.spread), FOCUS_MIN_HZ, FOCUS_ABS_MAX_HZ);
    const wL = Math.min((2 * Math.PI * fL) / sr, Math.PI * 0.95);
    const wR = Math.min((2 * Math.PI * fR) / sr, Math.PI * 0.95);
    const radius = clamp(R_FLOOR + R_RANGE * sm.dispersion, 0.05, R_MAX);
    const c2 = radius * radius;
    const c1L = -2 * radius * Math.cos(wL);
    const c1R = -2 * radius * Math.cos(wR);

    // PUNCH coefficients: same biquad form as DISPERSION, on a short radius.
    // The sign CHOOSES the center — positive delays the body band below the
    // focus (click leads, harder attack), negative the click band above it
    // (transient sinks, softer attack). At zero the radius is zero, so the
    // center flip is silent.
    const punchRadius = PUNCH_R_MAX * Math.abs(sm.punch);
    const punchActive = punchRadius > 1e-4;
    const punchFocus = clamp(
      sm.punch >= 0 ? sm.focusHz / PUNCH_BAND_RATIO : sm.focusHz * PUNCH_BAND_RATIO,
      FOCUS_MIN_HZ,
      Math.min(PUNCH_FOCUS_MAX_HZ, sr * 0.45),
    );
    const wPunch = Math.min((2 * Math.PI * punchFocus) / sr, Math.PI * 0.95);
    const pc2 = punchRadius * punchRadius;
    const pc1 = -2 * punchRadius * Math.cos(wPunch);

    const gain = Math.pow(10, sm.output / 20);
    const long = this.longState;
    const punch = this.punchState;

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;

      // --- DISPERSION stage (L) -----------------------------------------
      let xl = l;
      {
        const st = long[0];
        const x1 = st.x1;
        const x2 = st.x2;
        const y1 = st.y1;
        const y2 = st.y2;
        for (let s = 0; s < LONG_SECTIONS; s++) {
          const y = c2 * xl + c1L * x1[s] + x2[s] - c1L * y1[s] - c2 * y2[s];
          x2[s] = x1[s];
          x1[s] = xl;
          y2[s] = y1[s];
          y1[s] = Math.abs(y) < DENORM ? 0 : y;
          xl = y1[s];
        }
      }
      // --- DISPERSION stage (R) -----------------------------------------
      let xr = r;
      {
        const st = long[1];
        const x1 = st.x1;
        const x2 = st.x2;
        const y1 = st.y1;
        const y2 = st.y2;
        for (let s = 0; s < LONG_SECTIONS; s++) {
          const y = c2 * xr + c1R * x1[s] + x2[s] - c1R * y1[s] - c2 * y2[s];
          x2[s] = x1[s];
          x1[s] = xr;
          y2[s] = y1[s];
          y1[s] = Math.abs(y) < DENORM ? 0 : y;
          xr = y1[s];
        }
      }

      // --- PUNCH stage (skipped bit-exactly at punch = 0) ----------------
      if (punchActive) {
        const stL = punch[0];
        const px1L = stL.x1;
        const px2L = stL.x2;
        const py1L = stL.y1;
        const py2L = stL.y2;
        for (let s = 0; s < PUNCH_SECTIONS; s++) {
          const y = pc2 * xl + pc1 * px1L[s] + px2L[s] - pc1 * py1L[s] - pc2 * py2L[s];
          px2L[s] = px1L[s];
          px1L[s] = xl;
          py2L[s] = py1L[s];
          py1L[s] = Math.abs(y) < DENORM ? 0 : y;
          xl = py1L[s];
        }
        const stR = punch[1];
        const px1R = stR.x1;
        const px2R = stR.x2;
        const py1R = stR.y1;
        const py2R = stR.y2;
        for (let s = 0; s < PUNCH_SECTIONS; s++) {
          const y = pc2 * xr + pc1 * px1R[s] + px2R[s] - pc1 * py1R[s] - pc2 * py2R[s];
          px2R[s] = px1R[s];
          px1R[s] = xr;
          py2R[s] = py1R[s];
          py1R[s] = Math.abs(y) < DENORM ? 0 : y;
          xr = py1R[s];
        }
      }

      // --- dry/wet + output ---------------------------------------------
      // A non-finite wet sample must not poison the mix (an all-pass cascade
      // is stable by construction, but defend in depth like KOREŇ).
      if (!Number.isFinite(xl)) xl = 0;
      if (!Number.isFinite(xr)) xr = 0;
      let oL = (l * (1 - sm.mix) + xl * sm.mix) * gain;
      let oR = (r * (1 - sm.mix) + xr * sm.mix) * gain;
      if (!Number.isFinite(oL)) oL = 0;
      if (!Number.isFinite(oR)) oR = 0;
      outL[i] = oL;
      if (outR) outR[i] = oR;
    }
    return true;
  }
}

registerProcessor("skrutka-processor", SkrutkaProcessor);
