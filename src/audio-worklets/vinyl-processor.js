/**
 * Vinyl Suite AudioWorkletProcessor — a full turntable/lo-fi character chain,
 * not a single "age" knob. Each physical artefact is its own module with its
 * own controls, and `amount` remains the master macro that scales the noise
 * modules (crackle / hiss / rumble / wow / flutter).
 *
 *  - crackle  : Poisson pop stream (density + tone + decay) on a band-passed click
 *  - hiss     : continuous surface noise (level + tone)
 *  - rumble   : motor/turntable low-end noise (level + corner)
 *  - wow      : slow pitch drift via a modulated delay read (rate + depth)
 *  - flutter  : fast jitter layered on the same delay (rate + depth)
 *  - year     : 1920…2020 band-limit contour (thinner + noisier when old)
 *  - drive    : tube-ish saturation of the wet path (old gear character)
 *  - toneLp/Hp: master wet band trim
 *  - width    : stereo width of the wet signal (0 = mono, record-like)
 *
 * Stereo integrity: every filter runs with PER-CHANNEL state and the wow/
 * flutter delay reads in OPPOSITE directions per channel, so the wet path
 * keeps (and can widen) a real stereo image instead of collapsing to mono.
 *
 * Determinism: the noise RNG is seeded per instance (processorOptions.seed =
 * hash of the project | track | effect id), so live and offline renders are
 * bit-identical and the offline-parity contract holds.
 *
 * Back-compat: every parameter is read defensively (`pv`), so a parameter set
 * from an older document — or a partial harness in tests — never throws; the
 * descriptor default applies.
 *
 * NOTE: served as part of core-worklet.js — plain JavaScript only.
 */

/** Deterministic 32-bit PRNG (mulberry32) — same generator as the other worklets. */
function vinylRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

