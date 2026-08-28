import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { DrumTrack } from "../src/project-model/types";
import { yDocToProject, projectToYDoc } from "../src/collab/YDocAdapter";
import { YDocStore } from "../src/collab/YDocStore";
import { chopSampleToPads, setPadParams } from "../src/commands/commands";
import { yToggleStep } from "../src/commands/yDocHelpers";

describe("yToggleStep bounds safety", () => {
  it("is a no-op (not a RangeError) when the step index is out of range", () => {
    // Regression: a peer shrinking the pattern mid-gesture left stale grid
    // clicks pointing past the end of the Y row; yjs transactions have no
    // rollback, so `row.delete` threw straight through store.execute and the
    // whole edit crashed.
    const doc = createProjectFromTemplate("house");
    const yDoc = new Y.Doc();
    const yMap = yDoc.getMap("project");
    projectToYDoc(doc, yMap);
    const patternId = doc.patterns[0].id;
    const padId = Object.keys(doc.patterns[0].rows)[0];
    expect(() => {
      yToggleStep(yMap, patternId, padId, 15); // in range → toggles on
      yToggleStep(yMap, patternId, padId, 999); // out of range → no-op
      yToggleStep(yMap, patternId, padId, -1); // invalid → no-op
      yToggleStep(yMap, patternId, "missing-pad", 3); // missing row → no-op for non-zero index
    }).not.toThrow();
    const restored = yDocToProject(yMap);
    expect(restored.patterns[0].rows[padId][15]).toBeGreaterThan(0);
    expect(restored.patterns[0].rows[padId].length).toBe(16);
  });
});

describe("YDocAdapter — round-trip conversion", () => {
  it("converts ProjectDocument → Y.Doc → ProjectDocument (house template)", () => {
    const doc = createProjectFromTemplate("house");
    const yDoc = new Y.Doc();
    const yMap = yDoc.getMap("project");
    projectToYDoc(doc, yMap);
    const restored = yDocToProject(yMap);
    expect(restored.id).toBe(doc.id);
    expect(restored.name).toBe(doc.name);
    expect(restored.bpm).toBe(doc.bpm);
    expect(restored.tracks.length).toBe(doc.tracks.length);
    expect(restored.patterns.length).toBe(doc.patterns.length);
    expect(restored.scenes.length).toBe(doc.scenes.length);
  });

  it("preserves track structure", () => {
    const doc = createProjectFromTemplate("house");
    const yDoc = new Y.Doc();
    const yMap = yDoc.getMap("project");
    projectToYDoc(doc, yMap);
    const restored = yDocToProject(yMap);
    const origTrack = doc.tracks[0];
    const restTrack = restored.tracks[0];
    expect(restTrack.id).toBe(origTrack.id);
    expect(restTrack.kind).toBe(origTrack.kind);
    expect(restTrack.name).toBe(origTrack.name);
    expect(restTrack.gain).toBe(origTrack.gain);
  });

  it("preserves drum pads", () => {
    const doc = createProjectFromTemplate("house");
    const yDoc = new Y.Doc();
    const yMap = yDoc.getMap("project");
    projectToYDoc(doc, yMap);
    const restored = yDocToProject(yMap);
    const drumTrack = doc.tracks.find((t) => t.kind === "drum");
    const restDrum = restored.tracks.find((t) => t.kind === "drum");
    if (drumTrack && restDrum && restDrum.kind === "drum") {
      expect(restDrum.pads.length).toBe(drumTrack.pads.length);
      expect(restDrum.pads[0].name).toBe(drumTrack.pads[0].name);
    }
  });

  it("preserves project-local slice editing fields", () => {
    const doc = createProjectFromTemplate("house");
    const drum = doc.tracks.find((track): track is DrumTrack => track.kind === "drum")!;
    const sliced = chopSampleToPads(doc, {
      trackId: drum.id,
      assetId: "user.break",
      sourceName: "Break",
      createPattern: false,
      slices: [{ start: 0.1, end: 0.4, fadeIn: 0.02, fadeOut: 0.03, reverse: true }],
    }).execute(doc);
    const yDoc = new Y.Doc();
    const yMap = yDoc.getMap("project");
    projectToYDoc(sliced, yMap);
    const restored = yDocToProject(yMap);
    const restoredDrum = restored.tracks.find(
      (track): track is DrumTrack => track.id === drum.id && track.kind === "drum",
    )!;
    expect(restoredDrum.pads[0]).toMatchObject({
      sliceStart: 0.1,
      sliceEnd: 0.4,
      sliceFadeIn: 0.02,
      sliceFadeOut: 0.03,
      sliceReverse: true,
    });
  });

  it("syncs slice field edits and clears optional fields in YDoc", () => {
    const doc = createProjectFromTemplate("house");
    const store = YDocStore.fromDocument(doc);
    const drum = doc.tracks.find((track): track is DrumTrack => track.kind === "drum")!;
    const pad = drum.pads[0];
    store.execute(
      setPadParams(store.doc, pad.id, { sliceStart: 0.2, sliceEnd: 0.5, sliceFadeOut: 0.01, sliceReverse: true }),
    );
    const changedDrum = store.doc.tracks.find(
      (track): track is DrumTrack => track.id === drum.id && track.kind === "drum",
    )!;
    expect(changedDrum.pads[0]).toMatchObject({
      sliceStart: 0.2,
      sliceEnd: 0.5,
      sliceFadeOut: 0.01,
      sliceReverse: true,
    });
    store.execute(setPadParams(store.doc, pad.id, { assetId: "factory.kick.punch" }));
    const clearedDrum = store.doc.tracks.find(
      (track): track is DrumTrack => track.id === drum.id && track.kind === "drum",
    )!;
    const cleared = clearedDrum.pads[0];
    expect(cleared.sliceStart).toBeUndefined();
    expect(cleared.sliceEnd).toBeUndefined();
    expect(cleared.sliceReverse).toBeUndefined();
  });

  it("preserves pattern rows and notes", () => {
    const doc = createProjectFromTemplate("house");
    const yDoc = new Y.Doc();
    const yMap = yDoc.getMap("project");
    projectToYDoc(doc, yMap);
    const restored = yDocToProject(yMap);
    const origPattern = doc.patterns[0];
    const restPattern = restored.patterns[0];
    expect(restPattern.id).toBe(origPattern.id);
    expect(restPattern.name).toBe(origPattern.name);
    expect(restPattern.stepCount).toBe(origPattern.stepCount);
    expect(Object.keys(restPattern.rows).length).toBe(Object.keys(origPattern.rows).length);
  });

  it("preserves effects chain", () => {
    const doc = createProjectFromTemplate("house");
    const yDoc = new Y.Doc();
    const yMap = yDoc.getMap("project");
    projectToYDoc(doc, yMap);
    const restored = yDocToProject(yMap);
    for (let i = 0; i < doc.tracks.length; i++) {
      expect(restored.tracks[i].effects.length).toBe(doc.tracks[i].effects.length);
    }
  });

  it("preserves master config", () => {
    const doc = createProjectFromTemplate("house");
    const yDoc = new Y.Doc();
    const yMap = yDoc.getMap("project");
    projectToYDoc(doc, yMap);
    const restored = yDocToProject(yMap);
    expect(restored.master).toEqual(doc.master);
  });

  it("round-trip through scene-score (5 patterns, 5 scenes)", () => {
    const doc = createProjectFromTemplate("scene-score");
    const yDoc = new Y.Doc();
    const yMap = yDoc.getMap("project");
    projectToYDoc(doc, yMap);
    const restored = yDocToProject(yMap);
    expect(restored.patterns.length).toBe(5);
    expect(restored.scenes.length).toBe(5);
    expect(restored.arrangement.clips.length).toBe(doc.arrangement.clips.length);
  });
});

