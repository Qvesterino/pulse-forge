/**
 * Multi-Tap Delay AudioWorkletProcessor — four tempo-synced taps with a
 * shared feedback loop, tone filter and stereo spread.
 *
 * Ported from the native Web Audio graph (docs/PLUGIN-AUDIT-FOLLOWUP-ROADMAP.md
 * Phase 1): Chromium breaks native DelayNode feedback cycles
 * nondeterministically across OfflineAudioContext instances — consecutive
 * offline renders of the SAME document alternated between two stable audio
 * variants (~8 % RMS on high-feedback configs), violating export determinism.
 * Moving the loop inside one processor makes the graph acyclic and the render
 * deterministic; the per-sample math mirrors the original node graph exactly:
 *
 *   loopIn   = dry + fbGain · toneOut          (feedback recirculation)
 *   taps     = Σ tapGain_k · pan_k · delay_k(loopIn)
 *   toneOut  = lowpass(taps)                   (RBJ biquad, Q = 1)
 *   output   = loopIn + mix · toneOut          (dry passthrough carries the
 *                                               loop signal, as the native
 *                                               input→output path did)
 *
 * All four taps read ONE stereo ring buffer at different offsets (the native
 * graph fed every tap delay the same input). Tap times arrive in SECONDS via
 * the t1Time..t4Time AudioParams — the wrapper derives them from musical
 * divisions + BPM, so the processor stays tempo-free and automation-friendly.
 *
 * Deterministic live==offline (no random, phase starts at zero per context).
 * Denormal guard flushes the feedback path. NOTE: served RAW to
 * AudioWorklet.addModule() — plain JavaScript only.
 */
const MULTITAP_MAX_SEC = 8; // division 1/2 at the BPM floor (20) ≈ 6 s — 8 s headroom

class MultitapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = globalThis.sampleRate || 44100;
    this.size = 1024;
    while (this.size < Math.ceil(sr * MULTITAP_MAX_SEC)) this.size *= 2;
    this.mask = this.size - 1;
    this.bufL = new Float32Array(this.size);
    this.bufR = new Float32Array(this.size);
    this.writeIdx = 0;
    // Tone biquad state per channel
    this.x1L = 0;
    this.x2L = 0;
    this.y1L = 0;
    this.y2L = 0;
    this.x1R = 0;
    this.x2R = 0;
    this.y1R = 0;
    this.y2R = 0;
  }

  static get parameterDescriptors() {
    const beat = 60 / 124;
    return [
      { name: "mix", defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "feedback", defaultValue: 0.3, minValue: 0, maxValue: 0.85, automationRate: "k-rate" },
      { name: "tone", defaultValue: 4500, minValue: 500, maxValue: 8000, automationRate: "k-rate" },
      { name: "spread", defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "taps", defaultValue: 3, minValue: 1, maxValue: 4, automationRate: "k-rate" },
      // Tap delay times in seconds; defaults mirror the rack division
      // defaults (1/8, 1/16, 1/4, 1/2) at 124 BPM — the wrapper always
      // writes the division-derived values on construction.
      {
        name: "t1Time",
        defaultValue: beat * 0.5,
        minValue: 0.02,
        maxValue: MULTITAP_MAX_SEC,
        automationRate: "k-rate",
      },
      {
        name: "t2Time",
        defaultValue: beat * 0.25,
        minValue: 0.02,
        maxValue: MULTITAP_MAX_SEC,
        automationRate: "k-rate",
      },
      { name: "t3Time", defaultValue: beat, minValue: 0.02, maxValue: MULTITAP_MAX_SEC, automationRate: "k-rate" },
      { name: "t4Time", defaultValue: beat * 2, minValue: 0.02, maxValue: MULTITAP_MAX_SEC, automationRate: "k-rate" },
    ];
  }

  readCubic(buf, pos) {
    const i1 = Math.floor(pos);
    const frac = pos - i1;
    const i0 = i1 - 1;
    const s1 = buf[i1 & this.mask];
    const s0 = buf[i0 & this.mask];
    const s2 = buf[(i1 + 1) & this.mask];
    const s3 = buf[(i1 + 2) & this.mask];
    // Cubic hermite — same kernel as the comb processor.
    const a = 0.5 * (s2 - s0);
    const b = 0.5 * (s3 - s1);
    const c = s2 - s1;
    return s1 + 0.5 * frac * (a + b + frac * (c - a + frac * (b - c)));
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

    const mix = Math.max(0, Math.min(1, parameters.mix[0]));
    const feedback = Math.max(0, Math.min(0.85, parameters.feedback[0]));
    const toneFreq = Math.max(500, Math.min(8000, parameters.tone[0]));
    const spread = Math.max(0, Math.min(1, parameters.spread[0]));
    const tapCount = Math.max(1, Math.min(4, Math.round(parameters.taps[0])));
    const times = [
      Math.max(0.02, Math.min(MULTITAP_MAX_SEC, parameters.t1Time[0])) * sr,
      Math.max(0.02, Math.min(MULTITAP_MAX_SEC, parameters.t2Time[0])) * sr,
      Math.max(0.02, Math.min(MULTITAP_MAX_SEC, parameters.t3Time[0])) * sr,
      Math.max(0.02, Math.min(MULTITAP_MAX_SEC, parameters.t4Time[0])) * sr,
    ];

    // Tap gains: active taps only, normalized 1/sqrt(t+1) — the native
    // per-tap GainNodes. Feedback is normalized by their summed energy so
    // four taps cannot turn a safe feedback setting into a runaway loop.
    const tapGain = [0, 0, 0, 0];
    let loopGainSum = 0;
    for (let t = 0; t < tapCount; t++) {
      tapGain[t] = 1 / Math.sqrt(t + 1);
      loopGainSum += tapGain[t];
    }
    const fbGain = feedback / Math.max(1, loopGainSum);

    // Stereo spread: tap k pans across the field (0 with a single tap) —
    // equal-power gains, mirroring the native StereoPannerNode positions.
    const panL = [0, 0, 0, 0];
    const panR = [0, 0, 0, 0];
    for (let t = 0; t < 4; t++) {
      const pan = tapCount <= 1 ? 0 : ((t / (tapCount - 1)) * 2 - 1) * spread * 0.9;
      const angle = ((pan + 1) * Math.PI) / 4;
      panL[t] = Math.cos(angle);
      panR[t] = Math.sin(angle);
    }

    // Tone: RBJ lowpass (Q = 1 — the BiquadFilterNode default the native
    // graph ran with), coefficients updated per block.
    const w0 = (2 * Math.PI * Math.min(toneFreq, sr * 0.45)) / sr;
    const cosw0 = Math.cos(w0);
    const sinw0 = Math.sin(w0);
    const alpha = sinw0 / 2; // Q = 1
    const a0 = 1 + alpha;
    this.b0 = (1 - cosw0) / 2 / a0;
    this.b1 = (1 - cosw0) / a0;
    this.b2 = (1 - cosw0) / 2 / a0;
    this.a1 = (-2 * cosw0) / a0;
    this.a2 = (1 - alpha) / a0;

    const bufL = this.bufL;
    const bufR = this.bufR;
    for (let i = 0; i < len; i++) {
      const dryL = inL ? inL[i] : 0;
      const dryR = inR ? inR[i] : dryL;

      // Taps read the shared loop signal at their own offsets.
      let toneInL = 0;
      let toneInR = 0;
      const base = this.writeIdx;
      for (let t = 0; t < 4; t++) {
        if (tapGain[t] === 0) continue;
        const pos = base - times[t];
        const g = tapGain[t];
        toneInL += g * panL[t] * this.readCubic(bufL, pos);
        toneInR += g * panR[t] * this.readCubic(bufR, pos);
      }

      // Tone filter (biquad, per-channel state). The flush happens BEFORE
      // the state store: storing the raw toneOut let subnormal values live
      // in y1/y2 and poisoned the recursion with per-sample denormal math
      // (caught by tests/multitap-soak.test.ts). Threshold −260 dBFS —
      // inaudible, but far above the float64 subnormal range.
      let toneOutL =
        this.b0 * toneInL + this.b1 * this.x1L + this.b2 * this.x2L - this.a1 * this.y1L - this.a2 * this.y2L;
      let toneOutR =
        this.b0 * toneInR + this.b1 * this.x1R + this.b2 * this.x2R - this.a1 * this.y1R - this.a2 * this.y2R;
      if (Math.abs(toneOutL) < 1e-15) toneOutL = 0;
      if (Math.abs(toneOutR) < 1e-15) toneOutR = 0;
      this.x2L = this.x1L;
      this.x1L = toneInL;
      this.y2L = this.y1L;
      this.y1L = toneOutL;
      this.x2R = this.x1R;
      this.x1R = toneInR;
      this.y2R = this.y1R;
      this.y1R = toneOutR;

      // Feedback recirculation feeds the tap input — denormal-flushed.
      let fbL = fbGain * toneOutL;
      let fbR = fbGain * toneOutR;
      if (Math.abs(fbL) < 1e-15) fbL = 0;
      if (Math.abs(fbR) < 1e-15) fbR = 0;
      const loopInL = dryL + fbL;
      const loopInR = dryR + fbR;

      bufL[this.writeIdx & this.mask] = loopInL;
      bufR[this.writeIdx & this.mask] = loopInR;
      this.writeIdx++;

      // Dry passthrough carries the loop signal (the native input→output
      // path passed dry + feedback); wet rides the mix control.
      outL[i] = loopInL + mix * toneOutL;
      if (outR) outR[i] = loopInR + mix * toneOutR;
    }
    return true;
  }
}

registerProcessor("multitap-processor", MultitapProcessor);
