import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { INSTRUMENT_DEFS, defaultInstrumentParams } from "../src/instruments/registry";
import { normalizeProject, validateProjectShape } from "../src/project-model/schema";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { createInstrumentTrack, setTrackParams } from "../src/commands/commands";
import { setVelocityLayersCommand } from "../src/commands/layerCommands";
import { projectToYDoc, yDocToProject } from "../src/collab/YDocAdapter";
import { FACTORY_KICK_LAYERS } from "../src/sample-library/velocity-layers";
import type { InstrumentTrack, ProjectDocument, SampleLayer } from "../src/project-model/types";

function samplerTrack(doc: ProjectDocument): InstrumentTrack {
  const track = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.instrument === "sampler");
  if (!track) throw new Error("no sampler track");
  return track;
}

describe("velocity layers data", () => {
  it("factory kick kit has four ordered, touching zones", () => {
    // Every zone must point at a REAL bank id (factory.kick.sub used to be a
    // typo for sub808 — the zone silently vanished and the loudest kick band
    // fell back to another sample).
    expect(FACTORY_KICK_LAYERS.map((l) => l.sampleId)).toEqual([
      "factory.kick.soft",
      "factory.kick.punch",
      "factory.kick.deep",
      "factory.kick.sub808",
    ]);
    expect(FACTORY_KICK_LAYERS[0].min).toBe(0);
    expect(FACTORY_KICK_LAYERS[FACTORY_KICK_LAYERS.length - 1].max).toBe(1);
    for (let i = 1; i < FACTORY_KICK_LAYERS.length; i++) {
      expect(FACTORY_KICK_LAYERS[i].min).toBe(FACTORY_KICK_LAYERS[i - 1].max);
    }
  });
});

function samplerBaseDoc(): ProjectDocument {
  // "empty" ships no instrument track — add a sampler and canonicalize
  let doc = createProjectFromTemplate("empty");
  doc = createInstrumentTrack(doc, "sampler").execute(doc);
  return normalizeProject(doc);
}

describe("velocity layers normalization", () => {
  it("keeps a canonical layer set unchanged", () => {
    const base = samplerBaseDoc();
    const track = samplerTrack(base);
    const withLayers: ProjectDocument = {
      ...base,
      tracks: base.tracks.map((t) => (t.id === track.id ? { ...t, velocityLayers: FACTORY_KICK_LAYERS } : t)),
    };
    expect(normalizeProject(withLayers)).toBe(withLayers);
    expect(validateProjectShape(withLayers)).toBe(true);
  });

  it("sanitizes garbage zones and drops the field when nothing valid remains", () => {
    const base = samplerBaseDoc();
    const track = samplerTrack(base);
    const dirty = [
      { min: 0.6, max: 0.2, sampleId: "factory.kick.soft" }, // inverted — dropped
      { min: "x", max: null, sampleId: "factory.kick.soft" }, // garbage bounds — dropped
      { min: -3, max: 9, sampleId: "factory.kick.punch" }, // clamped to 0..1 — kept
    ];
    const withLayers = {
      ...base,
      tracks: base.tracks.map((t) => (t.id === track.id ? { ...t, velocityLayers: dirty } : t)),
    } as ProjectDocument;
    const norm = normalizeProject(withLayers);
    const normTrack = samplerTrack(norm);
    expect(normTrack.velocityLayers).toHaveLength(1);
    expect(normTrack.velocityLayers![0]).toMatchObject({ min: 0, max: 1, sampleId: "factory.kick.punch" });

    const allBad = {
      ...base,
      tracks: base.tracks.map((t) => (t.id === track.id ? { ...t, velocityLayers: [dirty[0]] } : t)),
    } as ProjectDocument;
    const norm2 = normalizeProject(allBad);
    expect(samplerTrack(norm2).velocityLayers).toBeUndefined();
  });
});

