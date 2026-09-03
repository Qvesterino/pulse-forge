import { describe, expect, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import {
  addArrangementClip,
  addAutomationLane,
  addAutomationPoint,
  addLfo,
  addMacroMapping,
  addEffect,
  addNote,
  clearPattern,
  chopSampleToPads,
  createDrumTrack,
  sliceToPads,
  applyFxEqPreset,
  applyUltinaPreset,
  applyUltinaProposal,
  setUltinaParam,
  setFxEqParam,
  createInstrumentTrack,
  createPattern,
  createScene,
  deleteArrangementClip,
  deleteNote,
  deletePattern,
  deleteScene,
  deleteTrack,
  duplicateArrangementClip,
  duplicatePattern,
  moveArrangementClip,
  moveAutomationPoint,
  moveEffect,
  moveNote,
  pastePattern,
  removeEffect,
  resetPadSlice,
  removeLfo,
  renamePattern,
  renameScene,
  resizeArrangementClip,
  resizeNote,
  setActivePattern,
  setBpm,
  setEffectParam,
  setInstrumentParam,
  setInstrumentSample,
  setLfoParams,
  setMacroMappingAmount,
  setMacroValue,
  setNoteVelocity,
  setPadParams,
  setPatternLength,
  setProjectName,
  setScenePattern,
  setStepVelocityCommand,
  setTrackParams,
  toggleEffectBypass,
  toggleStep,
} from "../src/commands/commands";
import { ProjectStore } from "../src/store/ProjectStore";
import { FACTORY_PRESETS } from "../src/effects/ultina-core/presets/factoryPresets";
import { getDrumTrack } from "../src/project-model/types";

describe("commands", () => {
  it("toggleStep adds and removes a step, with undo", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const pad = getDrumTrack(doc).pads[0];
    const before = store.doc.patterns[0].rows[pad.id][0];

    store.execute(toggleStep(store.doc, pad.id, 0, 0.8));
    expect(store.doc.patterns[0].rows[pad.id][0]).toBe(before > 0 ? 0 : 0.8);

    store.undo();
    expect(store.doc.patterns[0].rows[pad.id][0]).toBe(before);

    store.redo();
    expect(store.doc.patterns[0].rows[pad.id][0]).toBe(before > 0 ? 0 : 0.8);
  });

  it("toggleStep inverts the current velocity state", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const pad = getDrumTrack(doc).pads[0];
    store.execute(toggleStep(store.doc, pad.id, 1, 0.5));
    expect(store.doc.patterns[0].rows[pad.id][1]).toBe(0.5);
    store.execute(toggleStep(store.doc, pad.id, 1));
    expect(store.doc.patterns[0].rows[pad.id][1]).toBe(0);
  });

  it("setStepVelocityCommand clamps and undoes", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const pad = getDrumTrack(doc).pads[0];
    store.execute(setStepVelocityCommand(store.doc, pad.id, 3, 2));
    expect(store.doc.patterns[0].rows[pad.id][3]).toBe(1);
    store.undo();
    expect(store.doc.patterns[0].rows[pad.id][3]).toBe(0);
  });

  it("setBpm and setProjectName round-trip through undo", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    store.execute(setBpm(store.doc, 140));
    store.execute(setProjectName(store.doc, "Night Drive"));
    expect(store.doc.bpm).toBe(140);
    expect(store.doc.name).toBe("Night Drive");
    store.undo();
    store.undo();
    expect(store.doc.bpm).toBe(doc.bpm);
    expect(store.doc.name).toBe(doc.name);
  });

  it("setPadParams restores the exact previous pad", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const pad = getDrumTrack(doc).pads[6];
    store.execute(setPadParams(store.doc, pad.id, { gain: 1.4, pan: -0.3, pitch: 3 }));
    const edited = getDrumTrack(store.doc).pads.find((p) => p.id === pad.id)!;
    expect(edited.gain).toBe(1.4);
    expect(edited.pan).toBe(-0.3);
    expect(edited.pitch).toBe(3);
    store.undo();
    const restored = getDrumTrack(store.doc).pads.find((p) => p.id === pad.id)!;
    expect(restored).toEqual(pad);
  });

  it("setTrackParams restores previous track state", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const track = getDrumTrack(doc);
    store.execute(setTrackParams(store.doc, track.id, { gain: 0.5, mute: true }));
    expect(getDrumTrack(store.doc).gain).toBe(0.5);
    expect(getDrumTrack(store.doc).mute).toBe(true);
    store.undo();
    expect(getDrumTrack(store.doc)).toEqual(track);
  });
});

