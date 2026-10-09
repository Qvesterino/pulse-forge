import { describe, expect, it } from "vitest";
import { factoryPresets, warmFactoryPresets } from "../src/presets/factory-loader";
// The pack seam (2026-10-04): the full bank = core + real-instrument packs,
// assembled by the loader's warm — same presets as before the seam.
const FACTORY_PRESETS = await warmFactoryPresets().then(() => factoryPresets());
import { getPresetMetadata, PRESET_ENERGIES, PRESET_USE_CASES } from "../src/presets/catalog";
import type { InstrumentPreset } from "../src/presets/types";
import { INSTRUMENT_DEFS, defaultInstrumentParams } from "../src/instruments/registry";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { applyInstrumentPreset } from "../src/commands/commands";
import type { InstrumentTrack, ProjectDocument } from "../src/project-model/types";
import { CORE_EFFECT_PRESETS } from "../src/effects/presets";

function trackFor(instrument: InstrumentPreset["instrument"]): { doc: ProjectDocument; track: InstrumentTrack } {
  const doc = createProjectFromTemplate("empty");
  const track: InstrumentTrack = {
    id: `track-${instrument}`,
    kind: "instrument",
    instrument,
    name: "Test",
    gain: 0.85,
    pan: 0,
    mute: false,
    solo: false,
    sampleId: null,
    params: defaultInstrumentParams(instrument),
    effects: [],
    sends: {},
  };
  return { doc: { ...doc, tracks: [...doc.tracks, track] }, track };
}

describe("factory presets", () => {
  it("has unique ids and names per instrument", () => {
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const preset of FACTORY_PRESETS) {
      expect(ids.has(preset.id)).toBe(false);
      ids.add(preset.id);
      const nameKey = `${preset.instrument}:${preset.name}`;
      expect(names.has(nameKey)).toBe(false);
      names.add(nameKey);
    }
  });

  it("covers every implemented instrument", () => {
    const instruments = new Set(FACTORY_PRESETS.map((p) => p.instrument));
    for (const kind of ["sampler", "analog", "bass", "808", "texture"] as const) {
      expect(instruments.has(kind)).toBe(true);
    }
  });

  it("every preset's params exist and fall inside the instrument's defined ranges", () => {
    for (const preset of FACTORY_PRESETS) {
      const defs = INSTRUMENT_DEFS[preset.instrument].params;
      for (const [id, value] of Object.entries(preset.params)) {
        const def = defs.find((p) => p.id === id);
        expect(def, `preset ${preset.id} param ${id}`).toBeDefined();
        expect(value, `preset ${preset.id} param ${id}`).toBeGreaterThanOrEqual(def!.min);
        expect(value, `preset ${preset.id} param ${id}`).toBeLessThanOrEqual(def!.max);
      }
    }
  });

  it("sample-driven presets reference a real sample (bank asset or pack zone)", async () => {
    const { FACTORY_ASSETS } = await import("../src/sample-library/manifest");
    const bankIds = new Set(FACTORY_ASSETS.map((a) => a.id));
    for (const preset of FACTORY_PRESETS.filter((p) => ["sampler", "granular", "vocalchop"].includes(p.instrument))) {
      expect(preset.sampleId).toBeTruthy();
      const id = preset.sampleId as string;
      // Real-instrument pack zones (Salamander piano, VSCO2 round robins)
      // resolve through their pack loaders; everything else must be a bank
      // asset. A frozen id enumeration would rot on every expand wave — the
      // 808/lead/world-perc voices already proved that.
      const isPackZone = /^factory\.(piano\.[a-gs]+\d\.z[1-4]|vsco\.[a-z][a-z0-9-]*\.r\d+)$/.test(id);
      expect(isPackZone || bankIds.has(id), `preset ${preset.id} sample ${id}`).toBe(true);
    }
  });

  it("every genre tag is a known genre", () => {
    const genres = new Set(["house", "techno", "trap", "ambient", "score", "drill", "phonk", "jersey", "dnb", null]);
    for (const preset of FACTORY_PRESETS) {
      expect(genres.has(preset.genre)).toBe(true);
    }
  });

  it("every factory preset declares mood tags within the known set", () => {
    const moods = new Set(["dark", "bright", "warm", "aggressive", "clean", "deep", "atmosphere"]);
    for (const preset of FACTORY_PRESETS) {
      expect(preset.mood.length).toBeGreaterThan(0);
      for (const m of preset.mood) expect(moods.has(m)).toBe(true);
    }
  });

  it("every factory preset has deterministic discovery and provenance metadata", () => {
    for (const preset of FACTORY_PRESETS) {
      const first = getPresetMetadata(preset);
      const second = getPresetMetadata(preset);
      expect(second).toEqual(first);
      expect(PRESET_USE_CASES).toContain(first.useCase);
      expect(PRESET_ENERGIES).toContain(first.energy);
      expect(first.keySuitability).toBe("any");
      expect(first.bpmRange.min).toBeGreaterThanOrEqual(20);
      expect(first.bpmRange.max).toBeLessThanOrEqual(300);
      expect(first.bpmRange.min).toBeLessThanOrEqual(first.bpmRange.max);
      expect(first.source).toBe("KYX factory");
      expect(first.license).toBe("internal");
    }
  });

  it("re-derives metadata when persisted user data is incomplete", () => {
    const source = FACTORY_PRESETS[0];
    const malformed = { ...source, metadata: {} } as InstrumentPreset;

    expect(() => getPresetMetadata(malformed)).not.toThrow();
    expect(getPresetMetadata(malformed)).toEqual(getPresetMetadata(source));
  });
});

