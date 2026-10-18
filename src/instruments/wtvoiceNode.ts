import type { InstrumentRuntime } from "./types";
import type { InstrumentTrack } from "../project-model/types";
import { buildWavetableMips, extractWavetable, FACTORY_WAVETABLES } from "./wavetables";

type WtMessage = Record<string, unknown> & { type: string };

interface WtVoiceRuntimeOptions {
  output: GainNode;
  createNode(processorOptions: Record<string, unknown>): AudioWorkletNode;
}

/**
 * Worklet-backed wavetable runtime. Live nodes receive timestamped messages;
 * offline nodes are created immediately before rendering with the same tables,
 * parameters and queued note events in processorOptions.
 */
export function createWtVoiceRuntime(
  node: AudioWorkletNode | null,
  track: InstrumentTrack,
  env: { bpm: number; getSample(id: string | null): AudioBuffer | undefined },
  options?: WtVoiceRuntimeOptions,
): InstrumentRuntime {
  if (!node && !options) throw new Error("wavetable runtime requires a live node or offline node factory");
  const port = () => node?.port;
  let currentTrack = track;
  const pendingEvents: WtMessage[] = [];
  const params = Object.fromEntries(
    Object.entries(track.params).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
  );

  /** Extract + mip-map the current table for the worklet. */
  const makeTables = () => {
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
    return { levels: mips.levels, ks: mips.ks };
  };
  let tables = makeTables();

  const send = (message: WtMessage) => {
    const currentPort = port();
    if (currentPort) currentPort.postMessage(message);
    else pendingEvents.push(message);
  };

  const uploadTables = () => {
    tables = makeTables();
    send({ type: "tables", ...tables });
  };

  // Live starts with a clean worklet snapshot. Offline state is passed once at
  // construction because OfflineAudioContext does not deliver port messages
  // while rendering.
  if (node) {
    node.port.postMessage({ type: "tables", ...tables });
    for (const [name, value] of Object.entries(params)) node.port.postMessage({ type: "param", name, value });
  }

  const output: AudioNode = options?.output ?? node!;
  if (node && options) node.connect(options.output);
  const runtime: InstrumentRuntime = {
    output,
    get processorNode() {
      return node ?? undefined;
    },
    noteOn(pitch, velocity, when, _durationSec, _slideFrom, expression) {
      send({
        type: "noteOn",
        pitch,
        velocity,
        when,
        pan: expression?.pan,
        releaseVelocity: expression?.releaseVelocity,
      });
    },
    noteOff(pitch, when) {
      send({ type: "noteOff", pitch, when });
    },
    polyPressure(pitch, pressure, when) {
      send({ type: "pressure", pitch, value: pressure, when });
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
    setParameter(name, value, when) {
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      currentTrack = { ...currentTrack, params: { ...currentTrack.params, [name]: value } };
      if (when === undefined && !node) params[name] = value;
      send({ type: "param", name, value, ...(when !== undefined ? { when } : {}) });
      if (name === "table") uploadTables();
    },
    setParameterAt(name, value, when) {
      this.setParameter(name, value, when);
    },
    panic() {
      if (node) node.port.postMessage({ type: "panic" });
      else pendingEvents.length = 0;
    },
    dispose() {
      if (node) {
        node.port.postMessage({ type: "panic" });
        node.disconnect();
        node = null;
      }
      options?.output.disconnect();
    },
  };

  if (options) {
    runtime.prepareOfflineRender = () => {
      if (node) return;
      node = options.createNode({
        params: { ...params },
        tables,
        events: pendingEvents.slice(),
      });
      node.connect(options.output);
    };
  }

  return runtime;
}