describe("pattern commands", () => {
  it("createPattern adds an empty pattern and selects it; undo restores", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    store.execute(createPattern(store.doc));
    expect(store.doc.patterns).toHaveLength(2);
    expect(store.doc.activePatternId).toBe(store.doc.patterns[1].id);
    const rows = Object.values(store.doc.patterns[1].rows);
    for (const row of rows) expect(row.every((v) => v === 0)).toBe(true);
    store.undo();
    expect(store.doc.patterns).toHaveLength(1);
    expect(store.doc.activePatternId).toBe(doc.activePatternId);
  });

  it("createPattern covers pads of all tracks", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    store.execute(createDrumTrack(store.doc));
    store.execute(createPattern(store.doc));
    const pattern = store.doc.patterns[1];
    for (const track of store.doc.tracks) {
      if (track.kind !== "drum") continue;
      for (const pad of track.pads) {
        expect(pattern.rows[pad.id]).toBeDefined();
      }
    }
  });

  it("duplicatePattern deep-copies rows; editing the copy leaves the source intact", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const sourceId = store.doc.activePatternId;
    store.execute(duplicatePattern(store.doc, sourceId));
    const copy = store.doc.patterns[1];
    expect(copy.rows).toEqual(store.doc.patterns[0].rows);
    expect(copy.rows).not.toBe(store.doc.patterns[0].rows);
    const firstPadId = getDrumTrack(store.doc).pads[0].id;
    store.execute(setStepVelocityCommand(store.doc, firstPadId, 1, 1));
    expect(store.doc.patterns[1].rows[firstPadId][1]).toBe(1);
    expect(store.doc.patterns[0].rows[firstPadId][1]).toBe(doc.patterns[0].rows[firstPadId][1]);
  });

  it("deletePattern switches active pattern and refuses the last one", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    expect(() => deletePattern(store.doc, store.doc.activePatternId)).toThrow();
    store.execute(createPattern(store.doc));
    const firstId = store.doc.patterns[0].id;
    store.execute(deletePattern(store.doc, firstId));
    expect(store.doc.patterns).toHaveLength(1);
    expect(store.doc.activePatternId).not.toBe(firstId);
    store.undo();
    expect(store.doc.patterns).toHaveLength(2);
  });

  it("renamePattern and setActivePattern round-trip", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    store.execute(createPattern(store.doc));
    const second = store.doc.patterns[1];
    store.execute(renamePattern(store.doc, second.id, "Fill"));
    expect(store.doc.patterns[1].name).toBe("Fill");
    store.execute(setActivePattern(store.doc, store.doc.patterns[0].id));
    expect(store.doc.activePatternId).toBe(store.doc.patterns[0].id);
    store.undo();
    expect(store.doc.activePatternId).toBe(second.id);
    store.undo();
    expect(store.doc.patterns[1].name).toBe("Pattern B");
  });

  it("setPatternLength resizes rows preserving content", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    store.execute(setPatternLength(store.doc, store.doc.activePatternId, 32));
    const pattern = store.doc.patterns[0];
    expect(pattern.stepCount).toBe(32);
    const kick = getDrumTrack(store.doc).pads[0];
    expect(pattern.rows[kick.id]).toHaveLength(32);
    expect(pattern.rows[kick.id][0]).toBeGreaterThan(0);
    store.execute(setPatternLength(store.doc, store.doc.activePatternId, 16));
    expect(store.doc.patterns[0].rows[kick.id]).toHaveLength(16);
  });

  it("clearPattern zeroes every row; undo restores the groove", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    store.execute(clearPattern(store.doc, store.doc.activePatternId));
    const pattern = store.doc.patterns[0];
    for (const row of Object.values(pattern.rows)) expect(row.every((v) => v === 0)).toBe(true);
    store.undo();
    expect(store.doc.patterns[0].rows).toEqual(doc.patterns[0].rows);
  });

  it("pastePattern replaces active pattern content", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    store.execute(duplicatePattern(store.doc, store.doc.activePatternId));
    const source = store.doc.patterns[0];
    store.execute(clearPattern(store.doc, store.doc.activePatternId));
    store.execute(
      pastePattern(store.doc, { stepCount: source.stepCount, rows: source.rows, notes: source.notes ?? {} }),
    );
    expect(store.doc.patterns.find((p) => p.id === store.doc.activePatternId)!.rows).toEqual(source.rows);
    store.undo();
    const cleared = store.doc.patterns.find((p) => p.id === store.doc.activePatternId)!;
    for (const row of Object.values(cleared.rows)) expect(row.every((v) => v === 0)).toBe(true);
  });
});