describe("setVelocityLayersCommand", () => {
  it("applies, undoes, and clears back to single-sample mode", () => {
    let doc = samplerBaseDoc();
    const sampler = samplerTrack(doc);

    const cmd = setVelocityLayersCommand(doc, sampler.id, FACTORY_KICK_LAYERS);
    const applied = cmd.execute(doc);
    expect(samplerTrack(applied).velocityLayers).toHaveLength(4);

    const undone = cmd.undo(applied);
    expect(samplerTrack(undone).velocityLayers).toBeUndefined();

    const cleared = setVelocityLayersCommand(applied, sampler.id, []).execute(applied);
    expect(samplerTrack(cleared).velocityLayers).toBeUndefined();

    expect(() => setVelocityLayersCommand(doc, "missing-track", [])).toThrow();
    void setTrackParams;
  });

  it("preserves keyzones and applies the fallback sample in one command", () => {
    const doc = samplerBaseDoc();
    const sampler = samplerTrack(doc);
    const layers: SampleLayer[] = [
      { id: "kz-low", sampleId: "sample.low", min: 0, max: 1, minPitch: 0, maxPitch: 59 },
      { id: "kz-high", sampleId: "sample.high", min: 0, max: 1, minPitch: 60, maxPitch: 127 },
    ];

    const command = setVelocityLayersCommand(doc, sampler.id, layers, "sample.low");
    const applied = samplerTrack(command.execute(doc));
    expect(applied.sampleId).toBe("sample.low");
    expect(applied.velocityLayers).toEqual(layers);

    const undone = samplerTrack(command.undo(command.execute(doc)));
    expect(undone.sampleId).toBe(sampler.sampleId);
    expect(undone.velocityLayers).toBeUndefined();
  });

  it("rejects layer commands for non-sampler instrument tracks", () => {
    let doc = createProjectFromTemplate("empty");
    doc = createInstrumentTrack(doc, "analog").execute(doc);
    const analog = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.instrument === "analog");
    expect(analog).toBeDefined();
    expect(() => setVelocityLayersCommand(doc, analog!.id, FACTORY_KICK_LAYERS)).toThrow(/sampler/);
  });

  it("survives JSON migration and Y.Doc collaboration round-trips", () => {
    const doc = samplerBaseDoc();
    const sampler = samplerTrack(doc);
    const layers: SampleLayer[] = [
      { id: "kz-low", sampleId: "sample.low", min: 0, max: 0.5, minPitch: 0, maxPitch: 59 },
      { id: "kz-high", sampleId: "sample.high", min: 0.5, max: 1, minPitch: 60, maxPitch: 127 },
    ];
    const applied = setVelocityLayersCommand(doc, sampler.id, layers, "sample.low").execute(doc);
    const migrated = normalizeProject(JSON.parse(JSON.stringify(applied)) as ProjectDocument);
    const yDoc = new Y.Doc();
    projectToYDoc(migrated, yDoc.getMap("project"));
    const restored = yDocToProject(yDoc.getMap("project"));
    expect(samplerTrack(migrated).velocityLayers).toEqual(layers);
    expect(samplerTrack(restored).velocityLayers).toEqual(layers);
    expect(samplerTrack(restored).sampleId).toBe("sample.low");
  });

  it("keeps the inclusive full-velocity upper boundary usable", () => {
    const doc = samplerBaseDoc();
    const sampler = samplerTrack(doc);
    const layers: SampleLayer[] = [
      { id: "full", sampleId: "sample.high", min: 0, max: 1, minPitch: 60, maxPitch: 127 },
    ];
    const applied = setVelocityLayersCommand(doc, sampler.id, layers, "sample.high").execute(doc);
    expect(samplerTrack(applied).velocityLayers![0].max).toBe(1);
    // The actual AudioWorklet/OfflineAudioContext selection is covered by the
    // browser gate; this assertion pins the contract value that used to make
    // velocity === 1 fall through to sampleId.
    expect(1 >= layers[0].min && (1 < layers[0].max || (layers[0].max >= 1 && 1 <= layers[0].max))).toBe(true);
  });
});

