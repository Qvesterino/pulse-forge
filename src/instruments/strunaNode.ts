/**
 * STRUNA runtime bridge (ADR 0061) — live = port messages; offline = the
 * `processorOptions.events` seed. The MPE surface (pressure → brightness,
 * timbre → pick position) relays as dedicated live events.
 */

import type { InstrumentRuntime } from "./types";
import type { InstrumentTrack } from "../project-model/types";
import type { StrunaEvent } from "../struna/dsp/strunaProcessor";

export interface StrunaRuntime extends InstrumentRuntime {
  prepareOfflineRender?: () => void;
}

export interface StrunaRuntimeOptions {
  createGain: () => GainNode;
  createNode: (processorOptions: Record<string, unknown>) => AudioWorkletNode;
  offline: boolean;
  track: InstrumentTrack;
}

export function createStrunaRuntime(options: StrunaRuntimeOptions): StrunaRuntime {
  const { offline } = options;
  const output = options.createGain();
  const pendingEvents: StrunaEvent[] = [];
  let currentTrack = { ...options.track };
  let node: AudioWorkletNode | null = null;

  const connectNode = (built: AudioWorkletNode) => {
    built.connect(output);
    node = built;
  };

  if (!offline) {
    connectNode(options.createNode({ params: { ...currentTrack.params } }));
  }

  const forward = (event: StrunaEvent) => {
    if (node) {
      node.port.postMessage({
        type: event.type,
        when: event.when,
        pitch: event.pitch,
        velocity: event.velocity,
        value: event.value,
      });
    } else {
      pendingEvents.push(event);
    }
  };

  const runtime: StrunaRuntime = {
    output,
    noteOn(pitch, velocity, when) {
      forward({ type: "noteOn", pitch, velocity, when });
    },
    noteOff(pitch, when) {
      forward({ type: "noteOff", pitch, when });
    },
    /** MPE pressure → loop brightness for THIS note, live. */
    polyPressure(pitch, pressure) {
      forward({ type: "bright", pitch, value: clamp01(pressure), when: 0 });
    },
    /** MPE timbre → pick position for THIS note, live. */
    polyTimbre(pitch, timbre) {
      forward({ type: "pick", pitch, value: clamp01(timbre), when: 0 });
    },
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

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
