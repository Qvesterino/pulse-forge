/**
 * SKRUTKA (skrutka) AudioWorkletProcessor — v2: dynamic phase dispersion.
 *
 * A linear, phase-only effect: no gain rides on the frequency axis, so a
 * steady tone passes at the same level while its PHASE is warped. Broadband
 * events (kick/snare/808 attacks) read the warp as a frequency-dependent
 * arrival time — the modern "throw / gulp" transient character no EQ,
 * saturation or transient shaper can produce (they move amplitude, not
 * arrival).
 *
 * v2 adds three layers on top of the v1 static engine:
 *
 *   DYNAMIC  — the dispersion hump BREATHES with the signal. A fast/slow
 *              envelope pair derives an "attackness" (transient) and a
 *              "bodyness" (sustain, attack-suppressed) score; the signed
 *              `dyn` control deepens the pole radius on attacks (> 0,
 *              smears the click) or on sustain (< 0, preserves the
 *              transient and gulps the tail). `dyn = 0` is the v1 engine
 *              bit-exactly (the followers are not even updated).
 *   KEY      — a second worklet input carries a sidechain key (the engine's
 *              generic `setSidechainInput` contract, same as KOREŇ). PUMP
 *              deepens the hump with the key envelope (the kick throws the
 *              phase), DUCK pulls the radius down (the kick clears its own
 *              phase smear). `keyMode = 0`, or any mode without a key
 *              connected, is a bit-exact no-op.
 *   MOTION   — an internal tempo-aware LFO sweeps FOCUS (± `lfoDepth`
 *              octaves) with SINE / TRIANGLE / seeded random-step shapes.
 *              The rate arrives as Hz written by the node wrapper (host-side
 *              division→Hz conversion, the flanger/tremolo contract), so the
 *              processor stays tempo-agnostic; `lfoPhase` may be written at
 *              transport start to anchor the phase to the musical grid
 *              (default −1 = free-run from phase 0, deterministic).
 *
 * The DISPERSION stage is 8 identical 2nd-order all-pass sections (v1) whose
 * pole angles/radius the SHAPE control redistributes:
 *   GULP   — all 8 at FOCUS: one symmetric hump (v1).
 *   CHIRP  — angles log-spread 0.5×…2× FOCUS: a rising/liquid chirp.
 *   DOUBLE — 4 at FOCUS/3.5 + 4 at FOCUS×3.5: two humps.
 *   RESO   — all at FOCUS with a hotter radius mapping: a tall narrow hump.
 * The PUNCH stage is 3 sections on `0.93·|punch|`, centered at `punchHz` (or
 * AUTO = FOCUS/3.5 for positive punch, FOCUS×3.5 for negative), and
 * `punchMix` blends its output against the long-stage output (1 = v1).
 *
 * Parameter surface: plain AudioParams (M2 pattern) — no port messages for
 * parameters, so offline automation is native and live == offline parity
 * holds; the one port frame is observer-only telemetry (~20 Hz). All
 * smoothing uses per-sample time constants applied at block rate with the
 * block-length correction (NEW-EFFECT-CHECKLIST §4). No RNG in the signal
 * path; the random LFO step derives from the persisted seed. Every filter
 * state is flushed below 1e-20 before it is stored. `mix = 0` is a bit-exact
 * dry passthrough, and the v1 default parameter set renders bit-identically
 * to v1 (pinned by tests/skrutka-golden.test.ts).
 *
 * Served as its own lazy bundle: public/skrutka-worklet.js
 * (scripts/build-skrutka-worklet.mjs). Plain JavaScript only.
 */