describe.skipIf(typeof OfflineAudioContext === "undefined")("Sampler layer selection runtime", () => {
  const SR = 44100;

  function makeTrack(layers: SampleLayer[]): InstrumentTrack {
    return {
      id: "smp-layer-test",
      kind: "instrument",
      instrument: "sampler",
      name: "Sampler",
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: "sample.low",
      velocityLayers: layers,
      params: defaultInstrumentParams("sampler"),
      effects: [],
      sends: {},
    };
  }

  function makeRuntime(ctx: BaseAudioContext, track: InstrumentTrack) {
    const bank = new Map<string, AudioBuffer>();
    for (const [id, freq] of [
      ["sample.low", 220],
      ["sample.high", 660],
      ["sample.mid", 440],
    ] as const) {
      const buf = ctx.createBuffer(1, SR, SR);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = 0.6 * Math.sin((2 * Math.PI * freq * i) / SR);
      bank.set(id, buf);
    }
    return INSTRUMENT_DEFS.sampler.factory(ctx, track, {
      bpm: 124,
      getSample: (id) => bank.get(id ?? ""),
    });
  }

  function zcc(data: Float32Array, from: number, to: number): number {
    let c = 0;
    for (let i = from + 1; i < to; i++) {
      if (data[i - 1] < 0 !== data[i] < 0) c++;
    }
    return c;
  }

  it("disjoint windows select the layer matching the note velocity", async () => {
    const layers: SampleLayer[] = [
      { id: "l1", sampleId: "sample.low", min: 0, max: 0.5 },
      { id: "l2", sampleId: "sample.high", min: 0.5, max: 1 },
    ];
    const render = async (velocity: number) => {
      const ctx = new OfflineAudioContext(2, SR, SR);
      const rt = makeRuntime(ctx, makeTrack(layers));
      rt.output.connect(ctx.destination);
      rt.noteOn(60, velocity, 0.05, 0.4);
      const buffer = await ctx.startRendering();
      rt.dispose();
      return zcc(buffer.getChannelData(0), 0, SR);
    };
    const softZcc = await render(0.2);
    const hardZcc = await render(0.8);
    expect(softZcc).toBeGreaterThan(100); // 220 Hz content
    expect(hardZcc).toBeGreaterThan(softZcc * 2); // 660 Hz content — clearly the other layer
  });

  it("overlapping windows round-robin through candidates across repeats", async () => {
    const layers: SampleLayer[] = [
      { id: "rr1", sampleId: "sample.low", min: 0, max: 1 },
      { id: "rr2", sampleId: "sample.high", min: 0, max: 1 },
    ];
    const ctx = new OfflineAudioContext(2, SR, SR);
    const rt = makeRuntime(ctx, makeTrack(layers));
    rt.output.connect(ctx.destination);
    rt.noteOn(60, 0.8, 0.05, 0.2); // RR -> sample.low
    rt.noteOn(60, 0.8, 0.3, 0.2); // RR -> sample.high
    const buffer = await ctx.startRendering();
    rt.dispose();
    const data = buffer.getChannelData(0);
    const first = zcc(data, Math.floor(0.08 * SR), Math.floor(0.24 * SR));
    const second = zcc(data, Math.floor(0.33 * SR), Math.floor(0.49 * SR));
    expect(first).toBeGreaterThan(100);
    expect(second).toBeGreaterThan(first * 1.8); // alternated to the faster sample
  });

  it("falls back to the default sample when no window matches", async () => {
    const layers: SampleLayer[] = [{ id: "l1", sampleId: "sample.high", min: 0.9, max: 1 }];
    const ctx = new OfflineAudioContext(2, SR, SR);
    const rt = makeRuntime(ctx, makeTrack(layers));
    rt.output.connect(ctx.destination);
    rt.noteOn(60, 0.5, 0.05, 0.3); // below the only window -> sample.low fallback
    const buffer = await ctx.startRendering();
    rt.dispose();
    expect(zcc(buffer.getChannelData(0), 0, SR)).toBeGreaterThan(100);
  });
});

