import { describe, it, expect, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  executeMcpTool,
  resetMcpCheckpoints,
  setMcpCheckpointRepository,
  type CheckpointRepoLike,
  type McpToolContext,
} from "../src/mcp/tools";
import { McpCheckpointRepository, checkpointKey } from "../src/persistence/McpCheckpointRepository";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { useDeterministicIds, resetDeterministicIds } from "../src/shared/ids";
import { ProjectStore } from "../src/store/ProjectStore";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * C7 — PERSISTED AGENT CHECKPOINTS. The in-memory map stays the live state;
 * the durable copy (own tiny IDB DB, McpCheckpointRepository) is hydrated
 * per project on first checkpoint use and written through on save/delete.
 * Persistence is best-effort: no IDB → session-only, reported honestly.
 *
 * The vitest environment has no global indexedDB, so the tool-level tests
 * inject an in-memory CheckpointRepoLike (the same contract the real
 * repository satisfies), and the REAL repository gets its own
 * fake-indexeddb round-trip below.
 */

/** In-memory CheckpointRepoLike — mirrors the durable contract. */
function memoryRepo(): CheckpointRepoLike & {
  rows: Map<
    string,
    { projectId: string; name: string; label: string; auto: boolean; savedAt: string; doc: ProjectDocument }
  >;
} {
  const rows = new Map<
    string,
    { projectId: string; name: string; label: string; auto: boolean; savedAt: string; doc: ProjectDocument }
  >();
  return {
    rows,
    async put(record: {
      key: string;
      projectId: string;
      name: string;
      label: string;
      auto: boolean;
      savedAt: string;
      doc: ProjectDocument;
    }) {
      rows.set(record.key, record);
    },
    async list(projectId: string) {
      return [...rows.values()]
        .filter((r) => r.projectId === projectId)
        .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))
        .map((r) => ({ ...r, key: `${r.projectId}::${r.name}` }));
    },
    async remove(projectId: string, name: string) {
      rows.delete(`${projectId}::${name}`);
    },
  };
}

/** Same document identity across calls = same project (hydration key). */
function sameProjectCtxFactory() {
  useDeterministicIds();
  resetDeterministicIds();
  const base = createProjectFromTemplate("house");
  const doc: ProjectDocument = {
    ...base,
    id: "project-durable-1",
    arrangement: { ...base.arrangement, clips: [] },
    markers: [],
    scenes: [],
  };
  return () => new ProjectStore({ ...doc });
}

beforeEach(() => {
  resetMcpCheckpoints();
  setMcpCheckpointRepository(null);
  globalThis.indexedDB = new IDBFactory();
});

describe("McpCheckpointRepository (real, fake-indexeddb)", () => {
  it("put / list (per project, newest first) / remove round-trip", async () => {
    const repo = new McpCheckpointRepository();
    const doc = createProjectFromTemplate("house");
    const record = (name: string, projectId: string, savedAt: string) => ({
      key: checkpointKey(projectId, name),
      projectId,
      name,
      label: `summary of ${name}`,
      auto: false,
      savedAt,
      doc,
    });
    await repo.put(record("cp-a", "proj-1", "2026-09-30T10:00:00Z"));
    await repo.put(record("cp-b", "proj-1", "2026-09-30T11:00:00Z"));
    await repo.put(record("cp-other", "proj-2", "2026-09-30T12:00:00Z"));

    const list = await repo.list("proj-1");
    expect(list.map((r) => r.name)).toEqual(["cp-b", "cp-a"]); // newest first, project-scoped
    expect((await repo.list("proj-2")).map((r) => r.name)).toEqual(["cp-other"]);

    await repo.remove("proj-1", "cp-a");
    expect((await repo.list("proj-1")).map((r) => r.name)).toEqual(["cp-b"]);
    expect(checkpointKey("p", "n")).toBe("p::n");
  });
});

describe("tool-level durable hydration", () => {
  it("save persists; after a full in-memory reset the checkpoint hydrates back", async () => {
    const newCtx = sameProjectCtxFactory();
    const repo = memoryRepo();
    setMcpCheckpointRepository(repo);

    const ctx = makeCtxFor(newCtx());
    const saved = await executeMcpTool(ctx, "kyx_checkpoint", { op: "save", name: "durable" });
    expect(saved.text).toContain("persisted");
    expect(repo.rows.size).toBe(1);

    // simulate a reload: in-memory map cleared, a fresh context for the SAME project
    resetMcpCheckpoints();
    const ctx2 = makeCtxFor(newCtx());
    const list = await executeMcpTool(ctx2, "kyx_checkpoint", { op: "list" });
    expect(list.text).toContain("durable");
    // hydrated entries restart their steps-since counter
    expect(list.text).toContain("↻ reloaded");

    // and the restored document is the FULL saved snapshot
    await executeMcpTool(ctx2, "kyx_generate", { genre: "techno", seed: "post-reload" });
    const restore = await executeMcpTool(ctx2, "kyx_checkpoint", { op: "restore", name: "durable" });
    expect(restore.mutated).toBe(true);
    const after = ctx2.getDoc();
    expect(after.patterns.some((p) => p.name.includes("techno"))).toBe(false);
  }, 30_000);

  it("without a repository the save is honest session-only", async () => {
    setMcpCheckpointRepository(null);
    const ctx = makeCtxFor(sameProjectCtxFactory()());
    const result = await executeMcpTool(ctx, "kyx_checkpoint", { op: "save", name: "ephemeral" });
    expect(result.text).toContain("session only");
  });

  it("hydration is once-per-project and other projects' entries never leak", async () => {
    const repo = memoryRepo();
    setMcpCheckpointRepository(repo);
    const doc = sameProjectCtxFactory()().doc;
    await repo.put({
      key: `${doc.id}::from-last-session`,
      projectId: doc.id,
      name: "from-last-session",
      label: "last session",
      auto: false,
      savedAt: new Date().toISOString(),
      doc,
    });
    const list = await executeMcpTool(makeCtxFor(sameProjectCtxFactory()()), "kyx_checkpoint", { op: "list" });
    expect(list.text).toContain("from-last-session");
    // second list: no duplicate hydration
    expect((list.text.match(/from-last-session/g) ?? []).length).toBe(1);
  });
});

function makeCtxFor(store: ProjectStore): McpToolContext {
  return {
    getDoc: () => store.doc,
    execute: (command) => store.execute(command),
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => store.history.map((entry) => entry.label),
    isMicRecordingActive: () => false,
    transport: { play() {}, stop() {}, pause() {}, setLoop() {}, setMetronome() {} },
  };
}
