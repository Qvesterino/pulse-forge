import { describe, it, expect, beforeEach } from "vitest";
import { executeMcpTool, resetMcpCheckpoints, type McpToolContext } from "../src/mcp/tools";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { useDeterministicIds, resetDeterministicIds } from "../src/shared/ids";
import { ProjectStore } from "../src/store/ProjectStore";

/**
 * kyx_checkpoint — the agent time machine (Fáza C, docs/AGENTIC-DAW-PLAN.md).
 * Named full-document snapshots: save/list/restore/delete, ONE-undo restore,
 * LRU cap 8, and the auto-checkpoint that rides the D4 destructive gate.
 */

function storeCtx(store: ProjectStore, options: { allowDestructive?: boolean } = {}): McpToolContext {
  return {
    getDoc: () => store.doc,
    execute: (command) => store.execute(command),
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => store.history.map((entry) => entry.label),
    isMicRecordingActive: () => false,
    transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
    ...(options.allowDestructive ? { allowDestructive: () => true } : {}),
  };
}

function datasetStore(): ProjectStore {
  useDeterministicIds();
  resetDeterministicIds();
  return new ProjectStore(createProjectFromTemplate("house"));
}

beforeEach(() => {
  resetMcpCheckpoints();
});

describe("kyx_checkpoint", async () => {
  it("save → list shows the name, summary and steps-since; mutations grow the counter", async () => {
    const store = datasetStore();
    const ctx = storeCtx(store);
    const saved = await executeMcpTool(ctx, "kyx_checkpoint", { op: "save", name: "clean-house" });
    expect(saved.mutated).toBe(false);
    expect(saved.text).toContain('"clean-house"');
    expect(saved.text).toContain("1/8 used");

    await executeMcpTool(ctx, "kyx_generate", { genre: "techno", seed: "mutate-1" });
    await executeMcpTool(ctx, "kyx_generate", { genre: "trap", seed: "mutate-2" });

    const list = await executeMcpTool(ctx, "kyx_checkpoint", { op: "list" });
    expect(list.text).toContain("clean-house");
    expect(list.text).toContain("2 step(s) since");
  });

  it("restore rolls the WHOLE document back; one undo returns to the pre-restore state", async () => {
    const store = datasetStore();
    const ctx = storeCtx(store);
    const beforePatterns = store.doc.patterns.length;
    const beforeActive = store.doc.activePatternId;
    await executeMcpTool(ctx, "kyx_checkpoint", { op: "save", name: "base" });

    await executeMcpTool(ctx, "kyx_generate", { genre: "techno", seed: "experiment" });
    expect(store.doc.patterns.length).toBe(beforePatterns + 1);
    expect(store.doc.activePatternId).not.toBe(beforeActive);

    const restored = await executeMcpTool(ctx, "kyx_checkpoint", { op: "restore", name: "base" });
    expect(restored.mutated).toBe(true);
    expect(store.doc.patterns.length).toBe(beforePatterns);
    expect(store.doc.activePatternId).toBe(beforeActive);

    // the undo ladder works through the restore
    store.undo();
    expect(store.doc.patterns.length).toBe(beforePatterns + 1);
    store.redo();
    expect(store.doc.activePatternId).toBe(beforeActive);
  });

  it("restore of an unknown name is an honest isError and names what exists", async () => {
    const ctx = storeCtx(datasetStore());
    await executeMcpTool(ctx, "kyx_checkpoint", { op: "save", name: "real" });
    const missing = await executeMcpTool(ctx, "kyx_checkpoint", { op: "restore", name: "ghost" });
    expect(missing.isError).toBe(true);
    expect(missing.mutated).toBe(false);
    expect(missing.text).toContain("real");
    const noName = await executeMcpTool(ctx, "kyx_checkpoint", { op: "restore" });
    expect(noName.isError).toBe(true);
  });

  it("names are sanitized (trimmed, control chars stripped, 40-char cap); empty names auto-number", async () => {
    const ctx = storeCtx(datasetStore());
    const saved = await executeMcpTool(ctx, "kyx_checkpoint", { op: "save", name: "  My  <Checkpoint>:v1  " });
    expect(saved.text).toContain('"My Checkpointv1"');
    const auto = await executeMcpTool(ctx, "kyx_checkpoint", { op: "save" });
    expect(auto.text).toContain('"checkpoint-');
    expect((await executeMcpTool(ctx, "kyx_checkpoint", { op: "list" })).text).toContain("checkpoint-");
  });

  it("LRU: only the last 8 checkpoints are kept", async () => {
    const ctx = storeCtx(datasetStore());
    for (let i = 1; i <= 9; i++) {
      await executeMcpTool(ctx, "kyx_checkpoint", { op: "save", name: `cp-${i}` });
    }
    const list = await executeMcpTool(ctx, "kyx_checkpoint", { op: "list" });
    expect(list.text).not.toContain("cp-1\n");
    expect(list.text).not.toContain("cp-1 ·");
    expect(list.text).toContain("cp-9");
    expect(list.text.split("\n")).toHaveLength(8);
  });

  it("delete removes one checkpoint without touching the project", async () => {
    const store = datasetStore();
    const ctx = storeCtx(store);
    await executeMcpTool(ctx, "kyx_checkpoint", { op: "save", name: "temp" });
    const patterns = store.doc.patterns.length;
    const deleted = await executeMcpTool(ctx, "kyx_checkpoint", { op: "delete", name: "temp" });
    expect(deleted.mutated).toBe(false);
    expect(store.doc.patterns.length).toBe(patterns);
    const list = await executeMcpTool(ctx, "kyx_checkpoint", { op: "list" });
    expect(list.text).toContain("no checkpoints");
  });

  it("D4 destructive ops auto-save an auto-before checkpoint that actually restores", async () => {
    const store = datasetStore();
    const ctx = storeCtx(store, { allowDestructive: true });
    const tracksBefore = store.doc.tracks.length;

    const removed = await executeMcpTool(ctx, "kyx_tracks", { op: "remove", family: "drums" });
    expect(removed.mutated).toBe(true);
    expect(store.doc.tracks.length).toBeLessThan(tracksBefore);

    const list = await executeMcpTool(ctx, "kyx_checkpoint", { op: "list" });
    expect(list.text).toContain("auto-before-kyx_tracks");

    const restored = await executeMcpTool(ctx, "kyx_checkpoint", { op: "restore", name: "auto-before-kyx_tracks" });
    expect(restored.mutated).toBe(true);
    expect(store.doc.tracks.length).toBe(tracksBefore);
  });

  it("locked destructive ops do NOT create auto checkpoints", async () => {
    const ctx = storeCtx(datasetStore());
    await executeMcpTool(ctx, "kyx_tracks", { op: "remove", family: "drums" });
    const list = await executeMcpTool(ctx, "kyx_checkpoint", { op: "list" });
    expect(list.text).toContain("no checkpoints");
  });
});