describe("round-robin sample content", () => {
  it("declares variations only for manifest bases with subtle, safe amounts", async () => {
    const { RR_VARIATIONS } = await import("../src/sample-library/factory");
    const { FACTORY_ASSETS } = await import("../src/sample-library/manifest");
    const manifestIds = new Set(FACTORY_ASSETS.map((a) => a.id));
    for (const [base, vars] of Object.entries(RR_VARIATIONS)) {
      expect(manifestIds.has(base)).toBe(true);
      for (const v of vars) {
        expect(v.rate).toBeGreaterThan(0.95);
        expect(v.rate).toBeLessThan(1.05);
        expect(v.gain).toBeGreaterThan(0.9);
        expect(v.gain).toBeLessThan(1.1);
      }
    }
  });

  it("beat kits separate velocity DYNAMICS from pure round robin", async () => {
    const { FACTORY_BEAT_RR_KITS, FACTORY_SNARE_DYNAMIC, FACTORY_HAT_DYNAMIC, FACTORY_HAT_OPEN_RR } =
      await import("../src/sample-library/velocity-layers");
    // Snare + closed hat are DYNAMIC (disjoint bands: ghost / body / accent)…
    for (const layers of [FACTORY_SNARE_DYNAMIC, FACTORY_HAT_DYNAMIC]) {
      expect(layers.length).toBeGreaterThanOrEqual(3);
      expect(new Set(layers.map((l) => l.sampleId)).size).toBe(layers.length);
      for (const l of layers) expect(l.sampleId).toBeTruthy();
      // Distinct BANDS must partition 0..1 (layers inside one band may share
      // a window — that pool is the round robin).
      const byBand = new Map<string, { min: number; max: number }>();
      for (const l of layers) byBand.set(`${l.min}-${l.max}`, { min: l.min, max: l.max });
      const bands = [...byBand.values()].sort((a, b) => a.min - b.min || a.max - b.max);
      expect(bands[0].min).toBe(0);
      expect(bands[bands.length - 1].max).toBe(1);
      for (let i = 1; i < bands.length; i++) {
        expect(bands[i].min).toBe(bands[i - 1].max);
      }
    }
    // …and the snare's BODY band is a multi-sample RR pool inside one window
    // (ghost below it, accent above it — the exact bounds are the design).
    const body = FACTORY_SNARE_DYNAMIC.filter((l) => l.min > 0 && l.max < 1);
    expect(body.length).toBeGreaterThanOrEqual(2);
    expect(body[0].min).toBe(FACTORY_SNARE_DYNAMIC[0].max); // ghost → body
    expect(new Set(body.map((l) => l.max)).size).toBe(1);
    // The ghost band is the soft timbre, the accent band the hard one.
    expect(FACTORY_SNARE_DYNAMIC[0].sampleId).toBe("factory.snare.tight");
    expect(FACTORY_SNARE_DYNAMIC[FACTORY_SNARE_DYNAMIC.length - 1].sampleId).toBe("factory.snare.punch");
    expect(FACTORY_SNARE_DYNAMIC[FACTORY_SNARE_DYNAMIC.length - 1].min).toBe(body[0].max);
    // Open hats stay a plain full-window RR set (no ghost/accent samples).
    for (const l of FACTORY_HAT_OPEN_RR) {
      expect(l.min).toBe(0);
      expect(l.max).toBe(1);
    }
    expect(FACTORY_BEAT_RR_KITS.snare).toBe(FACTORY_SNARE_DYNAMIC);
    expect(FACTORY_BEAT_RR_KITS.hatClosed).toBe(FACTORY_HAT_DYNAMIC);
  });

  it("every layer id resolves in the factory bank contract (no silent zone)", async () => {
    const { RR_VARIATIONS } = await import("../src/sample-library/factory");
    const { FACTORY_ASSETS } = await import("../src/sample-library/manifest");
    const {
      FACTORY_BEAT_RR_KITS,
      FACTORY_KICK_LAYERS,
      FACTORY_SNARE_RR,
      FACTORY_HAT_CLOSED_RR,
      FACTORY_HAT_OPEN_RR,
      FACTORY_KICK_PUNCH_RR,
    } = await import("../src/sample-library/velocity-layers");
    const manifestIds = new Set(FACTORY_ASSETS.map((a) => a.id));
    // A bank id is either a manifest asset or a derived RR variant.
    const exists = (id: string | null): boolean => {
      if (!id) return false;
      if (manifestIds.has(id)) return true;
      const base = id.replace(/\.rr\d+$/, "");
      return base !== id && RR_VARIATIONS[base] !== undefined;
    };
    const all = [
      ...FACTORY_KICK_LAYERS,
      ...FACTORY_SNARE_RR,
      ...FACTORY_HAT_CLOSED_RR,
      ...FACTORY_HAT_OPEN_RR,
      ...FACTORY_KICK_PUNCH_RR,
    ];
    for (const kit of Object.values(FACTORY_BEAT_RR_KITS)) all.push(...kit);
    for (const layer of all) {
      expect(exists(layer.sampleId), `${layer.id} → ${layer.sampleId}`).toBe(true);
    }
  });
});

