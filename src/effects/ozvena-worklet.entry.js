/**
 * Ozvena AudioWorklet entry — bundled by scripts/build-ozvena-worklet.mjs
 * into a single classic-script file (public/ozvena-worklet.js) that the
 * loader feeds to AudioWorklet.addModule().
 *
 * Thin wrapper: all DSP lives in the vendored ozvena-core (parity-checked
 * against upstream fixtures, see tests/ozvena-golden.test.ts). The wrapper
 * owns block copying, dotted-path state updates and latency reporting.
 */
import { createOzvenaProcessor } from "./ozvena-core/core/ozvenaProcessor.ts";
import { defaultOzvenaStateV1 } from "./ozvena-core/v2/types.ts";

const MAX_BLOCK = 128;
const CHANNELS = 2;

/** Set a dotted path ("engines.e2.mix") preserving the current value's type. */
function setPath(state, id, value) {
  const parts = id.split(".");
  let node = state;
  for (let i = 0; i < parts.length - 1; i++) {
    node = node[parts[i]];
    if (!node) return;
  }
  const key = parts[parts.length - 1];
  const current = node[key];
  if (typeof current === "boolean") node[key] = value >= 0.5;
  else if (typeof current === "number") node[key] = typeof value === "number" ? value : Number(value);
  else node[key] = value;
}

class OzvenaWorkletProcessor extends AudioWorkletProcessor {
  proc = createOzvenaProcessor();
  state = defaultOzvenaStateV1();
  scratch = [new Float32Array(MAX_BLOCK), new Float32Array(MAX_BLOCK)];
  lastLatencyPosted = -1;
  blockCount = 0;

  constructor(options) {
    super();
    this.proc.prepare(sampleRate, CHANNELS, 120, MAX_BLOCK);
    const initial = options?.processorOptions?.params;
    if (initial) {
      for (const [id, value] of Object.entries(initial)) setPath(this.state, id, value);
      this.proc.loadState(this.state);
    }
    this.postLatency();
    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === "param") {
        setPath(this.state, msg.id, msg.value);
        this.proc.loadState(this.state);
        this.postLatency();
      } else if (msg.type === "reset") {
        this.state = defaultOzvenaStateV1();
        this.proc.loadState(this.state);
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
    if (!output || !output[0] || !output[1]) return true;
    const frames = Math.min(MAX_BLOCK, output[0].length);
    const input = inputs[0];

    // Ozvena is stereo and requires both channels — stage into scratch
    // (input or silence), process in place, copy back.
    for (let c = 0; c < CHANNELS; c++) {
      const buf = this.scratch[c];
      const inCh = input && input[c];
      if (inCh && inCh.length >= frames) buf.set(inCh.subarray(0, frames));
      else buf.fill(0, 0, frames);
    }
    this.proc.process(this.scratch, frames);
    for (let c = 0; c < CHANNELS; c++) {
      output[c].set(this.scratch[c].subarray(0, frames));
    }
    return true;
  }
}

registerProcessor("ozvena-processor", OzvenaWorkletProcessor);
