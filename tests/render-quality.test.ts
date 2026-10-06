import { describe, expect, it, vi } from "vitest";
import {
  assertOfflineRenderPcmBudget,
  fxeqRenderQualityBumps,
  MAX_OFFLINE_RENDER_PCM_BYTES,
  ozvenaRenderQualityBumps,
  renderQualityBumps,
  renderProject,
  resolveRenderQuality,
  resolveRenderTailSeconds,
} from "../src/rendering/renderer";
import type { ProjectDocument } from "../src/project-model/types";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { SampleBank } from "../src/sample-library/factory";

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

describe("offline render PCM budget", () => {
  it("accepts a render at the documented limit", () => {
    expect(() => assertOfflineRenderPcmBudget(MAX_OFFLINE_RENDER_PCM_BYTES)).not.toThrow();
  });

  it("rejects a render before it can exceed the browser allocation budget", () => {
    expect(() => assertOfflineRenderPcmBudget(MAX_OFFLINE_RENDER_PCM_BYTES + 1)).toThrow(
      /above KYX's 320 MiB safety limit/,
    );
  });

  it("rejects unknown or empty estimates instead of allocating an unbounded context", () => {
    expect(() => assertOfflineRenderPcmBudget(Number.NaN)).toThrow(/could not estimate the memory/i);
    expect(() => assertOfflineRenderPcmBudget(Number.POSITIVE_INFINITY)).toThrow(/could not estimate the memory/i);
    expect(() => assertOfflineRenderPcmBudget(0)).toThrow(/could not estimate the memory/i);
  });

  it("rejects an oversized project before constructing OfflineAudioContext", async () => {
    const doc = createProjectFromTemplate("empty");
    doc.arrangement.clips = doc.arrangement.clips.map((clip) => ({ ...clip, lengthBars: 8192 }));
    const contextConstructor = vi.fn();
    vi.stubGlobal("OfflineAudioContext", contextConstructor);
    try {
      await expect(renderProject(doc, new SampleBank(), { mode: "song", sampleRate: 192_000 })).rejects.toThrow(
        /above KYX's 320 MiB safety limit/,
      );
      expect(contextConstructor).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
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
    ({
      tracks: [{ id: "track-1", effects }],
      returns: returns.map((fx) => ({ id: "ret-1", effects: [fx] })),
    }) as unknown as ProjectDocument;

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

  it("covers global master-bus reverb inserts so their tails are not cut off", () => {
    const doc = {
      bpm: 120,
      scenes: [],
      tracks: [],
      returns: [],
      master: {
        effects: [
          {
            id: "master-reverb",
            type: "ozvena",
            bypassed: false,
            params: { "engines.e3.enabled": 1, "engines.e3.time": 8000 },
          },
        ],
      },
    } as unknown as ProjectDocument;

    expect(resolveRenderTailSeconds(doc)).toBeCloseTo(9.3, 5);
  });

  it("covers master-bus delay inserts and ignores bypassed tail processors", () => {
    const doc = {
      bpm: 120,
      scenes: [],
      tracks: [],
      returns: [],
      master: {
        effects: [
          {
            id: "master-delay",
            type: "delay",
            bypassed: false,
            params: { time: 500, sync: 0, feedback: 0.4, mix: 0.5 },
          },
        ],
      },
    } as unknown as ProjectDocument;

    expect(resolveRenderTailSeconds(doc)).toBeCloseTo(6, 5);
    const bypassed = {
      ...doc,
      master: {
        effects: (doc.master.effects ?? []).map((fx) => ({ ...fx, bypassed: true })),
      },
    } as unknown as ProjectDocument;
    expect(resolveRenderTailSeconds(bypassed)).toBe(2);
  });

  it("estimates a native feedback-delay tail to -80 dB", () => {
    const doc = {
      bpm: 120,
      scenes: [],
      tracks: [
        {
          id: "track-1",
          effects: [
            { id: "delay", type: "delay", bypassed: false, params: { time: 500, sync: 0, feedback: 0.4, mix: 0.5 } },
          ],
        },
      ],
      returns: [],
    } as unknown as ProjectDocument;
    // ceil(log(1e-4)/log(.4)) = 11 repeats: 11 × 0.5 s + 0.5 s release.
    expect(resolveRenderTailSeconds(doc)).toBeCloseTo(6, 5);
  });

  it("uses active multi-tap divisions and respects the global tail cap", () => {
    const base = {
      bpm: 120,
      scenes: [],
      tracks: [
        {
          id: "track-1",
          effects: [
            {
              id: "multi-tap",
              type: "multiTapDelay",
              bypassed: false,
              params: { taps: 2, t1Div: 4, t2Div: 0, feedback: 0.4, mix: 0.5 },
            },
          ],
        },
      ],
      returns: [],
    } as unknown as ProjectDocument;
    expect(resolveRenderTailSeconds(base)).toBeCloseTo(11.5, 5);
    const capped = {
      ...base,
      tracks: [
        {
          id: "track-1",
          effects: [
            { id: "delay", type: "delay", bypassed: false, params: { time: 2000, sync: 0, feedback: 0.9, mix: 1 } },
          ],
        },
      ],
    } as unknown as ProjectDocument;
    expect(resolveRenderTailSeconds(capped)).toBe(12);
  });
});