describe("YDocStore", () => {
  it("creates from a ProjectDocument", () => {
    const doc = createProjectFromTemplate("house");
    const store = YDocStore.fromDocument(doc);
    expect(store.doc.id).toBe(doc.id);
    expect(store.doc.name).toBe(doc.name);
    expect(store.doc.tracks.length).toBe(doc.tracks.length);
  });

  it("getDoc returns current snapshot", () => {
    const doc = createProjectFromTemplate("house");
    const store = YDocStore.fromDocument(doc);
    expect(store.getDoc().id).toBe(doc.id);
  });

  it("subscribe fires on changes", () => {
    const doc = createProjectFromTemplate("house");
    const store = YDocStore.fromDocument(doc);
    const listener = vi.fn();
    store.subscribe(listener);
    // Execute a command that changes the doc
    const cmd = { type: "test", label: "test", execute: (d: any) => ({ ...d, name: "changed" }), undo: (d: any) => d };
    store.execute(cmd);
    expect(listener).toHaveBeenCalled();
    expect(store.doc.name).toBe("changed");
  });

  it("undo restores previous state", () => {
    const doc = createProjectFromTemplate("house");
    const store = YDocStore.fromDocument(doc);
    const cmd = {
      type: "test",
      label: "test",
      execute: (d: any) => ({ ...d, name: "changed" }),
      undo: (d: any) => ({ ...d, name: doc.name }),
    };
    store.execute(cmd);
    expect(store.doc.name).toBe("changed");
    store.undo();
    expect(store.doc.name).toBe(doc.name);
  });

  it("redo re-applies after undo", () => {
    const doc = createProjectFromTemplate("house");
    const store = YDocStore.fromDocument(doc);
    const cmd = {
      type: "test",
      label: "test",
      execute: (d: any) => ({ ...d, name: "changed" }),
      undo: (d: any) => ({ ...d, name: doc.name }),
    };
    store.execute(cmd);
    store.undo();
    store.redo();
    expect(store.doc.name).toBe("changed");
  });

  it("canUndo/canRedo reflect state", () => {
    const doc = createProjectFromTemplate("house");
    const store = YDocStore.fromDocument(doc);
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(false);
    const cmd = { type: "test", label: "test", execute: (d: any) => ({ ...d, name: "changed" }), undo: (d: any) => d };
    store.execute(cmd);
    expect(store.canUndo).toBe(true);
    store.undo();
    expect(store.canRedo).toBe(true);
  });

  it("replaceDoc clears undo stack", () => {
    const doc = createProjectFromTemplate("house");
    const store = YDocStore.fromDocument(doc);
    const cmd = { type: "test", label: "test", execute: (d: any) => ({ ...d, name: "changed" }), undo: (d: any) => d };
    store.execute(cmd);
    const newDoc = createProjectFromTemplate("techno");
    store.replaceDoc(newDoc);
    expect(store.canUndo).toBe(false);
    expect(store.doc.name).toBe(newDoc.name);
  });
});
