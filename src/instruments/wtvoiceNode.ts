import type { InstrumentRuntime } from "./types";
import type { InstrumentTrack } from "../project-model/types";
import { buildWavetableMips, extractWavetable, FACTORY_WAVETABLES } from "./wavetables";

/**
 * Worklet-backed wavetable runtime (Phase-2 voice-engine pilot).
 *
 * The whole voice runs per-sample inside `wtvoice-processor`; this wrapper is
 * only a message bridge: table uploads on create/sample/table changes, and
 * note/param/pressure events relayed with their absolute times. The worklet
 * owns polyphony (8 voices, oldest-steal), the amp envelope, the mod matrix
 * and the scan engine — all per-sample, deterministic.
 */
export function createWtVoiceRuntime(
  node: AudioWorkletNode,
  track: InstrumentTrack,
  env: { bpm: number; getSample(id: string | null): AudioBuffer | undefined },
): InstrumentRuntime {
  const port = node.port;
  let currentTrack = track;

  /** Extract + mip-map the current table and upload it to the worklet. */
  const uploadTables = () => {
    let table = null;
    if (currentTrack.sampleId) {
      const buffer = env.getSample(currentTrack.sampleId);
      if (buffer) table = extractWavetable(buffer.getChannelData(0), buffer.sampleRate);
    }
    if (!table) {
      const count = FACTORY_WAVETABLES.length;
      table = FACTORY_WAVETABLES[((Math.round(currentTrack.params.table ?? 0) % count) + count) % count];
    }
    const mips = buildWavetableMips(table.frames);
    port.postMessage({
      type: "tables",
      levels: mips.levels,
      ks: mips.ks,
    });
  };
  uploadTables();

  const setParam = (name: string, value: number) => port.postMessage({ type: "param", name, value });

  // Push the initial parameter snapshot so the first note uses track values.
  for (const [name, value] of Object.entries(track.params)) {
    if (typeof value === "number") setParam(name, value);
  }

  const runtime: InstrumentRuntime = {
    output: node,
    noteOn(pitch, velocity, when) {
      port.postMessage({ type: "noteOn", pitch, velocity, when });
    },
    noteOff(pitch, when) {
      port.postMessage({ type: "noteOff", pitch, when });
    },
    polyPressure(pitch, pressure, when) {
      void when;
      port.postMessage({ type: "pressure", pitch, value: pressure });
    },
    setSample(id) {
      currentTrack = { ...currentTrack, sampleId: id };
      uploadTables();
    },
    setVelocityLayers(layers) {
      void layers; // keyzones/RR are sampler features
    },
    syncBpm() {
      // BPM-synced modulation lives in the per-voice LFO; nothing to rescale.
    },
    setParameter(name, value) {
      // Numeric params relay straight through; table changes re-upload.
      if (typeof value === "number") {
        setParam(name, value);
        if (name === "table") uploadTables();
      }
    },
    panic() {
      port.postMessage({ type: "panic" });
    },
    dispose() {
      port.postMessage({ type: "panic" });
      node.disconnect();
    },
  };
  return runtime;
}