describe("track commands", () => {
  it("createDrumTrack adds a track with a full kit and pattern rows; undo restores exactly", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    store.execute(createDrumTrack(store.doc));
    expect(store.doc.tracks).toHaveLength(doc.tracks.length + 1);
    const newTrack = store.doc.tracks[store.doc.tracks.length - 1];
    if (newTrack.kind !== "drum") throw new Error("expected drum track");
    expect(newTrack.pads).toHaveLength(16);
    const padIds = new Set(newTrack.pads.map((p) => p.id));
    const firstTrackPadIds = new Set(getDrumTrack(store.doc).pads.map((p) => p.id));
    for (const id of padIds) expect(firstTrackPadIds.has(id)).toBe(false);
    for (const pattern of store.doc.patterns) {
      for (const padId of padIds) expect(pattern.rows[padId]).toBeDefined();
    }
    store.undo();
    expect(store.doc).toEqual(doc);
  });

  it("deleteTrack removes the track and its pad rows", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    store.execute(createDrumTrack(store.doc));
    const second = store.doc.tracks[store.doc.tracks.length - 1];
    const secondId = second.id;
    const secondPads = second.kind === "drum" ? second.pads.map((p) => p.id) : [];
    store.execute(deleteTrack(store.doc, secondId));
    expect(store.doc.tracks).toHaveLength(doc.tracks.length);
    for (const pattern of store.doc.patterns) {
      for (const padId of secondPads) expect(pattern.rows[padId]).toBeUndefined();
    }
    store.undo();
    expect(store.doc.tracks).toHaveLength(doc.tracks.length + 1);
  });

  it("deleteTrack refuses when it is the last remaining track", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    while (store.doc.tracks.length > 1) {
      store.execute(deleteTrack(store.doc, store.doc.tracks[0].id));
    }
    expect(store.doc.tracks).toHaveLength(1);
    expect(() => deleteTrack(store.doc, store.doc.tracks[0].id)).toThrow();
  });

  it("deleteTrack removes automation/LFO/macro/scene-automation routed at it; undo restores them", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const target = store.doc.tracks.find(
      (t): t is import("../src/project-model/types").InstrumentTrack => t.kind === "instrument",
    )!;
    const sceneId = store.doc.scenes[0].id;
    const otherTrackId = getDrumTrack(store.doc).id; // must exist — normalize drops dangling refs
    // Route all four modulation domains at the doomed track.
    store.replaceDoc({
      ...store.doc,
      automation: [
        { id: "lane-1", target: { kind: "trackGain", trackId: target.id }, points: [{ tick: 0, value: 0.5 }] },
        { id: "lane-keep", target: { kind: "trackGain", trackId: otherTrackId }, points: [{ tick: 0, value: 0.5 }] },
      ],
      lfos: [
        { id: "lfo-1", trackId: target.id, param: "gain", amount: 0.5 },
        {
          id: "lfo-target",
          trackId: otherTrackId,
          param: "gain",
          amount: 0.5,
          target: { kind: "trackGain", trackId: target.id },
        },
      ],
      macros: [
        {
          id: "macro-1",
          name: "M",
          value: 0.5,
          mappings: [
            { id: "map-1", trackId: target.id, param: "gain", amount: 0.5 },
            {
              id: "map-2",
              trackId: target.id,
              param: "pan",
              amount: 0.5,
              target: { kind: "trackGain", trackId: target.id },
            },
          ],
        },
      ],
      sceneAutomation: [
        { id: "sc-1", sceneId, target: { kind: "trackGain", trackId: target.id }, points: [{ tick: 0, value: 0.5 }] },
      ],
    });
    const before = store.doc;

    store.execute(deleteTrack(store.doc, target.id));
    expect(store.doc.automation.map((l) => l.id)).toEqual(["lane-keep"]);
    expect(store.doc.lfos).toHaveLength(0); // both the host and the generic target pointed at the track
    expect(store.doc.macros![0].mappings).toHaveLength(0);
    expect(store.doc.sceneAutomation).toHaveLength(0);

    store.undo();
    expect(store.doc.automation).toEqual(before.automation);
    expect(store.doc.lfos).toEqual(before.lfos);
    expect(store.doc.macros).toEqual(before.macros);
    expect(store.doc.sceneAutomation).toEqual(before.sceneAutomation);
  });

  it("setTrackParams mutates drum tracks", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const drum = getDrumTrack(doc);
    store.execute(setTrackParams(store.doc, drum.id, { name: "Big Drums", gain: 0.6, pan: -0.2, mute: true }));
    const updated = getDrumTrack(store.doc);
    expect(updated.name).toBe("Big Drums");
    expect(updated.gain).toBe(0.6);
    expect(updated.pan).toBe(-0.2);
    expect(updated.mute).toBe(true);
    store.undo();
    expect(getDrumTrack(store.doc).name).toBe(drum.name);
    expect(getDrumTrack(store.doc).gain).toBe(drum.gain);
  });

  it("setTrackParams mutates instrument tracks", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const bass = doc.tracks.find((t) => t.kind === "instrument")!;
    store.execute(setTrackParams(store.doc, bass.id, { name: "Sub Bass", gain: 0.4, pan: 0.3, mute: true }));
    const updated = store.doc.tracks.find((t) => t.id === bass.id);
    if (!updated || updated.kind !== "instrument") throw new Error("expected instrument track");
    expect(updated.name).toBe("Sub Bass");
    expect(updated.gain).toBe(0.4);
    expect(updated.pan).toBe(0.3);
    expect(updated.mute).toBe(true);
    store.undo();
    const restored = store.doc.tracks.find((t) => t.id === bass.id);
    if (!restored || restored.kind !== "instrument") throw new Error("expected instrument track");
    expect(restored.name).toBe(bass.name);
    expect(restored.gain).toBe(bass.gain);
    expect(restored.pan).toBe(bass.pan);
    expect(restored.mute).toBe(bass.mute);
  });
});

describe("effect commands", () => {
  it("addEffect appends an instance with default params; undo removes it", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const trackId = doc.tracks[0].id;
    store.execute(addEffect(store.doc, trackId, "reverb"));
    const track = getDrumTrack(store.doc);
    expect(track.effects).toHaveLength(1);
    expect(track.effects[0].type).toBe("reverb");
    expect(track.effects[0].bypassed).toBe(false);
    expect(track.effects[0].params.decay).toBeCloseTo(1.8, 5);
    store.undo();
    expect(getDrumTrack(store.doc).effects).toHaveLength(0);
  });

  it("setEffectParam clamps to the parameter range and undoes exactly", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const trackId = doc.tracks[0].id;
    store.execute(addEffect(store.doc, trackId, "eq"));
    const fx = getDrumTrack(store.doc).effects[0];
    store.execute(setEffectParam(store.doc, trackId, fx.id, "lowGain", 99));
    expect(getDrumTrack(store.doc).effects[0].params.lowGain).toBe(15);
    store.undo();
    expect(getDrumTrack(store.doc).effects[0].params.lowGain).toBe(0);
  });

  it("setEffectParam throws for an unknown paramId (no silent default injection)", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const trackId = doc.tracks[0].id;
    store.execute(addEffect(store.doc, trackId, "eq"));
    const fx = getDrumTrack(store.doc).effects[0];
    expect(() => setEffectParam(store.doc, trackId, fx.id, "nonexistent", 0.5)).toThrow(/not defined/);
  });

  it("setEffectParam undo restores the default when the param was never set before", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const trackId = doc.tracks[0].id;
    store.execute(addEffect(store.doc, trackId, "saturation"));
    const fx = getDrumTrack(store.doc).effects[0];
    const before = getDrumTrack(store.doc).effects[0].params.drive;
    expect(before).toBeGreaterThanOrEqual(0);
    store.execute(setEffectParam(store.doc, trackId, fx.id, "drive", 0.9));
    expect(getDrumTrack(store.doc).effects[0].params.drive).toBe(0.9);
    store.undo();
    expect(getDrumTrack(store.doc).effects[0].params.drive).toBe(before);
  });

  it("toggleEffectBypass flips and restores", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const trackId = doc.tracks[0].id;
    store.execute(addEffect(store.doc, trackId, "delay"));
    const fx = getDrumTrack(store.doc).effects[0];
    store.execute(toggleEffectBypass(store.doc, trackId, fx.id));
    expect(getDrumTrack(store.doc).effects[0].bypassed).toBe(true);
    store.undo();
    expect(getDrumTrack(store.doc).effects[0].bypassed).toBe(false);
  });

  it("moveEffect reorders the chain and refuses out-of-range moves", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const trackId = doc.tracks[0].id;
    store.execute(addEffect(store.doc, trackId, "eq"));
    store.execute(addEffect(store.doc, trackId, "reverb"));
    store.execute(addEffect(store.doc, trackId, "pump"));
    const [eq, reverb, pump] = getDrumTrack(store.doc).effects;
    expect(() => moveEffect(store.doc, trackId, eq.id, -1)).toThrow();
    expect(() => moveEffect(store.doc, trackId, pump.id, 1)).toThrow();
    store.execute(moveEffect(store.doc, trackId, pump.id, -1));
    expect(getDrumTrack(store.doc).effects.map((f) => f.type)).toEqual(["eq", "pump", "reverb"]);
    store.undo();
    expect(getDrumTrack(store.doc).effects.map((f) => f.id)).toEqual([eq.id, reverb.id, pump.id]);
  });

  it("removeEffect deletes only the targeted instance", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const trackId = doc.tracks[0].id;
    store.execute(addEffect(store.doc, trackId, "eq"));
    store.execute(addEffect(store.doc, trackId, "saturation"));
    const eqFx = getDrumTrack(store.doc).effects[0];
    store.execute(removeEffect(store.doc, trackId, eqFx.id));
    expect(getDrumTrack(store.doc).effects.map((f) => f.type)).toEqual(["saturation"]);
    store.undo();
    expect(getDrumTrack(store.doc).effects.map((f) => f.type)).toEqual(["eq", "saturation"]);
  });

  it("effects travel with track duplication flow (create/delete track keeps effects on survivors)", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const drumsId = getDrumTrack(doc).id;
    store.execute(addEffect(store.doc, drumsId, "compressor"));
    store.execute(createDrumTrack(store.doc));
    const added = store.doc.tracks[store.doc.tracks.length - 1];
    store.execute(addEffect(store.doc, added.id, "delay"));
    store.execute(deleteTrack(store.doc, drumsId));
    const survivor = getDrumTrack(store.doc);
    expect(survivor.id).toBe(added.id);
    expect(survivor.effects.map((f) => f.type)).toEqual(["delay"]);
  });
});

