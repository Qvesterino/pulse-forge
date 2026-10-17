/** Source for the silent AudioWorklet side of the Electron PCM bridge probe. */
module.exports = `
class KyxAudioBridgeSmokeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bridge = null;
    this.buffer = new Float32Array(480 * 2);
    this.writeFrame = 0;
    this.nextSequence = 0;
    this.received = 0;
    this.sentFrame = new Float64Array(100);
    this.latencyMs = new Float64Array(100);
    this.failed = false;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message && message.type === "attach" && message.port) {
        this.bridge = message.port;
        this.bridge.onmessage = (bridgeEvent) => this.receive(bridgeEvent.data);
        this.bridge.start();
        this.port.postMessage({ type: "ready" });
      }
    };
  }

  fail(message) {
    if (this.failed) return;
    this.failed = true;
    this.bridge?.postMessage({ type: "probe-error", message });
    this.port.postMessage({ type: "failed", message });
  }

  receive(message) {
    if (!message || typeof message !== "object") return this.fail("AudioWorklet received a malformed bridge message");
    if (message.type === "ready") return;
    if (message.type === "probe-result-ack") return;
    if (message.type === "error") return this.fail(message.message || "utility host rejected a PCM period");
    if (message.type !== "render" || !Number.isSafeInteger(message.sequence)) {
      return this.fail("utility host returned a malformed PCM response");
    }
    const sequence = message.sequence;
    if (sequence !== this.received || !(message.samples instanceof ArrayBuffer) || message.samples.byteLength !== 3840) {
      return this.fail("PCM periods were lost, reordered or returned with the wrong size");
    }
    const samples = new Float32Array(message.samples);
    const marker = sequence + 1;
    if (samples[0] !== marker || samples[samples.length - 1] !== marker) {
      return this.fail("PCM response data changed across the utility MessagePort");
    }
    this.latencyMs[sequence] = ((currentFrame - this.sentFrame[sequence]) / sampleRate) * 1000;
    this.received += 1;
    if (this.received === 100) this.finish();
  }

  finish() {
    const ordered = Array.from(this.latencyMs).sort((a, b) => a - b);
    const result = {
      status: "done",
      ok: true,
      sent: this.nextSequence,
      received: this.received,
      framesPerBlock: 480,
      channels: 2,
      sampleRateHz: sampleRate,
      periodMs: (480 / sampleRate) * 1000,
      p95RoundTripMs: Number(ordered[Math.ceil(ordered.length * 0.95) - 1].toFixed(3)),
      maxRoundTripMs: Number(ordered[ordered.length - 1].toFixed(3)),
    };
    this.bridge?.postMessage({ type: "probe-result", result });
    this.port.postMessage({ type: "result", result });
  }

  process(_inputs, outputs) {
    for (const channel of outputs[0] || []) channel.fill(0);
    if (!this.bridge || this.failed || this.nextSequence >= 100) return true;
    const frames = outputs[0]?.[0]?.length || 128;
    let offset = 0;
    while (offset < frames && this.nextSequence < 100) {
      const count = Math.min(480 - this.writeFrame, frames - offset);
      const marker = this.nextSequence + 1;
      this.buffer.fill(marker, this.writeFrame * 2, (this.writeFrame + count) * 2);
      this.writeFrame += count;
      offset += count;
      if (this.writeFrame === 480) {
        const sequence = this.nextSequence++;
        this.sentFrame[sequence] = currentFrame + offset;
        this.bridge.postMessage({ type: "capture", sequence, samples: this.buffer.slice().buffer });
        this.writeFrame = 0;
      }
    }
    return true;
  }
}

registerProcessor("kyx-audio-bridge-smoke", KyxAudioBridgeSmokeProcessor);
`;
