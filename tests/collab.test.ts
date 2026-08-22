import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { yDocToProject, projectToYDoc } from "../src/collab/YDocAdapter";
import { YDocStore } from "../src/collab/YDocStore";

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
    const cmd = { type: "test", label: "test", execute: (d: any) => ({ ...d, name: "changed" }), undo: (d: any) => ({ ...d, name: doc.name }) };
    store.execute(cmd);
    expect(store.doc.name).toBe("changed");
    store.undo();
    expect(store.doc.name).toBe(doc.name);
  });

  it("redo re-applies after undo", () => {
    const doc = createProjectFromTemplate("house");
    const store = YDocStore.fromDocument(doc);
    const cmd = { type: "test", label: "test", execute: (d: any) => ({ ...d, name: "changed" }), undo: (d: any) => ({ ...d, name: doc.name }) };
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
