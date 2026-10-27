/**
 * Audit F-07 — an automation point is ADDRESSED BY IDENTITY, not by position
 * or by value.
 *
 * The finding (STATE_DIVERGENCE_HUNTER_REPORT.md §4/F-07): an automation
 * point carried only `tick` and `value`, so it had no identity of its own.
 * Measured against today's tree, that one decision produced four defects:
 *
 *   M1  the COMMAND layer duplicated an identical point (the MCP had a guard
 *       bolted on top; the UI, the intent pipeline and collab did not);
 *   M2  the MCP's movePoint acknowledgement read the committed point back by
 *       INDEX — after the lane re-sorted it named a point the move never
 *       touched ("1.1=0.1 → 1.2=0.2" for a move that went to bar 8);
 *   M3  an undo could not re-anchor a point that had been EDITED since it was
 *       created — the content it carried no longer matched anything, so the
 *       undo removed nothing while still consuming a history entry;
 *   M5  a positional capture (`lane.points[index]`) sent the write to whatever
 *       occupied the slot later — a shifted lane deleted the HUMAN's point.
 *
 * The repair: every authored point carries a stable `id` (SCHEMA v39+), the
 * commands re-anchor on it, and the structural delta anchors on it.
 */
import { describe, expect, it } from "vitest";
import { ProjectStore } from "../src/store/ProjectStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { assignPointIds } from "../src/project-model/automation";
import {
  addAutomationLane,
  addAutomationPoint,
  deleteAutomationPoint,
  moveAutomationPoint,
} from "../src/commands/automation";
import { computeDocDelta } from "../src/commands/docDelta";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import { useDeterministicIds } from "../src/shared/ids";
import type { Command } from "../src/commands/types";
import type { AutomationLane, AutomationPoint, ProjectDocument } from "../src/project-model/types";

const house = (): ProjectDocument => createProjectFromTemplate("house");

function ctxCapturing(store: ProjectStore, captured: Command[], apply: boolean): McpToolContext {
  return {
    getDoc: () => store.doc,
    execute: (command: Command) => {
      captured.push(command);
      if (apply) store.execute(command);
    },
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => store.history.map((e) => e.label),
    isMicRecordingActive: () => false,
    transport: { play() {}, stop() {}, pause() {}, setLoop() {}, setMetronome() {} },
  } as unknown as McpToolContext;
}

function laneOf(doc: ProjectDocument, trackId: string): AutomationLane | undefined {
  return doc.automation.find((l) => l.target.trackId === trackId && l.target.kind === "trackGain");
}

/** Every authored point in the document, across all four carriers. */
function authoredPoints(doc: ProjectDocument): AutomationPoint[] {
  const generative: AutomationPoint[] = [];
  for (const track of doc.tracks) {
    if ("generative" in track && track.generative) {
      for (const lane of track.generative.automation ?? []) generative.push(...lane.points);
    }
  }
  return [
    ...doc.automation.flatMap((lane) => lane.points),
    ...doc.sceneAutomation.flatMap((lane) => lane.points),
    ...(doc.arrangement?.automationClips ?? []).flatMap((clip) => clip.points),
    ...generative,
  ];
}