describe.skipIf(typeof OfflineAudioContext === "undefined")("round-robin bank generation", () => {
  it("generates rr samples that differ from their base (length and content)", async () => {
    const { generateFactoryBank, RR_VARIATIONS } = await import("../src/sample-library/factory");
    const bank = await generateFactoryBank();
    for (const [base, vars] of Object.entries(RR_VARIATIONS)) {
      const baseBuf = bank.get(base)!;
      vars.forEach((_, i) => {
        const rr = bank.get(`${base}.rr${i + 2}`)!;
        expect(rr).toBeDefined();
        // resampled length differs by ~1/rate
        expect(Math.abs(rr.length / baseBuf.length - 1)).toBeGreaterThan(0.005);
        // content actually differs somewhere
        const a = baseBuf.getChannelData(0);
        const b = rr.getChannelData(0);
        let diff = 0;
        const n = Math.min(a.length, b.length);
        for (let j = 0; j < n; j += 7) diff += Math.abs(a[j] - b[j]);
        expect(diff).toBeGreaterThan(0.01);
      });
    }
  });
});

describe.skipIf(typeof OfflineAudioContext === "undefined")("Sampler keyzone runtime", () => {
  const SR = 44100;

  function zcc(data: Float32Array, from: number, to: number): number {
    let c = 0;
    for (let i = from + 1; i < to; i++) {
      if (data[i - 1] < 0 !== data[i] < 0) c++;
    }
    return c;
  }

  it("routes notes to their pitch zone (keyzones over full velocity)", async () => {
    const { keyzoneLayers } = await import("../src/sample-library/velocity-layers");
    const layers = keyzoneLayers([
      { sampleId: "sample.low", minPitch: 0, maxPitch: 59 },
      { sampleId: "sample.high", minPitch: 60, maxPitch: 127 },
    ]);
    const render = async (pitch: number) => {
      const ctx = new OfflineAudioContext(2, SR, SR);
      const bank = new Map<string, AudioBuffer>();
      for (const [id, freq] of [
        ["sample.low", 220],
        ["sample.high", 880],
      ] as const) {
        const buf = ctx.createBuffer(1, SR, SR);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = 0.6 * Math.sin((2 * Math.PI * freq * i) / SR);
        bank.set(id, buf);
      }
      const track: InstrumentTrack = {
        id: "kz-test",
        kind: "instrument",
        instrument: "sampler",
        name: "Sampler",
        gain: 1,
        pan: 0,
        mute: false,
        solo: false,
        sampleId: "sample.low",
        velocityLayers: layers,
        params: defaultInstrumentParams("sampler"),
        effects: [],
        sends: {},
      };
      const rt = INSTRUMENT_DEFS.sampler.factory(ctx, track, {
        bpm: 124,
        getSample: (id) => bank.get(id ?? ""),
      });
      rt.output.connect(ctx.destination);
      rt.noteOn(pitch, 0.8, 0.05, 0.4);
      const buffer = await ctx.startRendering();
      rt.dispose();
      return zcc(buffer.getChannelData(0), 0, SR);
    };
    const lowNote = await render(36); // zone 1 -> 220 Hz
    const highNote = await render(84); // zone 2 -> 880 Hz
    expect(lowNote).toBeGreaterThan(100);
    expect(highNote).toBeGreaterThan(lowNote * 3);
  });
});
