/**
 * TSAR runtime bridge (docs/TSAR-ROADMAP.md T1/T5, ADR 0023).
 *
 * Two paths, ONE engine:
 *
 *  - LIVE: an `AudioWorkletNode("tsar-processor")` is created immediately,
 *    its output connects to the track input, and timed events relay through
 *    `port.postMessage` with absolute context times.
 *
 *  - OFFLINE: Chromium does NOT pump worklet message queues during an
 *    `OfflineAudioContext` render — port messages sent before
 *    `startRendering()` surface only after the buffer is done (the wtvoice
 *    silent-export defect). This runtime therefore BUFFERS every timed event
 *    while the renderer schedules notes and, at `prepareOfflineRender()`,
 *    creates the worklet node with `processorOptions.events` seeded. Same
 *    events, same interpreter, same sound (invariant #3).
 *
 * Graph shape is identical on both paths: `output` is a GainNode that the
 * engine connects to the track input. Live, the worklet connects into
 * `output` at build time. Offline, `output` stays silent until the renderer
 * calls `prepareOfflineRender()`, which builds the worklet (seeded with the
 * buffered events) and connects it into `output` — before `startRendering`,
 * so the very first sample renders.
 *
 * Source data: slot A reads `track.sampleId`, slot B `track.sampleIdB`. Each
 * slot uploads BOTH a wavetable (mip level 0 frames) and raw PCM, so the
 * `srcAEngine`/`srcBEngine` params can flip at runtime with no re-upload.
 */

import type { InstrumentRuntime } from "./types";
import type { InstrumentTrack } from "../project-model/types";
import { buildWavetableMips, extractWavetable, FACTORY_WAVETABLES, FRAME_SIZE } from "./wavetables";
import type { TsarEvent } from "../tsar/dsp/tsarProcessor";

export interface TsarRuntime extends InstrumentRuntime {
  /** OFFLINE ONLY — build the seeded worklet and connect it into `output`. */
  prepareOfflineRender?: () => void;
  /** Second source identity (Source B); mirrors `setSample` for slot A. */
  setSampleB?: (id: string | null) => void;
}

export interface TsarRuntimeOptions {
  /** The context's `createGain`/`AudioWorkletNode` access (never a raw ctx import). */
  createGain: () => GainNode;
  createNode: (processorOptions: Record<string, unknown>) => AudioWorkletNode;
  offline: boolean;
  track: InstrumentTrack;
  getSample(id: string | null): AudioBuffer | undefined;
}

interface SlotUpload {
  wavetable: { slot: 0 | 1; frames: Float32Array; frameCount: number };
  sample: { slot: 0 | 1; pcm: Float32Array; rootHz: number };
}

/** Flatten a mip level's frames (Float32Array[]) into one contiguous buffer. */
function flattenFrames(frames: Float32Array[], frameSize: number): Float32Array {
  const flat = new Float32Array(frames.length * frameSize);
  for (let f = 0; f < frames.length; f++) flat.set(frames[f]!, f * frameSize);
  return flat;
}