describe("applyInstrumentPreset command", () => {
  it("applies params, sample and preset id in one step", () => {
    const preset = FACTORY_PRESETS.find((p) => p.instrument === "bass")!;
    const { doc, track } = trackFor("bass");
    const next = applyInstrumentPreset(doc, track.id, preset).execute(doc);
    const applied = next.tracks.find((t) => t.id === track.id) as InstrumentTrack;
    expect(applied.presetId).toBe(preset.id);
    for (const [id, value] of Object.entries(preset.params)) {
      expect(applied.params[id]).toBe(value);
    }
  });

  it("resets omitted sparse-preset params to instrument defaults", () => {
    const { doc, track } = trackFor("analog");
    const defaults = defaultInstrumentParams("analog");
    const previous = {
      ...track,
      params: {
        ...defaults,
        cutoff: 15000,
        resonance: 18,
        modAAmt: 0.9,
      },
    };
    const editedDoc: ProjectDocument = {
      ...doc,
      tracks: doc.tracks.map((candidate) => (candidate.id === track.id ? previous : candidate)),
    };
    const sparse: InstrumentPreset = {
      id: "sparse-analog",
      name: "Sparse Analog",
      instrument: "analog",
      genre: "house",
      mood: ["clean"],
      tags: ["test"],
      params: { cutoff: 1200 },
    };

    const next = applyInstrumentPreset(editedDoc, track.id, sparse).execute(editedDoc);
    const applied = next.tracks.find((candidate) => candidate.id === track.id) as InstrumentTrack;

    expect(applied.params.cutoff).toBe(1200);
    expect(applied.params.resonance).toBe(defaults.resonance);
    expect(applied.params.modAAmt).toBe(defaults.modAAmt);
    expect(Object.keys(applied.params).sort()).toEqual(Object.keys(defaults).sort());
  });

  it("undo restores previous params, sample and preset id", () => {
    const preset = FACTORY_PRESETS.find((p) => p.instrument === "analog")!;
    const { doc, track } = trackFor("analog");
    const command = applyInstrumentPreset(doc, track.id, preset);
    const next = command.execute(doc);
    const undone = command.undo(next);
    const restored = undone.tracks.find((t) => t.id === track.id) as InstrumentTrack;
    expect(restored.params).toEqual(track.params);
    expect(restored.sampleId).toBe(track.sampleId);
    expect(restored.presetId ?? null).toBeNull();
  });

  it("sampler presets swap the sample id; non-sampler presets leave it alone", () => {
    const samplerPreset = FACTORY_PRESETS.find((p) => p.instrument === "sampler")!;
    const { doc, track } = trackFor("sampler");
    const next = applyInstrumentPreset(doc, track.id, samplerPreset).execute(doc);
    const applied = next.tracks.find((t) => t.id === track.id) as InstrumentTrack;
    expect(applied.sampleId).toBe(samplerPreset.sampleId);

    const bassPreset = FACTORY_PRESETS.find((p) => p.instrument === "bass")!;
    const bassCtx = trackFor("bass");
    const bassNext = applyInstrumentPreset(bassCtx.doc, bassCtx.track.id, bassPreset).execute(bassCtx.doc);
    const bassApplied = bassNext.tracks.find((t) => t.id === bassCtx.track.id) as InstrumentTrack;
    expect(bassApplied.sampleId).toBeNull();
  });

  it("clamps out-of-range preset values instead of failing", () => {
    const { doc, track } = trackFor("808");
    const wild: InstrumentPreset = {
      id: "wild",
      name: "Wild",
      instrument: "808",
      genre: null,
      mood: [],
      tags: [],
      params: { decay: 999, pitchDrop: -5, gain: 0.5 },
    };
    const next = applyInstrumentPreset(doc, track.id, wild).execute(doc);
    const applied = next.tracks.find((t) => t.id === track.id) as InstrumentTrack;
    const decayDef = INSTRUMENT_DEFS["808"].params.find((p) => p.id === "decay")!;
    const dropDef = INSTRUMENT_DEFS["808"].params.find((p) => p.id === "pitchDrop")!;
    expect(applied.params.decay).toBe(decayDef.max);
    expect(applied.params.pitchDrop).toBe(dropDef.min);
    expect(applied.params.gain).toBe(0.5);
  });

  it("throws for a missing track", () => {
    const { doc } = trackFor("bass");
    const preset = FACTORY_PRESETS.find((p) => p.instrument === "bass")!;
    expect(() => applyInstrumentPreset(doc, "nope", preset)).toThrow();
  });
});