const LONG_SECTIONS = 8; // 2nd-order all-pass sections in the DISPERSION stage
const PUNCH_SECTIONS = 3; // 2nd-order all-pass sections in the PUNCH stage
const R_FLOOR = 0.15; // pole radius at dispersion = 0 (GULP/CHIRP/DOUBLE)
const R_RANGE = 0.83; // radius span (floor + span = 0.98 at dispersion = 1)
const R_MAX = 0.985; // hard stability ceiling for the static mapping
const R_HARD_MAX = 0.995; // ceiling for dynamic/key boosts
const RESO_R_FLOOR = 0.45; // RESO radius floor (hotter mapping)
const RESO_R_RANGE = 0.53; // RESO span (0.45 + 0.53 = 0.98 at dispersion = 1)
const PUNCH_R_MAX = 0.93; // punch pole radius at |punch| = 1
const PUNCH_BAND_RATIO = 3.5; // AUTO punch center = focus / ratio (positive) or × ratio (negative)
const PUNCH_FOCUS_MAX_HZ = 6000; // punch center ceiling
const SPREAD_OFFSET = 0.12; // per-channel focus offset fraction at spread = 1
const FOCUS_MIN_HZ = 40; // descriptor floor (kept authoritative here too)
const SECTION_MIN_HZ = 20; // per-section angle floor (CHIRP/DOUBLE skirts)
const SECTION_MAX_HZ = 8000; // per-section angle ceiling
const SMOOTH_TAU_S = 0.03; // parameter glide time constant
const DENORM = 1e-20; // state flush threshold
const ENV_FAST_ATK_S = 0.001; // attackness follower attack
const ENV_FAST_REL_S = 0.015; // attackness follower release
const ENV_LAG_S = 0.06; // slow reference lag vs the fast follower (attackness window)
const ENV_SLOW_ATK_S = 0.01; // bodyness follower attack
const ENV_SLOW_REL_S = 0.15; // bodyness follower release
const SUSTAIN_REF = 0.1; // bodyness reference level (full at ≥ 0.1 amplitude)
const ATTACK_MARGIN = 0.4; // fast−lag excess that counts as a real transient (ripple guard)
const KEY_ATK_S = 0.002; // sidechain-key envelope attack
const KEY_REL_S = 0.18; // sidechain-key envelope release
const KEY_DUCK_DEPTH = 0.7; // DUCK radius scaling at full key (×0.3..1)
const RADIUS_TAU_S = 0.015; // glide on the dynamic/key radius delta (parametric-pump guard)
const METER_INTERVAL_S = 0.05; // telemetry cadence (~20 Hz)

/** Smoothed parameter mirror ids (static array — no allocation per block). */
const SM_KEYS = [
  "dispersion",
  "punch",
  "punchHz",
  "punchMix",
  "focusHz",
  "shape",
  "spread",
  "dyn",
  "keyMode",
  "lfoHz",
  "lfoShape",
  "lfoDepth",
  "mix",
  "output",
];

/** 2nd-order all-pass state block for one channel. */
function makeState(sections) {
  return {
    x1: new Float64Array(sections),
    x2: new Float64Array(sections),
    y1: new Float64Array(sections),
    y2: new Float64Array(sections),
  };
}

