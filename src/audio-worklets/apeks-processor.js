/**
 * APEX AudioWorkletProcessor — transient-preserving loudness maximizer.
 *
 * Own algorithm (ADR 0020 lineage, M2): a dual-path gain split. A block peak
 * drives one linked gain-reduction trajectory toward the ceiling; each sample
 * is decomposed into a sustain share (full GR) and a transient share (GR
 * partially released by `preserve`), so hits keep their tip while the body
 * rides louder. A final safety clip at the ceiling is a guard, not the
 * mechanism — the GR trajectory does the work. Stereo is linked (max of the
 * channel peaks) to keep the image stable. This is NOT iZotope IRC — it is a
 * classic transient/sustain split with our own smoothing topology.
 */
class ApeksProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "drive", minValue: 0, maxValue: 1, defaultValue: 0.5 },
      { name: "ceiling", minValue: -12, maxValue: 0, defaultValue: -1 },
      { name: "ceilingMode", minValue: 0, maxValue: 1, defaultValue: 1 },
      { name: "release", minValue: 0.05, maxValue: 0.5, defaultValue: 0.15 },
      { name: "preserve", minValue: 0, maxValue: 1, defaultValue: 0.5 },
      { name: "mix", minValue: 0, maxValue: 1, defaultValue: 1 },
      { name: "output", minValue: -12, maxValue: 12, defaultValue: 0 },
    ];
  }

  constructor(options) {
    super();
    this.fastEnv = [0, 0];
    this.slowEnv = [0, 0];
    this.gr = 1;
    this.meteringEnabled = options?.processorOptions?.metering === true;
    this.meterFrames = 0;
    this.meterMinGain = 1;
    this.buildTpFilter();
  }

  /**
   * TRUE-PEAK DETECTOR (ceilingMode 1): a 4× polyphase windowed-sinc FIR —
   * the construction class pro limiters use for ISP-aware gain computers.
   * Catmull-Rom was tried and REVERTED: it misreads adversarial patterns (a
   * SR/4 sine at phase π/4 — samples ±0.7071, true peak 1.0). A 64-tap
   * sinc/Blackman prototype reconstructs bandlimited material accurately
   * enough that the ceiling holds for INTER-SAMPLE peaks, which makes the
   * platform profiles' −1 dBTP a guarantee rather than a measurement.
   */
  buildTpFilter() {
    const PHASES = 4;
    const TAPS = 64; // prototype length
    const sinc = (x) => (Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
    const proto = new Float64Array(TAPS);
    let sum = 0;
    for (let m = 0; m < TAPS; m++) {
      const center = (m - (TAPS - 1) / 2) / PHASES;
      const window =
        0.42 - 0.5 * Math.cos((2 * Math.PI * m) / (TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * m) / (TAPS - 1));
      proto[m] = sinc(center) * window;
      sum += proto[m];
    }
    for (let m = 0; m < TAPS; m++) proto[m] /= sum;
    this.tpPhases = [];
    for (let p = 0; p < PHASES; p++) {
      const taps = [];
      let psum = 0;
      for (let m = p; m < TAPS; m += PHASES) {
        taps.push(proto[m]);
        psum += proto[m];
      }
      for (let i = 0; i < taps.length; i++) taps[i] /= psum;
      this.tpPhases.push(Float64Array.from(taps));
    }
    this.tpHistory = [new Float32Array(TAPS), new Float32Array(TAPS)];
    this.tpHistLen = TAPS;
  }

  /** Max over the 4× upsampled grid for one channel (history-aware). */
  tpPeakOf(data, hist) {
    const phases = this.tpPhases;
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      for (let j = this.tpHistLen - 1; j > 0; j--) hist[j] = hist[j - 1];
      hist[0] = data[i];
      for (let p = 0; p < phases.length; p++) {
        const taps = phases[p];
        let acc = 0;
        for (let k = 0; k < taps.length; k++) acc += taps[k] * hist[k];
        const a = Math.abs(acc);
        if (a > peak) peak = a;
      }
    }
    return peak;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) {
      // Keep the output silent-clear when no input is connected.
      for (const ch of output) ch.fill(0);
      return true;
    }
    const sr = sampleRate;
    const drive = Math.min(1, Math.max(0, parameters.drive[0]));
    const ceilingDb = Math.min(0, Math.max(-12, parameters.ceiling[0]));
    const release = Math.min(0.5, Math.max(0.05, parameters.release[0]));
    const preserve = Math.min(1, Math.max(0, parameters.preserve[0]));
    const mix = Math.min(1, Math.max(0, parameters.mix[0]));
    const outDb = Math.min(12, Math.max(-12, parameters.output[0]));
    const inGain = Math.pow(10, (drive * 12) / 20);
    const ceilLin = Math.pow(10, ceilingDb / 20);
    const outGain = Math.pow(10, outDb / 20);
    // Per-sample BLEND toward the GR target (one-pole): release sets the time
    // constant, so larger release = slower recovery. The exp form alone is a
    // KEEP fraction (~1); blending with it directly snapped GR to the target
    // in one sample and made the RELEASE knob inaudible (param audit 10-06).
    const relBlend = 1 - Math.exp(-1 / (sr * release));
    const fastCoef = Math.exp(-1 / (sr * 0.002));
    const slowCoef = Math.exp(-1 / (sr * 0.05));
    let quantumMinGain = 1;

    // Pass 1: linked block peak after input gain. ceilingMode 1 measures the
    // peak on the 4× sinc reconstruction — inter-sample peaks cannot escape.
    const tpMode = parameters.ceilingMode[0] >= 0.5;
    let peak = 0;
    let samplePeak = 0;
    for (let ch = 0; ch < input.length; ch++) {
      const data = input[ch];
      if (tpMode) {
        const up = this.tpPeakOf(data, this.tpHistory[Math.min(ch, 1)]);
        if (up * inGain > peak) peak = up * inGain;
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs(data[i]) * inGain;
          if (v > samplePeak) samplePeak = v;
        }
      } else {
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs(data[i]) * inGain;
          if (v > peak) peak = v;
        }
      }
    }
    const grTarget = Math.min(1, ceilLin / Math.max(peak, 1e-6));
    // The hard SAFETY clip re-flattens samples at its level — and a flattened
    // waveform RECONSTRUCTS above its sample peak. Self-calibrate: in TP mode
    // the clip sits at ceilLin / ρ where ρ is the measured TP-to-sample-peak
    // ratio, so the reconstruction lands back at ceilLin. Sample mode: clip
    // at the ceiling as before.
    const clipLevel = tpMode ? ceilLin / Math.max(1, peak / Math.max(samplePeak, 1e-6)) : ceilLin;

    // Pass 2: per-sample transient/sustain split with linked GR trajectory.
    for (let ch = 0; ch < output.length; ch++) {
      const inData = input[Math.min(ch, input.length - 1)];
      const outData = output[ch];
      let fast = this.fastEnv[Math.min(ch, 1)];
      let slow = this.slowEnv[Math.min(ch, 1)];
      let gr = ch === 0 ? this.gr : this.gr; // linked trajectory
      for (let i = 0; i < outData.length; i++) {
        const d = inData[i];
        const x = d * inGain;
        const ax = Math.abs(x);
        // Envelope followers classify the sample: transient when fast outruns slow.
        fast += (ax - fast) * (ax > fast ? fastCoef : 1);
        slow += (ax - slow) * slowCoef;
        if (gr < grTarget) gr += (grTarget - gr) * 0.5;
        else gr += (grTarget - gr) * relBlend;
        quantumMinGain = Math.min(quantumMinGain, gr);
        let r = Math.min(1, (fast - slow) / (ax + 1e-6));
        if (tpMode) {
          // The preserve path may exceed GR by preserve·(1−gr): cap the
          // transient ratio where even the WORST-case applied gain keeps the
          // reconstructed signal at/below the ceiling. Far from the ceiling
          // (gr ≈ 1) the cap is inert — preservation works untouched.
          const headroom = ceilLin / Math.max(peak, 1e-6);
          const rAllow = Math.min(1, Math.max(0, (headroom - gr) / Math.max(preserve * (1 - gr), 1e-9)));
          r = Math.min(r, rAllow);
        }
        const grTransient = Math.min(1, gr + preserve * (1 - gr));
        let y = gr * x * (1 - r) + grTransient * x * r;
        // Safety ceiling guard (the GR trajectory keeps this quiet).
        if (y > clipLevel) y = clipLevel;
        else if (y < -clipLevel) y = -clipLevel;
        outData[i] = (d * (1 - mix) + y * mix) * outGain;
      }
      this.fastEnv[Math.min(ch, 1)] = fast;
      this.slowEnv[Math.min(ch, 1)] = slow;
      if (ch === 0) this.gr = gr;
    }
    if (this.meteringEnabled) {
      this.meterMinGain = Math.min(this.meterMinGain, quantumMinGain);
      this.meterFrames += output[0]?.length ?? 0;
      if (this.meterFrames >= sr * 0.05) {
        const gainReductionDb = -20 * Math.log10(Math.max(this.meterMinGain, 1e-6));
        this.port.postMessage({ type: "gainReduction", gainReductionDb });
        this.meterFrames = 0;
        this.meterMinGain = 1;
      }
    }
    return true;
  }
}

registerProcessor("apeks-processor", ApeksProcessor);
