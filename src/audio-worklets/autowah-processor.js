/**
 * Autowah AudioWorkletProcessor — envelope follower drives a Chamberlin SVF's
 * cutoff frequency per-sample. Playing harder opens the filter; the release
 * tail closes it gradually. This is a SINGLE worklet combining detection and
 * filtering — truly zero-delay (no port messaging, no control-rate polling).
 *
 * The envelope is asymmetric: fast attack tracks the transient, slower
 * release closes the filter gradually. Sensitivity pre-gains the detector
 * so quiet signals can still reach the maxFreq ceiling.
 *
 * Filter: Chamberlin SVF (proven stable across 20–20 kHz) in BP or LP mode
 * with resonance (damping q) for that vocal "wah" quality.
 *
 * NOTE: served RAW to AudioWorklet.addModule() — plain JavaScript only.
 */
function newAwDriveState() {
  return { sub: new Float32Array(8), sat: new Float32Array(8), w: 0, sw: 0, prev: 0 };
}

class AutowahProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.env = 0;
    this.awDriveL = newAwDriveState();
    this.awDriveR = newAwDriveState();
    this.lpL = 0;
    this.bpL = 0;
    this.lpR = 0;
    this.bpR = 0;
  }

  static get parameterDescriptors() {
    return [
      { name: "minFreq", defaultValue: 300, minValue: 100, maxValue: 2000, automationRate: "k-rate" },
      { name: "maxFreq", defaultValue: 2500, minValue: 500, maxValue: 8000, automationRate: "k-rate" },
      { name: "resonance", defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "attack", defaultValue: 0.01, minValue: 0.001, maxValue: 0.1, automationRate: "k-rate" },
      { name: "release", defaultValue: 0.15, minValue: 0.05, maxValue: 1, automationRate: "k-rate" },
      { name: "sensitivity", defaultValue: 1.5, minValue: 0.5, maxValue: 3, automationRate: "k-rate" },
      { name: "mode", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" }, // 0=BP 1=LP
      // 0 = up-wah (loud → opens), 1 = down-wah (loud → closes)
      { name: "direction", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      // Pre-SVF drive: tanh at (1 + drive·9) — grit before the sweep.
      { name: "drive", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  // ── 2× oversampled drive (PARAM-VALUE-AUDIT-2026-09 Vlna 3) ───────────
  // Same pattern as svfilter/freqshifter/kaskada: the tanh grit stage (up to
  // ×10 into tanh — the hottest curve in the FX rack) runs at 2× the rate
  // with a 9-tap windowed-sinc band-limit + anti-image FIR, so harmonics
  // above Nyquist fold back an octave higher and ~30 dB weaker. The stage
  // sits on the forward path into the SVF; the envelope follower reads the
  // RAW signal, so wah tracking is untouched.
  static get OS_TAPS() {
    if (!this._taps) {
      const N = 9;
      const fc = 0.375; // relative to the 2× rate ≈ 0.75× original fs
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
      this._taps = taps;
    }
    return this._taps;
  }

  static osDrive(st, x, k, invNorm) {
    const taps = AutowahProcessor.OS_TAPS;
    const sub = st.sub;
    const sat = st.sat;
    const mid = (st.prev + x) * 0.5;
    st.prev = x;
    sub[st.w] = mid;
    let i2 = st.w;
    let acc = 0;
    for (let i = 0; i < 9; i++) {
      acc += taps[i] * sub[i2];
      i2 = (i2 + 7) & 7;
    }
    st.w = (st.w + 1) & 7;
    const satMid = Math.tanh(acc * k) * invNorm;
    sub[st.w] = x;
    i2 = st.w;
    acc = 0;
    for (let i = 0; i < 9; i++) {
      acc += taps[i] * sub[i2];
      i2 = (i2 + 7) & 7;
    }
    st.w = (st.w + 1) & 7;
    const satEven = Math.tanh(acc * k) * invNorm;
    sat[st.sw] = satMid;
    st.sw = (st.sw + 1) & 7;
    sat[st.sw] = satEven;
    i2 = st.sw;
    let out = 0;
    for (let i = 0; i < 9; i++) {
      out += taps[i] * sat[i2];
      i2 = (i2 + 7) & 7;
    }
    st.sw = (st.sw + 1) & 7;
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
    const sr = globalThis.sampleRate || 44100;

    const minF = parameters.minFreq[0];
    const maxF = Math.max(minF + 50, parameters.maxFreq[0]);
    const res = Math.max(0, Math.min(1, parameters.resonance[0]));
    const atkBlend = 1 - Math.exp(-1 / (sr * Math.max(0.001, parameters.attack[0])));
    const relBlend = 1 - Math.exp(-1 / (sr * Math.max(0.05, parameters.release[0])));
    const sens = parameters.sensitivity[0];
    const bpMode = parameters.mode[0] < 0.5;
    const direction = (parameters.direction ? parameters.direction[0] : 0) >= 0.5;
    const drive = Math.max(0, Math.min(1, parameters.drive ? parameters.drive[0] : 0));
    const mix = parameters.mix[0];
    const q = 2 - 2 * res; // damping: 2 = max damping, 0 = self-osc

    const clampVal = 8;
    const driveK = 1 + drive * 9;
    const driveInvNorm = drive > 0.001 ? 1 / Math.tanh(driveK) : 0;

    for (let i = 0; i < len; i++) {
      let l = inL ? inL[i] : 0;
      let r = inR ? inR[i] : l;
      // Drive stage: 2× oversampled tanh grit BEFORE the SVF (the envelope
      // follower reads the RAW input below, so wah tracking is untouched).
      if (drive > 0.001) {
        l = AutowahProcessor.osDrive(this.awDriveL, l, driveK, driveInvNorm);
        r = AutowahProcessor.osDrive(this.awDriveR, r, driveK, driveInvNorm);
      }

      // ---- Envelope follower (on the RAW signal — drive would over-open it;
      // the envelope tracks the performance, not the grit) ----
      const rawL = inL ? inL[i] : 0;
      const rawR = inR ? inR[i] : rawL;
      const peak = Math.abs(rawL) > Math.abs(rawR) ? Math.abs(rawL) : Math.abs(rawR);
      const driven = Math.tanh(peak * sens);
      this.env =
        driven > this.env ? this.env + (driven - this.env) * atkBlend : this.env + (driven - this.env) * relBlend;
      if (this.env < 1e-20) this.env = 0;

      // ---- Envelope → cutoff frequency (direction flips the sweep) ----
      const env01 = direction ? 1 - this.env : this.env;
      const fc = minF + env01 * (maxF - minF);

      // ---- Chamberlin SVF (cutoff moves per-sample) ----
      const f = 2 * Math.sin((Math.PI * Math.min(fc, sr * 0.24)) / sr);
      // Numerical stability: the semi-implicit Chamberlin recursion diverges
      // when f*q >= (4 - f²)/2 — high cutoff combined with LOW resonance
      // (max damping is the unstable corner). Scale the damping into the
      // stable region exactly like svfilter-processor; settings that are
      // already stable are untouched. The ±8 state clamps below only remain
      // as a last-resort guard — they previously masked the divergence as a
      // harsh ±8 limit cycle on legal settings (res ≤ ~0.3, hot signal).
      let qEff = q;
      const fqMax = (4 - f * f) * 0.49;
      if (f * qEff > fqMax) qEff = fqMax / f;

      // Left
      const hpL = l - this.lpL - qEff * this.bpL;
      this.bpL += f * hpL;
      this.lpL += f * this.bpL;
      if (this.bpL > clampVal) this.bpL = clampVal;
      else if (this.bpL < -clampVal) this.bpL = -clampVal;
      if (this.lpL > clampVal) this.lpL = clampVal;
      else if (this.lpL < -clampVal) this.lpL = -clampVal;
      if (Math.abs(this.bpL) < 1e-20) this.bpL = 0;
      if (Math.abs(this.lpL) < 1e-20) this.lpL = 0;

      // Right
      const hpR = r - this.lpR - qEff * this.bpR;
      this.bpR += f * hpR;
      this.lpR += f * this.bpR;
      if (this.bpR > clampVal) this.bpR = clampVal;
      else if (this.bpR < -clampVal) this.bpR = -clampVal;
      if (this.lpR > clampVal) this.lpR = clampVal;
      else if (this.lpR < -clampVal) this.lpR = -clampVal;
      if (Math.abs(this.bpR) < 1e-20) this.bpR = 0;
      if (Math.abs(this.lpR) < 1e-20) this.lpR = 0;

      // Mode select
      let fL, fR;
      if (bpMode) {
        fL = this.bpL;
        fR = this.bpR;
      } else {
        fL = this.lpL;
        fR = this.lpR;
      }

      outL[i] = l * (1 - mix) + fL * mix;
      if (outR) outR[i] = r * (1 - mix) + fR * mix;
    }
    return true;
  }
}

registerProcessor("autowah-processor", AutowahProcessor);
