/**
 * CHORÁL runtime bridge (ADR 0054) — the tsarNode split, simplified: one
 * source (the uploaded monophonic timbre), no wavetables, no arp.
 *
 *  - LIVE: an `AudioWorkletNode("choral-processor")` created immediately;
 *    timed events relay through `port.postMessage` with absolute times.
 *  - OFFLINE: Chromium does NOT pump worklet message queues during an
 *    `OfflineAudioContext` render, so the runtime buffers every timed event
 *    and, at `prepareOfflineRender()`, creates the worklet with
 *    `processorOptions.events` (plus `harmony` + `params`) seeded — same
 *    events, same interpreter, same sound.
 */

import type { InstrumentRuntime } from "./types";
import type { InstrumentTrack } from "../project-model/types";
import type { ChoralEvent } from "../choral/dsp/choralProcessor";
import type { HarmonyContextInit } from "../effects/types";

export interface ChoralRuntime extends InstrumentRuntime {
  /** OFFLINE ONLY — build the seeded worklet and connect it into `output`. */
  prepareOfflineRender?: () => void;
  /** Project musical context (harmony stack masks); diffed before the send. */
  setHarmonyContext?: (init: HarmonyContextInit) => void;
}

export interface ChoralRuntimeOptions {
  createGain: () => GainNode;
  createNode: (processorOptions: Record<string, unknown>) => AudioWorkletNode;
  offline: boolean;
  bpm: number;
  track: InstrumentTrack;
  getSample(id: string | null): AudioBuffer | undefined;
  harmony?: HarmonyContextInit;
}

export function createChoralRuntime(options: ChoralRuntimeOptions): ChoralRuntime {
  const { offline } = options;
  const output = options.createGain();
  const pendingEvents: ChoralEvent[] = [];
  let currentTrack = { ...options.track };
  let node: AudioWorkletNode | null = null;
  let pendingHarmony: HarmonyContextInit | undefined = options.harmony;
  let harmonySig = "";
  /** The source upload is deferred to prepareOfflineRender on offline builds. */

  const connectNode = (built: AudioWorkletNode) => {
    built.connect(output);
    node = built;
  };

  const sourceUpload = (): Record<string, unknown> => {
    const buffer = currentTrack.sampleId ? options.getSample(currentTrack.sampleId) : undefined;
    const rootMidi = currentTrack.params.srcRoot ?? 60;
    if (!buffer) return {};
    return {
      pcm: new Float32Array(buffer.getChannelData(0)),
      pcmRootHz: 440 * Math.pow(2, (rootMidi - 69) / 12),
    };
  };

  if (!offline) {
    connectNode(
      options.createNode({
        params: { ...currentTrack.params },
        harmony: pendingHarmony,
        ...sourceUpload(),
      }),
    );
  }

  const forward = (event: ChoralEvent) => {
    if (node) {
      node.port.postMessage({
        type: event.type,
        when: event.when,
        pitch: event.pitch,
        velocity: event.velocity,
      });
    } else {
      pendingEvents.push(event);
    }
  };

  const runtime: ChoralRuntime = {
    output,
    noteOn(pitch, velocity, when) {
      forward({ type: "noteOn", pitch, velocity, when });
    },
    noteOff(pitch, when) {
      forward({ type: "noteOff", pitch, when });
    },
    polyPressure() {
      // v1: no per-note timbre control (ADR 0054 scope line).
    },
    setSample(id) {
      currentTrack = { ...currentTrack, sampleId: id };
      if (!node) return;
      const upload = sourceUpload();
      if (upload.pcm) node.port.postMessage({ type: "sample", ...upload });
    },
    setHarmonyContext(init) {
      if (!init || typeof init !== "object") return;
      pendingHarmony = init;
      const signature = `${init.scaleMask ?? 0xfff}:${(init.chords ?? [])
        .map((chord) => `${chord.startBar}.${chord.lengthBars}.${chord.chordMask ?? 0}`)
        .join(",")}`;
      if (signature === harmonySig) return;
      harmonySig = signature;
      if (node) node.port.postMessage({ type: "harmony", harmony: init });
      // Offline: stored in pendingHarmony and seeded at prepareOfflineRender.
    },
    setVelocityLayers() {},
    syncBpm() {
      // v1: no tempo-synced machinery (no arp/LFO).
    },
    setParameter(name, value) {
      if (!Number.isFinite(value)) return;
      currentTrack = { ...currentTrack, params: { ...currentTrack.params, [name]: value } };
      if (name === "srcRoot" && node) {
        // ROOT re-derives the source's playback reference without re-upload.
        const upload = sourceUpload();
        if (upload.pcm) node.port.postMessage({ type: "sample", ...upload });
      }
      // Params are STATE, not events: the offline seed reads
      // currentTrack.params at prepareOfflineRender, so nothing to queue.
      if (node) node.port.postMessage({ type: "param", name, value });
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
      connectNode(
        options.createNode({
          params: { ...currentTrack.params },
          events: pendingEvents.slice(),
          harmony: pendingHarmony,
          ...sourceUpload(),
        }),
      );
    };
  }

  return runtime;
}
