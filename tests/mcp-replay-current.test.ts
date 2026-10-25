/**
 * A replay reports the ORIGINAL outcome — and, in a SECOND channel, what
 * holds NOW (audit F-06).
 *
 * The replay's text and `data` are the original outcome, and that is a PINNED
 * contract (tests/mcp-idempotency.test.ts): the requestId names ONE logical
 * operation, the agent owns undo/redo, and the "nothing re-executed" reply
 * must stay byte-identical.
 *
 * What was missing is the PRESENT: the replay served the original read-back
 * (e.g. "gain 0.250") while the document held 0.9, and the envelope's
 * `mutated: true` describes the original call, not this one. The fix adds a
 * SIBLING field — `current` — carrying the fields that MOVED (not the whole
 * state), and makes the R-02 gate replay-aware so the replay passes through
 * its perimeter without the "nothing changed" rewrite contradicting it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../src/store/ProjectStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { setTrackParams } from "../src/commands/project";
import type { Command } from "../src/commands/types";
import { executeMcpTool, resetMcpIdempotencyLedger, type McpToolContext } from "../src/mcp/tools";

function makeCtx(store: ProjectStore): McpToolContext {
  return {
    getDoc: () => store.doc,
    execute: (command: Command) => store.execute(command),
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => store.history.map((entry) => entry.label),
    isMicRecordingActive: () => false,
    transport: {
      play() {},
      stop() {},
      pause() {},
      setLoop() {},
      setMetronome() {},
    },
  } as unknown as McpToolContext;
}

beforeEach(() => {
  resetMcpIdempotencyLedger();
});

describe("the replay's second channel — what holds NOW (F-06)", () => {
  it("keeps the original outcome AND reports what moved since", async () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const track = store.doc.tracks[0];
    const ctx = makeCtx(store);
    const args = { op: "setGain", trackId: track.id, gain: 0.5, requestId: "f06-moved" };

    const first = await executeMcpTool(ctx, "kyx_tracks", args);
    expect(first.mutated).toBe(true);

    // The human moves the fader after the AI's call.
    ctx.execute(setTrackParams(ctx.getDoc(), track.id, { gain: 0.9 }));

    const replay = await executeMcpTool(ctx, "kyx_tracks", args);
    expect(replay.replayed).toBe(true);

    // THE PINNED CONTRACT — the original outcome, unchanged.
    expect(replay.mutated).toBe(true);
    expect(replay.text).toBe(`idempotent replay — requestId was already applied; nothing re-executed\n${first.text}`);
    expect(replay.data).toEqual(first.data);

    // THE SECOND CHANNEL — what holds now for the field the call wrote.
    expect(replay.current).toBeDefined();
    expect(replay.current!.moved).toBe(true);
    expect(replay.current!.changed.length).toBeGreaterThan(0);
    const gainChange = replay.current!.changed.find((entry) => entry.path.includes("gain"));
    expect(gainChange?.was).toBe(0.5);
    expect(gainChange?.now).toBe(0.9);
  });

  it("says so when nothing moved since the original call", async () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const track = store.doc.tracks[0];
    const ctx = makeCtx(store);
    const args = { op: "setGain", trackId: track.id, gain: 0.5, requestId: "f06-same" };

    await executeMcpTool(ctx, "kyx_tracks", args);
    const replay = await executeMcpTool(ctx, "kyx_tracks", args);

    expect(replay.replayed).toBe(true);
    expect(replay.current?.moved).toBe(false);
    expect(replay.current?.changed).toEqual([]);
  });

  it("the present is a SIBLING — it never leaks into `data`", async () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const track = store.doc.tracks[0];
    const ctx = makeCtx(store);
    const args = { op: "setGain", trackId: track.id, gain: 0.5, requestId: "f06-sibling" };

    const first = await executeMcpTool(ctx, "kyx_tracks", args);
    ctx.execute(setTrackParams(ctx.getDoc(), track.id, { gain: 0.9 }));
    const replay = await executeMcpTool(ctx, "kyx_tracks", args);

    expect(replay.data).toEqual(first.data);
    expect((replay.data as Record<string, unknown> | undefined)?.current).toBeUndefined();
    expect(replay.current).toBeDefined();
  });
});
