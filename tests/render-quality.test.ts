import { describe, expect, it } from "vitest";
import {
  fxeqRenderQualityBumps,
  ozvenaRenderQualityBumps,
  renderQualityBumps,
  resolveRenderQuality,
} from "../src/rendering/renderer";
import type { ProjectDocument } from "../src/project-model/types";

type EffectFixture = {
  id: string;
  type: "fxeq" | "ultina";
  bypassed: boolean;
  params: Record<string, number>;
};

function docWithEffects(effects: EffectFixture[]): ProjectDocument {
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
    const doc = docWithEffects([{ id: "prism", type: "fxeq", bypassed: false, params: { bandCount: Number.NaN } }]);
    expect(fxeqRenderQualityBumps(doc)).toHaveLength(6);
  });
});

describe("global Live/Export quality switch", () => {
  it("studio enables both plugins, live enables neither", () => {
    expect(resolveRenderQuality({ quality: "studio" })).toEqual({ fxeq: true, ozvena: true });
    expect(resolveRenderQuality({ quality: "live" })).toEqual({ fxeq: false, ozvena: false });
  });

  it("the global switch wins over legacy per-plugin flags", () => {
    expect(resolveRenderQuality({ quality: "live", fxeqRenderQuality: true, ozvenaRenderQuality: true })).toEqual({
      fxeq: false,
      ozvena: false,
    });
    expect(resolveRenderQuality({ quality: "studio", fxeqRenderQuality: false })).toEqual({
      fxeq: true,
      ozvena: true,
    });
  });

  it("legacy flags keep working when the switch is absent (default: live tier)", () => {
    expect(resolveRenderQuality({})).toEqual({ fxeq: false, ozvena: false });
    expect(resolveRenderQuality({ fxeqRenderQuality: true })).toEqual({ fxeq: true, ozvena: false });
    expect(resolveRenderQuality({ ozvenaRenderQuality: true })).toEqual({ fxeq: false, ozvena: true });
  });

  it("unified bumps cover PRISM bands and default-tier VØID", () => {
    const doc = {
      tracks: [
        {
          id: "t",
          effects: [
            { id: "prism", type: "fxeq", bypassed: false, params: { bandCount: 2 } },
            { id: "void", type: "ozvena", bypassed: false, params: {} },
            { id: "eco", type: "ozvena", bypassed: false, params: { "global.quality": 0 } },
          ],
        },
      ],
      returns: [],
    } as unknown as ProjectDocument;
    expect(renderQualityBumps(doc)).toEqual([
      { trackId: "t", fxId: "prism", paramId: "band1.quality", value: 3 },
      { trackId: "t", fxId: "prism", paramId: "band2.quality", value: 3 },
      { trackId: "t", fxId: "void", paramId: "global.quality", value: 3 },
    ]);
    // ozvena-only helper agrees on the same single bump.
    expect(ozvenaRenderQualityBumps(doc)).toHaveLength(1);
  });
});
