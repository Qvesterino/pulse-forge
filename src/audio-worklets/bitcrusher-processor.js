/**
 * Bitcrusher AudioWorkletProcessor — runs on the audio rendering thread.
 *
 * Implements per-sample bit reduction and sample-and-hold downsampling.
 * The old WaveShaperNode approach could not implement downsampling (no state
 * across samples). This processor fixes that broken feature.
 *
 * AudioParams (automated from main thread via AudioParam scheduling):
 *   bits       — bit depth (1..16, default 8)
 *   downsample — sample-and-hold factor (1..50, default 1)
 *
 * NOTE: this file is served RAW to AudioWorklet.addModule() via
 * `new URL("./bitcrusher-processor.js", import.meta.url)` — it must stay
 * plain JavaScript with no imports and no TypeScript syntax.
 */
class BitcrusherProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.held = []; // per-channel sample-and-hold state
    this.counter = 0;
  }

  static get parameterDescriptors() {
    return [
      { name: "bits", defaultValue: 8, minValue: 1, maxValue: 16, automationRate: "k-rate" },
      { name: "downsample", defaultValue: 1, minValue: 1, maxValue: 50, automationRate: "k-rate" },
    ];
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;

    const bits = parameters.bits;
    const downsample = parameters.downsample;
    const bitsIsConstant = bits.length === 1;
    const dsIsConstant = downsample.length === 1;

    const channelCount = Math.min(input.length, output.length);
    const held = this.held;
    const counterStart = this.counter;
    let counter = counterStart;

    for (let ch = 0; ch < channelCount; ch++) {
      const inCh = input[ch];
      const inLen = inCh ? inCh.length : 0;
      const outCh = output[ch];
      // Every channel runs the SAME hold phase (the counter is restored per
      // channel) and keeps its OWN held sample. The old single counter +
      // single heldValue, consumed by sequential channel loops, offset ch1's
      // hold grid by blockLen % ds and let ch1 open each block with ch0's
      // stale hold — the opposite of the stereo coherence that was intended.
      counter = counterStart;
      let heldCh = held[ch] ?? 0;
      for (let i = 0; i < outCh.length; i++) {
        const b = bitsIsConstant ? bits[0] : bits[i];
        const ds = dsIsConstant ? downsample[0] : downsample[i];

        if (counter === 0) {
          // Quantize to bit depth. A missing (zero-length) or non-finite
          // input sample holds the previous value — a NaN must never latch
          // into the hold state, it would output NaN until the next valid
          // quantize on every channel.
          if (i < inLen && Number.isFinite(inCh[i])) {
            const levels = Math.max(2, Math.pow(2, Math.max(1, Math.round(b))));
            const step = 2 / (levels - 1);
            const quantized = Math.round((inCh[i] + 1) / step) * step - 1;
            heldCh = Math.max(-1, Math.min(1, quantized));
          }
        }
        outCh[i] = heldCh;
        counter = (counter + 1) % Math.max(1, Math.round(ds));
      }
      held[ch] = heldCh;
    }
    this.counter = counter;

    // Mono input feeding a multi-channel output: mirror ch0 so trailing
    // outputs never carry stale samples (svfilter/compressor do the same).
    if (channelCount > 0) {
      for (let ch = channelCount; ch < output.length; ch++) {
        if (output[ch]) output[ch].set(output[0]);
      }
    }

    return true;
  }
}

registerProcessor("bitcrusher-processor", BitcrusherProcessor);