describe("F-07 — an automation point has a stable identity", () => {
  it("every authored point in a normalised document carries a unique id", () => {
    const restore = useDeterministicIds();
    try {
      const store = new ProjectStore(house());
      const track = store.doc.tracks[0];
      store.execute(addAutomationLane(store.doc, { kind: "trackGain", trackId: track.id }));
      const laneId = laneOf(store.doc, track.id)!.id;
      store.execute(addAutomationPoint(store.doc, laneId, 960, 0.6));
      store.execute(addAutomationPoint(store.doc, laneId, 1440, 0.7));

      const points = authoredPoints(store.doc);
      expect(points.length).toBeGreaterThan(0);
      for (const point of points) {
        expect(typeof point.id).toBe("string");
        expect(point.id!.length).toBeGreaterThan(0);
      }
      // Uniqueness WITHIN a curve is what the id-anchored delta needs.
      for (const lane of store.doc.automation) {
        const ids = lane.points.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
    } finally {
      restore();
    }
  });

  it("a legacy document (points without ids) is given DETERMINISTIC ids", () => {
    // Two clients that load the SAME legacy file must derive the SAME
    // identity — a random id would make their collab merge treat every point
    // as a new one.
    const legacy: AutomationPoint[] = [
      { tick: 0, value: 0.1 },
      { tick: 480, value: 0.2 },
    ];
    const first = assignPointIds("lane-x", legacy);
    const second = assignPointIds("lane-x", legacy);
    expect(first.map((p) => p.id)).toEqual(second.map((p) => p.id));
    expect(first.every((p) => typeof p.id === "string" && p.id !== "")).toBe(true);
    // Existing ids are PRESERVED — a re-normalisation never renumbers a live
    // document.
    const kept = assignPointIds("lane-x", [{ id: "pt-keep", tick: 0, value: 0.1 }]);
    expect(kept[0]!.id).toBe("pt-keep");
  });

  it("normalisation is idempotent and does not renumber a live document", () => {
    const store = new ProjectStore(house());
    const track = store.doc.tracks[0];
    store.execute(addAutomationLane(store.doc, { kind: "trackGain", trackId: track.id }));
    const laneId = laneOf(store.doc, track.id)!.id;
    store.execute(addAutomationPoint(store.doc, laneId, 960, 0.6));

    const once = normalizeProject(store.doc);
    const twice = normalizeProject(once);
    expect(twice).toEqual(once);
    const ids = laneOf(once, track.id)!.points.map((p) => p.id);
    expect(laneOf(twice, track.id)!.points.map((p) => p.id)).toEqual(ids);
  });

  it("M1 — the COMMAND layer refuses to duplicate an identical point", () => {
    const store = new ProjectStore(house());
    const track = store.doc.tracks[0];
    store.execute(addAutomationLane(store.doc, { kind: "trackGain", trackId: track.id }));
    const laneId = laneOf(store.doc, track.id)!.id;

    store.execute(addAutomationPoint(store.doc, laneId, 960, 0.6));
    const depth = store.undoStackLength;
    store.execute(addAutomationPoint(store.doc, laneId, 960, 0.6));

    expect(laneOf(store.doc, track.id)!.points).toHaveLength(1);
    // A no-op must not grow the history either.
    expect(store.undoStackLength).toBe(depth);
  });

  it("M3 — an undo re-anchors on the point it created, even after it was EDITED", async () => {
    const store = new ProjectStore(house());
    const track = store.doc.tracks[0];
    const captured: Command[] = [];
    store.execute(addAutomationLane(store.doc, { kind: "trackGain", trackId: track.id }));
    const laneId = laneOf(store.doc, track.id)!.id;

    await executeMcpTool(ctxCapturing(store, captured, false), "kyx_automation", {
      op: "addPoint",
      trackId: track.id,
      param: "gain",
      bar: 4,
      value: 0.5,
    });
    const aiCommand = captured[0]!;
    const afterAi = aiCommand.execute(store.doc);
    expect(laneOf(afterAi, track.id)!.points).toHaveLength(1);
    const pointId = laneOf(afterAi, track.id)!.points[0]!.id;

    // The human MOVES that same point — the entity survives, its tick changes.
    const moved = moveAutomationPoint(afterAi, laneId, 0, { tick: 960, value: 0.7 }).execute(afterAi);
    expect(laneOf(moved, track.id)!.points[0]!.id).toBe(pointId);

    // The AI undoes: the undo must remove the point it created.
    const afterUndo = aiCommand.undo(moved);
    expect(laneOf(afterUndo, track.id)!.points).toHaveLength(0);
  });

  it("M5 — a positional capture lands on the CAPTURED point, not on the one that took its slot", () => {
    const store = new ProjectStore(house());
    const track = store.doc.tracks[0];
    store.execute(addAutomationLane(store.doc, { kind: "trackGain", trackId: track.id }));
    const laneId = laneOf(store.doc, track.id)!.id;

    const afterAi = addAutomationPoint(store.doc, laneId, 960, 0.6).execute(store.doc);
    // The AI's delete is built against the doc it saw: index 0 = the AI's point.
    const del = deleteAutomationPoint(afterAi, laneId, 0);
    const aiPointId = laneOf(afterAi, track.id)!.points[0]!.id;

    // A remote collaborator inserts an EARLIER point -> the AI's point moves to index 1.
    const shifted = addAutomationPoint(afterAi, laneId, 0, 0.9).execute(afterAi);
    expect(laneOf(shifted, track.id)!.points[0]!.tick).toBe(0);

    const afterDel = del.execute(shifted);
    const left = laneOf(afterDel, track.id)!.points;
    // The HUMAN's point survives; the AI's point is the one that was removed.
    expect(left).toHaveLength(1);
    expect(left[0]!.tick).toBe(0);
    expect(left.some((p) => p.id === aiPointId)).toBe(false);
  });

  it("M2 — the MCP's movePoint acknowledgement names the point that MOVED", async () => {
    const store = new ProjectStore(house());
    const track = store.doc.tracks[0];
    const captured: Command[] = [];
    store.execute(addAutomationLane(store.doc, { kind: "trackGain", trackId: track.id }));
    const laneId = laneOf(store.doc, track.id)!.id;
    for (const [bar, value] of [
      [1, 0.1],
      [2, 0.2],
      [3, 0.3],
    ] as const) {
      store.execute(addAutomationPoint(store.doc, laneId, (bar - 1) * 480, value));
    }

    // Move the FIRST point far away -> the lane re-sorts and the old index 0
    // now holds a different point.
    const res = await executeMcpTool(ctxCapturing(store, captured, true), "kyx_automation", {
      op: "movePoint",
      trackId: track.id,
      param: "gain",
      bar: 1,
      newBar: 8,
    });
    expect(res.mutated).toBe(true);
    // The acknowledgement must name the MOVED point (value 0.1) and NOT the
    // point that took the first slot (value 0.2).
    expect(res.text).toContain("=0.1");
    expect(res.text).not.toContain("=0.2");
  });

  it("the structural delta anchors a point removal on its ID, not on a slot", () => {
    const store = new ProjectStore(house());
    const track = store.doc.tracks[0];
    store.execute(addAutomationLane(store.doc, { kind: "trackGain", trackId: track.id }));
    const laneId = laneOf(store.doc, track.id)!.id;
    const afterAdd = addAutomationPoint(store.doc, laneId, 960, 0.6).execute(store.doc);
    const pointId = laneOf(afterAdd, track.id)!.points[0]!.id;

    // The lane gains its FIRST point: the empty side carries no evidence about
    // the element type, so the transition must be diffed by identity — a
    // slot-anchored removal is what made the undo a silent no-op.
    const forward = computeDocDelta(store.doc, afterAdd);
    const backward = computeDocDelta(afterAdd, store.doc);
    expect(forward.ops.length).toBeGreaterThan(0);
    const removals = backward.ops.filter((op) => op.k === "del");
    expect(removals.length).toBeGreaterThan(0);
    for (const op of removals) {
      const last = op.path[op.path.length - 1]!;
      expect(typeof last).toBe("object");
      expect((last as { id: string }).id).toBe(pointId);
    }
  });
});
