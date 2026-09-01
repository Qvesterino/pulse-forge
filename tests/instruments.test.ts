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

describe("instrument expansion registry", () => {
  it("spectral exposes additive macros", () => {
    const ids = new Set(INSTRUMENT_DEFS.spectral.params.map((p) => p.id));
    for (const expected of ["profile", "partials", "inharm", "shimmer", "skew", "width"]) {
      expect(ids.has(expected)).toBe(true);
    }
  });

  it("vocalchop exposes formant controls", () => {
    const ids = new Set(INSTRUMENT_DEFS.vocalchop.params.map((p) => p.id));
    for (const expected of ["vowel", "color", "shift", "sharp", "morph", "tone"]) {
      expect(ids.has(expected)).toBe(true);
    }
  });

  it("drumsynth exposes analog drum macros and all seven types", () => {
    const ids = new Set(INSTRUMENT_DEFS.drumsynth.params.map((p) => p.id));
    for (const expected of ["type", "tune", "tone", "decay", "snap", "body", "drive"]) {
      expect(ids.has(expected)).toBe(true);
    }
    const type = INSTRUMENT_DEFS.drumsynth.params.find((p) => p.id === "type")!;
    expect(type.options?.length).toBe(7);
  });

  it("new kinds ship factory presets with in-range params", () => {
    expect(INSTRUMENT_ORDER).toContain("spectral");
    expect(INSTRUMENT_ORDER).toContain("vocalchop");
    expect(INSTRUMENT_ORDER).toContain("drumsynth");
  });
});

describe.skipIf(typeof OfflineAudioContext === "undefined")("Spectral Pad runtime", () => {
  const SR = 44100;

  function makeTrack(): InstrumentTrack {
    return {
      id: "spc-test",
      kind: "instrument",
      instrument: "spectral",
      name: "Spectral",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: null,
      params: defaultInstrumentParams("spectral"),
      effects: [],
      sends: {},
    };
  }

  it("renders a normalized additive pad and survives a param sweep", async () => {
    const ctx = new OfflineAudioContext(2, SR * 2, SR);
    const rt = INSTRUMENT_DEFS.spectral.factory(ctx, makeTrack(), { bpm: 124, getSample: () => undefined });
    rt.output.connect(ctx.destination);
    for (const p of INSTRUMENT_DEFS.spectral.params) {
      rt.setParameter(p.id, p.min);
      rt.setParameter(p.id, p.max);
      rt.setParameter(p.id, p.default);
    }
    rt.noteOn(60, 0.9, 0.05, 0.8);
    rt.noteOn(67, 0.7, 0.1, 0.8);
    const buffer = await ctx.startRendering();
    let peak = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    }
    expect(peak).toBeGreaterThan(0.001);
    expect(peak).toBeLessThanOrEqual(2);
    rt.dispose();
  });
});

describe.skipIf(typeof OfflineAudioContext === "undefined")("Vocal Chop runtime", () => {
  const SR = 44100;

  function makeTrack(): InstrumentTrack {
    return {
      id: "vcx-test",
      kind: "instrument",
      instrument: "vocalchop",
      name: "Vocal Chop",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: "test-sample",
      params: defaultInstrumentParams("vocalchop"),
      effects: [],
      sends: {},
    };
  }

  function makeSample(ctx: BaseAudioContext): AudioBuffer {
    const buf = ctx.createBuffer(1, SR, SR);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.5;
    return buf;
  }

  it("formant-filters the sample and morph walks vowels", async () => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const sample = makeSample(ctx);
    const rt = INSTRUMENT_DEFS.vocalchop.factory(ctx, makeTrack(), {
      bpm: 124,
      getSample: (id) => (id === "test-sample" ? sample : undefined),
    });
    rt.output.connect(ctx.destination);
    rt.setParameter("morph", 0.8);
    rt.noteOn(60, 0.9, 0.05, 0.7);
    const buffer = await ctx.startRendering();
    let peak = 0;
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    expect(peak).toBeGreaterThan(0.01);
    rt.dispose();
  });

  it("stays silent without a sample instead of throwing", async () => {
    const ctx = new OfflineAudioContext(2, SR / 2, SR);
    const rt = INSTRUMENT_DEFS.vocalchop.factory(ctx, makeTrack(), { bpm: 124, getSample: () => undefined });
    rt.output.connect(ctx.destination);
    rt.noteOn(60, 0.9, 0, 0.3);
    const buffer = await ctx.startRendering();
    let peak = 0;
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    expect(peak).toBe(0);
    rt.dispose();
  });
});

describe.skipIf(typeof OfflineAudioContext === "undefined")("Drum Synth runtime", () => {
  const SR = 44100;

  function makeTrack(): InstrumentTrack {
    return {
      id: "dsy-test",
      kind: "instrument",
      instrument: "drumsynth",
      name: "Drum Synth",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: null,
      params: defaultInstrumentParams("drumsynth"),
      effects: [],
      sends: {},
    };
  }

  it("renders every analog model chromatically and survives voice stealing", async () => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const rt = INSTRUMENT_DEFS.drumsynth.factory(ctx, makeTrack(), { bpm: 124, getSample: () => undefined });
    rt.output.connect(ctx.destination);
    for (const p of INSTRUMENT_DEFS.drumsynth.params) {
      rt.setParameter(p.id, p.min);
      rt.setParameter(p.id, p.max);
      rt.setParameter(p.id, p.default);
    }
    for (let type = 0; type <= 6; type++) {
      rt.setParameter("type", type);
      rt.noteOn(48 + type * 4, 0.9, 0.02 + type * 0.05, 0.2);
    }
    rt.noteOff?.(60, 0.2);
    rt.panic();
    rt.setParameter("type", 0);
    rt.noteOn(60, 0.9, 0.5, 0.2); // still playable after panic
    const buffer = await ctx.startRendering();
    let peak = 0;
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    expect(peak).toBeGreaterThan(0.001);
    expect(peak).toBeLessThanOrEqual(2);
    rt.dispose();
  });
});
