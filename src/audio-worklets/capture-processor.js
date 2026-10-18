/**
 * Capture processor — live master tap for the live↔offline null test
 * (release-gate hardening). Sink node: captures every sample it receives and
 * posts fixed-size stereo chunks to the main thread (transferable
 * Float32Arrays — no SharedArrayBuffer, so no cross-origin-isolation
 * requirement).
 *
 * Protocol (port):
 *   { type: "arm", chunkFrames?: number, captureFrames?: number, startFrame?: number }
 *       — begin immediately or at the requested absolute audio frame
 *   { type: "stop" } — stop capturing; a final partial chunk is flushed
 * Main thread receives:
 *   { type: "capture-start", time, frame, sampleRate } — audio-clock time of the
 *       FIRST captured quantum; the harness uses it to align the live
 *       capture against the offline render without blind correlation.
 *   { type: "chunk", frames, left, right }  (right === left when mono input)
 *   { type: "capture-done", frames }
 *
 * NOTE: served RAW inside public/parity-capture-worklet.js — plain JavaScript,
 * no imports.
 */
const CAPTURE_DEFAULT_CHUNK = 4096;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    const chunk = Number(opts.chunkFrames);
    this.chunkFrames = Number.isFinite(chunk) && chunk >= 128 ? Math.floor(chunk) : CAPTURE_DEFAULT_CHUNK;
    this.left = new Float32Array(this.chunkFrames);
    this.right = new Float32Array(this.chunkFrames);
    this.filled = 0;
    this.captureFrames = 0;
    this.capturedFrames = 0;
    this.startFrame = 0;
    this.armed = false;
    this.announced = false;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "arm") {
        const requestedChunk = Number(data.chunkFrames);
        if (Number.isSafeInteger(requestedChunk) && requestedChunk >= 128 && requestedChunk !== this.chunkFrames) {
          this.chunkFrames = requestedChunk;
          this.left = new Float32Array(this.chunkFrames);
          this.right = new Float32Array(this.chunkFrames);
        }
        const frames = Number(data.captureFrames);
        this.filled = 0;
        this.capturedFrames = 0;
        this.captureFrames = Number.isSafeInteger(frames) && frames >= 128 ? frames : 0;
        const startFrame = Number(data.startFrame);
        this.startFrame = Number.isSafeInteger(startFrame) && startFrame >= 0 ? startFrame : 0;
        this.armed = true;
        this.announced = false;
      } else if (data.type === "stop") {
        this.finish();
      }
    };
  }

  static get parameterDescriptors() {
    return [];
  }

  flush() {
    if (this.filled <= 0) return;
    const left = this.left.slice(0, this.filled);
    const right = this.right.slice(0, this.filled);
    this.port.postMessage({ type: "chunk", frames: this.filled, left, right }, [left.buffer, right.buffer]);
    this.filled = 0;
  }

  finish() {
    this.flush();
    this.armed = false;
    this.port.postMessage({ type: "capture-done", frames: this.capturedFrames });
  }

  process(inputs) {
    if (!this.armed) return true;
    const frame = Number(globalThis.currentFrame) || 0;
    if (!this.announced && this.startFrame > 0 && frame < this.startFrame) return true;
    if (!this.announced) {
      this.announced = true;
      // currentTime is the audio-clock time at the start of this quantum —
      // the exact origin of the captured sample stream.
      this.port.postMessage({
        type: "capture-start",
        time: currentTime,
        frame,
        sampleRate: globalThis.sampleRate || 0,
      });
    }
    const input = inputs[0];
    const ch0 = input && input[0] && input[0].length ? input[0] : null;
    const ch1 = input && input.length > 1 && input[1] && input[1].length ? input[1] : null;
    if (!ch0) return true;
    const remaining = this.captureFrames > 0 ? Math.max(0, this.captureFrames - this.capturedFrames) : ch0.length;
    const count = Math.min(ch0.length, remaining);
    for (let i = 0; i < count; i++) {
      this.left[this.filled] = ch0[i];
      this.right[this.filled] = ch1 ? ch1[i] : ch0[i];
      this.filled++;
      this.capturedFrames++;
      if (this.filled >= this.chunkFrames) this.flush();
    }
    if (this.captureFrames > 0 && this.capturedFrames >= this.captureFrames) this.finish();
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
