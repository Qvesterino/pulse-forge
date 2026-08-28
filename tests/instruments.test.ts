import { describe, expect, it } from "vitest";
import {
  INSTRUMENT_DEFS,
  INSTRUMENT_ORDER,
  clampInstrumentParam,
  defaultInstrumentParams,
} from "../src/instruments/registry";
import type { InstrumentKind, InstrumentTrack } from "../src/project-model/types";

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

  it("texture exposes color/motion/space/density/texture/chaos", () => {
    const ids = new Set(INSTRUMENT_DEFS.texture.params.map((p) => p.id));
    for (const expected of ["color", "motion", "space", "density", "texture", "chaos"]) {
      expect(ids.has(expected)).toBe(true);
    }
  });
});

describe.skipIf(typeof OfflineAudioContext === "undefined")("Texture Synth runtime", () => {
  const SR = 44100;

  function makeTrack(): InstrumentTrack {
    return {
      id: "tex-test",
      kind: "instrument",
      instrument: "texture",
      name: "Texture",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: null,
      params: defaultInstrumentParams("texture"),
      effects: [],
      sends: {},
    };
  }

  it("constructs, accepts param updates, and renders an evolving signal", async () => {
    const ctx = new OfflineAudioContext(2, SR * 2, SR);
    const track = makeTrack();
    const rt = INSTRUMENT_DEFS.texture.factory(ctx, track, { bpm: 124, getSample: () => undefined });
    rt.output.connect(ctx.destination);
    for (const p of INSTRUMENT_DEFS.texture.params) {
      rt.setParameter(p.id, p.min);
      rt.setParameter(p.id, p.max);
      rt.setParameter(p.id, p.default);
    }
    rt.noteOn(60, 0.9, 0.05, 0.5);
    rt.noteOn(67, 0.7, 0.1, 0.5);
    const buffer = await ctx.startRendering();
    let peak = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i]);
        if (v > peak) peak = v;
      }
    }
    expect(peak).toBeGreaterThan(0.001);
    expect(peak).toBeLessThanOrEqual(2);
    rt.dispose();
  });

  it("panic stops sounding voices without leaving the engine in a bad state", async () => {
    const ctx = new OfflineAudioContext(2, SR / 2, SR);
    const track = makeTrack();
    const rt = INSTRUMENT_DEFS.texture.factory(ctx, track, { bpm: 124, getSample: () => undefined });
    rt.output.connect(ctx.destination);
    rt.noteOn(60, 0.9, 0.0, 0.4);
    rt.noteOn(64, 0.9, 0.0, 0.4);
    rt.noteOn(67, 0.9, 0.0, 0.4);
    rt.noteOn(70, 0.9, 0.0, 0.4);
    rt.noteOn(72, 0.9, 0.0, 0.4); // exceeds poly (4) — oldest voice should be stolen
    rt.panic();
    rt.noteOn(60, 0.9, 0.0, 0.4); // can still play after panic
    const buffer = await ctx.startRendering();
    let peak = 0;
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
    expect(peak).toBeGreaterThan(0.001);
    rt.dispose();
  });

  it("dispose releases all runtime nodes (subsequent setParameter is a no-op)", () => {
    const ctx = new OfflineAudioContext(2, 128, SR);
    const track = makeTrack();
    const rt = INSTRUMENT_DEFS.texture.factory(ctx, track, { bpm: 124, getSample: () => undefined });
    rt.dispose();
    // No throw + no crash means dispose is clean
    expect(() => rt.setParameter("color", 0.1)).not.toThrow();
  });
});
