import { describe, expect, it } from "vitest";
import { AudioEngine } from "../src/audio-engine/AudioEngine";

describe("AudioEngine channel meter snapshots", () => {
  it("treats a sidechain source change as a different FX graph", () => {
    const engine = new AudioEngine();
    const signature = (
      engine as unknown as {
        fxSignature: (
          effects: Array<{ id: string; type: string; bypassed: boolean; sidechainTrackId?: string }>,
        ) => string;
      }
    ).fxSignature;
    const base = { id: "fx-prism", type: "fxeq", bypassed: false };
    expect(signature([{ ...base, sidechainTrackId: "kick" }])).not.toBe(
      signature([{ ...base, sidechainTrackId: "snare" }]),
    );
    expect(signature([{ ...base, sidechainTrackId: "kick" }])).toBe(signature([{ ...base, sidechainTrackId: "kick" }]));
  });

  it("keeps a clipped peak visible instead of hiding it behind the 0..1 level clamp", () => {
    const engine = new AudioEngine();
    const analyser = {
      getFloatTimeDomainData: (buffer: Float32Array) => {
        buffer[0] = 1.12;
      },
    };
    (engine as unknown as { trackNodes: Map<string, unknown> }).trackNodes.set("track-1", { analyser });

    const snapshot = engine.getTrackMeterSnapshot("track-1");
    expect(snapshot.level).toBe(1);
    expect(snapshot.peakDb).toBeCloseTo(0.984, 3);
    expect(snapshot.clipping).toBe(true);
  });

  it("returns a quiet, non-clipping snapshot when a channel is not built yet", () => {
    const engine = new AudioEngine();

    expect(engine.getReturnMeterSnapshot("missing-return")).toEqual({ level: 0, peakDb: -120, clipping: false });
  });
});