/** Xorshift32 — deterministic stepped-random LFO source (seeded, signal path never uses it). */
function makeRandom(seed) {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * Transient score: the fast follower's lead over its 20 ms lag, with a margin
 * so steady waveform ripple (a rectified sine ripples at 2× its frequency)
 * never reads as an attack. 0 = steady/quiet, 1 = hard transient.
 */
const attackScore = (envFast, envLag) =>
  clamp01((envFast - envLag) / Math.max(envFast, 1e-6) / (1 - ATTACK_MARGIN) - ATTACK_MARGIN / (1 - ATTACK_MARGIN));

class SkrutkaProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "dispersion", minValue: 0, maxValue: 1, defaultValue: 0.35 },
      { name: "punch", minValue: -1, maxValue: 1, defaultValue: 0 },
      { name: "punchHz", minValue: 0, maxValue: 6000, defaultValue: 0 },
      { name: "punchMix", minValue: 0, maxValue: 1, defaultValue: 1 },
      { name: "focusHz", minValue: 40, maxValue: 4000, defaultValue: 220 },
      { name: "shape", minValue: 0, maxValue: 3, defaultValue: 0 },
      { name: "spread", minValue: 0, maxValue: 1, defaultValue: 0 },
      { name: "dyn", minValue: -1, maxValue: 1, defaultValue: 0 },
      { name: "keyMode", minValue: 0, maxValue: 2, defaultValue: 0 },
      { name: "lfoHz", minValue: 0, maxValue: 20, defaultValue: 0.5 },
      { name: "lfoShape", minValue: 0, maxValue: 2, defaultValue: 0 },
      { name: "lfoDepth", minValue: 0, maxValue: 1, defaultValue: 0 },
      { name: "lfoPhase", minValue: -1, maxValue: 1, defaultValue: -1 },
      { name: "mix", minValue: 0, maxValue: 1, defaultValue: 1 },
      { name: "output", minValue: -18, maxValue: 12, defaultValue: 0 },
    ];
  }

  constructor(options) {
    super();
    const seed = options && options.processorOptions ? Number(options.processorOptions.seed) || 0 : 0;
    this.longState = [makeState(LONG_SECTIONS), makeState(LONG_SECTIONS)];
    this.punchState = [makeState(PUNCH_SECTIONS), makeState(PUNCH_SECTIONS)];
    // Per-section pole cosines, recomputed per block (shape changes the angles).
    this.cosL = new Float64Array(LONG_SECTIONS);
    this.cosR = new Float64Array(LONG_SECTIONS);
    this.sm = {
      dispersion: 0.35,
      punch: 0,
      punchHz: 0,
      punchMix: 1,
      focusHz: 220,
      shape: 0,
      spread: 0,
      dyn: 0,
      keyMode: 0,
      lfoHz: 0.5,
      lfoShape: 0,
      lfoDepth: 0,
      mix: 1,
      output: 0,
    };
    this.primed = false;
    // Envelope followers (dyn) and sidechain key (PUMP/DUCK).
    this.envFast = 0;
    this.envLag = 0;
    this.envSlow = 0;
    this.keyEnv = 0;
    // Glided dynamic/key radius delta (see RADIUS_TAU_S above).
    this.radiusDelta = 0;
    this.radiusPrimed = false;
    // LFO phase in [0, 1): free-runs from 0; `lfoPhase` >= 0 snaps it at
    // transport start (host write), -1 (default) means "no anchor".
    this.lfoPhase = 0;
    this.lfoRandom = makeRandom(seed);
    this.lfoRandValue = 0;
    // Telemetry mirrors.
    this.lastRadius = R_FLOOR;
    this.lastAttackness = 0;
    this.lastBodyness = 0;
    this.lastKeyGain = 1;
    this.meterSamples = 0;
    this.meterFrame = { type: "skrutka", lfo: 0, env: 0, key: 1, radius: R_FLOOR };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const inL = input && input[0] && input[0].length ? input[0] : null;
    const inR = input && input.length > 1 && input[1] && input[1].length ? input[1] : null;
    const key = inputs[1];
    const keyL = key && key[0] && key[0].length ? key[0] : null;
    const keyR = key && key.length > 1 && key[1] && key[1].length ? key[1] : null;
    const outL = output[0];
    const outR = output.length > 1 && output[1] ? output[1] : null;
    const len = outL.length;
    const sr = globalThis.sampleRate || 44100;

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const target = {
      dispersion: clamp(parameters.dispersion[0], 0, 1),
      punch: clamp(parameters.punch[0], -1, 1),
      punchHz: clamp(parameters.punchHz[0], 0, 6000),
      punchMix: clamp(parameters.punchMix[0], 0, 1),
      focusHz: clamp(parameters.focusHz[0], FOCUS_MIN_HZ, 4000),
      shape: Math.round(clamp(parameters.shape[0], 0, 3)),
      spread: clamp(parameters.spread[0], 0, 1),
      dyn: clamp(parameters.dyn[0], -1, 1),
      keyMode: Math.round(clamp(parameters.keyMode[0], 0, 2)),
      lfoHz: Math.max(0, parameters.lfoHz[0]),
      lfoShape: Math.round(clamp(parameters.lfoShape[0], 0, 2)),
      lfoDepth: clamp(parameters.lfoDepth[0], 0, 1),
      mix: clamp(parameters.mix[0], 0, 1),
      output: clamp(parameters.output[0], -18, 12),
    };

    // Block-rate application of per-SAMPLE one-poles (checklist §4).
    const smoothCoef = 1 - Math.exp(-len / (SMOOTH_TAU_S * sr));
    const sm = this.sm;
    if (!this.primed) {
      this.primed = true;
      for (let k = 0; k < SM_KEYS.length; k++) sm[SM_KEYS[k]] = target[SM_KEYS[k]];
    } else {
      for (let k = 0; k < SM_KEYS.length; k++) {
        const id = SM_KEYS[k];
        sm[id] += smoothCoef * (target[id] - sm[id]);
      }
    }

    // --- LFO: anchor / advance / wave-shape (control rate) ---------------
    const lfoAnchor = parameters.lfoPhase[0];
    if (lfoAnchor >= 0) {
      const anchored = lfoAnchor % 1;
      if (Math.abs(this.lfoPhase - anchored) > 1e-6) this.lfoPhase = anchored;
    }
    this.lfoPhase += sm.lfoHz * (len / sr);
    if (this.lfoPhase >= 1) {
      this.lfoPhase -= Math.floor(this.lfoPhase);
      if (sm.lfoShape === 2) this.lfoRandValue = this.lfoRandom(); // one step per cycle
    }
    const p = this.lfoPhase;
    const wave =
      sm.lfoShape === 0
        ? Math.sin(2 * Math.PI * p)
        : sm.lfoShape === 1
          ? 4 * Math.abs(p - 0.5) - 1
          : this.lfoRandValue * 2 - 1;
    const lfoFactor = sm.lfoDepth > 1e-4 ? Math.pow(2, sm.lfoDepth * wave) : 1;

    // --- dynamic/key radius mapping (control rate) -----------------------
    const dynActive = Math.abs(sm.dyn) > 1e-4;
    const keyActive = sm.keyMode > 0;
    const reso = sm.shape === 3;
    const rBase = clamp((reso ? RESO_R_FLOOR : R_FLOOR) + (reso ? RESO_R_RANGE : R_RANGE) * sm.dispersion, 0.05, R_MAX);
    this.lastAttackness = attackScore(this.envFast, this.envLag);
    this.lastBodyness = clamp01(this.envSlow / SUSTAIN_REF) * (1 - this.lastAttackness);
    let dynDrive = 0;
    if (sm.dyn > 1e-4)
      dynDrive = sm.dyn * this.lastAttackness; // ATTACK: deepen on transients
    else if (sm.dyn < -1e-4) dynDrive = -sm.dyn * this.lastBodyness; // BODY: deepen on sustain
    // The dynamic/key radius delta GLIDES (25 ms): an envelope-following pole
    // radius on a near-unit-circle all-pass is a parametric amplifier if it
    // tracks fast envelope ripple at audio rates — the glide averages that
    // ripple out while keeping the musical attack/tail response.
    let deltaRaw = dynDrive * (R_HARD_MAX - rBase);
    let keyGain = 1;
    if (sm.keyMode === 1) {
      deltaRaw += this.keyEnv * (R_HARD_MAX - rBase);
      keyGain = 1 + this.keyEnv;
    } else if (sm.keyMode === 2) {
      deltaRaw -= rBase * KEY_DUCK_DEPTH * this.keyEnv;
      keyGain = Math.max(1 - KEY_DUCK_DEPTH, 1 - KEY_DUCK_DEPTH * this.keyEnv);
    }
    this.lastKeyGain = keyGain;
    const radiusDeltaCoef = 1 - Math.exp(-len / (RADIUS_TAU_S * sr));
    if (!this.radiusPrimed) {
      this.radiusPrimed = true;
      this.radiusDelta = deltaRaw;
    } else {
      this.radiusDelta += radiusDeltaCoef * (deltaRaw - this.radiusDelta);
    }
    const radius = clamp(rBase + this.radiusDelta, 0.05, R_HARD_MAX);
    this.lastRadius = radius;

    // --- DISPERSION angles (shape → per-section pole cosines) ------------
    const focusEff = clamp(sm.focusHz * lfoFactor, FOCUS_MIN_HZ, 4000);
    const fL = clamp(focusEff * (1 - SPREAD_OFFSET * sm.spread), FOCUS_MIN_HZ, SECTION_MAX_HZ);
    const fR = clamp(focusEff * (1 + SPREAD_OFFSET * sm.spread), FOCUS_MIN_HZ, SECTION_MAX_HZ);
    const cosL = this.cosL;
    const cosR = this.cosR;
    for (let s = 0; s < LONG_SECTIONS; s++) {
      let factor;
      if (sm.shape === 1)
        factor = 0.5 * Math.pow(4, s / (LONG_SECTIONS - 1)); // CHIRP 0.5×…2×
      else if (sm.shape === 2)
        factor = s % 2 === 0 ? 1 / PUNCH_BAND_RATIO : PUNCH_BAND_RATIO; // DOUBLE
      else factor = 1; // GULP / RESO
      const wl = Math.min((2 * Math.PI * clamp(fL * factor, SECTION_MIN_HZ, SECTION_MAX_HZ)) / sr, Math.PI * 0.95);
      const wr = Math.min((2 * Math.PI * clamp(fR * factor, SECTION_MIN_HZ, SECTION_MAX_HZ)) / sr, Math.PI * 0.95);
      cosL[s] = Math.cos(wl);
      cosR[s] = Math.cos(wr);
    }
    const c2 = radius * radius;

    // --- PUNCH coefficients ----------------------------------------------
    const punchRadius = PUNCH_R_MAX * Math.abs(sm.punch);
    const punchActive = punchRadius > 1e-4 && sm.punchMix > 1e-4;
    const punchCenter =
      sm.punchHz > 0 ? sm.punchHz : sm.punch >= 0 ? focusEff / PUNCH_BAND_RATIO : focusEff * PUNCH_BAND_RATIO;
    const punchFocus = clamp(punchCenter, FOCUS_MIN_HZ, Math.min(PUNCH_FOCUS_MAX_HZ, sr * 0.45));
    const wPunch = Math.min((2 * Math.PI * punchFocus) / sr, Math.PI * 0.95);
    const pc2 = punchRadius * punchRadius;
    const pc1 = -2 * punchRadius * Math.cos(wPunch);

    const gain = Math.pow(10, sm.output / 20);
    const long = this.longState;
    const punch = this.punchState;
    const punchMix = sm.punchMix;

    // Per-sample envelope/key coefficients (checklist §4).
    const envFastAtk = 1 - Math.exp(-1 / (sr * ENV_FAST_ATK_S));
    const envFastRel = 1 - Math.exp(-1 / (sr * ENV_FAST_REL_S));
    const lagCoef = 1 - Math.exp(-1 / (sr * ENV_LAG_S));
    const envSlowAtk = 1 - Math.exp(-1 / (sr * ENV_SLOW_ATK_S));
    const envSlowRel = 1 - Math.exp(-1 / (sr * ENV_SLOW_REL_S));
    const keyAtk = 1 - Math.exp(-1 / (sr * KEY_ATK_S));
    const keyRel = 1 - Math.exp(-1 / (sr * KEY_REL_S));

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;

      // --- envelope followers (DYNAMIC) ----------------------------------
      if (dynActive) {
        const absIn = Math.abs((l + r) * 0.5);
        this.envFast += (absIn > this.envFast ? envFastAtk : envFastRel) * (absIn - this.envFast);
        this.envLag += lagCoef * (this.envFast - this.envLag);
        this.envSlow += (absIn > this.envSlow ? envSlowAtk : envSlowRel) * (absIn - this.envSlow);
        if (this.envFast < DENORM) this.envFast = 0;
        if (this.envLag < DENORM) this.envLag = 0;
        if (this.envSlow < DENORM) this.envSlow = 0;
      }

      // --- sidechain key envelope (KEY) ----------------------------------
      if (keyActive) {
        const k = keyL ? Math.abs(keyR ? (keyL[i] + keyR[i]) * 0.5 : keyL[i]) : 0;
        this.keyEnv += (k > this.keyEnv ? keyAtk : keyRel) * (k - this.keyEnv);
        if (this.keyEnv < DENORM) this.keyEnv = 0;
      }

      // --- DISPERSION stage (L) -----------------------------------------
      let xl = l;
      {
        const st = long[0];
        const x1 = st.x1;
        const x2 = st.x2;
        const y1 = st.y1;
        const y2 = st.y2;
        for (let s = 0; s < LONG_SECTIONS; s++) {
          const c1 = -2 * radius * cosL[s];
          const y = c2 * xl + c1 * x1[s] + x2[s] - c1 * y1[s] - c2 * y2[s];
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
          const c1 = -2 * radius * cosR[s];
          const y = c2 * xr + c1 * x1[s] + x2[s] - c1 * y1[s] - c2 * y2[s];
          x2[s] = x1[s];
          x1[s] = xr;
          y2[s] = y1[s];
          y1[s] = Math.abs(y) < DENORM ? 0 : y;
          xr = y1[s];
        }
      }
      const longL = xl;
      const longR = xr;

      // --- PUNCH stage (PUNCH MIX blends against the long output) --------
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
        if (punchMix < 1) {
          xl = longL * (1 - punchMix) + xl * punchMix;
          xr = longR * (1 - punchMix) + xr * punchMix;
        }
      }

      // --- dry/wet + output ---------------------------------------------
      if (!Number.isFinite(xl)) xl = 0;
      if (!Number.isFinite(xr)) xr = 0;
      let oL = (l * (1 - sm.mix) + xl * sm.mix) * gain;
      let oR = (r * (1 - sm.mix) + xr * sm.mix) * gain;
      if (!Number.isFinite(oL)) oL = 0;
      if (!Number.isFinite(oR)) oR = 0;
      outL[i] = oL;
      if (outR) outR[i] = oR;
    }

    // Telemetry mirrors for the frame below (post-loop, final state).
    this.lastAttackness = attackScore(this.envFast, this.envLag);
    this.lastBodyness = clamp01(this.envSlow / SUSTAIN_REF) * (1 - this.lastAttackness);

    // Observer-only frame (~20 Hz): the panel's moving dot and state chips.
    this.meterSamples += len;
    if (this.meterSamples >= sr * METER_INTERVAL_S) {
      this.meterSamples = 0;
      const frame = this.meterFrame;
      frame.lfo = this.lfoPhase;
      frame.env = dynActive ? Math.max(this.lastAttackness, this.lastBodyness) : 0;
      frame.key = this.lastKeyGain;
      frame.radius = this.lastRadius;
      this.port.postMessage(frame);
    }
    return true;
  }
}

registerProcessor("skrutka-processor", SkrutkaProcessor);
