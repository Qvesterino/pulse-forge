class LatencyProbeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.lastDetectionFrame = -Infinity;
    this.refractoryFrames = Math.floor(sampleRate * 0.08);
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (output) output.fill(0);
    if (!input) return true;

    let peak = 0;
    let peakIndex = 0;
    for (let i = 0; i < input.length; i++) {
      const value = Math.abs(input[i]);
      if (value > peak) {
        peak = value;
        peakIndex = i;
      }
    }

    const frame = currentFrame + peakIndex;
    if (peak >= 0.035 && frame - this.lastDetectionFrame >= this.refractoryFrames) {
      this.lastDetectionFrame = frame;
      this.port.postMessage({ frame, time: currentTime + peakIndex / sampleRate, peak });
    }
    return true;
  }
}

registerProcessor("latency-probe-processor", LatencyProbeProcessor);
