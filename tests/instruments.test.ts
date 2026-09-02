import { describe, expect, it } from "vitest";
import {
  INSTRUMENT_DEFS,
  INSTRUMENT_ORDER,
  clampInstrumentParam,
  defaultInstrumentParams,
  syncRateHz,
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

describe("wavetable morph modulation", () => {
  it("exposes morph rate and depth alongside the static morph position", () => {
    const ids = new Set(INSTRUMENT_DEFS.wavetable.params.map((p) => p.id));
    for (const expected of ["morph", "morphRate", "morphDepth"]) {
      expect(ids.has(expected)).toBe(true);
    }
    const rate = INSTRUMENT_DEFS.wavetable.params.find((p) => p.id === "morphRate")!;
    expect(rate.default).toBe(0); // render-neutral for existing projects
  });
});

describe.skipIf(typeof OfflineAudioContext === "undefined")("Wavetable morph LFO runtime", () => {
  const SR = 44100;

  function makeTrack(): InstrumentTrack {
    return {
      id: "wt-morph-test",
      kind: "instrument",
      instrument: "wavetable",
      name: "Wavetable",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: null,
      params: defaultInstrumentParams("wavetable"),
      effects: [],
      sends: {},
    };
  }

  async function renderPeak(morphRate: number, morphDepth: number): Promise<number> {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const rt = INSTRUMENT_DEFS.wavetable.factory(ctx, makeTrack(), { bpm: 124, getSample: () => undefined });
    rt.output.connect(ctx.destination);
    rt.setParameter("morphRate", morphRate);
    rt.setParameter("morphDepth", morphDepth);
    rt.noteOn(60, 0.9, 0.05, 0.8);
    const buffer = await ctx.startRendering();
    let peak = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    }
    rt.dispose();
    return peak;
  }

  it("renders a modulated note within level bounds", async () => {
    const peak = await renderPeak(3, 0.8);
    expect(peak).toBeGreaterThan(0.001);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("stays level-safe at the depth extremes (0 and 1)", async () => {
    for (const depth of [0, 1]) {
      const peak = await renderPeak(5, depth);
      expect(peak).toBeGreaterThan(0.001);
      expect(peak).toBeLessThanOrEqual(2);
    }
  });
});

describe("SVF filter drive", () => {
  it("analog and bass expose filter drive, defaulting to render-neutral 0", () => {
    for (const kind of ["analog", "bass"] as const) {
      const drive = INSTRUMENT_DEFS[kind].params.find((p) => p.id === "drive");
      expect(drive).toBeDefined();
      expect(drive!.default).toBe(0);
      expect(drive!.max).toBe(1);
    }
  });

  it("other filter-based instruments are untouched by the drive rollout", () => {
    for (const kind of ["sampler", "texture", "wavetable", "keys", "pluck", "logdrum"] as const) {
      expect(INSTRUMENT_DEFS[kind].params.find((p) => p.id === "drive")).toBeUndefined();
    }
  });
});

describe.skipIf(typeof OfflineAudioContext === "undefined")("Filter drive runtime", () => {
  const SR = 44100;

  function makeTrack(kind: "analog" | "bass", params: Record<string, number>): InstrumentTrack {
    return {
      id: `drv-${kind}`,
      kind: "instrument",
      instrument: kind,
      name: kind,
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: null,
      params: { ...defaultInstrumentParams(kind), ...params },
      effects: [],
      sends: {},
    };
  }

  async function peakOf(kind: "analog" | "bass", params: Record<string, number>): Promise<number> {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const rt = INSTRUMENT_DEFS[kind].factory(ctx, makeTrack(kind, params), { bpm: 124, getSample: () => undefined });
    rt.output.connect(ctx.destination);
    rt.noteOn(48, 0.9, 0.05, 0.6);
    const buffer = await ctx.startRendering();
    let peak = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    }
    rt.dispose();
    return peak;
  }

  it("driven analog and bass render audible within bounds (incl. param sweep)", async () => {
    const analogPeak = await peakOf("analog", { drive: 0.9, resonance: 6, cutoff: 2200 });
    expect(analogPeak).toBeGreaterThan(0.001);
    expect(analogPeak).toBeLessThanOrEqual(2);
    const bassPeak = await peakOf("bass", { drive: 0.7, cutoff: 900, resonance: 2.5 });
    expect(bassPeak).toBeGreaterThan(0.001);
    expect(bassPeak).toBeLessThanOrEqual(2);
    // live drive updates must not throw on a silent engine
    const ctx = new OfflineAudioContext(2, 128, SR);
    const rt = INSTRUMENT_DEFS.bass.factory(ctx, makeTrack("bass", {}), { bpm: 124, getSample: () => undefined });
    expect(() => {
      rt.setParameter("drive", 1);
      rt.setParameter("drive", 0);
      rt.dispose();
    }).not.toThrow();
  });
});

describe("sampler velocity filter + stereo stretch", () => {
  it("exposes V-FLT defaulting to render-neutral 0", () => {
    const velFlt = INSTRUMENT_DEFS.sampler.params.find((p) => p.id === "velFlt");
    expect(velFlt).toBeDefined();
    expect(velFlt!.default).toBe(0);
    expect(velFlt!.max).toBe(1);
  });
});

describe.skipIf(typeof OfflineAudioContext === "undefined")("Sampler stretch + velocity runtime", () => {
  const SR = 44100;

  function makeTrack(params: Record<string, number>): InstrumentTrack {
    return {
      id: "smp-vflt-test",
      kind: "instrument",
      instrument: "sampler",
      name: "Sampler",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: "user.stereo",
      params: { ...defaultInstrumentParams("sampler"), ...params },
      effects: [],
      sends: {},
    };
  }

  function makeRuntime(ctx: BaseAudioContext, track: InstrumentTrack) {
    // Stereo source with DISTINCT channel content: 220 Hz left, 660 Hz right.
    const source = ctx.createBuffer(2, SR, SR);
    for (let i = 0; i < source.length; i++) {
      source.getChannelData(0)[i] = 0.6 * Math.sin((2 * Math.PI * 220 * i) / SR);
      source.getChannelData(1)[i] = 0.5 * Math.sin((2 * Math.PI * 660 * i) / SR);
    }
    return INSTRUMENT_DEFS.sampler.factory(ctx, track, {
      bpm: 124,
      getSample: (id) => (id === "user.stereo" ? source : undefined),
    });
  }

  function peak(data: Float32Array): number {
    let v = 0;
    for (let i = 0; i < data.length; i++) v = Math.max(v, Math.abs(data[i]));
    return v;
  }

  it("time-stretch keeps both channels of a stereo sample audible", async () => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const rt = makeRuntime(ctx, makeTrack({ stretch: 1 }));
    rt.output.connect(ctx.destination);
    rt.noteOn(72, 0.9, 0.05, 0.5); // +12 st forces the stretch path
    const buffer = await ctx.startRendering();
    expect(peak(buffer.getChannelData(0))).toBeGreaterThan(0.001);
    expect(peak(buffer.getChannelData(1))).toBeGreaterThan(0.001);
    rt.dispose();
  });

  it("renders with full velocity->filter at both velocity extremes", async () => {
    for (const velocity of [0.1, 1]) {
      const ctx = new OfflineAudioContext(2, SR / 2, SR);
      const rt = makeRuntime(ctx, makeTrack({ velFlt: 1, cutoff: 4000, resonance: 2 }));
      rt.output.connect(ctx.destination);
      rt.noteOn(60, velocity, 0.02, 0.3);
      const buffer = await ctx.startRendering();
      const p = peak(buffer.getChannelData(0));
      expect(p).toBeGreaterThan(0.001);
      expect(p).toBeLessThanOrEqual(2);
      rt.dispose();
    }
  });
});

