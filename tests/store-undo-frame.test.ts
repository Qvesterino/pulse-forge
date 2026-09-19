/**
 * Undo frame — a live record pass collapses into ONE history entry.
 * begin → N executes (live) → end: one Ctrl+Z removes the whole pass,
 * redo re-applies it. Empty frames leave no history entry.
 */
import { describe, expect, it } from "vitest";
import { ProjectStore } from "../src/store/ProjectStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { setStepVelocityCommand } from "../src/commands/commands";

function setup() {
  const doc = createProjectFromTemplate("house");
  const store = new ProjectStore(doc);
  const padId = doc.tracks.find((t) => t.kind === "drum")!.pads[0].id;
  const rowOf = (d = store.getDoc()) =>
    d.patterns.find((p) => p.id === d.activePatternId)!.rows[padId] ?? [];
  return { store, padId, rowOf };
}

describe("ProjectStore — undo frame", () => {
  it("collapses a multi-command pass into one undo entry", () => {
    const { store, padId, rowOf } = setup();
    const before = rowOf();
    store.beginUndoFrame("Recorded take");
    store.execute(setStepVelocityCommand(store.getDoc(), padId, 0, 0.9));
    store.execute(setStepVelocityCommand(store.getDoc(), padId, 4, 0.8));
    store.execute(setStepVelocityCommand(store.getDoc(), padId, 8, 0.7));
    expect(rowOf()[0]).toBe(0.9);
    store.endUndoFrame();
    // ONE undo removes the whole pass
    store.undo();
    expect(rowOf()).toEqual(before);
    // redo re-applies the whole pass
    store.redo();
    const after = rowOf();
    expect(after[0]).toBe(0.9);
    expect(after[4]).toBe(0.8);
    expect(after[8]).toBe(0.7);
  });

  it("an empty frame leaves no history entry", () => {
    const { store } = setup();
    const depth = store.undoStackLength;
    store.beginUndoFrame();
    store.endUndoFrame();
    expect(store.undoStackLength).toBe(depth);
  });

  it("coalesced gestures inside a frame do not break the collapse", () => {
    const { store, padId, rowOf } = setup();
    const before = rowOf();
    store.beginUndoFrame();
    const c1 = { ...setStepVelocityCommand(store.getDoc(), padId, 0, 0.5), coalesceKey: "vel" };
    const c2 = { ...setStepVelocityCommand(store.getDoc(), padId, 0, 0.8), coalesceKey: "vel" };
    store.execute(c1);
    store.execute(c2);
    store.endUndoFrame();
    expect(rowOf()[0]).toBe(0.8);
    store.undo();
    expect(rowOf()).toEqual(before);
  });
});
