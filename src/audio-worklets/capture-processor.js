/**
 * Capture processor — live master tap for the live↔offline null test
 * (release-gate hardening). Sink node: captures every sample it receives and
 * posts fixed-size stereo chunks to the main thread (transferable
 * Float32Arrays — no SharedArrayBuffer, so no cross-origin-isolation
 * requirement).
 *
 * Protocol (port):
 *   { type: "arm", chunkFrames?: number } — begin capture
 *   { type: "stop" } — stop capturing; a final partial chunk is flushed
 * Main thread receives:
 *   { type: "chunk", frames, left, right }  (right === left when mono input)
 *   { type: "capture-done", frames }
 *
 * NOTE: served RAW inside core-worklet.js — plain JavaScript, no imports.
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
    this.armed = false;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "arm") {
        this.filled = 0;
        this.armed = true;
      } else if (data.type === "stop") {
        this.flush();
        this.armed = false;
        this.port.postMessage({ type: "capture-done" });
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

  process(inputs) {
    if (!this.armed) return true;
    const input = inputs[0];
    const ch0 = input && input[0] && input[0].length ? input[0] : null;
    const ch1 = input && input.length > 1 && input[1] && input[1].length ? input[1] : null;
    if (!ch0) return true;
    for (let i = 0; i < ch0.length; i++) {
      this.left[this.filled] = ch0[i];
      this.right[this.filled] = ch1 ? ch1[i] : ch0[i];
      this.filled++;
      if (this.filled >= this.chunkFrames) this.flush();
    }
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
