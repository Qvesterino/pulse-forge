import { describe, expect, it } from "vitest";
import { AudioEngine } from "../src/audio-engine/AudioEngine";

/**
 * THE MASTER CHAIN IS PART OF THE BROADCAST.
 *
 * The engine pushes two facts to every effect runtime it owns: the effective
 * tempo (syncBpm) and the transport start (onTransportStarted). Track, group
 * and return chains were in the sweep — the MASTER chain was not. So a
 * tempo-synced effect on the master bus (a SYNC delay) kept the BPM it was
 * built with after a project/scene tempo change, and a phase-locked effect on
 * the master bus started out of phase with the transport for the whole play.
 *
 * The master chain is a chain like any other; leaving it out of the broadcast
 * is a boundary defect, not a design decision.
 *
 * The probe runtime is injected into the engine's master chain because the
 * real chain needs a worklet (unavailable in jsdom). The assertion is about
 * the BROADCAST — the master runtime must receive the same events the track
 * runtimes receive.
 */

interface ProbeRuntime {
  syncBpm?: (bpm: number, when?: number) => void;
  onTransportStarted?: (time: number, beatPhase: number, positionBeats: number) => void;
}

interface EngineInternals {
  masterFx: { runtimes: Map<string, ProbeRuntime> };
  trackNodes: Map<string, { fx: { runtimes: Map<string, ProbeRuntime> } }>;
}

function probe(): { calls: string[]; engine: AudioEngine; internals: EngineInternals } {
  const engine = new AudioEngine();
  const internals = engine as unknown as EngineInternals;
  const calls: string[] = [];
  internals.masterFx.runtimes.set("probe-master", {
    syncBpm: (bpm) => calls.push(`master:sync:${bpm}`),
    onTransportStarted: () => calls.push("master:started"),
  });
  return { calls, engine, internals };
}

describe("the master chain receives the tempo and the transport start", () => {
  it("a tempo push reaches the master chain's runtime", () => {
    const { calls, engine } = probe();
    engine.setEffectiveBpm(140);
    expect(calls, "the master chain must be told about the tempo change").toContain("master:sync:140");
  });

  it("a transport start reaches the master chain's runtime", () => {
    const { calls, engine } = probe();
    engine.transportStarted(0, 0);
    expect(calls, "the master chain must be re-anchored to the transport").toContain("master:started");
  });

  it("the master chain is broadcast to exactly like a track chain", () => {
    const { calls, engine, internals } = probe();
    internals.trackNodes.set("probe-track", {
      fx: {
        runtimes: new Map<string, ProbeRuntime>([
          ["probe-track", { syncBpm: (bpm) => calls.push(`track:sync:${bpm}`) }],
        ]),
      },
    });

    engine.setEffectiveBpm(90);
    expect(calls, "a track chain gets the tempo").toContain("track:sync:90");
    expect(calls, "the master chain gets the same tempo").toContain("master:sync:90");
  });
});