describe("instrument tracks and notes", () => {
  it("createInstrumentTrack adds a configured track; undo restores", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    store.execute(createInstrumentTrack(store.doc, "analog"));
    expect(store.doc.tracks).toHaveLength(doc.tracks.length + 1);
    const added = store.doc.tracks[store.doc.tracks.length - 1];
    if (added.kind !== "instrument") throw new Error("expected instrument track");
    expect(added.instrument).toBe("analog");
    expect(added.params.cutoff).toBeCloseTo(9000, 3);
    store.undo();
    expect(store.doc).toEqual(doc);
  });

  it("addNote/moveNote/resizeNote/setNoteVelocity/deleteNote round-trip with undo", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const bass = store.doc.tracks.find(
      (t): t is import("../src/project-model/types").InstrumentTrack => t.kind === "instrument",
    )!;
    store.execute(addNote(store.doc, bass.id, { pitch: 36, start: 480, duration: 240, velocity: 0.8 }));
    let notes = store.doc.patterns[0].notes[bass.id];
    expect(notes).toHaveLength(5);
    const noteId = notes[4].id;
    expect(notes[4].pitch).toBe(36);

    store.execute(moveNote(store.doc, bass.id, noteId, { pitch: 40, start: 720 }));
    notes = store.doc.patterns[0].notes[bass.id];
    expect(notes.find((n) => n.id === noteId)).toMatchObject({ pitch: 40, start: 720 });

    store.execute(resizeNote(store.doc, bass.id, noteId, 960));
    expect(store.doc.patterns[0].notes[bass.id].find((n) => n.id === noteId)?.duration).toBe(960);

    store.execute(setNoteVelocity(store.doc, bass.id, noteId, 5));
    expect(store.doc.patterns[0].notes[bass.id].find((n) => n.id === noteId)?.velocity).toBe(1);

    store.execute(deleteNote(store.doc, bass.id, noteId));
    expect(store.doc.patterns[0].notes[bass.id]).toHaveLength(4);

    store.undo();
    store.undo();
    store.undo();
    store.undo();
    store.undo();
    expect(store.doc.patterns[0].notes[bass.id]).toHaveLength(4);
  });

  it("setInstrumentParam clamps and undoes; setInstrumentSample round-trips", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const track = store.doc.tracks.find(
      (t): t is import("../src/project-model/types").InstrumentTrack => t.kind === "instrument",
    )!;
    store.execute(setInstrumentParam(store.doc, track.id, "decay", 99));
    const edited = store.doc.tracks.find(
      (t): t is import("../src/project-model/types").InstrumentTrack => t.kind === "instrument",
    )!;
    expect(edited.params.decay).toBe(4);
    store.undo();
    const restored = store.doc.tracks.find(
      (t): t is import("../src/project-model/types").InstrumentTrack => t.kind === "instrument",
    )!;
    expect(restored.params.decay).toBeCloseTo(0.9, 5);

    store.execute(setInstrumentSample(store.doc, track.id, "factory.tonal.stab"));
    expect(
      store.doc.tracks.find((t): t is import("../src/project-model/types").InstrumentTrack => t.kind === "instrument")!
        .sampleId,
    ).toBe("factory.tonal.stab");
    store.undo();
    expect(
      store.doc.tracks.find((t): t is import("../src/project-model/types").InstrumentTrack => t.kind === "instrument")!
        .sampleId,
    ).toBe(track.sampleId);
  });

  it("deleteTrack removes notes of the deleted instrument track", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const bassId = doc.tracks.find((t) => t.kind === "instrument")!.id;
    store.execute(deleteTrack(store.doc, bassId));
    expect(store.doc.tracks).toHaveLength(doc.tracks.length - 1);
    expect(store.doc.patterns[0].notes[bassId]).toBeUndefined();
    store.undo();
    expect(store.doc.patterns[0].notes[bassId]).toHaveLength(4);
  });

  it("clearPattern removes notes too; duplicatePattern deep-copies notes", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    store.execute(clearPattern(store.doc, store.doc.activePatternId));
    expect(Object.keys(store.doc.patterns[0].notes)).toHaveLength(0);
    store.undo();
    const bassId = doc.tracks.find((t) => t.kind === "instrument")!.id;
    expect(store.doc.patterns[0].notes[bassId]).toHaveLength(4);

    store.execute(duplicatePattern(store.doc, store.doc.activePatternId));
    const copy = store.doc.patterns[1];
    expect(copy.notes[bassId]).toHaveLength(4);
    expect(copy.notes[bassId]).not.toBe(store.doc.patterns[0].notes[bassId]);
  });
});

