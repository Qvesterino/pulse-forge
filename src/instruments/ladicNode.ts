/**
 * LADIČ runtime bridge (ADR 0055) — the choralNode split, simpler still:
 * no sample, no harmony, no bpm. Live = port messages; offline = the
 * `processorOptions.events` seed (Chromium does not pump worklet message
 * queues during an OfflineAudioContext render).
 */

import type { InstrumentRuntime } from "./types";
import type { InstrumentTrack } from "../project-model/types";
import type { LadicEvent } from "../ladic/dsp/ladicProcessor";

export interface LadicRuntime extends InstrumentRuntime {
  /** OFFLINE ONLY — build the seeded worklet and connect it into `output`. */
  prepareOfflineRender?: () => void;
}

export interface LadicRuntimeOptions {
  createGain: () => GainNode;
  createNode: (processorOptions: Record<string, unknown>) => AudioWorkletNode;
  offline: boolean;
  track: InstrumentTrack;
}

export function createLadicRuntime(options: LadicRuntimeOptions): LadicRuntime {
  const { offline } = options;
  const output = options.createGain();
  const pendingEvents: LadicEvent[] = [];
  let currentTrack = { ...options.track };
  let node: AudioWorkletNode | null = null;

  const connectNode = (built: AudioWorkletNode) => {
    built.connect(output);
    node = built;
  };

  if (!offline) {
    connectNode(options.createNode({ params: { ...currentTrack.params } }));
  }

  const forward = (event: LadicEvent) => {
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

  const runtime: LadicRuntime = {
    output,
    noteOn(pitch, velocity, when) {
      forward({ type: "noteOn", pitch, velocity, when });
    },
    noteOff(pitch, when) {
      forward({ type: "noteOff", pitch, when });
    },
    polyPressure() {
      // v1: no per-note timbre control (ADR 0055 scope line).
    },
    setSample() {
      // LADIČ is fully synthesized; the sample seam is inert.
    },
    setVelocityLayers() {},
    syncBpm() {
      // v1: no tempo-synced machinery.
    },
    setParameter(name, value) {
      if (!Number.isFinite(value)) return;
      currentTrack = { ...currentTrack, params: { ...currentTrack.params, [name]: value } };
      // Params are STATE, not events: the offline seed reads
      // currentTrack.params at prepareOfflineRender.
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
      connectNode(options.createNode({ params: { ...currentTrack.params }, events: pendingEvents.slice() }));
    };
  }

  return runtime;
}
