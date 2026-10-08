/**
 * TSAR AudioWorklet entry - bundled by scripts/build-tsar-worklet.mjs into
 * public/tsar-worklet.js (loaded on demand; see PLUGIN_WORKLET_TYPES in
 * src/audio-worklets/loader.ts and docs/TSAR-ROADMAP.md T1).
 *
 * Thin wrapper: ALL DSP lives in src/tsar/dsp/tsarProcessor.ts (typed,
 * first-party, vitest-testable). The wrapper owns the port, the block loop
 * and `currentFrame` - nothing else.
 *
 * Messaging (main thread -> worklet):
 *  { type: "init", params, events? }            params + optional seeded queue
 *  { type: "param", name, value }               immediate
 *  { type: "noteOn", pitch, velocity, when }    absolute ctx time
 *  { type: "noteOff", pitch, when }
 *  { type: "pressure", pitch, value }
 *  { type: "bpm", bpm, when? }
 *  { type: "wavetable", slot, frames, frameCount }  slot 0|1
 *  { type: "sample", slot, pcm, rootHz }
 *  { type: "clearSource", slot }  slot 0|1
 *  { type: "panic" }
 *
 * OFFLINE PARITY: `processorOptions.events` pre-seeds the same queue the port
 * feeds, so an OfflineAudioContext render (where message queues are not
 * pumped) hears the identical event sequence. See the runtime wrapper.
 */
import { TsarProcessor } from "./tsar/dsp/tsarProcessor.ts";

const BLOCK = 128;
/** Scratch buffers for the (rare) mono output case. */
const MONO_L = new Float32Array(BLOCK);
const MONO_R = new Float32Array(BLOCK);

class TsarWorkletProcessor extends AudioWorkletProcessor {
  // The DSP is created in the constructor because it needs `sampleRate` (a
  // global) and the seeded options; a field initializer cannot read the
  // constructor argument.
  constructor(options) {
    super();
    this.port.onmessage = (event) => this.handle(event.data);
    // processorOptions arrives as `options.processorOptions` — the GLOBAL
    // `processorOptions` is a legacy alias that is undefined in current
    // Chromium (measured: a processorOptions-only offline render produced
    // digital silence until this contract was fixed).
    const opts = (options && options.processorOptions) || {};
    this.proc = new TsarProcessor({
      sampleRate,
      bpm: typeof opts.bpm === "number" ? opts.bpm : undefined,
      events: Array.isArray(opts.events) ? opts.events : undefined,
    });
    if (opts.params) {
      this.proc.applyParams(opts.params);
      this.initialized = true;
    }
    if (opts.wavetables) {
      for (const entry of opts.wavetables) {
        this.proc.setWavetable(entry.slot, entry.frames, entry.frameCount);
      }
    }
    if (opts.samples) {
      for (const entry of opts.samples) {
        this.proc.setSample(entry.slot, entry.pcm, entry.rootHz);
      }
    }
  }

  handle(message) {
    if (!message || typeof message !== "object") return;
    switch (message.type) {
      case "init":
        if (message.params) this.proc.applyParams(message.params);
        if (Array.isArray(message.events)) for (const e of message.events) this.proc.postEvent(e);
        this.initialized = true;
        this.port.postMessage({ type: "ready" });
        break;
      case "param":
        this.proc.setParam(message.name, message.value);
        break;
      case "bpm":
        if (!Number.isFinite(message.bpm)) break;
        this.proc.postEvent({
          type: "bpm",
          when: typeof message.when === "number" ? message.when : currentTime,
          value: message.bpm,
        });
        break;
      case "noteOn":
      case "noteOff":
      case "pressure":
      case "panic":
        this.proc.postEvent({
          type: message.type,
          when: typeof message.when === "number" ? message.when : currentTime,
          pitch: message.pitch,
          velocity: message.velocity,
          value: message.value,
        });
        break;
      case "wavetable":
        if ((message.slot === 0 || message.slot === 1) && message.frames instanceof Float32Array) {
          this.proc.setWavetable(message.slot, message.frames, message.frameCount);
        }
        break;
      case "sample":
        if ((message.slot === 0 || message.slot === 1) && message.pcm instanceof Float32Array) {
          this.proc.setSample(message.slot, message.pcm, message.rootHz);
        }
        break;
      case "clearSource":
        if (message.slot === 0 || message.slot === 1) this.proc.clearSource(message.slot);
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
      // Stereo: render L and R into their real destination buffers.
      const right = output[1];
      const r = frames === right.length ? right : right.subarray(0, frames);
      this.proc.process(l, r, currentFrame);
    } else {
      // Mono: render both channels into scratch, fold to mono, copy back.
      const scratchL = MONO_L.subarray(0, frames);
      const scratchR = MONO_R.subarray(0, frames);
      this.proc.process(scratchL, scratchR, currentFrame);
      for (let i = 0; i < frames; i++) l[i] = (scratchL[i] + scratchR[i]) * 0.5;
    }
    return true;
  }
}

registerProcessor("tsar-processor", TsarWorkletProcessor);