describe("scenes and arrangement", () => {
  it("createScene references the active pattern without duplicating data", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    store.execute(createScene(store.doc, "Drop"));
    expect(store.doc.scenes).toHaveLength(2);
    expect(store.doc.scenes[1].name).toBe("Drop");
    expect(store.doc.scenes[1].patternId).toBe(doc.activePatternId);
    store.undo();
    expect(store.doc.scenes).toHaveLength(1);
  });

  it("deleteScene also removes its clips; setScenePattern and renameScene round-trip", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    store.execute(createScene(store.doc, "Fill"));
    const fillScene = store.doc.scenes[1];
    store.execute(addArrangementClip(store.doc, fillScene.id, 4, 2));
    expect(store.doc.arrangement.clips).toHaveLength(2);
    store.execute(deleteScene(store.doc, fillScene.id));
    expect(store.doc.scenes).toHaveLength(1);
    expect(store.doc.arrangement.clips).toHaveLength(1);
    store.undo();
    expect(store.doc.arrangement.clips).toHaveLength(2);

    store.execute(renameScene(store.doc, fillScene.id, "Break"));
    expect(store.doc.scenes[1].name).toBe("Break");
    store.execute(setScenePattern(store.doc, fillScene.id, store.doc.patterns[0].id));
    expect(store.doc.scenes[1].patternId).toBe(store.doc.patterns[0].id);
  });

  it("clip placement rejects overlaps and allows undo of moves and resizes", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const sceneId = doc.scenes[0].id;
    expect(() => addArrangementClip(store.doc, sceneId, 1, 4)).toThrow();
    store.execute(addArrangementClip(store.doc, sceneId, 4, 4));
    expect(store.doc.arrangement.clips).toHaveLength(2);
    store.execute(moveArrangementClip(store.doc, store.doc.arrangement.clips[1].id, 8));
    expect(store.doc.arrangement.clips[1].startBar).toBe(8);
    expect(() => moveArrangementClip(store.doc, store.doc.arrangement.clips[1].id, 2)).toThrow();
    store.execute(resizeArrangementClip(store.doc, store.doc.arrangement.clips[1].id, 2));
    expect(store.doc.arrangement.clips[1].lengthBars).toBe(2);
    store.undo();
    store.undo();
    expect(store.doc.arrangement.clips[1].startBar).toBe(4);
    expect(store.doc.arrangement.clips[1].lengthBars).toBe(4);
  });

  it("duplicateArrangementClip places the copy after the original at first free space", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const clipId = doc.arrangement.clips[0].id;
    store.execute(duplicateArrangementClip(store.doc, clipId));
    expect(store.doc.arrangement.clips).toHaveLength(2);
    expect(store.doc.arrangement.clips[1].startBar).toBe(4);
    store.execute(duplicateArrangementClip(store.doc, clipId));
    expect(store.doc.arrangement.clips[2].startBar).toBe(8);
    store.execute(deleteArrangementClip(store.doc, clipId));
    expect(store.doc.arrangement.clips).toHaveLength(2);
    store.undo();
    expect(store.doc.arrangement.clips).toHaveLength(3);
  });
});

