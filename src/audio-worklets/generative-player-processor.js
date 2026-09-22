/**
 * Bounded PCM sink for a live generative track.
 *
 * The control thread owns the provider session; this processor owns the
 * realtime queue. Incoming chunks are copied into a fixed-size interleaved
 * ring so a slow provider can underrun without blocking the audio callback,
 * and a fast provider cannot grow an unbounded array on the main thread.
 */
class GenerativePlayerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options?.processorOptions ?? {};
    this.channels = processorOptions.channels === 1 ? 1 : 2;
    this.maxFrames = Number.isInteger(processorOptions.maxFrames)
      ? Math.max(128, Math.min(480000, processorOptions.maxFrames))
      : 96000;
    this.ring = new Float32Array(this.maxFrames * this.channels);
    this.outputSampleRate =
      Number.isFinite(processorOptions.outputSampleRate) && processorOptions.outputSampleRate > 0
        ? processorOptions.outputSampleRate
        : typeof sampleRate === "number" && sampleRate > 0
          ? sampleRate
          : 48000;
    this.inputSampleRate = 0;
    this.sourceStep = 1;
    this.readPosition = 0;
    this.readFrame = 0;
    this.writeFrame = 0;
    this.queuedFrames = 0;
    this.lastSequence = -1;
    this.wasUnderrun = false;
    this.port.onmessage = (event) => this.receive(event.data);
  }

  receive(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "flush") {
      this.readFrame = 0;
      this.writeFrame = 0;
      this.queuedFrames = 0;
      this.lastSequence = -1;
      this.wasUnderrun = false;
      this.inputSampleRate = 0;
      this.sourceStep = 1;
      this.readPosition = 0;
      return;
    }
    if (message.type !== "chunk") return;
    const sequence = message.sequence;
    const sampleRate = message.sampleRate;
    const channels = message.channels;
    const frames = message.frames;
    const data = message.data;
    if (!Number.isInteger(sequence) || sequence < 0) return;
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) return;
    if (channels !== 1 && channels !== 2) return;
    if (!Number.isInteger(frames) || frames <= 0 || frames > this.maxFrames * 4) return;
    if (!(data instanceof Float32Array) || data.length !== frames * channels) return;
    for (let i = 0; i < data.length; i++) {
      if (!Number.isFinite(data[i])) return;
    }
    if (this.lastSequence >= 0 && sequence > this.lastSequence + 1) {
      this.port.postMessage({ type: "sequence-gap", expected: this.lastSequence + 1, received: sequence });
    }
    if (sequence <= this.lastSequence) return;
    if (this.inputSampleRate === 0) {
      this.inputSampleRate = sampleRate;
      this.sourceStep = sampleRate / this.outputSampleRate;
    } else if (sampleRate !== this.inputSampleRate) {
      this.port.postMessage({ type: "sample-rate-mismatch", expected: this.inputSampleRate, received: sampleRate });
      return;
    }
    this.lastSequence = sequence;

    let dropped = 0;
    for (let frame = 0; frame < frames; frame++) {
      if (this.queuedFrames >= this.maxFrames) {
        this.readFrame = (this.readFrame + 1) % this.maxFrames;
        this.queuedFrames--;
        this.readPosition = Math.max(0, this.readPosition - 1);
        dropped++;
      }
      const sourceOffset = frame * channels;
      const ringOffset = this.writeFrame * this.channels;
      const left = data[sourceOffset] ?? 0;
      this.ring[ringOffset] = left;
      this.ring[ringOffset + 1] = channels === 2 ? (data[sourceOffset + 1] ?? left) : left;
      this.writeFrame = (this.writeFrame + 1) % this.maxFrames;
      this.queuedFrames++;
    }
    if (dropped > 0) this.port.postMessage({ type: "overrun", droppedFrames: dropped });
    if (this.wasUnderrun && this.queuedFrames > 0) {
      this.wasUnderrun = false;
      this.port.postMessage({ type: "recovered", queuedFrames: this.queuedFrames });
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const left = output[0];
    const right = output[1] ?? output[0];
    let missing = 0;
    for (let i = 0; i < left.length; i++) {
      if (this.queuedFrames === 0) {
        left[i] = 0;
        if (right !== left) right[i] = 0;
        missing++;
        continue;
      }
      const wholeFrames = Math.floor(this.readPosition);
      const fraction = this.readPosition - wholeFrames;
      const firstFrame = (this.readFrame + wholeFrames) % this.maxFrames;
      const secondFrame = (firstFrame + 1) % this.maxFrames;
      const hasNext = this.queuedFrames > wholeFrames + 1;
      const firstOffset = firstFrame * this.channels;
      const secondOffset = secondFrame * this.channels;
      const firstLeft = this.ring[firstOffset] ?? 0;
      const secondLeft = hasNext ? (this.ring[secondOffset] ?? firstLeft) : firstLeft;
      left[i] = firstLeft + (secondLeft - firstLeft) * fraction;
      if (right !== left) {
        const firstRight = this.ring[firstOffset + 1] ?? firstLeft;
        const secondRight = hasNext ? (this.ring[secondOffset + 1] ?? firstRight) : firstRight;
        right[i] = firstRight + (secondRight - firstRight) * fraction;
      }
      this.readPosition += this.sourceStep;
      const consumeLimit = hasNext ? this.queuedFrames - 1 : this.queuedFrames;
      const consumed = Math.min(consumeLimit, Math.max(Math.floor(this.readPosition), hasNext ? 0 : 1));
      if (consumed > 0) {
        this.readFrame = (this.readFrame + consumed) % this.maxFrames;
        this.queuedFrames -= consumed;
        this.readPosition -= consumed;
      }
    }
    if (missing > 0 && !this.wasUnderrun) {
      this.wasUnderrun = true;
      this.port.postMessage({ type: "underrun", missingFrames: missing });
    }
    return true;
  }
}

registerProcessor("generative-player", GenerativePlayerProcessor);
