import { describe, it, expect, beforeEach } from "vitest";
import { executeMcpTool, resetMcpCheckpoints, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { useDeterministicIds, resetDeterministicIds } from "../src/shared/ids";
import { ProjectStore } from "../src/store/ProjectStore";

/**
 * C7.5 — CHECKPOINT DIFF: the agent decides whether to restore with
 * knowledge instead of blind-rolling. The diff names tracks added/removed/
 * renamed, tempo drift, pattern/clip counts and FX deltas — bounded at 12
 * lines with an honest "...and N more" tail.
 */

function makeCtx(): McpToolContext {
  useDeterministicIds();
  resetDeterministicIds();
  const store = new ProjectStore(createProjectFromTemplate("house"));
  return {
    getDoc: () => store.doc,
    execute: (command) => store.execute(command),
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => [],
    isMicRecordingActive: () => false,
    transport: { play() {}, stop() {}, pause() {}, setLoop() {}, setMetronome() {} },
  };
}

beforeEach(() => {
  resetMcpCheckpoints();
});

describe("kyx_checkpoint diff (C7.5)", () => {
  it("no differences → the document matches the checkpoint", async () => {
    const ctx = makeCtx();
    await executeMcpTool(ctx, "kyx_checkpoint", { op: "save", name: "snapshot" });
    const diff = await executeMcpTool(ctx, "kyx_checkpoint", { op: "diff", name: "snapshot" });
    expect(diff.mutated).toBe(false);
    expect(diff.text).toContain("no differences");
  });

  it("names the concrete changes: tracks, tempo, patterns, clips, FX", async () => {
    const ctx = makeCtx();
    await executeMcpTool(ctx, "kyx_checkpoint", { op: "save", name: "base" });

    // mutate: tempo, new track, FX, markers
    executeMcpTool(ctx, "kyx_intent", { instruction: "set tempo to 150" });
    executeMcpTool(ctx, "kyx_tracks", { op: "addInstrument", instrument: "808" });
    executeMcpTool(ctx, "kyx_fx", { effect: "reverb", family: "drums", action: "more" });

    const diff = await executeMcpTool(ctx, "kyx_checkpoint", { op: "diff", name: "base" });
    expect(diff.mutated).toBe(false);
    expect(diff.text).toContain("+ track");
    expect(diff.text).toContain("tempo 124 -> 150");
    expect(diff.text).toContain("FX instances");
    expect(diff.text).toContain("restore replaces ALL of this in one undo step");
  });

  it("unknown checkpoint name is an honest isError", async () => {
    const ctx = makeCtx();
    const diff = await executeMcpTool(ctx, "kyx_checkpoint", { op: "diff", name: "ghost" });
    expect(diff.isError).toBe(true);
    expect(diff.text).toContain('no checkpoint "ghost"');
  });
});
