/**
 * Ultina AudioWorklet entry — bundled by scripts/build-ultina-worklet.mjs
 * into a single classic-script file (public/ultina-worklet.js) that the
 * loader feeds to AudioWorklet.addModule().
 *
 * Thin wrapper: all DSP lives in the vendored ultina-core (bit-exact with
 * the VocalForge vectors, see tests/ultina-vectors.test.ts). The wrapper
 * owns block copying, parameter messaging and latency reporting.
 */
import { UltinaProcessor } from "./ultina-core/dsp/ultinaProcessor.ts";
import { registerCoreModules } from "./ultina-core/dsp/moduleFactories.ts";
import { MODULE_TYPES } from "./ultina-core/contracts/moduleTypes.ts";

const MAX_BLOCK = 128;
const CHANNELS = 2;

class UltinaWorkletProcessor extends AudioWorkletProcessor {
  proc = new UltinaProcessor();
  scratch = [new Float32Array(MAX_BLOCK), new Float32Array(MAX_BLOCK)];
  lastLatencyPosted = -1;
  blockCount = 0;

  constructor(options) {
    super();
    registerCoreModules(this.proc);
    this.proc.prepare({
      sampleRate,
      channelCount: CHANNELS,
      maxBlockSize: MAX_BLOCK,
      qualityMode: 1, // "mix" — matches the vector harness
    });
    const initial = options?.processorOptions?.params;
    if (initial) this.proc.loadState(initial);
    this.syncGraphFromParams();
    this.postLatency();
    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === "params") {
        this.proc.loadState(msg.params);
        this.syncGraphFromParams();
        this.postLatency();
      } else if (msg.type === "param") {
        this.proc.setParameter(msg.id, msg.value);
        // Module on/off travels as a regular "<module>.enabled" param, but
        // the audio thread walks the module GRAPH — a toggle must be mirrored
        // there or the module never enters the active chain.
        if (typeof msg.id === "string" && msg.id.endsWith(".enabled")) {
          this.syncGraphFromParams();
          this.postLatency();
        }
      } else if (msg.type === "reset") {
        this.proc.reset();
      } else if (msg.type === "dispose") {
        // Node teardown: unregister from the cross-instance spectral
        // registry. AudioWorkletProcessor has no destruction hook, so this
        // message is the only signal — without it every instance ever
        // created leaks a stale registry entry for the page's lifetime.
        this.proc.dispose();
      }
    };
  }

  /** Mirror the host-facing "<module>.enabled" params into the module graph.
   * The graph boots ALL-DISABLED and nothing else syncs it — without this,
   * the active chain stays empty forever and every module (EQ/Comp/Gate/…)
   * is silent DSP while the UI happily reports it on. */
  syncGraphFromParams() {
    const graph = this.proc.getGraphRuntime();
    for (const type of MODULE_TYPES) {
      graph.setModuleEnabled(type, this.proc.getParameter(`${type}.enabled`) >= 0.5);
    }
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

    // Ultina is stereo — stage into scratch (input or silence), process
    // in place, copy back.
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
    // Meters snapshot ≈21 Hz — spectrum/LUFS/waveform/GR for the panel.
    if ((this.blockCount++ & 3) === 0) {
      this.port.postMessage({ type: "meters", meters: this.proc.getMeters() });
    }
    return true;
  }
}

registerProcessor("ultina-processor", UltinaWorkletProcessor);
