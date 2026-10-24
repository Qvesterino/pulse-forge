/**
 * ŠTRK runtime bridge (ADR 0060) — the kopaNode split: live = port
 * messages; offline = the `processorOptions.events` seed.
 */

import type { InstrumentRuntime } from "./types";
import type { InstrumentTrack } from "../project-model/types";
import type { CinkEvent } from "../cink/dsp/cinkProcessor";

export interface CinkRuntime extends InstrumentRuntime {
  prepareOfflineRender?: () => void;
}

export interface CinkRuntimeOptions {
  createGain: () => GainNode;
  createNode: (processorOptions: Record<string, unknown>) => AudioWorkletNode;
  offline: boolean;
  track: InstrumentTrack;
}

export function createCinkRuntime(options: CinkRuntimeOptions): CinkRuntime {
  const { offline } = options;
  const output = options.createGain();
  const pendingEvents: CinkEvent[] = [];
  let currentTrack = { ...options.track };
  let node: AudioWorkletNode | null = null;

  const connectNode = (built: AudioWorkletNode) => {
    built.connect(output);
    node = built;
  };

  if (!offline) {
    connectNode(options.createNode({ params: { ...currentTrack.params } }));
  }

  const forward = (event: CinkEvent) => {
    if (node) {
      node.port.postMessage({ type: event.type, when: event.when, pitch: event.pitch, velocity: event.velocity });
    } else {
      pendingEvents.push(event);
    }
  };

  const runtime: CinkRuntime = {
    output,
    noteOn(pitch, velocity, when) {
      forward({ type: "noteOn", pitch, velocity, when });
    },
    noteOff(pitch, when) {
      forward({ type: "noteOff", pitch, when });
    },
    polyPressure() {},
    setSample() {},
    setVelocityLayers() {},
    syncBpm() {},
    setParameter(name, value) {
      if (!Number.isFinite(value)) return;
      currentTrack = { ...currentTrack, params: { ...currentTrack.params, [name]: value } };
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