describe("automation, lfo and macros", () => {
  it("addAutomationLane rejects duplicate targets and points round-trip", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const trackId = doc.tracks[0].id;
    store.execute(addAutomationLane(store.doc, { kind: "trackGain", trackId }));
    expect(() => addAutomationLane(store.doc, { kind: "trackGain", trackId })).toThrow();
    const lane = store.doc.automation[0];
    store.execute(addAutomationPoint(store.doc, lane.id, 0, 1));
    store.execute(addAutomationPoint(store.doc, lane.id, 480, 0));
    expect(store.doc.automation[0].points.map((p) => p.tick)).toEqual([0, 480]);
    store.execute(moveAutomationPoint(store.doc, lane.id, 1, { tick: 240, value: 0.5 }));
    expect(store.doc.automation[0].points[1]).toEqual({ tick: 240, value: 0.5 });
    store.undo();
    store.undo();
    expect(store.doc.automation[0].points).toHaveLength(1);
  });

  it("lfo commands add, edit and remove", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const trackId = doc.tracks[0].id;
    store.execute(addLfo(store.doc, trackId));
    const lfo = store.doc.lfos[0];
    expect(lfo.param).toBe("gain");
    expect(lfo.rateMode).toBe("sync");
    store.execute(setLfoParams(store.doc, lfo.id, { param: "pan", wave: "square", amount: 0.8 }));
    expect(store.doc.lfos[0]).toMatchObject({ param: "pan", wave: "square", amount: 0.8 });
    store.execute(removeLfo(store.doc, lfo.id));
    expect(store.doc.lfos).toHaveLength(0);
    store.undo();
    expect(store.doc.lfos).toHaveLength(1);
  });

  it("macros start at neutral and mappings apply bipolar offsets", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const trackId = doc.tracks[0].id;
    expect(store.doc.macros).toHaveLength(4);
    expect(store.doc.macros.every((m) => m.value === 0.5)).toBe(true);
    const macro = store.doc.macros[0];
    store.execute(addMacroMapping(store.doc, macro.id, trackId, "gain"));
    const mappingId = store.doc.macros[0].mappings[0].id;
    store.execute(setMacroMappingAmount(store.doc, macro.id, mappingId, 1));
    store.execute(setMacroValue(store.doc, macro.id, 1));
    expect(store.doc.macros[0].value).toBe(1);
    store.undo();
    expect(store.doc.macros[0].value).toBe(0.5);
    store.execute(setMacroValue(store.doc, macro.id, 5));
    expect(store.doc.macros[0].value).toBe(1);
  });

  it("default project ships a scene, an arrangement clip and neutral macros", () => {
    const doc = createDefaultProject();
    expect(doc.scenes).toHaveLength(1);
    expect(doc.scenes[0].patternId).toBe(doc.activePatternId);
    expect(doc.arrangement.clips).toHaveLength(1);
    expect(doc.arrangement.clips[0].startBar).toBe(0);
    expect(doc.macros).toHaveLength(4);
    expect(doc.automation).toHaveLength(0);
    expect(doc.lfos).toHaveLength(0);
  });

  it("addAutomationLane validates the target track and effect references", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const trackId = doc.tracks[0].id;
    expect(() => addAutomationLane(store.doc, { kind: "trackGain", trackId: "track-missing" })).toThrow(/Track/);
    expect(() =>
      addAutomationLane(store.doc, { kind: "fxParam", trackId, fxId: "fx-missing", paramId: "lowGain" }),
    ).toThrow(/Effect/);
    expect(() => addAutomationLane(store.doc, { kind: "fxParam", trackId })).toThrow(/fxParam target requires fxId/);
    store.execute(addEffect(store.doc, trackId, "eq"));
    const fxId = getDrumTrack(store.doc).effects[0].id;
    expect(() => addAutomationLane(store.doc, { kind: "fxParam", trackId, fxId })).toThrow(
      /fxParam target requires paramId/,
    );
    const instrument = doc.tracks.find((t) => t.kind === "instrument")!;
    expect(() =>
      addAutomationLane(store.doc, { kind: "instParam", trackId: instrument.id, paramId: "decay" }),
    ).not.toThrow();
  });

  it("addMacroMapping validates the target track and macro", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const macro = doc.macros[0];
    expect(() => addMacroMapping(store.doc, macro.id, "track-missing", "gain")).toThrow(/Track/);
    expect(() => addMacroMapping(store.doc, "macro-missing", doc.tracks[0].id, "gain")).toThrow(/Macro/);
  });
});

describe("ProjectStore history", () => {
  it("clears redo stack on a new command", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    store.execute(setBpm(store.doc, 130));
    store.undo();
    expect(store.canRedo).toBe(true);
    store.execute(setBpm(store.doc, 150));
    expect(store.canRedo).toBe(false);
  });

  it("notifies subscribers on mutation", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    let notified = 0;
    const unsubscribe = store.subscribe(() => notified++);
    store.execute(setBpm(store.doc, 128));
    expect(notified).toBe(1);
    unsubscribe();
    store.execute(setBpm(store.doc, 100));
    expect(notified).toBe(1);
  });

  it("marks document dirty after execution", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    expect(store.saveStatus).toBe("saved");
    store.execute(setBpm(store.doc, 128));
    expect(store.saveStatus).toBe("dirty");
  });
});

describe("sliceToPads (chop beats)", () => {
  const doc = createDefaultProject();
  const drum = getDrumTrack(doc);

  it("chops slices onto pads as [start, end) regions with names", () => {
    const cmd = sliceToPads(
      doc,
      drum.id,
      "user.break",
      [
        { start: 0, end: 0.25 },
        { start: 0.25, end: 0.5 },
      ],
      "Break",
    );
    const next = cmd.execute(doc);
    const pads = (next.tracks.find((t) => t.id === drum.id) as typeof drum).pads;
    expect(pads[0]).toMatchObject({ assetId: "user.break", sliceStart: 0, sliceEnd: 0.25, name: "Break 01" });
    expect(pads[1]).toMatchObject({ assetId: "user.break", sliceStart: 0.25, sliceEnd: 0.5, name: "Break 02" });
    // Pads beyond the slice count keep their previous content.
    expect(pads[2].sliceStart).toBeUndefined();
    expect(pads[2].assetId).toBe(drum.pads[2].assetId);
  });

  it("undo restores the previous kit", () => {
    const cmd = sliceToPads(doc, drum.id, "user.break", [{ start: 0, end: 1 }], "Break");
    const next = cmd.execute(doc);
    const undone = cmd.undo(next);
    const pads = (undone.tracks.find((t) => t.id === drum.id) as typeof drum).pads;
    expect(pads[0].assetId).toBe(drum.pads[0].assetId);
    expect(pads[0].sliceStart).toBeUndefined();
    expect(pads[0].name).toBe(drum.pads[0].name);
  });

  it("throws for a non-drum track", () => {
    const inst = doc.tracks.find((t) => t.kind === "instrument")!;
    expect(() => sliceToPads(doc, inst.id, "x", [{ start: 0, end: 1 }])).toThrow();
  });

  it("maps slice edits and creates a sequential pattern atomically", () => {
    const before = doc;
    const cmd = chopSampleToPads(doc, {
      trackId: drum.id,
      assetId: "user.break",
      sourceName: "Break",
      createPattern: true,
      slices: [
        { start: 0, end: 0.25, fadeIn: 0.01, fadeOut: 0.02, reverse: true },
        { start: 0.25, end: 0.5 },
      ],
    });
    const next = cmd.execute(doc);
    const nextDrum = next.tracks.find((t) => t.id === drum.id && t.kind === "drum") as typeof drum;
    const pattern = next.patterns.find((p) => p.id === next.activePatternId)!;
    expect(nextDrum.pads[0]).toMatchObject({
      assetId: "user.break",
      sliceStart: 0,
      sliceEnd: 0.25,
      sliceFadeIn: 0.01,
      sliceFadeOut: 0.02,
      sliceReverse: true,
    });
    expect(pattern.stepCount).toBe(16);
    expect(pattern.rows[nextDrum.pads[0].id][0]).toBe(0.9);
    expect(pattern.rows[nextDrum.pads[1].id][1]).toBe(0.9);
    expect(pattern.rows[nextDrum.pads[0].id][1]).toBe(0);
    expect(cmd.undo(next)).toEqual(before);
  });

  it("maps only the available pad slots and leaves the rest of the kit unchanged", () => {
    const cmd = chopSampleToPads(doc, {
      trackId: drum.id,
      assetId: "user.long",
      sourceName: "Long",
      createPattern: false,
      slices: Array.from({ length: 20 }, (_, i) => ({ start: i, end: i + 0.5 })),
    });
    const next = cmd.execute(doc);
    const pads = (next.tracks.find((t) => t.id === drum.id) as typeof drum).pads;
    expect(pads).toHaveLength(16);
    expect(pads[15].sliceStart).toBe(15);
    expect(pads[0].sliceEnd).toBe(0.5);
  });

  it("resets only project-local slice editing", () => {
    const sliced = sliceToPads(doc, drum.id, "user.break", [{ start: 0.1, end: 0.4 }], "Break").execute(doc);
    const next = resetPadSlice(sliced, drum.pads[0].id).execute(sliced);
    const pad = (next.tracks.find((t) => t.id === drum.id) as typeof drum).pads[0];
    expect(pad.assetId).toBe("user.break");
    expect(pad.sliceStart).toBeUndefined();
    expect(pad.sliceEnd).toBeUndefined();
  });
});

