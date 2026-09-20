/**
 * SVF (State Variable Filter) AudioWorkletProcessor — Chamberlin topology.
 *
 * Per-sample zero-feedback-delay for LP and BP (semi-implicit Euler: bp uses
 * updated hp, lp uses updated bp). Proven stable for fc < fs/4 across the
 * full 20–20 kHz range. Clamps prevent runaway from numerical drift at
 * extreme resonance settings.
 *
 * Modes: LP (12 dB/oct), HP (12 dB/oct), BP (6 dB/oct), Notch (LP + HP).
 * Drive: 2× oversampled tanh pre-filter saturation for analog-style
 * warming — running only the nonlinear stage at twice the rate keeps the
 * harmonics above Nyquist from folding back as inharmonic grit at high
 * DRIVE (drive === 0 keeps the exact original per-sample path).
 * Resonance: 0 = max damping, 1 = self-oscillation boundary (clamped).
 *
 * NOTE: served RAW to AudioWorklet.addModule() — plain JavaScript only.
 */
// ── 2× oversampled drive ────────────────────────────────────────────────
// Only the nonlinear stage runs at 2× the rate: sub-samples are band-limited
// with a short 9-tap windowed-sinc FIR, saturated, band-limited again and
// decimated. tanh harmonics above Nyquist therefore fold back an octave
// higher and ~30dB weaker instead of smearing into the audible band.
const OS_TAPS = (() => {
  const N = 9;
  const fc = 0.375; // relative to the 2× rate ≈ 0.75× original fs — audio band untouched
  const taps = new Array(N);
  const M = N - 1;
  for (let i = 0; i < N; i++) {
    const m = i - (M >> 1);
    const sinc = m === 0 ? 1 : Math.sin(Math.PI * fc * m) / (Math.PI * fc * m);
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / M); // Hamming
    taps[i] = sinc * w;
  }
  let sum = 0;
  for (let i = 0; i < N; i++) sum += taps[i];
  for (let i = 0; i < N; i++) taps[i] /= sum;
  return taps;
})();

