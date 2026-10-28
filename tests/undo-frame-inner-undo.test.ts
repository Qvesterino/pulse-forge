/**
 * F-22 — undo INSIDE an open undo frame.
 *
 * The frame owns a command list of its own (`frameCommands`) while the undo
 * stack is the real history. An undo performed while the frame is open used
 * to pop a stack entry the frame owns WITHOUT telling the frame — so the
 * compound built at the seal still wrapped the undone command:
 *
 *   - the frame's redo RE-APPLIED the undone command (the resurrection), and
 *   - the redo stack held that command a second time, so the NEXT redo
 *     applied it TWICE — a second point at one tick/value, the exact
 *     ambiguity F-07 removed from the command boundary.
 *
 * `jumpTo` already sealed the frame for precisely this reason; the undo path
 * did not. The frame is ONE history entry, so an undo inside it takes the
 * whole frame back — which is what the owned (MCP batch) frame already did.
 *
 * These specs assert the CLAIM, not the mechanism: they fail on the history
 * being wrong (a resurrected or duplicated point), not on a missing symbol.
 */
import { describe, expect, it } from "vitest";
import { ProjectStore } from "../src/store/ProjectStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { addAutomationLane, addAutomationPoint } from "../src/commands/automation";
import type { ProjectDocument } from "../src/project-model/types";

/** The authored point keys of the first lane — what a human sees. */
function pointKeys(doc: ProjectDocument): string[] {
  return (doc.automation[0]?.points ?? []).map((p) => `${p.tick}@${p.value}`);
}

function setup() {
  const store = new ProjectStore(createProjectFromTemplate("house"));
  const track = store.doc.tracks.find((t) => t.kind === "instrument")!;
  store.execute(addAutomationLane(store.doc, { kind: "trackGain", trackId: track.id }));
  const laneId = store.doc.automation[0]!.id;
  return { store, laneId };
}

/** Write three points into the lane, one command each. */
function writeThreePoints(store: ProjectStore, laneId: string): void {
  store.execute(addAutomationPoint(store.doc, laneId, 960, 0.1));
  store.execute(addAutomationPoint(store.doc, laneId, 1920, 0.2));
  store.execute(addAutomationPoint(store.doc, laneId, 2880, 0.3));
}

const frameCommands = (store: ProjectStore): unknown[] | null =>
  (store as unknown as { frameCommands: unknown[] | null }).frameCommands;

describe("F-22 — undo inside an open undo frame", () => {
  it("a legacy frame stays ONE entry: the undo takes the whole frame back", () => {
    const { store, laneId } = setup();
    store.beginUndoFrame("probe");
    writeThreePoints(store, laneId);
    expect(pointKeys(store.doc)).toHaveLength(3);

    store.undo();

    // The frame is sealed by the undo — it does not stay open holding a
    // command the history has already given back.
    expect(frameCommands(store)).toBeNull();
    // The frame is ONE history entry: the undo reverted the whole pass, and
    // the stack holds only what came BEFORE the frame.
    expect(pointKeys(store.doc)).toHaveLength(0);
    expect(store.undoStackLength).toBe(1); // the automation lane, added before the frame
  });

  it("the redo restores the frame EXACTLY once — no resurrected, duplicated point", () => {
    const { store, laneId } = setup();
    store.beginUndoFrame("probe");
    writeThreePoints(store, laneId);

    store.undo();
    expect(pointKeys(store.doc)).toHaveLength(0);

    // The frame's redo brings the whole pass back — once.
    store.redo();
    const afterRedo = pointKeys(store.doc);
    expect(afterRedo).toEqual(["960@0.1", "1920@0.2", "2880@0.3"]);

    // The second redo must not apply the undone command a second time: a lane
    // holds ONE point per (tick, value) — the invariant F-07 put at the
    // command boundary. Before the repair this produced FOUR points, two of
    // them at 2880@0.3.
    store.redo();
    const keys = pointKeys(store.doc);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["960@0.1", "1920@0.2", "2880@0.3"]);
  });

  it("the legacy frame behaves like the owned (MCP batch) frame", () => {
    const legacy = setup();
    legacy.store.beginUndoFrame("probe");
    writeThreePoints(legacy.store, legacy.laneId);
    legacy.store.undo();
    const legacyKeys = pointKeys(legacy.store.doc);
    const legacyStack = legacy.store.undoStackLength;

    const owned = setup();
    const token = owned.store.beginOwnedUndoFrame("batch")!;
    owned.store.executeAgentCommand(addAutomationPoint(owned.store.doc, owned.laneId, 960, 0.1), token);
    owned.store.executeAgentCommand(addAutomationPoint(owned.store.doc, owned.laneId, 1920, 0.2), token);
    owned.store.executeAgentCommand(addAutomationPoint(owned.store.doc, owned.laneId, 2880, 0.3), token);
    owned.store.undo();

    // Two paths, one contract: the undo inside the frame reverts the whole
    // pass and leaves the history one entry deep.
    expect(legacyKeys).toEqual(pointKeys(owned.store.doc));
    expect(legacyStack).toBe(owned.store.undoStackLength);
  });

  it("undo-all → baseline and redo-all → final survive an inner undo", () => {
    const { store, laneId } = setup();
    const baseline = pointKeys(store.doc);

    store.beginUndoFrame("probe");
    writeThreePoints(store, laneId);
    const final = pointKeys(store.doc);
    store.undo();
    // The gesture closes its frame afterwards — the realistic order.
    store.endUndoFrame();

    while (store.undoStackLength > 0) store.undo();
    expect(pointKeys(store.doc)).toEqual(baseline);

    while (store.canRedo) store.redo();
    expect(pointKeys(store.doc)).toEqual(final);
    // And the restored document holds no duplicated point.
    const keys = pointKeys(store.doc);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("the frame's own endUndoFrame after an inner undo adds no second entry", () => {
    const { store, laneId } = setup();
    store.beginUndoFrame("probe");
    writeThreePoints(store, laneId);
    store.undo();
    const stackAfterUndo = store.undoStackLength;

    // The gesture owner closes its frame afterwards — that close must be a
    // no-op, not a second history entry for a pass that is already gone.
    store.endUndoFrame();
    expect(store.undoStackLength).toBe(stackAfterUndo);
    expect(pointKeys(store.doc)).toHaveLength(0);
  });
});
