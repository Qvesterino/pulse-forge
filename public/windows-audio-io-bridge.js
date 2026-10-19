/*
 * Realtime side of the Windows shared-mode PCM bridge.
 *
 * AudioWorklet owns the sample clock. It batches render PCM into fixed-size
 * periods and consumes bounded capture packets. Buffers cross the utility
 * process boundary by transfer and return to their fixed pools after use.
 */
class KyxWindowsAudioIoBridgeProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options.processorOptions || {};
    this.sessionId = config.sessionId;
    this.periodFrames = config.periodFrames;
    this.captureChannels = config.captureChannels;
    this.renderChannels = 2;
    this.poolLimit = Math.max(2, Math.min(16, config.poolSize || 6));
    this.renderPool = [];
    this.renderInFlight = new Map();
    this.currentRender = null;
    this.renderView = null;
    this.renderFrame = 0;
    this.renderSequence = 0;
    this.renderDrops = 0;
    this.captureHead = 0;
    this.captureTail = 0;
    this.captureQueue = new Array(this.poolLimit);
    this.captureView = null;
    this.captureFrame = 0;
    this.captureDrops = 0;
    this.captureInvalidPackets = 0;
    this.processCalls = 0;
    this.nativePort = null;
    this.ready = false;
    this.lastStatusFrame = 0;
    this.lostReported = false;
    const renderBytes = this.periodFrames * this.renderChannels * Float32Array.BYTES_PER_ELEMENT;
    for (let index = 0; index < this.poolLimit; index++) this.renderPool.push(new ArrayBuffer(renderBytes));
    this.acquireRenderBuffer();
    this.port.onmessage = (event) => {
      const message = event.data;
      if (!message || typeof message !== "object") return;
      if (message.type === "attach" && message.port) {
        this.nativePort = message.port;
        this.nativePort.onmessage = (bridgeEvent) => this.receiveNative(bridgeEvent.data);
        this.nativePort.start();
        this.nativePort.postMessage({ type: "bridge-ready", sessionId: this.sessionId });
        this.port.postMessage({ type: "attached" });
      }
    };
  }

  acquireRenderBuffer() {
    this.currentRender = this.renderPool.pop() || null;
    this.renderView = this.currentRender ? new Float32Array(this.currentRender) : null;
  }

  receiveNative(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "ready") {
      if (
        message.sessionId !== this.sessionId ||
        message.sampleRateHz !== sampleRate ||
        message.periodFrames !== this.periodFrames ||
        message.captureChannels !== this.captureChannels ||
        message.renderChannels !== this.renderChannels
      ) {
        this.port.postMessage({ type: "error", message: "Native audio negotiation does not match the AudioWorklet" });
        return;
      }
      this.ready = true;
      this.lastStatusFrame = currentFrame;
      this.port.postMessage({ type: "ready", negotiation: message.negotiation });
      return;
    }
    if (message.type === "status") {
      this.lastStatusFrame = currentFrame;
      const nativeBridge = message.bridge && typeof message.bridge === "object" ? message.bridge : {};
      this.port.postMessage({
        type: "status",
        snapshot: message.snapshot,
        bridge: {
          ...nativeBridge,
          ...this.counters(),
          utilityRenderRejectedPackets: nativeBridge.renderRejectedPackets || 0,
        },
      });
      return;
    }
    if (message.type === "device-lost" || message.type === "error" || message.type === "stopped") {
      this.ready = false;
      this.port.postMessage({ type: message.type, message: message.message, snapshot: message.snapshot });
      return;
    }
    if (message.type === "recycle-render") {
      if (message.sessionId !== this.sessionId) return;
      const buffer = Number.isSafeInteger(message.sequence) ? this.renderInFlight.get(message.sequence) : null;
      const expectedBytes = this.periodFrames * this.renderChannels * Float32Array.BYTES_PER_ELEMENT;
      if (
        buffer instanceof ArrayBuffer &&
        buffer.byteLength === expectedBytes &&
        this.renderPool.length < this.poolLimit
      ) {
        this.renderInFlight.delete(message.sequence);
        this.renderPool.push(buffer);
      }
      return;
    }
    if (message.type === "capture") {
      const buffer = message.samples;
      const frames = message.frames;
      const sequence = message.sequence;
      if (message.sessionId !== this.sessionId) return;
      const expectedBytes = this.periodFrames * this.captureChannels * Float32Array.BYTES_PER_ELEMENT;
      if (
        !Number.isSafeInteger(sequence) ||
        sequence < 0 ||
        !Number.isInteger(frames) ||
        frames < 1 ||
        frames > this.periodFrames ||
        !(buffer instanceof ArrayBuffer) ||
        buffer.byteLength !== expectedBytes
      ) {
        this.captureInvalidPackets++;
        if (Number.isSafeInteger(sequence) && sequence >= 0)
          this.nativePort?.postMessage({ type: "recycle-capture", sessionId: this.sessionId, sequence });
        return;
      }
      if (this.captureTail - this.captureHead >= this.poolLimit) {
        this.captureDrops++;
        this.nativePort.postMessage({ type: "recycle-capture", sessionId: this.sessionId, sequence });
        return;
      }
      const slot = this.captureTail % this.poolLimit;
      this.captureQueue[slot] = { buffer, frames, sequence };
      this.captureTail++;
    }
  }

  counters() {
    return {
      ready: this.ready,
      processCalls: this.processCalls,
      renderSequence: this.renderSequence,
      renderDroppedPeriods: this.renderDrops,
      captureDroppedPackets: this.captureDrops,
      captureInvalidPackets: this.captureInvalidPackets,
      queuedCapturePackets: this.captureTail - this.captureHead,
      freeRenderBuffers: this.renderPool.length,
      inFlightRenderPackets: this.renderInFlight.size,
    };
  }

  process(inputs, outputs) {
    this.processCalls++;
    const monitor = outputs[0] || [];
    for (const channel of monitor) channel.fill(0);
    const captureOutput = outputs[1] || [];
    for (const channel of captureOutput) channel.fill(0);
    const renderInput = inputs[0] || [];
    const quantumFrames = monitor[0]?.length || captureOutput[0]?.length || 128;

    // The native capture queue is consumed at the worklet sample clock. A
    // completed packet is returned to the utility's bounded buffer pool.
    if (this.captureOutputActive(captureOutput)) {
      let outputFrame = 0;
      while (outputFrame < quantumFrames && this.captureHead < this.captureTail) {
        const slot = this.captureHead % this.poolLimit;
        const packet = this.captureQueue[slot];
        if (!packet) break;
        if (!this.captureView) {
          this.captureView = new Float32Array(packet.buffer);
          this.captureFrame = 0;
        }
        const count = Math.min(packet.frames - this.captureFrame, quantumFrames - outputFrame);
        for (let frame = 0; frame < count; frame++) {
          for (let channel = 0; channel < captureOutput.length; channel++) {
            captureOutput[channel][outputFrame + frame] =
              this.captureView[(this.captureFrame + frame) * this.captureChannels + channel] || 0;
          }
        }
        outputFrame += count;
        this.captureFrame += count;
        if (this.captureFrame === packet.frames) {
          this.nativePort.postMessage({
            type: "recycle-capture",
            sessionId: this.sessionId,
            sequence: packet.sequence,
          });
          this.captureQueue[slot] = undefined;
          this.captureHead++;
          this.captureView = null;
          this.captureFrame = 0;
        }
      }
    }

    // Copy the post-master signal into fixed packets. If the utility is late,
    // drop a whole period and keep the realtime callback bounded.
    for (let frame = 0; frame < quantumFrames; frame++) {
      if (this.renderView) {
        this.renderView[this.renderFrame * 2] = renderInput[0]?.[frame] || 0;
        this.renderView[this.renderFrame * 2 + 1] = renderInput[1]?.[frame] || 0;
      }
      this.renderFrame++;
      if (this.renderFrame === this.periodFrames) {
        if (this.currentRender && this.nativePort && this.ready) {
          const buffer = this.currentRender;
          this.renderInFlight.set(this.renderSequence, buffer);
          this.nativePort.postMessage({
            type: "render",
            sessionId: this.sessionId,
            sequence: this.renderSequence,
            frames: this.periodFrames,
            channels: this.renderChannels,
            samples: buffer,
          });
        } else if (this.currentRender) {
          this.renderPool.push(this.currentRender);
        } else {
          this.renderDrops++;
        }
        this.renderSequence++;
        this.renderFrame = 0;
        this.currentRender = null;
        this.renderView = null;
        this.acquireRenderBuffer();
      }
    }

    if (this.ready && !this.lostReported && currentFrame - this.lastStatusFrame > sampleRate * 2) {
      this.lostReported = true;
      this.ready = false;
      this.port.postMessage({ type: "error", message: "No native audio status arrived for two seconds" });
    }
    return true;
  }

  captureOutputActive(outputs) {
    return outputs.length > 0;
  }
}

registerProcessor("kyx-windows-audio-io-bridge", KyxWindowsAudioIoBridgeProcessor);
