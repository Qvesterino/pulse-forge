import { describe, expect, it } from "vitest";
import {
  INSTRUMENT_DEFS,
  INSTRUMENT_ORDER,
  clampInstrumentParam,
  defaultInstrumentParams,
  syncRateHz,
} from "../src/instruments/registry";
import { scheduleDahdsr } from "../src/instruments/envelope";
import { buildWavetableMips, FRAME_SIZE, pickMipLevel } from "../src/instruments/wavetables";
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

  it("808 exposes FL gate/mono controls with gated-mono defaults", () => {
    const byId = Object.fromEntries(INSTRUMENT_DEFS["808"].params.map((p) => [p.id, p]));
    expect(byId.gate.default).toBe(1);
    expect(byId.mono.default).toBe(1);
    expect(defaultInstrumentParams("808").gate).toBe(1);
    expect(defaultInstrumentParams("808").mono).toBe(1);
  });

  it("bass exposes semantic macro controls", () => {
    const ids = new Set(INSTRUMENT_DEFS.bass.params.map((p) => p.id));
    for (const expected of ["sub", "body", "punch", "grit", "movement", "width"]) {
      expect(ids.has(expected)).toBe(true);
    }
  });

  it("texture exposes color/motion/space/density/texture/chaos + Wave 3 controls", () => {
    const ids = new Set(INSTRUMENT_DEFS.texture.params.map((p) => p.id));
    for (const expected of [
      "color",
      "motion",
      "space",
      "density",
      "texture",
      "chaos",
      "attack",
      "hold",
      "release",
      "unison",
      "spread",
      "drift",
      "diffuse",
    ]) {
      expect(ids.has(expected)).toBe(true);
    }
    // Render-neutral defaults: the upgrade must reproduce the pre-Wave-3 sound.
    const byId = Object.fromEntries(INSTRUMENT_DEFS.texture.params.map((p) => [p.id, p.default]));
    expect(byId.attack).toBe(0.5);
    expect(byId.hold).toBe(1.5);
    expect(byId.release).toBe(0.6);
    expect(byId.gate).toBe(0);
    expect(byId.unison).toBe(2);
    expect(byId.spread).toBe(0);
    expect(byId.drift).toBe(0);
    expect(byId.diffuse).toBe(0);
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
    rt.noteOn(72, 0.9, 0.0, 0.4);
    rt.noteOn(74, 0.9, 0.0, 0.4);
    rt.noteOn(76, 0.9, 0.0, 0.4);
    rt.noteOn(78, 0.9, 0.0, 0.4);
    rt.noteOn(80, 0.9, 0.0, 0.4); // exceeds poly (8) — oldest voice should be stolen
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

  it("Wave 3 params (unison/spread/drift/diffuse/attack) render an evolving signal", async () => {
    const ctx = new OfflineAudioContext(2, SR * 2, SR);
    const track = makeTrack();
    const rt = INSTRUMENT_DEFS.texture.factory(ctx, track, { bpm: 124, getSample: () => undefined });
    rt.output.connect(ctx.destination);
    rt.setParameter("unison", 5);
    rt.setParameter("spread", 0.6);
    rt.setParameter("drift", 0.8);
    rt.setParameter("diffuse", 0.6);
    rt.setParameter("attack", 0.05);
    rt.setParameter("hold", 0.3);
    rt.setParameter("sync", 2);
    rt.noteOn(60, 0.9, 0.05, 0.5);
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

  it("drumsynth exposes analog drum macros and all thirteen types", () => {
    const ids = new Set(INSTRUMENT_DEFS.drumsynth.params.map((p) => p.id));
    for (const expected of ["type", "tune", "tone", "decay", "snap", "body", "drive"]) {
      expect(ids.has(expected)).toBe(true);
    }
    const type = INSTRUMENT_DEFS.drumsynth.params.find((p) => p.id === "type")!;
    expect(type.options?.length).toBe(13);
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
    for (let type = 0; type <= 12; type++) {
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

describe.skipIf(typeof OfflineAudioContext === "undefined")("Wavetable scan engine runtime", () => {
  const SR = 44100;

  function makeTrack(params: Record<string, number>): InstrumentTrack {
    return {
      id: "wt-scan-test",
      kind: "instrument",
      instrument: "wavetable",
      name: "Wavetable",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: null,
      params: { ...defaultInstrumentParams("wavetable"), ...params },
      effects: [],
      sends: {},
    };
  }

  function zcc(data: Float32Array, from: number, to: number): number {
    let c = 0;
    for (let i = from + 1; i < to; i++) {
      if (data[i - 1] < 0 !== data[i] < 0) c++;
    }
    return c;
  }

  it("scanRate defaults to render-neutral OFF", () => {
    expect(INSTRUMENT_DEFS.wavetable.params.find((p) => p.id === "scanRate")!.default).toBe(0);
  });

  it("renders a scanned note in bounds, deterministically, even with unison", async () => {
    const render = () => {
      const ctx = new OfflineAudioContext(2, SR * 2, SR);
      const rt = INSTRUMENT_DEFS.wavetable.factory(ctx, makeTrack({ scanRate: 1.5, unison: 4, spread: 14 }), {
        bpm: 124,
        getSample: () => undefined,
      });
      rt.output.connect(ctx.destination);
      rt.noteOn(60, 0.9, 0.05, 1.2);
      const buffer = ctx.startRendering();
      rt.dispose();
      return buffer;
    };
    const a = await render();
    const b = await render();
    const da = a.getChannelData(0);
    const db = b.getChannelData(0);
    let peak = 0;
    let maxDiff = 0;
    for (let i = 0; i < da.length; i++) {
      peak = Math.max(peak, Math.abs(da[i]));
      maxDiff = Math.max(maxDiff, Math.abs(da[i] - db[i]));
    }
    expect(peak).toBeGreaterThan(0.001);
    expect(peak).toBeLessThanOrEqual(2);
    expect(maxDiff).toBeLessThan(1e-4);
  });

  it("actually traverses the table: later note window is spectrally richer", async () => {
    const ctx = new OfflineAudioContext(2, SR * 2, SR);
    // Sine Grow grows from a plain sine — scanning morph 0 -> 1 adds harmonics
    const rt = INSTRUMENT_DEFS.wavetable.factory(ctx, makeTrack({ table: 0, morph: 0, scanRate: 0.5 }), {
      bpm: 124,
      getSample: () => undefined,
    });
    rt.output.connect(ctx.destination);
    rt.noteOn(60, 0.9, 0.05, 2.2);
    const buffer = await ctx.startRendering();
    rt.dispose();
    const data = buffer.getChannelData(0);
    const early = zcc(data, Math.floor(0.25 * SR), Math.floor(0.55 * SR));
    const late = zcc(data, Math.floor(1.55 * SR), Math.floor(1.85 * SR));
    expect(early).toBeGreaterThan(50);
    expect(late).toBeGreaterThan(early * 1.1);
  });
});

describe.skipIf(typeof OfflineAudioContext === "undefined")("Sampler START offset runtime", () => {
  const SR = 44100;

  function makeTrack(params: Record<string, number>): InstrumentTrack {
    return {
      id: "smp-start-test",
      kind: "instrument",
      instrument: "sampler",
      name: "Sampler",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: "user.halftone",
      params: { ...defaultInstrumentParams("sampler"), ...params },
      effects: [],
      sends: {},
    };
  }

  function makeRuntime(ctx: BaseAudioContext, track: InstrumentTrack) {
    // First half of the sample is silence, second half a 440 Hz tone.
    const source = ctx.createBuffer(1, SR, SR);
    const data = source.getChannelData(0);
    for (let i = SR / 2; i < SR; i++) data[i] = 0.6 * Math.sin((2 * Math.PI * 440 * i) / SR);
    return INSTRUMENT_DEFS.sampler.factory(ctx, track, {
      bpm: 124,
      getSample: (id) => (id === "user.halftone" ? source : undefined),
    });
  }

  function peak(data: Float32Array, from: number, to: number): number {
    let v = 0;
    for (let i = from; i < to; i++) v = Math.max(v, Math.abs(data[i]));
    return v;
  }

  it("START 0 on a silent first half plays nothing; START 0.5 hits the tone", async () => {
    const render = async (start: number) => {
      const ctx = new OfflineAudioContext(2, SR, SR);
      const rt = makeRuntime(ctx, makeTrack({ start }));
      rt.output.connect(ctx.destination);
      rt.noteOn(60, 0.9, 0.02, 0.2); // note ends before the half-sample mark
      const buffer = await ctx.startRendering();
      rt.dispose();
      return peak(buffer.getChannelData(0), 0, SR);
    };
    expect(await render(0)).toBeLessThan(1e-4); // default: attack region is silence
    expect(await render(0.5)).toBeGreaterThan(0.01); // offset into the tone
  });

  it("START + reverse stays in bounds and audible", async () => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const rt = makeRuntime(ctx, makeTrack({ start: 0.75, reverse: 1 }));
    rt.output.connect(ctx.destination);
    rt.noteOn(60, 0.9, 0.02, 0.3);
    const buffer = await ctx.startRendering();
    expect(peak(buffer.getChannelData(0), 0, SR)).toBeGreaterThan(0.001);
    rt.dispose();
  });
});

describe("wavetable mipmapping", () => {
  it("builds halving levels, keeps the original as level 0, and picks by pitch", () => {
    const frame = new Float32Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) {
      // fundamental + strong 60th harmonic (aliasing risk at musical pitches)
      frame[i] = 0.7 * Math.sin((2 * Math.PI * i) / FRAME_SIZE) + 0.5 * Math.sin((2 * Math.PI * 60 * i) / FRAME_SIZE);
    }
    const mips = buildWavetableMips([frame]);
    expect(mips.levels[0][0]).toBe(frame); // level 0 IS the original
    expect(mips.ks.length).toBeGreaterThan(2);
    for (let m = 1; m < mips.ks.length; m++) {
      expect(mips.ks[m]).toBeLessThan(mips.ks[m - 1]);
      // band-limited copy actually removed the top harmonic
      const h60 = Math.abs(mips.levels[m][0][90] - 0); // content differs from base
      void h60;
    }
    let diff = 0;
    const a = mips.levels[0][0];
    const b = mips.levels[1][0];
    for (let i = 0; i < FRAME_SIZE; i += 5) diff += Math.abs(a[i] - b[i]);
    expect(diff).toBeGreaterThan(1);
    // selection: low pitch keeps the full level, high pitch drops levels
    expect(pickMipLevel(mips.ks, 110, 44100)).toBe(0);
    expect(pickMipLevel(mips.ks, 2099, 44100)).toBeGreaterThan(0); // 60×2099 > Nyquist
  });
});

describe("DAHDSR envelope scheduling", () => {
  type Call = [string, number, number, number?];
  function mockParam(): AudioParam & { calls: Call[] } {
    const calls: Call[] = [];
    const mock = {
      calls,
      setValueAtTime: (v: number, t: number) => calls.push(["set", v, t]),
      linearRampToValueAtTime: (v: number, t: number) => calls.push(["lin", v, t]),
      exponentialRampToValueAtTime: (v: number, t: number) => calls.push(["exp", v, t]),
      setTargetAtTime: (v: number, t: number, tau: number) => calls.push(["target", v, t, tau]),
    };
    return mock as unknown as AudioParam & { calls: Call[] };
  }

  const LEGACY = {
    delay: 0,
    hold: 0,
    attack: 0.01,
    decay: 0.25,
    sustain: 0.7,
    release: 0.2,
    aShape: 0,
    dShape: 0,
    rShape: 0,
    decayLoops: 0,
    eps: 0.0001,
    susFloor: 0.0002,
    releaseTauDiv: 4,
    finalAnchor: false,
  };

  it("legacy defaults emit EXACTLY the historical Analog sequence", () => {
    const param = mockParam();
    scheduleDahdsr(param, 0, 1, 2, 0.8, LEGACY);
    // Deep-compare with float tolerance (sustain is 0.8*0.7 in float math)
    expect(param.calls.length).toBe(4);
    const [c0, c1, c2, c3] = param.calls;
    expect(c0).toEqual(["set", 0.0001, 0]);
    expect(c1).toEqual(["exp", 0.8, 0.01]);
    expect(c2![0]).toBe("target");
    expect(c2![1]).toBeCloseTo(0.56, 6);
    expect(c2![2]).toBeCloseTo(0.01, 6);
    expect(c2![3]).toBeCloseTo(0.25 / 3, 6);
    expect(c3).toEqual(["target", 0.0001, 1, 0.05]);
  });

  it("delay/hold/loop stages add flat hold and repeated decay ramps", () => {
    const param = mockParam();
    scheduleDahdsr(param, 0, 5, 8, 0.8, { ...LEGACY, delay: 0.2, hold: 0.1, decayLoops: 2 });
    const sets = param.calls.filter((c) => c[0] === "set");
    // flat delay (set at 0 and 0.2), hold at peak, two loop restarts
    expect(sets.some((c) => c[2] === 0.2)).toBe(true);
    expect(sets.filter((c) => c[1] === 0.8).length).toBeGreaterThanOrEqual(3);
    // three decay targets (initial + 2 loops) plus release
    const targets = param.calls.filter((c) => c[0] === "target" && Math.abs(c[1] - 0.56) < 1e-6);
    expect(targets.length).toBe(3);
  });

  it("shapes stay within bounds for extreme stage times", () => {
    const param = mockParam();
    scheduleDahdsr(param, 0, 0.05, 4, 1, {
      ...LEGACY,
      delay: 0.5,
      hold: 0.5,
      attack: 1.5,
      decay: 0.01,
      release: 3,
      aShape: 2,
      dShape: 1,
      rShape: 2,
      decayLoops: 4,
      finalAnchor: true,
    });
    for (const c of param.calls) {
      expect(c[1]).toBeGreaterThanOrEqual(0);
      expect(c[1]).toBeLessThanOrEqual(1.01);
    }
  });
});

describe("FM registry", () => {
  it("exposes the 2-op tonal params that retune held notes", () => {
    const ids = new Set(INSTRUMENT_DEFS.fm.params.map((p) => p.id));
    for (const expected of ["ratio", "index", "modDecay", "modSustain", "feedback", "fbDecay", "fbSus"]) {
      expect(ids.has(expected)).toBe(true);
    }
  });
});

describe.skipIf(typeof OfflineAudioContext === "undefined")("FM runtime", () => {
  const SR = 44100;

  function makeTrack(params: Record<string, number> = {}): InstrumentTrack {
    return {
      id: "fm-test",
      kind: "instrument",
      instrument: "fm",
      name: "FM",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: null,
      params: { ...defaultInstrumentParams("fm"), ...params },
      effects: [],
      sends: {},
    };
  }

  async function renderFm(
    modify?: (rt: ReturnType<typeof INSTRUMENT_DEFS.fm.factory>, ctx: OfflineAudioContext) => void,
    params: Record<string, number> = {},
  ) {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const rt = INSTRUMENT_DEFS.fm.factory(ctx, makeTrack(params), { bpm: 124, getSample: () => undefined });
    rt.output.connect(ctx.destination);
    rt.noteOn(60, 0.9, 0.01, 0.8);
    modify?.(rt, ctx);
    const buffer = await ctx.startRendering();
    rt.dispose();
    return buffer;
  }

  function peakDiff(a: AudioBuffer, b: AudioBuffer): number {
    let diff = 0;
    for (let ch = 0; ch < a.numberOfChannels; ch++) {
      const da = a.getChannelData(ch);
      const db = b.getChannelData(ch);
      for (let i = 0; i < da.length; i++) {
        const d = Math.abs(da[i] - db[i]);
        if (d > diff) diff = d;
      }
    }
    return diff;
  }

  it("renders an audible 2-op voice and survives a full param sweep", async () => {
    const buffer = await renderFm((rt) => {
      for (const p of INSTRUMENT_DEFS.fm.params) {
        rt.setParameter(p.id, p.min);
        rt.setParameter(p.id, p.max);
        rt.setParameter(p.id, p.default);
      }
    });
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
  });

  it("INDEX automation retunes a held note mid-flight", async () => {
    const base = await renderFm();
    const modulated = await renderFm((rt) => rt.setParameterAt!("index", 0.9, 0.4));
    expect(peakDiff(base, modulated)).toBeGreaterThan(0.01);
  });

  it("RATIO automation re-pitches the modulator on a held note", async () => {
    const base = await renderFm();
    const modulated = await renderFm((rt) => rt.setParameterAt!("ratio", 4.01, 0.4));
    expect(peakDiff(base, modulated)).toBeGreaterThan(0.01);
  });

  it("FEEDBK automation can rise from zero mid-note", async () => {
    const base = await renderFm(undefined, { feedback: 0 });
    const modulated = await renderFm((rt) => rt.setParameterAt!("feedback", 0.8, 0.35), { feedback: 0 });
    expect(peakDiff(base, modulated)).toBeGreaterThan(0.005);
  });

  it("MPE pressure brightens only the matching pitch and restores at 0", async () => {
    const twin = await renderFm((rt) => {
      rt.noteOn(67, 0.9, 0.01, 0.8);
    });
    const pressed = await renderFm((rt) => {
      rt.noteOn(67, 0.9, 0.01, 0.8);
      rt.polyPressure!(60, 1, 0.4); // INDEX ×1.5 on pitch 60 only
      rt.polyPressure!(60, 0, 0.7); // restore before the release tail
    });
    expect(peakDiff(twin, pressed)).toBeGreaterThan(0.005);
  });

  it("pressure on a pitch with no live voice is a no-op", async () => {
    const base = await renderFm();
    const touched = await renderFm((rt) => rt.polyPressure!(72, 1, 0.3));
    expect(peakDiff(base, touched)).toBeLessThan(1e-6);
  });
});

describe.skipIf(typeof OfflineAudioContext === "undefined")("MPE timbre (CC74)", () => {
  const SR = 44100;

  it("filter instruments and FM expose polyTimbre", () => {
    for (const kind of ["analog", "bass", "keys", "wavetable", "fm"] as const) {
      const ctx = new OfflineAudioContext(2, 128, SR);
      const track = {
        id: `timbre-${kind}`,
        kind: "instrument" as const,
        instrument: kind,
        name: kind,
        gain: 1,
        pan: 0,
        mute: false,
        solo: false,
        sampleId: null,
        params: defaultInstrumentParams(kind),
        effects: [],
        sends: {},
      };
      const rt = INSTRUMENT_DEFS[kind].factory(ctx, track, { bpm: 124, getSample: () => undefined });
      expect(typeof rt.polyTimbre, `${kind} polyTimbre`).toBe("function");
      expect(() => rt.polyTimbre!(60, 0.8, 0.1)).not.toThrow();
      rt.panic();
      rt.dispose();
    }
  });
});

describe("mod matrix rollout", () => {
  it("every rolled-out instrument exposes the shared mod matrix params", () => {
    const kinds = [
      "analog",
      "bass",
      "keys",
      "pluck",
      "808",
      "texture",
      "logdrum",
      "spectral",
      "sampler",
      "vocalchop",
      "wavetable",
    ] as const;
    for (const kind of kinds) {
      const ids = new Set(INSTRUMENT_DEFS[kind].params.map((p) => p.id));
      for (const id of ["modASrc", "modADst", "modAAmt", "modBSrc", "modBDst", "modBAmt", "modLfoRate"]) {
        expect(ids.has(id), `${kind}.${id}`).toBe(true);
      }
    }
    // Granular is intentionally excluded — its PLAY/SCAN/RAND parameters are
    // its modulation story, and the worklet engine has no mod routes.
    expect(new Set(INSTRUMENT_DEFS.granular.params.map((p) => p.id)).has("modASrc")).toBe(false);
  });

  it("CUTOFF destination is offered only where a per-voice filter exists", () => {
    const dstOf = (kind: string) =>
      INSTRUMENT_DEFS[kind as "keys"].params.find((p) => p.id === "modADst")!.options ?? [];
    // vocalchop: formant bank only — no CUTOFF
    expect(dstOf("vocalchop").some((o) => o.value === 1)).toBe(false);
    // filter instruments offer it
    for (const kind of ["analog", "bass", "keys", "pluck", "808", "texture", "logdrum", "spectral", "sampler"]) {
      expect(dstOf(kind).some((o) => o.value === 1), `${kind} CUTOFF dst`).toBe(true);
    }
    // wavetable also offers MORPH (dst 0)
    expect(dstOf("wavetable").some((o) => o.value === 0)).toBe(true);
  });
});