describe("filter mode + keytrack rollout", () => {
  it("bass, sampler, wavetable and keys expose MODE and KEYTRACK (render-neutral defaults)", () => {
    for (const kind of ["bass", "sampler", "wavetable", "keys"] as const) {
      const mode = INSTRUMENT_DEFS[kind].params.find((p) => p.id === "mode");
      const keytrack = INSTRUMENT_DEFS[kind].params.find((p) => p.id === "keytrack");
      expect(mode).toBeDefined();
      expect(mode!.default).toBe(0);
      expect(mode!.options?.map((o) => o.label)).toEqual(["LP", "BP", "HP"]);
      expect(keytrack).toBeDefined();
      expect(keytrack!.default).toBe(0);
    }
    // Analog keeps its shipped musical default (taste choice locked by test)
    expect(INSTRUMENT_DEFS.analog.params.find((p) => p.id === "keytrack")!.default).toBe(0.3);
  });
});

describe.skipIf(typeof OfflineAudioContext === "undefined")("Bandpass + keytrack runtime", () => {
  const SR = 44100;

  function makeTrack(kind: "bass" | "sampler" | "wavetable" | "keys"): InstrumentTrack {
    return {
      id: `bpm-${kind}`,
      kind: "instrument",
      instrument: kind,
      name: kind,
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: kind === "sampler" ? "user.tone" : null,
      params: {
        ...defaultInstrumentParams(kind),
        mode: 1,
        keytrack: 1,
        cutoff: kind === "sampler" ? 6000 : kind === "bass" ? 1200 : 3000,
        resonance: 2.5,
      },
      effects: [],
      sends: {},
    };
  }

  function peak(data: Float32Array): number {
    let v = 0;
    for (let i = 0; i < data.length; i++) v = Math.max(v, Math.abs(data[i]));
    return v;
  }

  it("all four instruments render audibly in bandpass mode with full keytrack", async () => {
    for (const kind of ["bass", "sampler", "wavetable", "keys"] as const) {
      const ctx = new OfflineAudioContext(2, SR, SR);
      const source = ctx.createBuffer(1, SR, SR);
      {
        const data = source.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = 0.6 * Math.sin((2 * Math.PI * 220 * i) / SR);
      }
      const rt = INSTRUMENT_DEFS[kind].factory(ctx, makeTrack(kind), {
        bpm: 124,
        getSample: (id) => (id === "user.tone" ? source : undefined),
      });
      rt.output.connect(ctx.destination);
      rt.noteOn(60, 0.9, 0.05, 0.5);
      rt.noteOn(72, 0.8, 0.1, 0.5); // keytracked octave — cutoff doubles
      const buffer = await ctx.startRendering();
      const p = peak(buffer.getChannelData(0));
      expect(p).toBeGreaterThan(0.001);
      expect(p).toBeLessThanOrEqual(2);
      rt.dispose();
    }
  });
});

