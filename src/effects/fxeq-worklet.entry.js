/**
 * FXEQ AudioWorklet entry — bundled by scripts/build-fxeq-worklet.mjs into a
 * single classic-script file (public/fxeq-worklet.js) that the loader feeds
 * to AudioWorklet.addModule().
 *
 * Thin wrapper: all DSP lives in the vendored fxeq-core (bit-exact with the
 * VocalForge oracle, see tests/fxeq-golden.test.ts). The wrapper owns only
 * the worklet plumbing — block copying and parameter messaging.
 */
import { createFxEqProcessor } from "./fxeq-core/core/fxEqProcessor.ts";

const MAX_BLOCK = 128;
const CHANNELS = 2;

class FxEqWorkletProcessor extends AudioWorkletProcessor {
  // `proc` never allocates inside process() — scratch is preallocated in prepare().
  proc = createFxEqProcessor();
  /** Processing scratch (in-place DSP), copied to/from the graph buffers. */
  scratch = [new Float32Array(MAX_BLOCK), new Float32Array(MAX_BLOCK)];

  constructor(options) {
    super();
    this.proc.prepare(sampleRate, CHANNELS, MAX_BLOCK);
    this.lastLatencyPosted = -1;
    const initial = options?.processorOptions?.params;
    if (initial) this.proc.loadParameters(initial);
    // Report DSP latency (oversampled bands add delay) so the host's PDC
    // can compensate — sent on init and whenever params change it.
    this.postLatency();
    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === "params") {
        this.proc.loadParameters(msg.params);
        this.postLatency();
      } else if (msg.type === "param") {
        this.proc.setParameter(msg.id, msg.value);
        this.postLatency();
      } else if (msg.type === "reset") {
        this.proc.reset();
      }
    };
  }

  postLatency() {
    const samples = this.proc.getLatencySamples();
    if (samples !== this.lastLatencyPosted) {
      this.lastLatencyPosted = samples;
      this.port.postMessage({ type: "latency", samples });
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const frames = Math.min(MAX_BLOCK, output[0].length);
    const input = inputs[0];

    // Stage the block into scratch (input or silence), process in place,
    // copy back. Deterministic regardless of how the host wires channels.
    for (let c = 0; c < CHANNELS; c++) {
      const buf = this.scratch[c];
      const inCh = input?.[c];
      if (inCh && inCh.length >= frames) buf.set(inCh.subarray(0, frames));
      else buf.fill(0, 0, frames);
    }
    this.proc.process(this.scratch, frames);
    for (let c = 0; c < CHANNELS; c++) {
      const outCh = output[c];
      if (outCh) outCh.set(this.scratch[c].subarray(0, frames));
    }
    return true;
  }
}

registerProcessor("fxeq-processor", FxEqWorkletProcessor);
