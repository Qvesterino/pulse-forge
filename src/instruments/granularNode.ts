import type { InstrumentRuntime } from "./types";
import type { InstrumentTrack } from "../project-model/types";
import { hashString } from "../shared/rng";

/**
 * Initial worklet state for `new AudioWorkletNode(..., { processorOptions })`.
 * Offline renders never deliver port messages during the render (they land
 * after it), so the sample, params and bpm the first note needs must be
 * constructor state. Live updates keep flowing through the port.
 */
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
 * Worklet-backed granular runtime (Phase-2 voice-engine track, sibling of
 * wtvoiceNode). The whole granular voice runs per-sample inside
 * `granular-voice-processor`; this wrapper is only a message bridge: sample
 * upload on create/sample changes, note/param/bpm events relayed with their
 * absolute times. The worklet owns polyphony (6 voices, oldest-steal), the
 * grain scheduler and the LIVE PLAYHEAD — POSITION/SCAN/JITTER/RATE/SIZE
 * are read at every grain spawn, so dragging them mid-note steers the cloud
 * (the main-thread fallback cloud captures params at noteOn).
 */
export function createGrainVoiceRuntime(
  node: AudioWorkletNode,
  track: InstrumentTrack,
  env: { bpm: number; getSample(id: string | null): AudioBuffer | undefined },
): InstrumentRuntime {
  const port = node.port;
  let currentTrack = track;

  /** Upload the current sample to the worklet (mono or stereo channel data). */
  const uploadSample = () => {
    const buffer = currentTrack.sampleId ? env.getSample(currentTrack.sampleId) : undefined;
    if (!buffer || buffer.length === 0) return;
    port.postMessage({
      type: "sample",
      ch0: buffer.getChannelData(0),
      ch1: buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null,
      length: buffer.length,
      sampleRate: buffer.sampleRate,
    });
  };
  uploadSample();

  const setParam = (name: string, value: number) => port.postMessage({ type: "param", name, value });

  // Push the initial parameter snapshot so the first note uses track values.
  for (const [name, value] of Object.entries(track.params)) {
    if (typeof value === "number") setParam(name, value);
  }
  port.postMessage({ type: "bpm", value: env.bpm });

  const runtime: InstrumentRuntime = {
    output: node,
    noteOn(pitch, velocity, when, durationSec) {
      // Same PRNG seed contract as the fallback cloud: trackId:pitch.
      port.postMessage({
        type: "noteOn",
        pitch,
        velocity,
        when,
        dur: durationSec ?? 0.5,
        seed: hashString(`${currentTrack.id}:${pitch}`),
      });
    },
    noteOff(pitch, when) {
      port.postMessage({ type: "noteOff", pitch, when });
    },
    setSample(id) {
      currentTrack = { ...currentTrack, sampleId: id };
      uploadSample();
    },
    setVelocityLayers(layers) {
      void layers; // keyzones/RR are sampler features
    },
    syncBpm(bpm) {
      port.postMessage({ type: "bpm", value: bpm });
    },
    setParameter(name, value) {
      if (typeof value === "number") setParam(name, value);
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