describe("BPM sync modulations", () => {
  it("division table maps note values to rates correctly at 120 BPM", () => {
    expect(syncRateHz(0, 120)).toBe(0); // OFF
    expect(syncRateHz(2, 120)).toBeCloseTo(2, 5); // 1/4 -> 2 Hz
    expect(syncRateHz(4, 120)).toBeCloseTo(4, 5); // 1/8 -> 4 Hz
    expect(syncRateHz(3, 120)).toBeCloseTo(120 / (60 * 0.75), 5); // 1/8D
    expect(syncRateHz(5, 120)).toBeCloseTo(6, 5); // 1/8T
    expect(syncRateHz(6, 120)).toBeCloseTo(8, 5); // 1/16
    expect(syncRateHz(2, 60)).toBeCloseTo(1, 5); // tempo scales linearly
  });

  it("sync selectors exist on analog, keys, texture and granular (default OFF)", () => {
    expect(INSTRUMENT_DEFS.analog.params.find((p) => p.id === "lfoSync")!.default).toBe(0);
    expect(INSTRUMENT_DEFS.keys.params.find((p) => p.id === "lfoSync")!.default).toBe(0);
    expect(INSTRUMENT_DEFS.texture.params.find((p) => p.id === "sync")!.default).toBe(0);
    expect(INSTRUMENT_DEFS.granular.params.find((p) => p.id === "rateSync")!.default).toBe(0);
  });
});

describe.skipIf(typeof OfflineAudioContext === "undefined")("BPM sync runtime", () => {
  const SR = 44100;

  function peak(data: Float32Array): number {
    let v = 0;
    for (let i = 0; i < data.length; i++) v = Math.max(v, Math.abs(data[i]));
    return v;
  }

  function makeTrack(kind: "analog" | "texture" | "granular", params: Record<string, number>): InstrumentTrack {
    return {
      id: `sync-${kind}`,
      kind: "instrument",
      instrument: kind,
      name: kind,
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: kind === "granular" ? "user.tone" : null,
      params: { ...defaultInstrumentParams(kind), ...params },
      effects: [],
      sends: {},
    };
  }

  it("synced LFO / delay / grain rate render audibly and syncBpm is safe", async () => {
    const cases: Array<{
      kind: "analog" | "texture" | "granular";
      params: Record<string, number>;
    }> = [
      { kind: "analog", params: { lfoSync: 4, lfoDepth: 0.4, cutoff: 2400, resonance: 3 } },
      { kind: "texture", params: { sync: 2, space: 0.6 } },
      { kind: "granular", params: { rateSync: 6 } },
    ];
    for (const { kind, params } of cases) {
      const ctx = new OfflineAudioContext(2, SR, SR);
      const source = ctx.createBuffer(1, SR, SR);
      {
        const data = source.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = 0.6 * Math.sin((2 * Math.PI * 220 * i) / SR);
      }
      const rt = INSTRUMENT_DEFS[kind].factory(ctx, makeTrack(kind, params), {
        bpm: 124,
        getSample: (id) => (id === "user.tone" ? source : undefined),
      });
      rt.output.connect(ctx.destination);
      expect(() => rt.syncBpm?.(140)).not.toThrow(); // live tempo change
      rt.noteOn(60, 0.9, 0.05, 0.5);
      const buffer = await ctx.startRendering();
      const p = peak(buffer.getChannelData(0));
      expect(p).toBeGreaterThan(0.001);
      expect(p).toBeLessThanOrEqual(2);
      rt.dispose();
    }
  });
});