/** Fast tanh approximation (Padé 3/2) — smooth tube-ish saturation. */
function softSat(x) {
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

/** One-pole lowpass coefficient for a cutoff in Hz. */
function lpCoef(hz, sr) {
  return 1 - Math.exp((-2 * Math.PI * hz) / sr);
}

class VinylProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sr = globalThis.sampleRate || 44100;
    this.sr = sr;
    // `|| 1` collapsed a legitimate seed 0 into 1 (two instances then shared
    // one noise pattern, breaking the live/offline bit-identity contract for
    // that seed).
    const opt = options && options.processorOptions;
    const seed = typeof opt === "object" && opt !== null && Number.isFinite(opt.seed) ? opt.seed : 1;
    this.rng = vinylRng(seed);

    // Wow/flutter delay lines (one per channel — keeps the stereo image).
    // 12 ms of headroom covers the max wobble depth with interpolation slack.
    this.delayLen = Math.ceil(sr * 0.012);
    this.delayL = new Float32Array(this.delayLen);
    this.delayR = new Float32Array(this.delayLen);
    this.delayPos = 0;
    this.lfoPhase = 0; // wow phase (0..1)
    this.flutterPhase = 0;

    // Crackle pop state (independent envelopes per channel).
    this.popEnvL = 0;
    this.popEnvR = 0;
    this.popGapSamples = 0;

    // Per-channel one-pole filter states: [L, R].
    this.yearLpState = [0, 0];
    this.yearHpState = [0, 0];
    this.yearHpPrev = [0, 0];
    this.toneLpState = [0, 0];
    this.toneHpState = [0, 0];
    this.toneHpPrev = [0, 0];
    this.hissLpState = [0, 0];
    this.hissHpState = [0, 0];
    this.hissHpPrev = [0, 0];
    this.crackleLpState = [0, 0];
    this.rumbleLpState = [0, 0];
  }

  static get parameterDescriptors() {
    return [
      // Master macro — scales the artefact modules (crackle/hiss/rumble/wow/
      // flutter). Drive/tone/year are deliberate settings, not noise.
      { name: "amount", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      // Crackle pops
      { name: "crackle", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "crackleTone", defaultValue: 2200, minValue: 400, maxValue: 9000, automationRate: "k-rate" },
      { name: "crackleDecay", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      // Continuous surface noise
      { name: "hiss", defaultValue: 0.35, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "hissTone", defaultValue: 6000, minValue: 1000, maxValue: 16000, automationRate: "k-rate" },
      // Motor rumble
      { name: "rumble", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "rumbleTone", defaultValue: 60, minValue: 30, maxValue: 120, automationRate: "k-rate" },
      // Pitch wobble
      { name: "wowRate", defaultValue: 0.7, minValue: 0.2, maxValue: 4, automationRate: "k-rate" },
      { name: "wow", defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "flutterRate", defaultValue: 11, minValue: 4, maxValue: 30, automationRate: "k-rate" },
      { name: "flutter", defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      // Gear character
      { name: "drive", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "year", defaultValue: 0.8, minValue: 0, maxValue: 1, automationRate: "k-rate" }, // 0=2020 1=1920
      { name: "toneLp", defaultValue: 16000, minValue: 1000, maxValue: 16000, automationRate: "k-rate" },
      { name: "toneHp", defaultValue: 20, minValue: 10, maxValue: 400, automationRate: "k-rate" },
      { name: "width", defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
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
    const sr = this.sr;

    // --- Parameter reads (defensive; macro applied per module) ---
    const amount = clamp(pv(parameters, "amount", 0.5), 0, 1);
    const crackleAmt = clamp(pv(parameters, "crackle", 0.5), 0, 1) * amount;
    const crackleTone = clamp(pv(parameters, "crackleTone", 2200), 400, 9000);
    const crackleDecay = clamp(pv(parameters, "crackleDecay", 0.5), 0, 1);
    const hissAmt = clamp(pv(parameters, "hiss", 0.35), 0, 1) * amount;
    const hissTone = clamp(pv(parameters, "hissTone", 6000), 1000, 16000);
    const rumbleAmt = clamp(pv(parameters, "rumble", 0), 0, 1) * amount;
    const rumbleTone = clamp(pv(parameters, "rumbleTone", 60), 30, 120);
    const wowRate = clamp(pv(parameters, "wowRate", 0.7), 0.2, 4);
    const wowAmt = clamp(pv(parameters, "wow", 0.5), 0, 1) * amount;
    const flutterRate = clamp(pv(parameters, "flutterRate", 11), 4, 30);
    const flutterAmt = clamp(pv(parameters, "flutter", 0.3), 0, 1) * amount;
    const drive = clamp(pv(parameters, "drive", 0), 0, 1);
    const year = clamp(pv(parameters, "year", 0.8), 0, 1);
    const toneLpHz = clamp(pv(parameters, "toneLp", 16000), 1000, 16000);
    const toneHpHz = clamp(pv(parameters, "toneHp", 20), 10, 400);
    const width = clamp(pv(parameters, "width", 0.6), 0, 1);
    const mix = clamp(pv(parameters, "mix", 1), 0, 1);

    // --- Derived coefficients ---
    const yearLpCoef = lpCoef(9000 - year * 7500, sr); // 9000 → 1500 Hz
    const yearHpCoef = lpCoef(120 + year * 700, sr); // 120 → 820 Hz
    const toneLpCoef = lpCoef(toneLpHz, sr);
    const toneHpCoef = lpCoef(toneHpHz, sr);
    const hissLpCoef = lpCoef(hissTone, sr);
    const hissHpCoef = lpCoef(250, sr);
    const crackleLpCoef = lpCoef(crackleTone, sr);
    const rumbleLpCoef = lpCoef(rumbleTone, sr);
    // Wow depth up to ~2 ms, flutter up to ~0.25 ms — musical turntable ranges.
    const wowDepthSamples = wowAmt * sr * 0.002;
    const flutterDepthSamples = flutterAmt * sr * 0.00025;
    const wowStep = wowRate / sr;
    const flutterStep = flutterRate / sr;
    // Poisson pop density: up to ~55 pops/s at full crackle.
    const popRatePerSample = (crackleAmt * 55) / sr;
    // Pop decay: 0 = long (≈2.5 ms tail), 1 = tight click.
    const popDecay = 0.86 + crackleDecay * 0.12;
    const popAmp = crackleAmt * 0.55;
    const hissAmp = hissAmt * 0.012;
    const rumbleAmp = rumbleAmt * 0.06;
    const driveK = 1 + drive * 4;
    const driveComp = 1 / (1 + drive * 0.6); // keep level roughly constant
    const dryMix = 1 - mix;

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;

      // --- Wow + flutter: modulated delay-line read (opposite per channel,
      // so the wobble is in anti-phase — a wide, turntable-like smear) ---
      this.lfoPhase += wowStep;
      if (this.lfoPhase > 1) this.lfoPhase -= 1;
      this.flutterPhase += flutterStep;
      if (this.flutterPhase > 1) this.flutterPhase -= 1;
      const wobble =
        Math.sin(this.lfoPhase * 2 * Math.PI) * wowDepthSamples +
        Math.sin(this.flutterPhase * 2 * Math.PI) * flutterDepthSamples;
      // Base one-sample delay keeps the read behind the write for any |wobble|.
      const readL = (this.delayPos - 1 - wobble + this.delayLen) % this.delayLen;
      const rL0 = Math.floor(readL);
      const fL = readL - rL0;
      const wetL = this.delayL[rL0] * (1 - fL) + this.delayL[(rL0 + 1) % this.delayLen] * fL;
      const readR = (this.delayPos - 1 + wobble + this.delayLen) % this.delayLen;
      const rR0 = Math.floor(readR);
      const fR = readR - rR0;
      const wetR = this.delayR[rR0] * (1 - fR) + this.delayR[(rR0 + 1) % this.delayLen] * fR;
      // Write AFTER reading (the delay holds previous content — true varispeed).
      this.delayL[this.delayPos] = l;
      this.delayR[this.delayPos] = r;
      this.delayPos = (this.delayPos + 1) % this.delayLen;

      // --- Crackle: Poisson-timed pops on a band-limited click ---
      if (this.popGapSamples <= 0 && popRatePerSample > 0 && this.rng() < popRatePerSample) {
        // Exponential inter-arrival keeps the stream Poisson (not a grid).
        const u = 1 - this.rng();
        this.popGapSamples = clamp(Math.round(-Math.log(u) / popRatePerSample), 1, sr);
        // Each pop lands on one channel (deterministic draw) — spread surface.
        if (this.rng() < 0.5) this.popEnvL = 0.2 + this.rng() * 0.8;
        else this.popEnvR = 0.2 + this.rng() * 0.8;
      } else if (this.popGapSamples > 0) {
        this.popGapSamples -= 1;
      }
      const popNoiseL = this.popEnvL * (this.rng() * 2 - 1);
      const popNoiseR = this.popEnvR * (this.rng() * 2 - 1);
      this.popEnvL *= popDecay;
      this.popEnvR *= popDecay;
      // Click shaping: one-pole LP at CRACKLE TONE (removes the dull thump).
      this.crackleLpState[0] += (popNoiseL - this.crackleLpState[0]) * crackleLpCoef;
      this.crackleLpState[1] += (popNoiseR - this.crackleLpState[1]) * crackleLpCoef;

      // --- Hiss: continuous filtered noise floor (per channel) ---
      let hissL = 0;
      let hissR = 0;
      if (hissAmp > 0.00001) {
        this.hissLpState[0] += (this.rng() * 2 - 1 - this.hissLpState[0]) * hissLpCoef;
        this.hissHpState[0] = (1 - hissHpCoef) * (this.hissHpState[0] + this.hissLpState[0] - this.hissHpPrev[0]);
        this.hissHpPrev[0] = this.hissLpState[0];
        hissL = this.hissHpState[0];
        this.hissLpState[1] += (this.rng() * 2 - 1 - this.hissLpState[1]) * hissLpCoef;
        this.hissHpState[1] = (1 - hissHpCoef) * (this.hissHpState[1] + this.hissLpState[1] - this.hissHpPrev[1]);
        this.hissHpPrev[1] = this.hissLpState[1];
        hissR = this.hissHpState[1];
      }

      // --- Rumble: low-passed motor noise (per channel) ---
      let rumbleL = 0;
      let rumbleR = 0;
      if (rumbleAmp > 0.00001) {
        this.rumbleLpState[0] += (this.rng() * 2 - 1 - this.rumbleLpState[0]) * rumbleLpCoef;
        this.rumbleLpState[1] += (this.rng() * 2 - 1 - this.rumbleLpState[1]) * rumbleLpCoef;
        rumbleL = this.rumbleLpState[0];
        rumbleR = this.rumbleLpState[1];
      }

      // --- Sum the artefact layers ---
      let sumL = wetL + this.crackleLpState[0] * popAmp + hissL * hissAmp + rumbleL * rumbleAmp;
      let sumR = wetR + this.crackleLpState[1] * popAmp + hissR * hissAmp + rumbleR * rumbleAmp;

      // --- Drive: tube-ish saturation of the wet path ---
      if (drive > 0.001) {
        sumL = softSat(sumL * driveK) * driveComp;
        sumR = softSat(sumR * driveK) * driveComp;
      }

      // --- Year contour: old records are thin + band-limited (per channel) ---
      this.yearLpState[0] += (sumL - this.yearLpState[0]) * yearLpCoef;
      this.yearHpState[0] = (1 - yearHpCoef) * (this.yearHpState[0] + this.yearLpState[0] - this.yearHpPrev[0]);
      this.yearHpPrev[0] = this.yearLpState[0];
      this.yearLpState[1] += (sumR - this.yearLpState[1]) * yearLpCoef;
      this.yearHpState[1] = (1 - yearHpCoef) * (this.yearHpState[1] + this.yearLpState[1] - this.yearHpPrev[1]);
      this.yearHpPrev[1] = this.yearLpState[1];

      // --- Master wet tone trim (per channel) ---
      this.toneLpState[0] += (this.yearHpState[0] - this.toneLpState[0]) * toneLpCoef;
      this.toneHpState[0] = (1 - toneHpCoef) * (this.toneHpState[0] + this.toneLpState[0] - this.toneHpPrev[0]);
      this.toneHpPrev[0] = this.toneLpState[0];
      this.toneLpState[1] += (this.yearHpState[1] - this.toneLpState[1]) * toneLpCoef;
      this.toneHpState[1] = (1 - toneHpCoef) * (this.toneHpState[1] + this.toneLpState[1] - this.toneHpPrev[1]);
      this.toneHpPrev[1] = this.toneLpState[1];
      let trimL = this.toneHpState[0];
      let trimR = this.toneHpState[1];

      // --- Width: 0 = mono wet (classic record), 1 = full stereo ---
      if (width < 0.999) {
        const mid = (trimL + trimR) * 0.5;
        const side = (trimL - trimR) * 0.5 * width;
        trimL = mid + side;
        trimR = mid - side;
      }

      outL[i] = l * dryMix + trimL * mix;
      if (outR) outR[i] = r * dryMix + trimR * mix;
    }
    return true;
  }
}

registerProcessor("vinyl-processor", VinylProcessor);
