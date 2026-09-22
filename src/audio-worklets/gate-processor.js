class GateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.envelope = 0;
    this.gain = 0;
    this.holdSamples = 0;
    // Look-ahead: the computed gain is applied to a DELAYED signal, so the
    // envelope sees the transient BEFORE the gain closes — drum attacks pass
    // at full level instead of being clipped by the attack lag. Constant
    // 2.5 ms delay, reported to the host PDC by the runtime layer.
    const sr = globalThis.sampleRate || 44100;
    this.lookaheadSamples = Math.round(sr * 0.0025);
    this.gainRing = new Float32Array(this.lookaheadSamples);
    this.gainRingIdx = 0;
    this.wasOpen = false;
    // Report the look-ahead delay once so the host PDC can align tracks.
    this.port.postMessage({ type: "latency", samples: this.lookaheadSamples });
  }

  static get parameterDescriptors() {
    return [
      { name: "threshold", defaultValue: -36, minValue: -80, maxValue: 0, automationRate: "k-rate" },
      // Hysteresis band (0..100% of 12 dB below the open threshold): once
      // open, the gate stays open until the envelope falls that far back —
      // stops the gain chatter on signals hovering at the threshold.
      { name: "hysteresis", defaultValue: 0.15, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "lookahead", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "attack", defaultValue: 0.002, minValue: 0.0001, maxValue: 0.5, automationRate: "k-rate" },
      { name: "hold", defaultValue: 0.02, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "release", defaultValue: 0.08, minValue: 0.001, maxValue: 2, automationRate: "k-rate" },
      { name: "range", defaultValue: -48, minValue: -80, maxValue: 0, automationRate: "k-rate" },
      { name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;
    const sr = globalThis.sampleRate || 44100;
    const channels = Math.min(input.length, output.length);
    for (let i = 0; i < output[0].length; i++) {
      let peak = 0;
      for (let ch = 0; ch < channels; ch++) peak = Math.max(peak, Math.abs(input[ch][i] || 0));
      const threshold = parameters.threshold.length > 1 ? parameters.threshold[i] : parameters.threshold[0];
      const hysteresis = parameters.hysteresis.length > 1 ? parameters.hysteresis[i] : parameters.hysteresis[0];
      const lookahead = parameters.lookahead.length > 1 ? parameters.lookahead[i] : parameters.lookahead[0];
      const attack = parameters.attack.length > 1 ? parameters.attack[i] : parameters.attack[0];
      const hold = parameters.hold.length > 1 ? parameters.hold[i] : parameters.hold[0];
      const release = parameters.release.length > 1 ? parameters.release[i] : parameters.release[0];
      const range = parameters.range.length > 1 ? parameters.range[i] : parameters.range[0];
      const mix = parameters.mix.length > 1 ? parameters.mix[i] : parameters.mix[0];
      const envCoef = Math.exp(
        -1 / (sr * (peak > this.envelope ? Math.max(0.0001, attack) : Math.max(0.001, release))),
      );
      this.envelope = envCoef * this.envelope + (1 - envCoef) * peak;
      if (Math.abs(this.envelope) < 1e-20) this.envelope = 0;
      // Hysteresis: OPEN at the threshold, CLOSE only below threshold minus
      // the hysteresis band. Inside the band the gate keeps its previous
      // state (hold neither refills nor decrements) — no chatter.
      const envDb = 20 * Math.log10(Math.max(this.envelope, 1e-7));
      const closeDb = threshold - Math.max(0, Math.min(1, hysteresis)) * 12;
      if (envDb >= threshold) {
        this.wasOpen = true;
        this.holdSamples = Math.max(this.holdSamples, Math.round(hold * sr));
      } else if (envDb < closeDb) {
        this.wasOpen = false;
        this.holdSamples = Math.max(0, this.holdSamples - 1);
      } // else: inside the hysteresis band — keep the current state.
      const target = this.holdSamples > 0 || this.wasOpen ? 1 : Math.pow(10, range / 20);
      if (lookahead >= 0.5 && target > this.gain) {
        // Look-ahead OPEN is instantaneous: the envelope crossed the
        // threshold at the live signal position, while the RING applies
        // that gain 2.5 ms later — exactly where the delayed transient
        // sits. The attack lag would otherwise still clip the attack.
        this.gain = target;
      } else {
        const step =
          target > this.gain
            ? 1 / Math.max(1, sr * Math.max(0.0001, attack))
            : 1 / Math.max(1, sr * Math.max(0.001, release));
        this.gain += (target - this.gain) * Math.min(1, step);
      }
      if (Math.abs(this.gain) < 1e-20) this.gain = 0;

      // Apply the computed gain to the DELAYED input when look-ahead is on:
      // the envelope reacted to the transient BEFORE it reaches the output.
      let appliedGain = this.gain;
      if (lookahead >= 0.5 && this.lookaheadSamples > 0) {
        if (!this.lookaheadWasOn) {
          // Re-enabling look-ahead must not replay gains parked in the ring
          // while it was off (stale open/closed values mute or leak for the
          // whole 2.5 ms ring on the transition block).
          this.gainRing.fill(this.gain);
          this.lookaheadWasOn = true;
        }
        appliedGain = this.gainRing[this.gainRingIdx];
        this.gainRing[this.gainRingIdx] = this.gain;
        this.gainRingIdx = (this.gainRingIdx + 1) % this.lookaheadSamples;
      } else {
        this.lookaheadWasOn = false;
      }
      for (let ch = 0; ch < channels; ch++) output[ch][i] = (input[ch][i] || 0) * (1 + (appliedGain - 1) * mix);
    }
    // Mono input feeding a multi-channel output: mirror ch0 so trailing
    // outputs never carry stale samples (svfilter/compressor do the same).
    for (let ch = channels; ch < output.length; ch++) {
      if (output[ch]) output[ch].set(output[0]);
    }
    return true;
  }
}

registerProcessor("gate-processor", GateProcessor);