describe("vocalchop vibrato / consonant / glide", () => {
  it("exposes VIB and CONS defaulting to render-neutral 0", () => {
    expect(INSTRUMENT_DEFS.vocalchop.params.find((p) => p.id === "vib")!.default).toBe(0);
    expect(INSTRUMENT_DEFS.vocalchop.params.find((p) => p.id === "cons")!.default).toBe(0);
  });
});

describe.skipIf(typeof OfflineAudioContext === "undefined")("Vocal chop expressive runtime", () => {
  const SR = 44100;

  function makeTrack(params: Record<string, number>): InstrumentTrack {
    return {
      id: "vcx-exp-test",
      kind: "instrument",
      instrument: "vocalchop",
      name: "Vocal Chop",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: "user.tone",
      params: { ...defaultInstrumentParams("vocalchop"), ...params },
      effects: [],
      sends: {},
    };
  }

  function makeRuntime(ctx: BaseAudioContext, track: InstrumentTrack) {
    const source = ctx.createBuffer(1, SR, SR);
    const data = source.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = 0.6 * Math.sin((2 * Math.PI * 220 * i) / SR);
    return INSTRUMENT_DEFS.vocalchop.factory(ctx, track, {
      bpm: 124,
      getSample: (id) => (id === "user.tone" ? source : undefined),
    });
  }

  function peak(data: Float32Array): number {
    let v = 0;
    for (let i = 0; i < data.length; i++) v = Math.max(v, Math.abs(data[i]));
    return v;
  }

  it("renders with full vibrato and consonant transient within bounds", async () => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const rt = makeRuntime(ctx, makeTrack({ vib: 1, cons: 1, sharp: 0.8, morph: 0.5 }));
    rt.output.connect(ctx.destination);
    rt.noteOn(60, 0.9, 0.05, 0.6);
    const buffer = await ctx.startRendering();
    const p = peak(buffer.getChannelData(0));
    expect(p).toBeGreaterThan(0.001);
    expect(p).toBeLessThanOrEqual(2);
    rt.dispose();
  });

  it("glides an overlapping note instead of re-attacking (no throw, audible)", async () => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const rt = makeRuntime(ctx, makeTrack({ vib: 0.6, cons: 0.5 }));
    rt.output.connect(ctx.destination);
    rt.noteOn(60, 0.9, 0.05, 0.5);
    // overlapping retrigger with slideFrom — must glide the live voice
    expect(() => rt.noteOn(64, 0.85, 0.2, 0.4, { pitch: 60, when: 0.05 })).not.toThrow();
    const buffer = await ctx.startRendering();
    expect(peak(buffer.getChannelData(0))).toBeGreaterThan(0.001);
    rt.dispose();
  });
});

describe.skipIf(typeof OfflineAudioContext === "undefined")("MPE poly aftertouch runtime", () => {
  const SR = 44100;

  function peak(data: Float32Array): number {
    let v = 0;
    for (let i = 0; i < data.length; i++) v = Math.max(v, Math.abs(data[i]));
    return v;
  }

  it("per-voice pressure opens matching notes only, survives dead pitches, renders in bounds", async () => {
    const kinds = ["analog", "bass", "sampler", "wavetable", "keys", "pluck", "spectral", "logdrum"] as const;
    for (const kind of kinds) {
      const ctx = new OfflineAudioContext(2, SR, SR);
      const source = ctx.createBuffer(1, SR, SR);
      {
        const data = source.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = 0.6 * Math.sin((2 * Math.PI * 220 * i) / SR);
      }
      const track: InstrumentTrack = {
        id: `mpe-${kind}`,
        kind: "instrument",
        instrument: kind,
        name: kind,
        gain: 1,
        pan: 0,
        mute: false,
        solo: false,
        sampleId: kind === "sampler" ? "user.tone" : null,
        params: defaultInstrumentParams(kind),
        effects: [],
        sends: {},
      };
      const rt = INSTRUMENT_DEFS[kind].factory(ctx, track, {
        bpm: 124,
        getSample: (id) => (id === "user.tone" ? source : undefined),
      });
      rt.output.connect(ctx.destination);
      rt.noteOn(60, 0.9, 0.05, 0.5);
      rt.noteOn(64, 0.8, 0.1, 0.5);
      // pressure on one sounding note, another note's pitch, and a dead pitch
      expect(() => {
        rt.polyPressure?.(60, 0.9, 0.15);
        rt.polyPressure?.(64, 0.2, 0.15);
        rt.polyPressure?.(90, 0.8, 0.15); // no live voice — must be a no-op
        rt.polyPressure?.(60, 0, 0.2); // release restores the base cutoff
      }).not.toThrow();
      const buffer = await ctx.startRendering();
      const p = peak(buffer.getChannelData(0));
      expect(p).toBeGreaterThan(0.001);
      expect(p).toBeLessThanOrEqual(2);
      rt.dispose();
    }
  });
});

