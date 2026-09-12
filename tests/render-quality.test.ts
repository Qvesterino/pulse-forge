import { describe, expect, it } from "vitest";
import { fxeqRenderQualityBumps } from "../src/rendering/renderer";
import type { ProjectDocument } from "../src/project-model/types";

type EffectFixture = {
  id: string;
  type: "fxeq" | "ultina";
  bypassed: boolean;
  params: Record<string, number>;
};

function docWithEffects(
  effects: EffectFixture[],
): ProjectDocument {
  return { tracks: [{ id: "track-1", effects }] } as unknown as ProjectDocument;
}

describe("PRISM offline render quality", () => {
  it("bumps active PRISM bands to render quality without touching the document", () => {
    const effects: EffectFixture[] = [
      { id: "prism", type: "fxeq" as const, bypassed: false, params: { bandCount: 3, "band1.quality": 0 } },
      { id: "bypassed", type: "fxeq" as const, bypassed: true, params: { bandCount: 6 } },
      { id: "vlyx", type: "ultina" as const, bypassed: false, params: {} },
    ];
    const doc = docWithEffects(effects);

    expect(fxeqRenderQualityBumps(doc)).toEqual([
      { trackId: "track-1", fxId: "prism", paramId: "band1.quality", value: 3 },
      { trackId: "track-1", fxId: "prism", paramId: "band2.quality", value: 3 },
      { trackId: "track-1", fxId: "prism", paramId: "band3.quality", value: 3 },
    ]);
    expect(effects[0].params["band1.quality"]).toBe(0);
  });

  it("uses the six-band default for malformed band counts", () => {
    const doc = docWithEffects([
      { id: "prism", type: "fxeq", bypassed: false, params: { bandCount: Number.NaN } },
    ]);
    expect(fxeqRenderQualityBumps(doc)).toHaveLength(6);
  });
});