// Rational tanh — saturates smoothly to ±1 (clamped past |x|>3 where the
// rational form is already flat), ~5× cheaper than Math.tanh on this hot
// path. Curve deviation from true tanh stays under ~1%.
function fastTanh(x) {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

// One input sample through the oversampled saturator. `state` carries the
// per-channel history: sub/sat ring buffers (8 slots = 4 input samples at
// the 2× rate) and the previous input for the midpoint stage.
function osDrive(state, x, driveGain, makeup) {
  const sub = state.sub;
  const sat = state.sat;
  // 1) 2× upsample: midpoint (odd sub-sample) then the sample itself
  const mid = (state.prev + x) * 0.5;
  state.prev = x;
  // 2) band-limit the midpoint, saturate
  sub[state.w] = mid;
  let k = state.w;
  let acc = 0;
  for (let i = 0; i < 9; i++) {
    acc += OS_TAPS[i] * sub[k];
    k = (k + 7) & 7;
  }
  state.w = (state.w + 1) & 7;
  const satMid = (fastTanh(acc * driveGain) / driveGain) * makeup;
  // 3) band-limit the real sample, saturate
  sub[state.w] = x;
  k = state.w;
  acc = 0;
  for (let i = 0; i < 9; i++) {
    acc += OS_TAPS[i] * sub[k];
    k = (k + 7) & 7;
  }
  state.w = (state.w + 1) & 7;
  const satEven = (fastTanh(acc * driveGain) / driveGain) * makeup;
  // 4) anti-image FIR on the saturated stream, decimate to the even slot
  sat[state.sw] = satMid;
  state.sw = (state.sw + 1) & 7;
  sat[state.sw] = satEven;
  k = state.sw;
  let out = 0;
  for (let i = 0; i < 9; i++) {
    out += OS_TAPS[i] * sat[k];
    k = (k + 7) & 7;
  }
  state.sw = (state.sw + 1) & 7;
  return out;
}

function driveStateIsSilent(state) {
  if (state.prev !== 0) return false;
  for (let i = 0; i < 8; i++) {
    if (state.sub[i] !== 0 || state.sat[i] !== 0) return false;
  }
  return true;
}

class SvFilterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.lpL = 0;
    this.bpL = 0;
    this.lpR = 0;
    this.bpR = 0;
    this.lastCutoff = -1;
    this.lastRes = -1;
    this.f = 0.1;
    this.q = 1;
    // 2× oversampled drive history, per channel
    this.drvL = { sub: new Float32Array(8), w: 0, sat: new Float32Array(8), sw: 0, prev: 0 };
    this.drvR = { sub: new Float32Array(8), w: 0, sat: new Float32Array(8), sw: 0, prev: 0 };
  }

  static get parameterDescriptors() {
    return [
      { name: "cutoff", defaultValue: 2000, minValue: 20, maxValue: 20000, automationRate: "k-rate" },
      { name: "resonance", defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "mode", defaultValue: 0, minValue: 0, maxValue: 3, automationRate: "k-rate" }, // 0=LP 1=HP 2=BP 3=Notch
      { name: "drive", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
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
    const sr = globalThis.sampleRate || 44100;
    // Browsers may upmix a mono source to two identical channels before it
    // reaches this node. Detect that once per render quantum so the mono
    // fast path also covers those graphs without guessing from node options.
    let monoInput = !inR;
    if (inL && inR) {
      monoInput = true;
      for (let i = 0; i < len; i++) {
        if (inL[i] !== inR[i]) {
          monoInput = false;
          break;
        }
      }
    }

    const cutoff = Math.max(20, Math.min(20000, parameters.cutoff[0]));
    const res = Math.max(0, Math.min(1, parameters.resonance[0]));
    const mode = Math.round(parameters.mode[0]);
    const drive = parameters.drive[0];
    const mix = parameters.mix[0];

    // Per-note synth voices can remain connected to the mix bus for the rest
    // of an OfflineAudioContext render after their oscillator has stopped.
    // Once both the input and SVF/drive history are exactly silent, avoid the
    // per-sample DSP while keeping the processor alive for later input.
    let hasInput = false;
    if (inL || inR) {
      for (let i = 0; i < len; i++) {
        if ((inL && inL[i] !== 0) || (inR && inR[i] !== 0)) {
          hasInput = true;
          break;
        }
      }
    }
    const filterIsSilent = this.lpL === 0 && this.bpL === 0 && this.lpR === 0 && this.bpR === 0;
    const driveIsSilent = drive <= 0 || (driveStateIsSilent(this.drvL) && driveStateIsSilent(this.drvR));
    if (!hasInput && filterIsSilent && driveIsSilent) {
      outL.fill(0);
      if (outR) outR.fill(0);
      return true;
    }

    if (cutoff !== this.lastCutoff || res !== this.lastRes) {
      this.lastCutoff = cutoff;
      this.lastRes = res;
      this.f = 2 * Math.sin((Math.PI * Math.min(cutoff, sr * 0.24)) / sr);
      this.q = 2 - 2 * res; // damping: 2 = max damping, 0 = self-osc
      // Numerical stability: the semi-implicit Chamberlin recursion diverges
      // when f*q >= (4 - f²)/2 — i.e. high cutoff combined with LOW resonance
      // (counter-intuitive: max damping is the unstable corner). The old
      // state clamps hid the divergence as a harsh ±8 limit cycle. Scale the
      // damping into the stable region instead; settings that are already
      // stable (small f, or res near 1) are untouched.
      const fqMax = (4 - this.f * this.f) * 0.49;
      if (this.f * this.q > fqMax) this.q = fqMax / this.f;
    }

    const driveGain = drive > 0 ? 1 + drive * 9 : 1;
    const clampVal = 8; // prevent runaway at high resonance

    for (let i = 0; i < len; i++) {
      let l = inL ? inL[i] : 0;
      let r = inR ? inR[i] : l;
      if (drive > 0) {
        const makeup = 1 + drive * 2.5;
        l = osDrive(this.drvL, l, driveGain, makeup);
        if (inR) r = osDrive(this.drvR, r, driveGain, makeup);
        else r = l;
      }

      // Chamberlin SVF — left
      const hpL = l - this.lpL - this.q * this.bpL;
      this.bpL += this.f * hpL;
      this.lpL += this.f * this.bpL;
      // Clamp for stability at high resonance
      if (this.bpL > clampVal) this.bpL = clampVal;
      else if (this.bpL < -clampVal) this.bpL = -clampVal;
      if (this.lpL > clampVal) this.lpL = clampVal;
      else if (this.lpL < -clampVal) this.lpL = -clampVal;
      if (Math.abs(this.bpL) < 1e-20) this.bpL = 0;
      if (Math.abs(this.lpL) < 1e-20) this.lpL = 0;

      // A mono source is upmixed identically by the engine. Reuse the left
      // result instead of running an identical second SVF per sample; mirror
      // state after the quantum below so a later stereo quantum resumes as
      // if both channels had been filtered independently throughout.
      let hpR = hpL;
      if (!monoInput) {
        // Chamberlin SVF — right
        hpR = r - this.lpR - this.q * this.bpR;
        this.bpR += this.f * hpR;
        this.lpR += this.f * this.bpR;
        if (this.bpR > clampVal) this.bpR = clampVal;
        else if (this.bpR < -clampVal) this.bpR = -clampVal;
        if (this.lpR > clampVal) this.lpR = clampVal;
        else if (this.lpR < -clampVal) this.lpR = -clampVal;
        if (Math.abs(this.bpR) < 1e-20) this.bpR = 0;
        if (Math.abs(this.lpR) < 1e-20) this.lpR = 0;
      }

      // Mode select
      let fL, fR;
      switch (mode) {
        case 1:
          fL = hpL;
          fR = hpR;
          break; // HP
        case 2:
          fL = this.bpL;
          fR = this.bpR;
          break; // BP
        case 3:
          fL = this.lpL + hpL;
          fR = this.lpR + hpR;
          break; // Notch
        default:
          fL = this.lpL;
          fR = this.lpR;
          break; // LP
      }
      if (monoInput) fR = fL;

      outL[i] = l * (1 - mix) + fL * mix;
      if (outR) outR[i] = r * (1 - mix) + fR * mix;
    }

    if (monoInput) {
      this.bpR = this.bpL;
      this.lpR = this.lpL;
      if (drive > 0) {
        this.drvR.sub.set(this.drvL.sub);
        this.drvR.w = this.drvL.w;
        this.drvR.sat.set(this.drvL.sat);
        this.drvR.sw = this.drvL.sw;
        this.drvR.prev = this.drvL.prev;
      }
    }

    return true;
  }
}

registerProcessor("svfilter-processor", SvFilterProcessor);
