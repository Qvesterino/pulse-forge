import type { InstrumentRuntime } from "./types";
import type { InstrumentTrack } from "../project-model/types";
import { hashString } from "../shared/rng";

type GrainMessage = Record<string, unknown> & { type: string };

interface GrainVoiceRuntimeOptions {
  /** Stable final node exposed to AudioEngine on both live and offline paths. */
  output: GainNode;
  /** Node after the worklet, used for instrument-local tone shaping. */
  input?: AudioNode;
  createNode(processorOptions: Record<string, unknown>): AudioWorkletNode;
}

/** Initial sample/parameter state for a worklet created before offline render. */
export function grainProcessorOptions(
  track: InstrumentTrack,
  env: { bpm: number; getSample(id: string | null): AudioBuffer | undefined },
): {
  params: Record<string, number>;
  bpm: number;
  sample: { ch0: Float32Array; ch1: Float32Array | null; sampleRate: number } | null;
} {
  const buffer = track.sampleId ? env.getSample(track.sampleId) : undefined;
  const params: Record<string, number> = {};
  for (const [name, value] of Object.entries(track.params)) {
    if (typeof value === "number") params[name] = value;
  }
  return {
    params,
    bpm: env.bpm,
    sample:
      buffer && buffer.length > 0
        ? {
            ch0: buffer.getChannelData(0),
            ch1: buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null,
            sampleRate: buffer.sampleRate,
          }
        : null,
  };
}

/**
 * Worklet-backed granular runtime. Live nodes receive timed messages; offline
 * nodes receive the same sample, parameters, BPM and events in their initial
 * processor state before startRendering.
 */
export function createGrainVoiceRuntime(
  node: AudioWorkletNode | null,
  track: InstrumentTrack,
  env: { bpm: number; getSample(id: string | null): AudioBuffer | undefined },
  options?: GrainVoiceRuntimeOptions,
): InstrumentRuntime {
  if (!node && !options) throw new Error("granular runtime requires a live node or offline node factory");
  let currentTrack = track;
  let currentBpm = env.bpm;
  const pendingEvents: GrainMessage[] = [];
  const initial = grainProcessorOptions(track, env);
  let params = { ...initial.params };
  let sample = initial.sample;

  const send = (message: GrainMessage) => {
    if (node) node.port.postMessage(message);
    else pendingEvents.push(message);
  };

  const uploadSample = () => {
    const buffer = currentTrack.sampleId ? env.getSample(currentTrack.sampleId) : undefined;
    sample =
      buffer && buffer.length > 0
        ? {
            ch0: buffer.getChannelData(0),
            ch1: buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null,
            sampleRate: buffer.sampleRate,
          }
        : null;
    if (node && sample) node.port.postMessage({ type: "sample", ...sample });
  };

  if (node) {
    if (sample) node.port.postMessage({ type: "sample", ...sample });
    for (const [name, value] of Object.entries(params)) node.port.postMessage({ type: "param", name, value });
    node.port.postMessage({ type: "bpm", value: currentBpm });
    if (options) node.connect(options.input ?? options.output);
  }

  const runtime: InstrumentRuntime = {
    output: options?.output ?? node!,
    get processorNode() {
      return node ?? undefined;
    },
    noteOn(pitch, velocity, when, durationSec, _slideFrom, expression) {
      send({
        type: "noteOn",
        pitch,
        velocity,
        when,
        dur: durationSec ?? 0.5,
        pan: expression?.pan,
        releaseVelocity: expression?.releaseVelocity,
        seed: hashString(`${currentTrack.id}:${pitch}`),
      });
    },
    noteOff(pitch, when) {
      send({ type: "noteOff", pitch, when });
    },
    setSample(id) {
      currentTrack = { ...currentTrack, sampleId: id };
      uploadSample();
    },
    setVelocityLayers(layers) {
      void layers; // Keyzones/RR are sampler features.
    },
    syncBpm(bpm, when) {
      if (!Number.isFinite(bpm) || bpm <= 0) return;
      if (when !== undefined) {
        send({ type: "bpm", value: bpm, when });
        return;
      }
      currentBpm = bpm;
      if (node) node.port.postMessage({ type: "bpm", value: bpm });
    },
    setParameter(name, value, when) {
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      currentTrack = { ...currentTrack, params: { ...currentTrack.params, [name]: value } };
      if (when === undefined && !node) params[name] = value;
      send({ type: "param", name, value, ...(when !== undefined ? { when } : {}) });
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
        bpm: currentBpm,
        sample,
        events: pendingEvents.slice(),
      });
      node.connect(options.input ?? options.output);
    };
  }

  return runtime;
}
