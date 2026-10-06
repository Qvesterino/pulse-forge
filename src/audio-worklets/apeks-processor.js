/**
 * APEKS AudioWorkletProcessor — transient-preserving loudness maximizer.
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
      { name: "release", minValue: 0.05, maxValue: 0.5, defaultValue: 0.15 },
      { name: "preserve", minValue: 0, maxValue: 1, defaultValue: 0.5 },
      { name: "mix", minValue: 0, maxValue: 1, defaultValue: 1 },
      { name: "output", minValue: -12, maxValue: 12, defaultValue: 0 },
    ];
  }

  constructor() {
    super();
    this.fastEnv = [0, 0];
    this.slowEnv = [0, 0];
    this.gr = 1;
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

    // Pass 1: linked block peak after input gain.
    let peak = 0;
    for (let ch = 0; ch < input.length; ch++) {
      const data = input[ch];
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i]) * inGain;
        if (v > peak) peak = v;
      }
    }
    const grTarget = Math.min(1, ceilLin / Math.max(peak, 1e-6));

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
        const r = Math.min(1, (fast - slow) / (ax + 1e-6));
        const grTransient = Math.min(1, gr + preserve * (1 - gr));
        let y = gr * x * (1 - r) + grTransient * x * r;
        // Safety ceiling guard (the GR trajectory keeps this quiet).
        if (y > ceilLin) y = ceilLin;
        else if (y < -ceilLin) y = -ceilLin;
        outData[i] = (d * (1 - mix) + y * mix) * outGain;
      }
      this.fastEnv[Math.min(ch, 1)] = fast;
      this.slowEnv[Math.min(ch, 1)] = slow;
      if (ch === 0) this.gr = gr;
    }
    return true;
  }
}

registerProcessor("apeks-processor", ApeksProcessor);