describe("deletePattern dangling-reference cleanup (regression)", () => {
  function docWithSceneOnSecondPattern() {
    const base = createDefaultProject();
    let store = new ProjectStore(base);
    store.execute(createPattern(store.doc, "Pattern B"));
    const patternB = store.doc.patterns.find((p) => p.id !== base.activePatternId)!;
    store.execute(createScene(store.doc, "Drop"));
    const scene = store.doc.scenes[store.doc.scenes.length - 1];
    store.execute(setScenePattern(store.doc, scene.id, patternB.id));
    // A clip in the arrangement referencing the scene (bar 10 — the template
    // already pre-places a clip near the start).
    store.execute(addArrangementClip(store.doc, scene.id, 10, 2));
    return { store, patternB, sceneId: scene.id };
  }

  it("deleting a pattern removes scenes that reference it and their arrangement clips", () => {
    const { store, patternB } = docWithSceneOnSecondPattern();
    const clipCountBefore = store.doc.arrangement.clips.length;
    expect(clipCountBefore).toBeGreaterThan(0);

    store.execute(deletePattern(store.doc, patternB.id));
    const doc = store.doc;

    // No dangling scene → no crash in UI/scheduler when reading the doc.
    expect(doc.scenes.every((s) => doc.patterns.some((p) => p.id === s.patternId))).toBe(true);
    // The clip pointing at the deleted scene must be gone too.
    for (const clip of doc.arrangement.clips) {
      expect(doc.scenes.some((s) => s.id === clip.sceneId)).toBe(true);
    }
  });

  it("deleting a pattern is fully undoable", () => {
    const { store, patternB } = docWithSceneOnSecondPattern();
    const before = store.doc;
    store.execute(deletePattern(store.doc, patternB.id));
    store.undo();
    expect(store.doc.patterns.some((p) => p.id === patternB.id)).toBe(true);
    expect(store.doc.scenes.length).toBe(before.scenes.length);
    expect(store.doc.arrangement.clips.length).toBe(before.arrangement.clips.length);
  });

  it("setActivePattern ignores a pattern id that no longer exists", () => {
    const { store, patternB } = docWithSceneOnSecondPattern();
    const before = store.doc;
    // Simulate a stale launch racing a delete: the queued id may be gone.
    const cmd = setActivePattern(before, patternB.id);
    const afterDeleteDoc = deletePattern(before, patternB.id).execute(before);
    const result = cmd.execute(afterDeleteDoc);
    expect(result.activePatternId).toBe(afterDeleteDoc.activePatternId);
    expect(result).toBe(afterDeleteDoc); // no-op — same document
  });

  it("setActivePattern still switches between existing patterns (and undoes)", () => {
    const base = createDefaultProject();
    const store = new ProjectStore(base);
    store.execute(createPattern(store.doc, "Pattern B"));
    const patternB = store.doc.patterns.find((p) => p.id !== base.activePatternId)!;
    const prev = store.doc.activePatternId;
    store.execute(setActivePattern(store.doc, patternB.id));
    expect(store.doc.activePatternId).toBe(patternB.id);
    store.undo();
    expect(store.doc.activePatternId).toBe(prev);
  });
});

