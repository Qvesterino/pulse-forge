import { describe, it, expect } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { executeMcpTool, type McpToolContext } from "../src/mcp/tools";
import { ProjectRepository } from "../src/persistence/ProjectRepository";
import { createAutosaveDebouncer } from "../src/persistence/autosave-debouncer";
import { ProjectStore } from "../src/store/ProjectStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * MCP → COMMAND → STORE → ENGINE PROJECTION → PERSISTENCE (control-surface
 * audit 2026-10-13, GAP-05 / roadmap P1-C).
 *
 * The MCP tool suite asserts against in-memory state; the hop where a silent
 * persistence failure would live — the `services.ts` onDocChanged fan-out
 * (engine.setProject + autosave-debouncer → repository save) — was executed
 * by no MCP test. This suite binds the REAL pieces along that hop:
 *
 *   real ProjectStore.onDocChanged  ← the services.ts wiring shape
 *   engine.setProject spy           ← the audio-graph projection contract
 *   real createAutosaveDebouncer    ← the D.1 force-flush contract
 *   REAL ProjectRepository          ← over fake-indexeddb (save/load/recent)
 *
 * so that "mutated: true" is proven to reach durable state, and a write
 * failure is proven to surface as saveStatus "error" instead of a silent
 * success. The mutating tool is kyx_markers (a plain doc command — transport
 * tools are runtime state by design and report mutated:false).
 */

/** Engine projection spy — only setProject is on the mutation hop. */
function engineSpy(): { setProjectCalls: ProjectDocument[]; setProject: (doc: ProjectDocument) => void } {
  const setProjectCalls: ProjectDocument[] = [];
  return { setProjectCalls, setProject: (doc) => setProjectCalls.push(doc) };
}

/** The services.ts wiring, verbatim in shape: mutation → projection → arm. */
function wirePersistence(
  store: ProjectStore,
  engine: ReturnType<typeof engineSpy>,
  repo: { save: (doc: ProjectDocument) => Promise<void> },
): { flushSave: () => Promise<void> } {
  let saving: Promise<void> | null = null;
  let saveQueued = false;

  const doSave = async (): Promise<void> => {
    const documentAtStart = store.doc;
    try {
      store.setSaveStatus("saving");
      await repo.save(documentAtStart);
      if (store.doc !== documentAtStart) {
        saveQueued = true;
        store.setSaveStatus("dirty");
      } else {
        store.setSaveStatus("saved");
      }
    } catch {
      store.setSaveStatus("error");
      if (store.doc !== documentAtStart) saveQueued = true;
    }
  };

  const flushSave = async (): Promise<void> => {
    saveDebouncer.cancel();
    if (saving) {
      saveQueued = true;
      await saving;
      return;
    }
    if (store.saveStatus !== "dirty" && store.saveStatus !== "error") return;
    const run = (async (): Promise<void> => {
      try {
        await doSave();
      } finally {
        saving = null;
        if (saveQueued) {
          saveQueued = false;
          await flushSave();
        }
      }
    })();
    saving = run;
    await run;
  };

  const saveDebouncer = createAutosaveDebouncer({ flush: flushSave, debounceMs: 800, maxDeferMs: 5000, maxArms: 50 });

  store.onDocChanged = (doc) => {
    engine.setProject(doc);
    store.setSaveStatus("dirty");
    saveDebouncer.arm();
  };

  return { flushSave };
}

/** Context bound to the REAL store (the storeCtx shape from mcp-tools.test.ts). */
function storeCtx(store: ProjectStore): McpToolContext {
  return {
    getDoc: () => store.doc,
    execute: (command) => store.execute(command),
    undo: () => store.undo(),
    redo: () => store.redo(),
    undoStackLength: () => store.undoStackLength,
    historyLabels: () => store.history.map((entry) => entry.label),
    isMicRecordingActive: () => false,
    transport: { play: () => {}, stop: () => {}, pause: () => {}, setLoop: () => {}, setMetronome: () => {} },
  };
}

function bootDoc(): ProjectDocument {
  // Random template ids per construction: db.ts caches ONE IDB connection per
  // process (module-level openDb), so tests in this file share whatever
  // fake-indexeddb instance opened first — unique project ids are the
  // isolation mechanism, not factory swaps.
  return createProjectFromTemplate("house");
}

const addMarker = (ctx: McpToolContext) => executeMcpTool(ctx, "kyx_markers", { op: "add", bar: 1, name: "mcp-p1c" });

// Open the process-wide fake database once, before any ProjectRepository
// touches the module-level connection cache (see bootDoc).
globalThis.indexedDB = new IDBFactory();

describe("mcp mutation → engine projection → durable persistence (GAP-05)", () => {
  it("a mutating tool call re-projects the engine and survives flush + reload", async () => {
    const start = bootDoc();
    const store = new ProjectStore(start);
    const engine = engineSpy();
    const repo = new ProjectRepository();
    const { flushSave } = wirePersistence(store, engine, repo);
    const ctx = storeCtx(store);

    const result = await addMarker(ctx);
    expect(result.mutated).toBe(true);
    expect(store.doc.markers).toHaveLength(start.markers.length + 1);

    // (a) the engine was re-projected with the NEW doc — not the boot doc.
    expect(engine.setProjectCalls.length).toBeGreaterThanOrEqual(1);
    expect(engine.setProjectCalls.at(-1)).toBe(store.doc);
    expect(engine.setProjectCalls.at(-1)!.markers).toHaveLength(start.markers.length + 1);
    expect(engine.setProjectCalls[0]).not.toBe(start);

    // (b) the debounced save drains; "mutated: true" promises a SCHEDULED
    // save, this flush is what makes it a completed one.
    await flushSave();
    expect(store.saveStatus).toBe("saved");

    // (c) reload from the repository yields the mutated state.
    const reloaded = await repo.load(start.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.markers).toHaveLength(start.markers.length + 1);
  });

  it("a failed write surfaces as saveStatus error — never a silent success", async () => {
    const start = bootDoc();
    const store = new ProjectStore(start);
    const engine = engineSpy();
    const { flushSave } = wirePersistence(store, engine, {
      save: async () => {
        throw new Error("idb quota exceeded");
      },
    });
    const ctx = storeCtx(store);

    const result = await addMarker(ctx);
    expect(result.mutated).toBe(true);
    await flushSave();
    // The doc mutation happened, but persistence failed LOUDLY: the wiring
    // must report error status, not leave "saved"/"dirty" implying durability.
    expect(store.saveStatus).toBe("error");
    // And the failed write reached nothing — a fresh repository reads no
    // project at all.
    const fresh = new ProjectRepository();
    expect(await fresh.load(start.id)).toBeNull();
  });

  it("undo after an MCP edit re-projects the engine and persists the reverted state", async () => {
    const start = bootDoc();
    const store = new ProjectStore(start);
    const engine = engineSpy();
    const repo = new ProjectRepository();
    const { flushSave } = wirePersistence(store, engine, repo);
    const ctx = storeCtx(store);

    await addMarker(ctx);
    const undoResult = await executeMcpTool(ctx, "kyx_undo", { action: "undo", steps: 1 });
    expect(undoResult.mutated).toBe(true);
    expect(store.doc.markers).toHaveLength(start.markers.length);
    expect(engine.setProjectCalls.at(-1)).toBe(store.doc);

    await flushSave();
    const reloaded = await repo.load(start.id);
    expect(reloaded!.markers).toHaveLength(start.markers.length);
    expect(store.saveStatus).toBe("saved");
  });
});
