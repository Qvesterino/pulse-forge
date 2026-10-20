import { describe, expect, it } from "vitest";
import { effectTargetParamDefs, instrumentTargetParamDefs } from "../src/project-model/targets";
import { buildSchema as buildFxEqSchema } from "../src/effects/fxeq-core/core/parameterSchema";
import type { EffectInstance, InstrumentTrack, Track } from "../src/project-model/types";

/**
 * Guard for the PARAMETER CATALOG cache.
 *
 * `effectTargetParamDefs` used to rebuild the whole parameter catalog of an
 * effect on every call. The automation path resolves a target seven times per
 * lane per scheduler tick, and the fxeq catalog is 315 defs plus two maps —
 * measured 0.65 ms per rebuild, i.e. ~159 ms of CPU per second for a single
 * automated fxeq, spent rebuilding an identical catalog 280 times a second.
 *
 * The catalog is derived purely from the effect TYPE (and, for fxeq, the band
 * count), so it is cached. The guards below pin the three things a cache can
 * get wrong: it must be SHARED (the whole point), it must be KEYED (a stale
 * band count would expose the wrong params), and it must not leak ACROSS
 * types.
 */

function fxeq(bandCount: number, id = "fx-1"): EffectInstance {
  return { id, type: "fxeq", bypassed: false, params: { bandCount } } as EffectInstance;
}

function effect(type: string, id: string): EffectInstance {
  return { id, type, bypassed: false, params: {} } as EffectInstance;
}

function instrument(kind: string, id: string): InstrumentTrack {
  return { id, kind: "instrument", instrument: kind } as unknown as InstrumentTrack;
}

describe("automation target parameter catalog cache", () => {
  it("shares one catalog per effect type (the whole point of the cache)", () => {
    const a = effectTargetParamDefs(fxeq(6, "fx-a"));
    const b = effectTargetParamDefs(fxeq(6, "fx-b"));
    expect(a).toBe(b);
  });

  it("keys the fxeq catalog by band count — a stale band count would expose the wrong params", () => {
    const six = effectTargetParamDefs(fxeq(6, "fx-1"));
    const four = effectTargetParamDefs(fxeq(4, "fx-2"));
    expect(six).not.toBe(four);
    // Fewer bands → fewer automatable params.
    expect(four.length).toBeLessThan(six.length);
  });

  it("does not leak a catalog across effect types", () => {
    const reverb = effectTargetParamDefs(effect("reverb", "fx-r"));
    const ozvena = effectTargetParamDefs(effect("ozvena", "fx-o"));
    expect(reverb).not.toBe(ozvena);
    expect(reverb.map((d) => d.id)).not.toEqual(ozvena.map((d) => d.id));
  });

  it("still exposes every automatable deep fxeq param of the requested band count", () => {
    for (const bandCount of [2, 4, 6]) {
      const catalog = effectTargetParamDefs(fxeq(bandCount, `fx-${bandCount}`));
      const ids = new Set(catalog.map((d) => d.id));
      const schema = buildFxEqSchema(bandCount);
      const automatable = schema.defs.filter((d) => d.automatable);
      expect(automatable.length).toBeGreaterThan(0);
      for (const def of automatable) {
        expect(ids.has(def.id)).toBe(true);
      }
    }
  });

  it("shares one catalog per instrument kind", () => {
    const a = instrumentTargetParamDefs(instrument("sampler", "t-1") as Extract<Track, { kind: "instrument" }>);
    const b = instrumentTargetParamDefs(instrument("sampler", "t-2") as Extract<Track, { kind: "instrument" }>);
    expect(a).toBe(b);
    const other = instrumentTargetParamDefs(
      instrument("analog", "t-3") as Extract<Track, { kind: "instrument" }>,
    );
    expect(other).not.toBe(a);
  });
});