describe("applyFxEqPreset / setFxEqParam", () => {
  const doc = createDefaultProject();
  const inst = doc.tracks.find((t) => t.kind === "instrument")!;
  const withFx = addEffect(doc, inst.id, "fxeq").execute(doc);
  const fx = withFx.tracks.find((t) => t.id === inst.id)!.effects.find((f) => f.type === "fxeq")!;

  it("applyFxEqPreset replaces params with schema defaults + preset in ONE undoable gesture", () => {
    const cmd = applyFxEqPreset(withFx, inst.id, fx.id, "Test Preset", {
      bandCount: 4,
      "band2.satEnabled": 1,
      "band2.satDriveDb": 12,
    });
    const next = cmd.execute(withFx);
    const after = next.tracks.find((t) => t.id === inst.id)!.effects.find((f) => f.type === "fxeq")!;
    expect(after.params.bandCount).toBe(4);
    expect(after.params["band2.satEnabled"]).toBe(1);
    expect(after.params["band2.satDriveDb"]).toBe(12);
    // Schema defaults filled in for everything else (sat disabled on band 3).
    expect(after.params["band3.satEnabled"]).toBe(0);
    // Undo restores the pre-preset params exactly.
    const undone = cmd.undo(next);
    const before = undone.tracks.find((t) => t.id === inst.id)!.effects.find((f) => f.type === "fxeq")!;
    expect(before.params).toEqual(fx.params);
  });

  it("setFxEqParam accepts dotted band ids with schema clamping", () => {
    const cmd = setFxEqParam(withFx, inst.id, fx.id, "band1.satDriveDb", 999);
    const next = cmd.execute(withFx);
    const after = next.tracks.find((t) => t.id === inst.id)!.effects.find((f) => f.type === "fxeq")!;
    // satDriveDb tops out at +24 dB — clamped to the schema max, not stored raw.
    expect(after.params["band1.satDriveDb"]).toBe(24);
    // Undo restores the schema default (6 dB), not an absent key.
    expect(
      cmd
        .undo(next)
        .tracks.find((t) => t.id === inst.id)!
        .effects.find((f) => f.type === "fxeq")!.params["band1.satDriveDb"],
    ).toBe(6);
  });

  it("setFxEqParam rejects ids outside the schema", () => {
    expect(() => setFxEqParam(withFx, inst.id, fx.id, "band9.nope", 1)).toThrow();
  });
});

describe("applyUltinaPreset / setUltinaParam", () => {
  const doc = createDefaultProject();
  const inst = doc.tracks.find((t) => t.kind === "instrument")!;
  const withFx = addEffect(doc, inst.id, "ultina").execute(doc);
  const fx = withFx.tracks.find((t) => t.id === inst.id)!.effects.find((f) => f.type === "ultina")!;

  it("setUltinaParam accepts namespaced module params with schema clamping", () => {
    const cmd = setUltinaParam(withFx, inst.id, fx.id, "comp.thresholdDb", -999);
    const next = cmd.execute(withFx);
    const after = next.tracks.find((t) => t.id === inst.id)!.effects.find((f) => f.type === "ultina")!;
    // Clamped to the schema minimum, not stored raw.
    expect(after.params["comp.thresholdDb"]).toBeLessThan(-40);
    expect(() => setUltinaParam(withFx, inst.id, fx.id, "comp.nonexistent", 1)).toThrow();
  });

  it("applyUltinaPreset merges preset onto defaults in ONE undoable gesture", () => {
    // Use a drum-category preset from the vendored factory set.
    const preset = FACTORY_PRESETS[0];
    const cmd = applyUltinaPreset(withFx, inst.id, fx.id, preset.name, preset.params);
    const next = cmd.execute(withFx);
    const after = next.tracks.find((t) => t.id === inst.id)!.effects.find((f) => f.type === "ultina")!;
    for (const [k, v] of Object.entries(preset.params)) {
      expect(after.params[k]).toBe(v);
    }
    // Defaults filled in for everything else (e.g. globals).
    expect(after.params["global.inputGainDb"]).toBe(0);
    // Undo restores the exact pre-preset params.
    const undone = cmd.undo(next);
    const before = undone.tracks.find((t) => t.id === inst.id)!.effects.find((f) => f.type === "ultina")!;
    expect(before.params).toEqual(fx.params);
  });
});

describe("applyUltinaProposal (mix assistant)", () => {
  const doc = createDefaultProject();
  const inst = doc.tracks.find((t) => t.kind === "instrument")!;
  const withFx = addEffect(doc, inst.id, "ultina").execute(doc);
  const fx = withFx.tracks.find((t) => t.id === inst.id)!.effects.find((f) => f.type === "ultina")!;

  it("applies module toggles + param changes in ONE undoable gesture", () => {
    const cmd = applyUltinaProposal(
      withFx,
      inst.id,
      fx.id,
      "Mix assist (Drums)",
      [
        { moduleType: "comp", enabled: true },
        { moduleType: "gate", enabled: false },
      ],
      [
        { parameterId: "comp.thresholdDb", value: -18 },
        { parameterId: "global.inputGainDb", value: 3 },
      ],
    );
    const next = cmd.execute(withFx);
    const after = next.tracks.find((t) => t.id === inst.id)!.effects.find((f) => f.type === "ultina")!;
    expect(after.params["comp.enabled"]).toBe(1);
    expect(after.params["gate.enabled"]).toBe(0);
    expect(after.params["comp.thresholdDb"]).toBe(-18);
    expect(after.params["global.inputGainDb"]).toBe(3);
    // Undo restores the exact pre-proposal params.
    const undone = cmd.undo(next);
    const before = undone.tracks.find((t) => t.id === inst.id)!.effects.find((f) => f.type === "ultina")!;
    expect(before.params).toEqual(fx.params);
  });
});

describe("state integrity — in-flight collab deletions", () => {
  it("moveNote/resizeNote on a note deleted mid-drag are no-ops, not throws", () => {
    // Regression: a collab peer deleting the note between pointerdown and
    // pointerup used to make the drag commit throw inside the UI handler.
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const bass = store.doc.tracks.find(
      (t): t is import("../src/project-model/types").InstrumentTrack => t.kind === "instrument",
    )!;
    store.execute(addNote(store.doc, bass.id, { pitch: 36, start: 480, duration: 240, velocity: 0.8 }));
    const notes = store.doc.patterns[0].notes[bass.id];
    const noteId = notes![notes!.length - 1].id;
    store.execute(deleteNote(store.doc, bass.id, noteId));
    const before = store.doc;

    expect(() => store.execute(moveNote(store.doc, bass.id, noteId, { pitch: 40, start: 720 }))).not.toThrow();
    expect(() => store.execute(resizeNote(store.doc, bass.id, noteId, 900))).not.toThrow();
    expect(store.doc).toEqual(before);
  });
});
