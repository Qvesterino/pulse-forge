import { describe, expect, it } from "vitest";
import { FACTORY_PRESETS } from "../src/presets/factory";
import type { InstrumentPreset } from "../src/presets/types";
import { INSTRUMENT_DEFS, defaultInstrumentParams } from "../src/instruments/registry";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { applyInstrumentPreset } from "../src/commands/commands";
import type { InstrumentTrack, ProjectDocument } from "../src/project-model/types";

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

  it("sampler presets reference a real tonal factory sample", () => {
    for (const preset of FACTORY_PRESETS.filter((p) => p.instrument === "sampler")) {
      expect(preset.sampleId).toBeTruthy();
      expect(preset.sampleId).toMatch(/^factory\.tonal\./);
    }
  });

  it("every genre tag is a known genre", () => {
    const genres = new Set(["house", "techno", "trap", "ambient", "score", null]);
    for (const preset of FACTORY_PRESETS) {
      expect(genres.has(preset.genre)).toBe(true);
    }
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
