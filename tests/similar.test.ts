import { describe, expect, it } from "vitest";
import { rankSimilarPresets } from "../src/presets/similar";
import { defaultInstrumentParams } from "../src/instruments/registry";
import type { InstrumentPreset } from "../src/presets/types";
import type { InstrumentTrack } from "../src/project-model/types";

function preset(id: string, params: Record<string, number>): InstrumentPreset {
  return {
    id,
    name: id,
    instrument: "analog",
    genre: "house",
    mood: ["warm"],
    tags: [],
    params,
  };
}

function track(params: Record<string, number>, presetId: string | null = null): InstrumentTrack {
  return {
    id: "t",
    kind: "instrument",
    instrument: "analog",
    name: "T",
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    sampleId: null,
    params: { ...defaultInstrumentParams("analog"), ...params },
    effects: [],
    sends: {},
    presetId,
  };
}

describe("rankSimilarPresets", () => {
  it("ranks identical params first and orders by distance", () => {
    const candidates = [
      preset("far", { cutoff: 300, oscA: 0 }),
      preset("near", { cutoff: 8900, oscA: 2 }),
      preset("mid", { cutoff: 5000, oscA: 1 }),
    ];
    const t = track({ cutoff: 9000, oscA: 2 });
    const ranked = rankSimilarPresets(candidates, t);
    expect(ranked[0].preset.id).toBe("near");
    expect(ranked[0].similarity).toBeGreaterThan(ranked[1].similarity);
    expect(ranked.map((r) => r.preset.id)).toEqual(["near", "mid", "far"]);
  });

  it("identical params give similarity 1 and the current preset is excluded", () => {
    const candidates = [preset("self", { cutoff: 9000 }), preset("twin", { cutoff: 9000 })];
    const t = track({ cutoff: 9000 }, "self");
    const ranked = rankSimilarPresets(candidates, t);
    expect(ranked.length).toBe(1);
    expect(ranked[0].preset.id).toBe("twin");
    expect(ranked[0].similarity).toBeCloseTo(1, 5);
  });

  it("skips other instruments and sparse presets default to instrument defaults", () => {
    const other: InstrumentPreset = { ...preset("keys-x", {}), instrument: "keys" };
    const sparse = preset("sparse", {}); // all defaults
    const t = track({ cutoff: 9000 });
    const ranked = rankSimilarPresets([other, sparse], t);
    expect(ranked.length).toBe(1);
    expect(ranked[0].preset.id).toBe("sparse");
    // sparse = all defaults; the track only moved cutoff → high similarity
    expect(ranked[0].similarity).toBeGreaterThan(0.8);
  });

  it("is deterministic on ties (id order) and respects the limit", () => {
    const candidates = [
      preset("b-tie", { cutoff: 2000 }),
      preset("a-tie", { cutoff: 2000 }),
      preset("c", { cutoff: 3000 }),
    ];
    const t = track({ cutoff: 2000 });
    const ranked = rankSimilarPresets(candidates, t, 2);
    expect(ranked.map((r) => r.preset.id)).toEqual(["a-tie", "b-tie"]);
  });
});
