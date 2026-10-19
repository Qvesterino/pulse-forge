/* Karplus–Strong delay loop for the pluck voice. */
class KarplusStrongProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    const processorOptions = options?.processorOptions ?? {};
    const sr = globalThis.sampleRate || 44100;
    const requestedDelay = Number(processorOptions.delaySamples);
    const requestedFeedback = Number(processorOptions.feedback);
    this.delaySamples = Number.isFinite(requestedDelay) ? Math.max(sr * 0.001, Math.min(sr - 2, requestedDelay)) : 128;
    this.feedback = Number.isFinite(requestedFeedback) ? Math.max(0, Math.min(0.999, requestedFeedback)) : 0.9;
    const capacity = Math.ceil(this.delaySamples) + 2;
    this.delayLines = [new Float32Array(capacity), new Float32Array(capacity)];
    this.writeIndex = 0;
    this.flushThreshold = 1e-20;
  }

  readDelayed(line) {
    const capacity = line.length;
    let index = this.writeIndex - Math.floor(this.delaySamples);
    while (index < 0) index += capacity;
    const olderIndex = (index - 1 + capacity) % capacity;
    const fraction = this.delaySamples - Math.floor(this.delaySamples);
    return line[index] * (1 - fraction) + line[olderIndex] * fraction;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const input = inputs[0];
    const channels = Math.min(output.length, this.delayLines.length);

    for (let frame = 0; frame < output[0].length; frame += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        const source = input && input[channel] ? input[channel] : input?.[0];
        const sample = source && Number.isFinite(source[frame]) ? source[frame] : 0;
        const excitation = Math.abs(sample) >= this.flushThreshold ? sample : 0;
        const line = this.delayLines[channel];
        const delayed = this.readDelayed(line);
        const delayedSample = Math.abs(delayed) >= this.flushThreshold ? delayed : 0;
        const feedbackSample = excitation + delayedSample * this.feedback;
        line[this.writeIndex] =
          Number.isFinite(feedbackSample) && Math.abs(feedbackSample) >= this.flushThreshold ? feedbackSample : 0;
        output[channel][frame] = delayedSample;
      }
      this.writeIndex = (this.writeIndex + 1) % this.delayLines[0].length;
    }
    return true;
  }
}

registerProcessor("karplus-strong-processor", KarplusStrongProcessor);
