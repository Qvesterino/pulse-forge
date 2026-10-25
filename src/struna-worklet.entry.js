/**
 * STRUNA AudioWorklet entry - bundled by scripts/build-struna-worklet.mjs
 * into public/struna-worklet.js (loaded on demand; ADR 0061). Thin
 * wrapper: ALL DSP lives in src/struna/dsp/strunaProcessor.ts. Chunked
 * render (the rezonans contract): every sample of any quantum is written.
 *
 * Messaging (main thread -> worklet):
 *  { type: "init", params, events? }
 *  { type: "param", name, value }
 *  { type: "noteOn", pitch, velocity, when }
 *  { type: "noteOff", when }
 *  { type: "bright", pitch, value }   MPE pressure → loop brightness
 *  { type: "pick", pitch, value }     MPE timbre → pick position
 *  { type: "panic" }
 */
import { StrunaProcessor } from "./struna/dsp/strunaProcessor.ts";

const BLOCK = 128;

class StrunaWorkletProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.port.onmessage = (event) => this.handle(event.data);
    const opts = (options && options.processorOptions) || {};
    this.proc = new StrunaProcessor({
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
      case "bright":
      case "pick":
        if (
          !Number.isFinite(message.when) &&
          message.type !== "noteOn" &&
          message.type !== "bright" &&
          message.type !== "pick" &&
          message.type !== "panic"
        )
          break;
        this.proc.postEvent({
          type: message.type,
          when: typeof message.when === "number" ? message.when : currentTime,
          pitch: Number.isFinite(message.pitch) ? message.pitch : undefined,
          velocity: Number.isFinite(message.velocity) ? message.velocity : undefined,
          value: Number.isFinite(message.value) ? message.value : undefined,
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

registerProcessor("struna-processor", StrunaWorkletProcessor);
