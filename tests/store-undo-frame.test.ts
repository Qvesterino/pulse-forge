/**
 * Undo frame — a live record pass collapses into ONE history entry.
 * begin → N executes (live) → end: one Ctrl+Z removes the whole pass,
 * redo re-applies it. Empty frames leave no history entry.
 */
import { describe, expect, it } from "vitest";
import { ProjectStore } from "../src/store/ProjectStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { addEffect, setEffectParam, setStepVelocityCommand } from "../src/commands/commands";

function setup() {
  const doc = createProjectFromTemplate("house");
  const store = new ProjectStore(doc);
  const padId = doc.tracks.find((t) => t.kind === "drum")!.pads[0].id;
  const rowOf = (d = store.getDoc()) => d.patterns.find((p) => p.id === d.activePatternId)!.rows[padId] ?? [];
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

  it("collapses an XY pad drag (two params per pointermove) into one entry", () => {
    // The Ozvena blend pad's exact production shape: every pointermove writes
    // blendPad.x and then blendPad.y, bracketed by the frame hooks EffectRack
    // passes down. Before the frame existed, a 1s drag produced ~120 history
    // entries and one Ctrl+Z peeled back a single coordinate.
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((t) => t.kind === "instrument")!;
    const withOzvena = addEffect(doc, track.id, "ozvena").execute(doc);
    const store = new ProjectStore(withOzvena);
    const fxId = withOzvena.tracks.find((t) => t.id === track.id)!.effects[0]!.id;
    const padOf = () => {
      const t = store.getDoc().tracks.find((tr) => tr.id === track.id)!;
      return { x: t.effects[0]!.params["blendPad.x"] ?? 0.5, y: t.effects[0]!.params["blendPad.y"] ?? 0.5 };
    };
    const before = padOf();

    // 30 pointermoves, each writing two params — the frame stays open.
    store.beginUndoFrame("Blend pad");
    for (let i = 1; i <= 30; i += 1) {
      const v = +(0.5 + i / 100).toFixed(4);
      store.execute(setEffectParam(store.getDoc(), track.id, fxId, "blendPad.x", v));
      store.execute(setEffectParam(store.getDoc(), track.id, fxId, "blendPad.y", v));
    }
    store.endUndoFrame();

    const after = padOf();
    expect(after.x).toBe(0.8);
    expect(after.y).toBe(0.8);

    // ONE undo takes back the whole drag — both coordinates together.
    const depth = store.undoStackLength;
    store.undo();
    expect(padOf()).toEqual(before);
    // …and it really was one entry, not sixty.
    expect(depth - 1).toBe(store.undoStackLength);
  });
});
