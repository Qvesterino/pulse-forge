/**
 * An automation point's undo must remove the point it created — never a
 * different one (audit F-29, High; and F-07's destructive half).
 *
 * A lane point carries only `{ tick, value }` — no identity — and the
 * normaliser rebuilds the whole points array on every command, so identity is
 * gone by the time an undo runs. The undo delta therefore carried the point's
 * INDEX, and a positional splice deletes whatever now occupies that slot: when
 * the lane's array shifted between the command and its undo (a point inserted
 * before it), the AI's undo removed the HUMAN's point and left its own.
 *
 * Two repairs, both asserted here:
 *   1. the delta's `del` op VERIFIES the slot before splicing — the op
 *      carries the removed element, and it was never compared;
 *   2. the command's own undo re-anchors by identity, then by (tick, value),
 *      taking the LAST match — the "Audit 06 D3" treatment that
 *      `moveAutomationPoint` already had.
 */
import { describe, expect, it } from "vitest";
import { ProjectStore } from "../src/store/ProjectStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { addAutomationLane, addAutomationPoint } from "../src/commands/automation";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import type { Command } from "../src/commands/types";
import type { AutomationLane, ProjectDocument } from "../src/project-model/types";
import { withAgentWriter } from "./helpers/mcpAgentWriter";

const house = (): ProjectDocument => createProjectFromTemplate("house");

function ctxCapturing(store: ProjectStore, captured: Command[], apply: boolean): McpToolContext {
  return withAgentWriter({
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
    transport: {
      play() {},
      stop() {},
      pause() {},
      setLoop() {},
      setMetronome() {},
    },
  }) as unknown as McpToolContext;
}

function laneOf(doc: ProjectDocument, trackId: string): AutomationLane | undefined {
  return doc.automation.find((l) => l.target.trackId === trackId && l.target.kind === "trackGain");
}

describe("an automation undo removes the point it created (F-29)", () => {
  it("the MCP undo removes its point after a remote insert shifts the lane", async () => {
    const store = new ProjectStore(house());
    const track = store.doc.tracks[0];
    const captured: Command[] = [];

    // The lane EXISTS and is EMPTY, so the AI's delta touches the POINT only.
    store.execute(addAutomationLane(store.doc, { kind: "trackGain", trackId: track.id }));
    const laneId = laneOf(store.doc, track.id)!.id;

    // Capture the actual MCP snapshot command without applying it. Apply it
    // against its base, then simulate a remote merge before its local undo.
    // This keeps the regression focused on F-29's positional delete rather
    // than relying on the F-25 stale-write gate to accept an old command.
    await executeMcpTool(ctxCapturing(store, captured, false), "kyx_automation", {
      op: "addPoint",
      trackId: track.id,
      param: "gain",
      bar: 4,
      value: 0.5,
    });
    const aiCommand = captured[0];
    expect(aiCommand).toBeDefined();

    const afterAi = aiCommand.execute(store.doc);
    expect(laneOf(afterAi, track.id)!.points.length).toBe(1);

    // A remote collaborator inserts an EARLIER point after the MCP write.
    // It is not in this client's undo stack, so the next local undo still
    // targets the captured MCP command.
    const withRemotePoint = addAutomationPoint(afterAi, laneId, 0, 0.9).execute(afterAi);
    const afterUndo = aiCommand.undo(withRemotePoint);
    const after = laneOf(afterUndo, track.id)!.points;

    // THE FIX: the human's point survived, the AI's is gone.
    expect(after.some((p) => p.tick === 0 && p.value === 0.9)).toBe(true);
    expect(after.some((p) => p.tick !== 0 && p.value === 0.5)).toBe(false);
  });

  it("the F-25 stale-write gate refuses the old deferred scenario", async () => {
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
    const aiCommand = captured[0];
    expect(aiCommand).toBeDefined();

    // The human changes the same lane after the MCP tool read it. F-25 now
    // refuses this stale write before it can enter history or require undo.
    store.execute(addAutomationPoint(store.doc, laneId, 0, 0.9));
    const undoDepth = store.undoStackLength;
    expect(() => store.execute(aiCommand)).toThrow(/stale write refused/);
    expect(store.undoStackLength).toBe(undoDepth);
    expect(laneOf(store.doc, track.id)!.points.map((p) => ({ tick: p.tick, value: p.value }))).toEqual([
      { tick: 0, value: 0.9 },
    ]);
  });

  it("the plain stack order still undoes in order (the control)", async () => {
    const store = new ProjectStore(house());
    const track = store.doc.tracks[0];
    const captured: Command[] = [];

    store.execute(addAutomationLane(store.doc, { kind: "trackGain", trackId: track.id }));
    const laneId = laneOf(store.doc, track.id)!.id;

    // The AI's write lands IMMEDIATELY.
    await executeMcpTool(ctxCapturing(store, captured, true), "kyx_automation", {
      op: "addPoint",
      trackId: track.id,
      param: "gain",
      bar: 4,
      value: 0.5,
    });
    const aiPoint = laneOf(store.doc, track.id)!.points[0];

    // The human adds an earlier point — ON TOP of the AI's command.
    store.execute(addAutomationPoint(store.doc, laneId, 0, 0.9));

    // Ctrl+Z #1 → the human's command.
    store.undo();
    expect(laneOf(store.doc, track.id)!.points.some((p) => p.tick === 0 && p.value === 0.9)).toBe(false);

    // Ctrl+Z #2 → the AI's command.
    store.undo();
    expect(laneOf(store.doc, track.id)!.points.some((p) => p.tick === aiPoint.tick && p.value === aiPoint.value)).toBe(
      false,
    );
  });

  it("the command's own undo removes the point it inserted", () => {
    const store = new ProjectStore(house());
    const track = store.doc.tracks[0];
    store.execute(addAutomationLane(store.doc, { kind: "trackGain", trackId: track.id }));
    const laneId = laneOf(store.doc, track.id)!.id;

    store.execute(addAutomationPoint(store.doc, laneId, 960, 0.6));
    expect(laneOf(store.doc, track.id)!.points.length).toBe(1);

    store.undo();
    expect(laneOf(store.doc, track.id)!.points.length).toBe(0);
  });

  it("an identical point is refused instead of duplicated (F-07)", async () => {
    const store = new ProjectStore(house());
    const track = store.doc.tracks[0];
    const captured: Command[] = [];

    const first = await executeMcpTool(ctxCapturing(store, captured, true), "kyx_automation", {
      op: "addPoint",
      trackId: track.id,
      param: "gain",
      bar: 4,
      value: 0.5,
    });
    expect(first.mutated).toBe(true);
    const laneId = laneOf(store.doc, track.id)!.id;
    expect(laneOf(store.doc, track.id)!.points.length).toBe(1);

    // The SAME write again — a no-op that used to duplicate the point and grow
    // the history.
    const second = await executeMcpTool(ctxCapturing(store, captured, true), "kyx_automation", {
      op: "addPoint",
      trackId: track.id,
      param: "gain",
      bar: 4,
      value: 0.5,
    });
    expect(second.mutated).toBe(false);
    expect(second.text).toContain("already present");
    expect(laneOf(store.doc, track.id)!.points.length).toBe(1);
    // The lane is still the one the first call created.
    expect(laneOf(store.doc, track.id)!.id).toBe(laneId);
  });
});
