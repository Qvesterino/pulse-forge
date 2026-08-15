import { describe, expect, it } from "vitest";
import { INSTRUMENT_DEFS, INSTRUMENT_ORDER, clampInstrumentParam, defaultInstrumentParams } from "../src/instruments/registry";
import type { InstrumentKind } from "../src/project-model/types";

describe("instrument registry", () => {
  it("INSTRUMENT_ORDER covers every definition", () => {
    expect(new Set(INSTRUMENT_ORDER)).toEqual(new Set(Object.keys(INSTRUMENT_DEFS) as InstrumentKind[]));
  });

  it("every definition has valid parameter metadata", () => {
    for (const def of Object.values(INSTRUMENT_DEFS)) {
      expect(def.params.length).toBeGreaterThan(0);
      const ids = new Set<string>();
      for (const p of def.params) {
        expect(p.min).toBeLessThan(p.max);
        expect(p.default).toBeGreaterThanOrEqual(p.min);
        expect(p.default).toBeLessThanOrEqual(p.max);
        ids.add(p.id);
      }
      expect(ids.size).toBe(def.params.length);
    }
  });

  it("defaultInstrumentParams returns every default", () => {
    for (const kind of INSTRUMENT_ORDER) {
      const def = INSTRUMENT_DEFS[kind];
      const params = defaultInstrumentParams(kind);
      expect(Object.keys(params).sort()).toEqual(def.params.map((p) => p.id).sort());
      for (const p of def.params) expect(params[p.id]).toBe(p.default);
    }
  });

  it("clampInstrumentParam enforces bounds", () => {
    expect(clampInstrumentParam("analog", "cutoff", 99999)).toBe(16000);
    expect(clampInstrumentParam("808", "decay", -5)).toBe(0.05);
    expect(clampInstrumentParam("bass", "sub", 0.42)).toBeCloseTo(0.42, 5);
    expect(clampInstrumentParam("sampler", "root", 100)).toBe(84);
  });

  it("808 exposes decay, pitch drop, click, drive, tone", () => {
    const ids = new Set(INSTRUMENT_DEFS["808"].params.map((p) => p.id));
    for (const expected of ["decay", "pitchDrop", "click", "drive", "tone"]) {
      expect(ids.has(expected)).toBe(true);
    }
  });

  it("bass exposes semantic macro controls", () => {
    const ids = new Set(INSTRUMENT_DEFS.bass.params.map((p) => p.id));
    for (const expected of ["sub", "body", "punch", "grit", "movement", "width"]) {
      expect(ids.has(expected)).toBe(true);
    }
  });
});
