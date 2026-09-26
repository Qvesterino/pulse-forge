class PulseForgePcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const requested = options?.processorOptions?.chunkFrames;
    this.chunkFrames = Number.isInteger(requested) && requested >= 128 ? requested : sampleRate;
    // About 1.5 seconds of headroom absorbs normal IndexedDB jitter; if the UI
    // thread stays stalled, fail closed instead of retaining an unbounded take.
    this.maxInFlight = 3;
    this.buffers = null;
    this.channelCount = 0;
    this.writeOffset = 0;
    this.sequence = 0;
    this.inFlight = 0;
    this.lastAckedSequence = -1;
    this.readySent = false;
    this.armed = false;
    this.takeBoundaryFrames = [];
    this.chunkTakeBoundaries = [];
    this.stopAtFrame = null;
    this.stopped = false;
    this.failed = false;
    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  handleMessage(message) {
    if (!message || typeof message.type !== "string") return;
    if (message.type === "start") {
      if (!this.stopped && !this.failed) {
        this.armed = true;
        if (message.loopCapture === true) this.takeBoundaryFrames.push(0);
        if (message.punchInNow === true) this.takeBoundaryFrames.push(0);
      }
      return;
    }
    if (message.type === "take-boundary") {
      if (!this.armed || this.stopped || this.failed) return;
      const atTime = message.atTime;
      if (typeof atTime !== "number" || !Number.isFinite(atTime)) return;
      const targetFrame = Math.round(atTime * sampleRate);
      if (targetFrame < currentFrame) {
        this.fail("An audio capture boundary reached the worklet too late; recording stopped to preserve alignment");
        return;
      }
      const previous = this.takeBoundaryFrames[this.takeBoundaryFrames.length - 1];
      if (previous !== undefined && targetFrame <= previous) return;
      this.takeBoundaryFrames.push(targetFrame);
      return;
    }
    if (message.type === "cancel-take-boundary") {
      if (!this.armed || this.stopped || this.failed) return;
      const atTime = message.atTime;
      if (typeof atTime !== "number" || !Number.isFinite(atTime)) return;
      const targetFrame = Math.round(atTime * sampleRate);
      const pendingIndex = this.takeBoundaryFrames.indexOf(targetFrame);
      if (pendingIndex >= 0) {
        this.takeBoundaryFrames.splice(pendingIndex, 1);
      } else if (targetFrame < currentFrame) {
        this.fail("An audio capture boundary changed after its frame; recording stopped to preserve alignment");
      }
      return;
    }
    if (message.type === "stop-at") {
      if (!this.armed || this.stopped || this.failed) return;
      const atTime = message.atTime;
      if (typeof atTime !== "number" || !Number.isFinite(atTime)) return;
      const targetFrame = Math.round(atTime * sampleRate);
      if (targetFrame < currentFrame) {
        this.fail("Punch-out reached the capture worklet too late; the partial take remains recoverable");
        return;
      }
      this.stopAtFrame = targetFrame;
      return;
    }
    if (message.type === "cancel-stop-at") {
      if (!this.armed || this.stopped || this.failed) return;
      const atTime = message.atTime;
      if (typeof atTime !== "number" || !Number.isFinite(atTime)) return;
      if (this.stopAtFrame === Math.round(atTime * sampleRate)) this.stopAtFrame = null;
      else if (this.stopAtFrame !== null && this.stopAtFrame < currentFrame) {
        this.fail("Punch-out changed after its audio frame; the partial take remains recoverable");
      }
      return;
    }
    if (message.type === "ack") {
      if (message.sequence <= this.lastAckedSequence) return;
      if (message.sequence !== this.lastAckedSequence + 1 || this.inFlight <= 0) {
        this.fail("Recording storage acknowledgements arrived out of order");
        return;
      }
      this.lastAckedSequence = message.sequence;
      this.inFlight--;
      return;
    }
    if (message.type === "stop") {
      if (this.stopped) return;
      this.armed = false;
      if (!this.failed) this.flush(true);
      this.stopped = true;
      this.port.postMessage({ type: "stopped", sequence: this.sequence });
    }
  }

  fail(reason) {
    if (this.failed) return;
    this.failed = true;
    this.armed = false;
    this.port.postMessage({ type: "error", reason });
    this.stopped = true;
    this.port.postMessage({ type: "stopped", sequence: this.sequence });
  }

  allocateBuffers() {
    this.buffers = new Array(this.channelCount);
    for (let channel = 0; channel < this.channelCount; channel++) {
      this.buffers[channel] = new Float32Array(this.chunkFrames);
    }
    this.writeOffset = 0;
  }

  flush(partial, punchOut = false) {
    if (this.writeOffset === 0) return true;
    if (this.inFlight >= this.maxInFlight) {
      this.fail("Audio storage could not keep up; capture stopped to avoid unbounded memory growth");
      return false;
    }
    const frames = this.writeOffset;
    const channels = new Array(this.channelCount);
    const transfer = new Array(this.channelCount);
    for (let channel = 0; channel < this.channelCount; channel++) {
      const buffer = this.buffers[channel];
      const pcm = partial ? buffer.slice(0, frames) : buffer;
      channels[channel] = pcm.buffer;
      transfer[channel] = pcm.buffer;
    }
    const sequence = this.sequence++;
    this.inFlight++;
    this.port.postMessage(
      {
        type: "chunk",
        sequence,
        frames,
        channels,
        takeBoundaries: this.chunkTakeBoundaries,
        ...(punchOut ? { punchOut: true } : {}),
      },
      transfer,
    );
    this.chunkTakeBoundaries = [];
    this.allocateBuffers();
    return true;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (output) {
      for (let channel = 0; channel < output.length; channel++) output[channel].fill(0);
    }
    if (this.stopped || this.failed) return false;

    const input = inputs[0];
    if (!input || input.length === 0) {
      if (this.stopAtFrame !== null && this.stopAtFrame <= currentFrame) {
        if (!this.flush(true, true)) return false;
        this.armed = false;
        this.stopped = true;
        this.port.postMessage({ type: "stopped", sequence: this.sequence, reason: "punch-out" });
        return false;
      }
      return true;
    }
    if (!this.readySent) {
      this.channelCount = input.length;
      this.allocateBuffers();
      this.readySent = true;
      this.port.postMessage({ type: "ready", channels: this.channelCount, sampleRate });
      return true;
    }
    if (input.length !== this.channelCount) {
      this.fail("Microphone channel layout changed during recording");
      return false;
    }
    if (!this.armed) return true;

    const quantumFrames = input[0]?.length ?? 0;
    for (let frame = 0; frame < quantumFrames; frame++) {
      const absoluteFrame = currentFrame + frame;
      if (this.stopAtFrame !== null && this.stopAtFrame <= absoluteFrame) {
        if (!this.flush(true, true)) return false;
        this.armed = false;
        this.stopped = true;
        this.port.postMessage({ type: "stopped", sequence: this.sequence, reason: "punch-out" });
        return false;
      }
      while (this.takeBoundaryFrames.length > 0 && this.takeBoundaryFrames[0] <= absoluteFrame) {
        const boundaryFrame = this.takeBoundaryFrames.shift();
        if (boundaryFrame === undefined) break;
        if (this.chunkTakeBoundaries[this.chunkTakeBoundaries.length - 1] !== this.writeOffset) {
          this.chunkTakeBoundaries.push(this.writeOffset);
        }
      }
      for (let channel = 0; channel < this.channelCount; channel++) {
        this.buffers[channel][this.writeOffset] = input[channel][frame];
      }
      this.writeOffset++;
      if (this.stopAtFrame !== null && this.stopAtFrame === absoluteFrame + 1) {
        if (!this.flush(true, true)) return false;
        this.armed = false;
        this.stopped = true;
        this.port.postMessage({ type: "stopped", sequence: this.sequence, reason: "punch-out" });
        return false;
      }
      if (this.writeOffset === this.chunkFrames && !this.flush(false)) return false;
    }
    return true;
  }
}

registerProcessor("pulse-forge-pcm-capture", PulseForgePcmCaptureProcessor);
