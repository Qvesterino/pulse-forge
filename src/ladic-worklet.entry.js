/**
 * LADIČ AudioWorklet entry - bundled by scripts/build-ladic-worklet.mjs
 * into public/ladic-worklet.js (loaded on demand; see INSTRUMENT_WORKLET_TYPES
 * in src/audio-worklets/loader.ts and ADR 0055).
 *
 * Thin wrapper: ALL DSP lives in src/ladic/dsp/ladicProcessor.ts (typed,
 * first-party, vitest-testable). The wrapper owns the port, the block loop
 * and `currentFrame` - nothing else. Chunked render loop (the rezonans
 * contract): the spec allows larger quanta than 128 — every sample written.
 *
 * Messaging (main thread -> worklet):
 *  { type: "init", params, events? }
 *  { type: "param", name, value }
 *  { type: "noteOn", pitch, velocity, when }   absolute ctx time
 *  { type: "noteOff", pitch, when }
 *  { type: "panic" }
 */
import { LadicProcessor } from "./ladic/dsp/ladicProcessor.ts";

const BLOCK = 128;

class LadicWorkletProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.port.onmessage = (event) => this.handle(event.data);
    const opts = (options && options.processorOptions) || {};
    this.proc = new LadicProcessor({
      sampleRate,
      events: Array.isArray(opts.events) ? opts.events.filter((e) => e && typeof e === "object") : undefined,
    });
    if (opts.params) this.proc.applyParams(opts.params);
  }

  handle(message) {
    if (!message || typeof message !== "object") return;
    switch (message.type) {
      case "init":
        if (message.params) this.proc.applyParams(message.params);
        if (Array.isArray(message.events)) for (const e of message.events) this.proc.postEvent(e);
        break;
      case "param":
        if (typeof message.name === "string") this.proc.setParam(message.name, message.value);
        break;
      case "noteOn":
      case "noteOff":
      case "panic":
        if (!Number.isFinite(message.when) && message.type !== "panic") break;
        this.proc.postEvent({
          type: message.type,
          when: typeof message.when === "number" ? message.when : currentTime,
          pitch: Number.isFinite(message.pitch) ? message.pitch : undefined,
          velocity: Number.isFinite(message.velocity) ? message.velocity : undefined,
        });
        break;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const left = output[0];
    for (let offset = 0; offset < left.length; offset += BLOCK) {
      const frames = Math.min(BLOCK, left.length - offset);
      const l = left.subarray(offset, offset + frames);
      if (output.length > 1) {
        const r = output[1].subarray(offset, offset + frames);
        this.proc.process(l, r, currentFrame + offset);
      } else {
        const r = new Float32Array(frames);
        this.proc.process(l, r, currentFrame + offset);
        for (let i = 0; i < frames; i++) l[i] = (l[i] + r[i]) * 0.5;
      }
    }
    return true;
  }
}

registerProcessor("ladic-processor", LadicWorkletProcessor);
