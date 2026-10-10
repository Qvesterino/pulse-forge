/**
 * KOPA AudioWorklet entry - bundled by scripts/build-kopa-worklet.mjs into
 * public/kopa-worklet.js (loaded on demand; see INSTRUMENT_WORKLET_TYPES in
 * src/audio-worklets/loader.ts and the KOPA plan §3.2).
 *
 * Thin wrapper: ALL DSP lives in src/kopa/dsp/kopaProcessor.ts (typed,
 * first-party, vitest-testable). The wrapper owns the port, the block loop
 * and `currentFrame` - nothing else.
 *
 * Messaging (main thread -> worklet):
 *  { type: "init", params, events? }            params + optional seeded queue
 *  { type: "param", name, value }               immediate
 *  { type: "noteOn", pitch, velocity, when }    absolute ctx time
 *  { type: "noteOff", pitch, when }
 *  { type: "panic" }
 *
 * OFFLINE PARITY: `processorOptions.events` pre-seeds the same queue the port
 * feeds, so an OfflineAudioContext render (where message queues are not
 * pumped) hears the identical event sequence. See src/instruments/kopaNode.ts.
 */
import { KopaProcessor } from "./kopa/dsp/kopaProcessor.ts";

const BLOCK = 128;
/** Scratch buffers for the (rare) mono output case. */
const MONO_L = new Float32Array(BLOCK);
const MONO_R = new Float32Array(BLOCK);

class KopaWorkletProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.port.onmessage = (event) => this.handle(event.data);
    // processorOptions arrives as `options.processorOptions` - the GLOBAL
    // `processorOptions` alias is undefined in current Chromium (the TSAR
    // silent-offline defect).
    const opts = (options && options.processorOptions) || {};
    this.proc = new KopaProcessor({
      sampleRate,
      events: Array.isArray(opts.events) ? opts.events : undefined,
    });
    if (opts.params) this.proc.applyParams(opts.params);
  }

  handle(message) {
    if (!message || typeof message !== "object") return;
    switch (message.type) {
      case "init":
        if (message.params) this.proc.applyParams(message.params);
        if (Array.isArray(message.events)) for (const e of message.events) this.proc.postEvent(e);
        this.port.postMessage({ type: "ready" });
        break;
      case "param":
        this.proc.setParam(message.name, message.value);
        break;
      case "noteOn":
      case "noteOff":
      case "panic":
        this.proc.postEvent({
          type: message.type,
          when: typeof message.when === "number" ? message.when : currentTime,
          pitch: message.pitch,
          velocity: message.velocity,
        });
        break;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const left = output[0];
    const frames = Math.min(BLOCK, left.length);
    const l = frames === left.length ? left : left.subarray(0, frames);
    if (output.length > 1) {
      const right = output[1];
      const r = frames === right.length ? right : right.subarray(0, frames);
      this.proc.process(l, r, currentFrame);
    } else {
      const scratchL = MONO_L.subarray(0, frames);
      const scratchR = MONO_R.subarray(0, frames);
      this.proc.process(scratchL, scratchR, currentFrame);
      for (let i = 0; i < frames; i++) l[i] = (scratchL[i] + scratchR[i]) * 0.5;
    }
    return true;
  }
}

registerProcessor("kopa-processor", KopaWorkletProcessor);
