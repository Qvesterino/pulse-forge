import { describe, expect, it } from "vitest";
import {
  fxeqRenderQualityBumps,
  ozvenaRenderQualityBumps,
  renderQualityBumps,
  resolveRenderQuality,
  resolveRenderTailSeconds,
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

describe("VØID render tail (2026-09-19 audit)", () => {
  type OzvenaFixture = {
    id: string;
    type: "ozvena";
    bypassed: boolean;
    params: Record<string, number>;
  };
  const docWithOzvena = (effects: OzvenaFixture[], returns: OzvenaFixture[] = []) =>
    ({ tracks: [{ id: "track-1", effects }], returns: returns.map((fx) => ({ id: "ret-1", effects: [fx] })) }) as unknown as ProjectDocument;

  it("falls back to 2 s without a VØID reverb", () => {
    expect(resolveRenderTailSeconds(docWithEffects([]))).toBe(2);
  });

  it("extends the tail to the longest enabled VØID decay", () => {
    const doc = docWithOzvena([
      {
        id: "reverb",
        type: "ozvena",
        bypassed: false,
        params: { "engines.e3.enabled": 1, "engines.e3.time": 8000, "engines.e2.time": 2000 },
      },
    ]);
    // 8 s x 1.1 + 0.5 = 9.3 s — a 2 s tail would truncate a long hall.
    expect(resolveRenderTailSeconds(doc)).toBeCloseTo(9.3, 5);
  });

  it("ignores a disabled engine's time", () => {
    const doc = docWithOzvena([
      {
        id: "reverb",
        type: "ozvena",
        bypassed: false,
        params: { "engines.e3.enabled": 0, "engines.e3.time": 24000, "engines.e2.time": 2000 },
      },
    ]);
    expect(resolveRenderTailSeconds(doc)).toBeCloseTo(2.7, 5);
  });

  it("caps a pathological decay at 12 s", () => {
    const doc = docWithOzvena([
      {
        id: "reverb",
        type: "ozvena",
        bypassed: false,
        params: { "engines.e3.enabled": 1, "engines.e3.time": 24000 },
      },
    ]);
    expect(resolveRenderTailSeconds(doc)).toBe(12);
  });

  it("covers return-track reverbs too, and ignores bypassed ones", () => {
    const ret = docWithOzvena(
      [],
      [
        {
          id: "ret-reverb",
          type: "ozvena",
          bypassed: false,
          params: { "engines.e3.enabled": 1, "engines.e3.time": 6000 },
        },
      ],
    );
    expect(resolveRenderTailSeconds(ret)).toBeCloseTo(7.1, 5);
    const bypassed = docWithOzvena([
      {
        id: "reverb",
        type: "ozvena",
        bypassed: true,
        params: { "engines.e3.enabled": 1, "engines.e3.time": 24000 },
      },
    ]);
    expect(resolveRenderTailSeconds(bypassed)).toBe(2);
  });
});
