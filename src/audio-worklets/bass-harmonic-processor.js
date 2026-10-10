/**
 * KOREŇ (bassHarmonic) AudioWorkletProcessor — missing-fundamental bass
 * exciter.
 *
 * Takes a bass signal, tracks its fundamental with a zero-crossing rate
 * estimator (hysteresis, window-limited by `focusHz`), and synthesizes a
 * phase-locked harmonic stack (2nd/3rd-leaning, octave `range`) driven by
 * the low band's envelope. The wet path keeps the original (high-passed at
 * `lowCut`, scaled by `subAnchor`) and adds the generated harmonics ON TOP —
 * not a classic dry/wet, but "keep the sub, add the harmonics" so a 55 Hz
 * 808 reads on phone speakers and laptop drivers.
 *
 * Parameter surface: plain AudioParams (M2 pattern, zenit-m2-nodes.ts) —
 * no port messages, so offline automation works natively via
 * setValueAtTime. All per-sample smoothing uses per-sample coefficients
 * (NEW-EFFECT-CHECKLIST §4). No RNG — deterministic.
 *
 * `mix = 0` is a bit-exact dry passthrough (`dry * 1 + wet * 0`).
 *
 * Served as its own lazy bundle: public/bass-harmonic-worklet.js
 * (scripts/build-bass-harmonic-worklet.mjs). Plain JavaScript only.
 */
class BassHarmonicProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "drive", minValue: 0, maxValue: 1, defaultValue: 0.45 },
      { name: "focusHz", minValue: 40, maxValue: 220, defaultValue: 90 },
      { name: "harmonics", minValue: 0, maxValue: 1, defaultValue: 0.5 },
      { name: "subAnchor", minValue: 0, maxValue: 1, defaultValue: 0.7 },
      { name: "lowCut", minValue: 20, maxValue: 200, defaultValue: 45 },
      { name: "range", minValue: 1, maxValue: 4, defaultValue: 2 },
      { name: "attack", minValue: 0.001, maxValue: 0.1, defaultValue: 0.008 },
      { name: "release", minValue: 0.01, maxValue: 1, defaultValue: 0.12 },
      { name: "mix", minValue: 0, maxValue: 1, defaultValue: 0.6 },
      { name: "output", minValue: -18, maxValue: 12, defaultValue: 0 },
    ];
  }

  constructor() {
    super();
    // Detection state (mono sum).
    this.lp = 0; // 300 Hz one-pole low band used for detection
    this.lastSign = 0;
    this.sinceCross = 0;
    this.f0 = 0; // smoothed fundamental estimate (Hz); 0 = none yet
    this.envLow = 0; // fast low-band amplitude follower
    this.envGen = 0; // generator gain envelope
    // Per-channel one-pole HP state for the sub-anchor branch.
    this.hpY = [0, 0];
    this.hpX = [0, 0];
    // Phase accumulators for harmonics 2..N (index n, 0/1 unused).
    this.phase = new Float64Array(11);
    // Per-block harmonic weights (preallocated — no allocations in process()).
    this.weights = new Float64Array(11);
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
    const drive = clamp(parameters.drive[0], 0, 1);
    const focus = clamp(parameters.focusHz[0], 40, 220);
    const harmonics = clamp(parameters.harmonics[0], 0, 1);
    const subAnchor = clamp(parameters.subAnchor[0], 0, 1);
    const lowCut = clamp(parameters.lowCut[0], 20, 200);
    const range = clamp(parameters.range[0], 1, 4);
    const attack = clamp(parameters.attack[0], 0.001, 0.1);
    const release = clamp(parameters.release[0], 0.01, 1);
    const mix = clamp(parameters.mix[0], 0, 1);
    const outGain = Math.pow(10, clamp(parameters.output[0], -18, 12) / 20);

    // Per-sample coefficients (checklist §4: never a per-block blend of a
    // per-sample constant).
    const detLpCoef = 1 - Math.exp((-2 * Math.PI * 300) / sr);
    const envAtkCoef = 1 - Math.exp(-1 / (sr * 0.005));
    const envRelCoef = 1 - Math.exp(-1 / (sr * 0.03));
    const genAtkCoef = 1 - Math.exp(-1 / (sr * attack));
    const genRelCoef = 1 - Math.exp(-1 / (sr * release));
    const hpA = Math.exp((-2 * Math.PI * lowCut) / sr);

    // Harmonic stack: n = 2..N (N = 2^range capped at 10). Weight blend:
    // `harmonics` 0 → 2nd dominant, 1 → 3rd-lean; n ≥ 4 sit low.
    const count = Math.min(10, Math.max(2, Math.round(Math.pow(2, range))));
    const weights = this.weights;
    for (let n = 0; n <= 10; n++) weights[n] = 0;
    let norm = 0;
    for (let n = 2; n <= count; n++) {
      const w = n === 2 ? 1 - harmonics : n === 3 ? harmonics : 0.25 / (n - 1);
      weights[n] = w;
      norm += w;
    }
    const normScale = norm > 1e-9 ? 0.9 / norm : 0;
    const fMin = focus * 0.5;
    const fMax = focus * 2;
    const twoPi = 2 * Math.PI;

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : l;
      const mono = (l + r) * 0.5;

      // --- fundamental detection (mono, ≤300 Hz band) -------------------
      this.lp += detLpCoef * (mono - this.lp);
      if (Math.abs(this.lp) < 1e-20) this.lp = 0;
      const absLp = Math.abs(this.lp);
      this.envLow += (absLp > this.envLow ? envAtkCoef : envRelCoef) * (absLp - this.envLow);
      if (this.envLow < 1e-20) this.envLow = 0;

      const sign = this.lp > 0.005 ? 1 : this.lp < -0.005 ? -1 : this.lastSign;
      this.sinceCross++;
      if (this.lastSign < 0 && sign > 0 && this.sinceCross >= 16) {
        const rawF0 = sr / this.sinceCross;
        // Smooth; clamp the estimate to the tracking window (out-of-window
        // frequencies are intentionally left alone — no invented harmonics).
        const smoothed = this.f0 > 0 ? this.f0 + 0.2 * (rawF0 - this.f0) : rawF0;
        this.f0 = clamp(smoothed, 20, 400);
        this.sinceCross = 0;
      } else if (this.sinceCross > sr / 20) {
        // No upward crossing for 50 ms → nothing pitched down there.
        this.sinceCross = sr / 20;
        this.f0 = 0;
      }
      this.lastSign = sign;

      const inWindow = this.f0 >= fMin && this.f0 <= fMax;

      // --- generator gain envelope --------------------------------------
      const genTarget = inWindow ? drive * this.envLow : 0;
      this.envGen += (genTarget > this.envGen ? genAtkCoef : genRelCoef) * (genTarget - this.envGen);
      if (this.envGen < 1e-20) this.envGen = 0;

      // --- phase-locked harmonic stack ----------------------------------
      let gen = 0;
      if (this.envGen > 1e-6 && this.f0 > 0) {
        for (let n = 2; n <= count; n++) {
          let p = this.phase[n] + (twoPi * n * this.f0) / sr;
          if (p >= twoPi) p -= twoPi * Math.floor(p / twoPi);
          this.phase[n] = p;
          gen += weights[n] * Math.sin(p);
        }
        gen *= normScale * this.envGen;
      }
      if (!Number.isFinite(gen)) gen = 0;

      // --- sub-anchor branch: one-pole HP at lowCut per channel ---------
      const hpL = hpA * (this.hpY[0] + l - this.hpX[0]);
      const hpR = hpA * (this.hpY[1] + r - this.hpX[1]);
      this.hpX[0] = l;
      this.hpY[0] = Math.abs(hpL) < 1e-20 ? 0 : hpL;
      this.hpX[1] = r;
      this.hpY[1] = Math.abs(hpR) < 1e-20 ? 0 : hpR;

      const wetL = hpL * subAnchor + gen;
      const wetR = hpR * subAnchor + gen;
      let oL = (l * (1 - mix) + wetL * mix) * outGain;
      let oR = (r * (1 - mix) + wetR * mix) * outGain;
      // mix = 0 must stay bit-exact dry: dry * 1 + wet * 0. outGain at the
      // default 0 dB is exactly 1, so the sum reproduces the input sample.
      if (!Number.isFinite(oL)) oL = 0;
      if (!Number.isFinite(oR)) oR = 0;
      outL[i] = oL;
      if (outR) outR[i] = oR;
    }
    return true;
  }
}

registerProcessor("bass-harmonic-processor", BassHarmonicProcessor);