describe("variability pack: spacing / unison / choke / splay", () => {
  it("exposes new params with render-neutral defaults", () => {
    expect(INSTRUMENT_DEFS.spectral.params.find((p) => p.id === "spacing")!.default).toBe(1);
    for (const kind of ["bass", "keys"] as const) {
      expect(INSTRUMENT_DEFS[kind].params.find((p) => p.id === "unison")!.default).toBe(1);
    }
    expect(INSTRUMENT_DEFS.logdrum.params.find((p) => p.id === "dropSplay")!.default).toBe(0);
  });
});

describe.skipIf(typeof OfflineAudioContext === "undefined")("Variability pack runtime", () => {
  const SR = 44100;

  function peak(data: Float32Array): number {
    let v = 0;
    for (let i = 0; i < data.length; i++) v = Math.max(v, Math.abs(data[i]));
    return v;
  }

  function makeTrack(kind: (typeof kinds)[number], params: Record<string, number>): InstrumentTrack {
    return {
      id: `var-${kind}`,
      kind: "instrument",
      instrument: kind,
      name: kind,
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: null,
      params: { ...defaultInstrumentParams(kind), ...params },
      effects: [],
      sends: {},
    };
  }

  const kinds = ["spectral", "bass", "keys", "logdrum", "drumsynth"] as const;

  it("renders param extremes audibly within bounds", async () => {
    const cases: Array<{ kind: (typeof kinds)[number]; params: Record<string, number> }> = [
      { kind: "spectral", params: { spacing: 2, partials: 8 } },
      { kind: "spectral", params: { spacing: 0.5, partials: 8 } },
      { kind: "bass", params: { unison: 6, spread: 50 } },
      { kind: "keys", params: { unison: 3, spread: 25 } },
      { kind: "logdrum", params: { dropSplay: 1, pitchDrop: 0.8 } },
      { kind: "drumsynth", params: { type: 3, decay: 1.2 } },
    ];
    for (const { kind, params } of cases) {
      const ctx = new OfflineAudioContext(2, SR / 2, SR);
      const rt = INSTRUMENT_DEFS[kind].factory(ctx, makeTrack(kind, params), { bpm: 124, getSample: () => undefined });
      rt.output.connect(ctx.destination);
      rt.noteOn(60, 0.9, 0.02, 0.3);
      const buffer = await ctx.startRendering();
      const p = peak(buffer.getChannelData(0));
      expect(p).toBeGreaterThan(0.001);
      expect(p).toBeLessThanOrEqual(2);
      rt.dispose();
    }
  });

  it("closed hat chokes a ringing open hat (energy drops after the choke)", async () => {
    const render = async (choke: boolean) => {
      const ctx = new OfflineAudioContext(2, SR, SR);
      const rt = INSTRUMENT_DEFS.drumsynth.factory(ctx, makeTrack("drumsynth", { type: 3, decay: 0.9, tone: 0.5 }), {
        bpm: 124,
        getSample: () => undefined,
      });
      rt.output.connect(ctx.destination);
      rt.noteOn(60, 1, 0.05, 0.2); // open hat, long ring
      if (choke) {
        rt.setParameter("type", 2);
        rt.noteOn(60, 1, 0.25, 0.2); // closed hat chokes it
      }
      const buffer = await ctx.startRendering();
      rt.dispose();
      const data = buffer.getChannelData(0);
      let sum = 0;
      const from = Math.floor(0.4 * SR);
      for (let i = from; i < data.length; i++) sum += Math.abs(data[i]);
      return sum;
    };
    const choked = await render(true);
    const free = await render(false);
    expect(choked).toBeLessThan(free * 0.5);
  });
});