describe("southern specialties + eski wave (signature sounds)", () => {
  it("plugg bell is a bright koto/bell pluck for the plugg lane", () => {
    const bell = FACTORY_PRESETS.find((p) => p.id === "factory.pluck.trap.pluggbell")!;
    expect(bell).toBeDefined();
    expect(bell.genre).toBe("trap");
    expect(bell.tags).toContain("plugg");
    expect(getPresetMetadata(bell).useCase).toBe("pluck");
  });

  it("eski lead is a cold detuned square for the grime lane", () => {
    const eski = FACTORY_PRESETS.find((p) => p.id === "factory.analog.drill.eskilead")!;
    expect(eski).toBeDefined();
    expect(eski.params.oscA).toBe(3);
    expect(eski.params.oscB).toBe(3);
    expect(getPresetMetadata(eski).useCase).toBe("lead");
  });

  it("electro snare + triggerman set ride the drumsynth engine", () => {
    for (const id of [
      "factory.drumsynth.trap.electrosnare",
      "factory.drumsynth.trap.triggclave",
      "factory.drumsynth.trap.nolawhistle",
    ]) {
      const preset = FACTORY_PRESETS.find((p) => p.id === id)!;
      expect(preset, id).toBeDefined();
      expect(preset.instrument).toBe("drumsynth");
      expect(preset.genre).toBe("trap");
    }
  });

  it("syrup chain presets exist in order: pitch −3 → vinyl → dark LP", () => {
    const ids = CORE_EFFECT_PRESETS.map((p) => p.id);
    for (const id of ["pitchshift-syrup", "vinyl-syrup", "svf-syrup-dark"]) {
      expect(ids).toContain(id);
    }
    const pitch = CORE_EFFECT_PRESETS.find((p) => p.id === "pitchshift-syrup")!;
    expect(pitch.params.semitones).toBe(-3);
    const lp = CORE_EFFECT_PRESETS.find((p) => p.id === "svf-syrup-dark")!;
    expect(lp.params.mode).toBe(0);
  });
});