export function createTsarRuntime(options: TsarRuntimeOptions): TsarRuntime {
  const { offline, getSample } = options;
  const output = options.createGain();
  const pendingEvents: TsarEvent[] = [];
  let currentTrack = { ...options.track };
  let node: AudioWorkletNode | null = null;

  /** Root frequency per slot: the per-slot ROOT param is the real contract. */
  const rootHzFor = (slot: 0 | 1): number => {
    const midi = (slot === 0 ? currentTrack.params.srcARoot : currentTrack.params.srcBRoot) ?? 60;
    return 440 * Math.pow(2, ((Number.isFinite(midi) ? midi : 60) - 69) / 12);
  };

  const uploadFor = (slot: 0 | 1, sampleId: string | null): SlotUpload | null => {
    const buffer = sampleId ? getSample(sampleId) : undefined;
    if (!buffer) return null;
    const pcm = buffer.getChannelData(0);
    const table = extractWavetable(pcm, buffer.sampleRate) ?? FACTORY_WAVETABLES[0]!;
    const mips = buildWavetableMips(table.frames);
    return {
      wavetable: {
        slot,
        frames: flattenFrames(mips.levels[0] ?? table.frames, FRAME_SIZE),
        frameCount: table.frames.length,
      },
      sample: { slot, pcm: new Float32Array(pcm), rootHz: rootHzFor(slot) },
    };
  };

  const uploadAll = () =>
    [uploadFor(0, currentTrack.sampleId), uploadFor(1, currentTrack.sampleIdB ?? null)].filter(
      (u): u is SlotUpload => u !== null,
    );

  /** Param snapshot the engine pushed at build time. */
  const paramsSnapshot = (): Record<string, number> => ({ ...currentTrack.params });

  const connectNode = (built: AudioWorkletNode) => {
    built.connect(output);
    node = built;
  };

  if (!offline) {
    const uploads = uploadAll();
    connectNode(
      options.createNode({
        params: paramsSnapshot(),
        wavetables: uploads.map((u) => u.wavetable),
        samples: uploads.map((u) => u.sample),
      }),
    );
  }

  const forward = (event: TsarEvent) => {
    if (node) {
      node.port.postMessage({
        type: event.type,
        when: event.when,
        pitch: event.pitch,
        velocity: event.velocity,
        value: event.value,
        name: event.name,
      });
    } else {
      pendingEvents.push(event);
    }
  };

  const runtime: TsarRuntime = {
    output,
    noteOn(pitch, velocity, when) {
      forward({ type: "noteOn", pitch, velocity, when });
    },
    noteOff(pitch, when) {
      forward({ type: "noteOff", pitch, when });
    },
    polyPressure(pitch, pressure, when) {
      forward({ type: "pressure", pitch, when, value: pressure });
    },
    setSample(id) {
      currentTrack = { ...currentTrack, sampleId: id };
      if (!node) return;
      const upload = uploadFor(0, id);
      if (upload) {
        node.port.postMessage({ type: "wavetable", ...upload.wavetable });
        node.port.postMessage({ type: "sample", ...upload.sample });
      }
    },
    setSampleB(id) {
      currentTrack = { ...currentTrack, sampleIdB: id };
      if (!node) return;
      const upload = uploadFor(1, id);
      if (upload) {
        node.port.postMessage({ type: "wavetable", ...upload.wavetable });
        node.port.postMessage({ type: "sample", ...upload.sample });
      }
    },
    setVelocityLayers() {
      // Keyzones / round-robin are sampler features, not TSAR.
    },
    syncBpm() {
      // The tempo-synced LFO lives in the worklet; nothing to rescale here.
    },
    setParameter(name, value) {
      if (!Number.isFinite(value)) return;
      currentTrack = { ...currentTrack, params: { ...currentTrack.params, [name]: value } };
      if (node) {
        node.port.postMessage({ type: "param", name, value });
        // ROOT changes re-derive the slot's PCM root without re-uploading.
        if (name === "srcARoot" || name === "srcBRoot") {
          const slot: 0 | 1 = name === "srcARoot" ? 0 : 1;
          const upload = uploadFor(slot, slot === 0 ? currentTrack.sampleId : (currentTrack.sampleIdB ?? null));
          if (upload) node.port.postMessage({ type: "sample", ...upload.sample });
        }
      } else {
        pendingEvents.push({ type: "param", when: 0, name, value });
      }
    },
    panic() {
      forward({ type: "panic", when: 0 });
      if (!node) pendingEvents.push({ type: "panic", when: 0 });
    },
    dispose() {
      if (node) {
        node.port.postMessage({ type: "panic" });
        node.disconnect();
      }
      output.disconnect();
      node = null;
    },
  };

  if (offline) {
    runtime.prepareOfflineRender = () => {
      if (node) return;
      const uploads = uploadAll();
      connectNode(
        options.createNode({
          params: paramsSnapshot(),
          events: pendingEvents.slice(),
          wavetables: uploads.map((u) => u.wavetable),
          samples: uploads.map((u) => u.sample),
        }),
      );
    };
  }

  return runtime;
}
