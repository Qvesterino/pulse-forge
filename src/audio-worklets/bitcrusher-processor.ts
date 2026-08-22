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
 */
class BitcrusherProcessor extends AudioWorkletProcessor {
  heldValue = 0;
  counter = 0;

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;

    const bits = parameters.bits;
    const downsample = parameters.downsample;
    const bitsIsConstant = bits.length === 1;
    const dsIsConstant = downsample.length === 1;

    const channelCount = Math.min(input.length, output.length);

    for (let ch = 0; ch < channelCount; ch++) {
      const inCh = input[ch];
      const outCh = output[ch];
      // Reset counter for each channel? No — share counter for stereo coherence.
      for (let i = 0; i < outCh.length; i++) {
        const b = bitsIsConstant ? bits[0] : bits[i];
        const ds = dsIsConstant ? downsample[0] : downsample[i];

        if (this.counter === 0) {
          // Quantize to bit depth
          const levels = Math.max(2, Math.pow(2, Math.max(1, Math.round(b))));
          const step = 2 / (levels - 1);
          const quantized = Math.round((inCh[i] + 1) / step) * step - 1;
          this.heldValue = Math.max(-1, Math.min(1, quantized));
        }
        outCh[i] = this.heldValue;
        this.counter = (this.counter + 1) % Math.max(1, Math.round(ds));
      }
    }

    return true;
  }
}

registerProcessor("bitcrusher-processor", BitcrusherProcessor);
