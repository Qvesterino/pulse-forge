class GateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.envelope = 0;
    this.gain = 0;
    this.holdSamples = 0;
    // The audio path always carries this fixed delay, including with the
    // look-ahead switch off. Keeping physical latency fixed makes the host's
    // PDC report truthful and avoids a discontinuity when the switch changes.
    const sr = globalThis.sampleRate || 44100;
    this.lookaheadSamples = Math.round(sr * 0.0025);
    this.audioRing = new Float32Array(this.lookaheadSamples * 2);
    this.gainRing = new Float32Array(this.lookaheadSamples);
    this.audioRingIdx = 0;
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
        // The detector sees the live input while the output is delayed by
        // 2.5 ms. Open immediately so the upcoming delayed transient clears
        // the gate without being clipped by the attack ramp.
        this.gain = target;
      } else {
        const step =
          target > this.gain
            ? 1 / Math.max(1, sr * Math.max(0.0001, attack))
            : 1 / Math.max(1, sr * Math.max(0.001, release));
        this.gain += (target - this.gain) * Math.min(1, step);
      }
      if (Math.abs(this.gain) < 1e-20) this.gain = 0;

      // Delay the audio itself by the declared look-ahead latency. The gain
      // detector stays on the live input, so it can react before that sample
      // reaches the output. Keeping the audio delay present with look-ahead
      // off holds the effect's physical latency constant for PDC. In that
      // mode, pair the delayed sample with the gain from the same input time
      // so the switch actually disables detector look-ahead.
      for (let ch = 0; ch < channels; ch++) {
        const ringIdx = ch * this.lookaheadSamples + this.audioRingIdx;
        const delayed = this.audioRing[ringIdx];
        this.audioRing[ringIdx] = input[ch][i] || 0;
        const delayedGain = this.gainRing[this.audioRingIdx];
        output[ch][i] = delayed * (1 + ((lookahead >= 0.5 ? this.gain : delayedGain) - 1) * mix);
      }
      this.gainRing[this.audioRingIdx] = this.gain;
      this.audioRingIdx = (this.audioRingIdx + 1) % this.lookaheadSamples;
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
