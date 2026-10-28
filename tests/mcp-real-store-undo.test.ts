import { describe, expect, it } from "vitest";
import { ProjectStore } from "../src/store/ProjectStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import type { Command } from "../src/commands/types";
import { withAgentWriter } from "./helpers/mcpAgentWriter";

/**
 * MCP → REAL ProjectStore UNDO GATE (seam: mcp-to-real-projectstore)
 *
 * The seam ledger listed this OPEN: "dispatch to command is covered, but every
 * ctx in the suite is a hand-rolled fake; dispatch → REAL store → undo depth is
 * not asserted anywhere in the committed suite." A fake ctx that swallows
 * `execute` makes every mutation spec green while the agent's write never
 * reaches the undo stack — an agent edit the user cannot undo.
 *
 * These specs wire the REAL store and assert the round trip, plus the
 * negative the fakes could never see: a READ must not touch the undo stack.
 */

function realCtx() {
  const store = new ProjectStore(createProjectFromTemplate("house"));
  const ctx: McpToolContext = withAgentWriter({
    getDoc: () => store.doc,
    execute: (command: Command) => store.execute(command),
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => store.history.map((entry) => entry.label),
    isMicRecordingActive: () => false,
    transport: { play() {}, stop() {}, pause() {}, setLoop() {}, setMetronome() {} },
  });
  return { store, ctx };
}

const bassGain = (store: ProjectStore): number => {
  const bass = store.doc.tracks.find((t) => t.kind === "instrument");
  expect(bass, "the house template must seed an instrument track").toBeDefined();
  return bass!.gain;
};

describe("MCP dispatch against a real store (seam: mcp-to-real-projectstore)", () => {
  it("a mutating tool writes the REAL document and lands on the undo stack", async () => {
    const { store, ctx } = realCtx();
    const before = bassGain(store);
    expect(store.undoStackLength).toBe(0);

    const result = await executeMcpTool(ctx, "kyx_tracks", { op: "setGain", family: "bass", gain: 0.42 });

    expect(result.mutated).toBe(true);
    expect(bassGain(store)).toBeCloseTo(0.42, 6);
    expect(bassGain(store)).not.toBe(before);
    // The write is a real command — one user-visible history entry.
    expect(store.undoStackLength).toBe(1);
    expect(ctx.historyLabels()).toHaveLength(1);
  });

  it("the agent's edit is undoable through the ordinary undo path", async () => {
    const { store, ctx } = realCtx();
    const before = bassGain(store);

    await executeMcpTool(ctx, "kyx_tracks", { op: "setGain", family: "bass", gain: 0.42 });
    expect(bassGain(store)).not.toBe(before);

    ctx.undo();
    expect(bassGain(store), "undo must restore the pre-agent value").toBe(before);
    expect(store.undoStackLength).toBe(0);
  });

  it("NEGATIVE: a read tool leaves the document AND the undo stack untouched", async () => {
    const { store, ctx } = realCtx();
    const before = JSON.stringify(store.doc);

    const state = await executeMcpTool(ctx, "kyx_state", {});
    expect(state.mutated).toBe(false);

    const presets = await executeMcpTool(ctx, "kyx_tracks", { op: "listPresets" });
    expect(presets.mutated).toBe(false);

    expect(JSON.stringify(store.doc)).toBe(before);
    expect(store.undoStackLength, "reads must not push history").toBe(0);
  });
});
