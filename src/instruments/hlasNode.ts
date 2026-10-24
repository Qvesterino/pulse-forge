/**
 * HĽAS runtime bridge (ADR 0059) — the choralNode split, simplest of all:
 * no sample, no harmony, no bpm. Live = port messages; offline = the
 * `processorOptions.events` seed (Chromium does not pump worklet message
 * queues during an OfflineAudioContext render).
 *
 * The MPE surface is the instrument: `polyTimbre` carries the vowel morph
 * override and `polyPressure` the breath override, both relayed INSIDE the
 * noteOn event (they are per-note constants for the note's lifetime in v1).
 */

import type { InstrumentRuntime } from "./types";
import type { InstrumentTrack } from "../project-model/types";
import type { HlasEvent } from "../hlas/dsp/hlasProcessor";

export interface HlasRuntime extends InstrumentRuntime {
  /** OFFLINE ONLY — build the seeded worklet and connect it into `output`. */
  prepareOfflineRender?: () => void;
}

export interface HlasRuntimeOptions {
  createGain: () => GainNode;
  createNode: (processorOptions: Record<string, unknown>) => AudioWorkletNode;
  offline: boolean;
  track: InstrumentTrack;
}

export function createHlasRuntime(options: HlasRuntimeOptions): HlasRuntime {
  const { offline } = options;
  const output = options.createGain();
  const pendingEvents: HlasEvent[] = [];
  let currentTrack = { ...options.track };
  let node: AudioWorkletNode | null = null;

  const connectNode = (built: AudioWorkletNode) => {
    built.connect(output);
    node = built;
  };

  if (!offline) {
    connectNode(options.createNode({ params: { ...currentTrack.params } }));
  }

  const forward = (event: HlasEvent) => {
    if (node) {
      node.port.postMessage({
        type: event.type,
        when: event.when,
        pitch: event.pitch,
        velocity: event.velocity,
        timbre: event.timbre,
        pressure: event.pressure,
      });
    } else {
      pendingEvents.push(event);
    }
  };

  const runtime: HlasRuntime = {
    output,
    noteOn(pitch, velocity, when) {
      forward({ type: "noteOn", pitch, velocity, when });
    },
    noteOff(pitch, when) {
      forward({ type: "noteOff", pitch, when });
    },
    /** MPE timbre → the vowel morph for THIS note, live (no re-attack). */
    polyTimbre(pitch, timbre) {
      forward({ type: "timbre", pitch, timbre: clamp01(timbre), when: 0 });
    },
    /** MPE pressure → the breath for THIS note, live (no re-attack). */
    polyPressure(pitch, pressure) {
      forward({ type: "breath", pitch, pressure: clamp01(pressure), when: 0 });
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
  return clamp(v, 0, 1);
}
function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
