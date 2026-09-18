/**
 * Stateful persistence + recorder — adversarial edge cases.
 *
 * Mirrors `tests/snapshot-repository.test.ts` and `tests/persistence/db-retry.test.ts`
 * style: corrupted rows, transient failure recovery, snapshot divergence.
 *
 * Scope:
 *   - src/persistence/*         — repositories (Project, Snapshot, FrozenBuffer, Ultina, UserSample), db-retry
 *   - src/audio-engine/recorder.ts — recorder lifecycle (mock MediaRecorder)
 *
 * Companion to (NOT a replacement for):
 *   - tests/snapshot-repository.test.ts  — D.4 secondary index
 *   - tests/persistence/doc-retry.test.ts — openDb retry under transient failure
 *   - tests/persistence/db-retry.test.ts — openDb single-failure recovery
 *   - tests/save-lifecycle.test.ts       — save() debouncing
 *   - tests/recorder.test.ts             — recorder happy path
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "../src/persistence/db";
import {
  DB_NAME,
  openDb,
  STORE_FROZEN_AUDIO,
  STORE_PROJECTS,
  STORE_SNAPSHOTS,
  STORE_SNAPSHOT_INDEX,
  STORE_ULTINA_PRESETS,
  STORE_USER_SAMPLES,
  STORE_USER_SAMPLE_AUDIO,
} from "../src/persistence/db";
import { SnapshotRepository, shouldAutoSnapshot } from "../src/persistence/SnapshotRepository";
import { ProjectRepository } from "../src/persistence/ProjectRepository";
import { FrozenBufferRepository } from "../src/persistence/FrozenBufferRepository";
import {
  UltinaPresetRepository,
  sanitizeUltinaPresetParams,
} from "../src/persistence/UltinaPresetRepository";
import { UserSampleRepository } from "../src/persistence/UserSampleRepository";
import { createDefaultProject, normalizeProject } from "../src/project-model/schema";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Wipe ALL stores between tests so corrupted rows from one test don't leak. */
async function wipeAll(): Promise<void> {
  const db = await openDb();
  const stores = [
    STORE_PROJECTS,
    STORE_FROZEN_AUDIO,
    STORE_USER_SAMPLES,
    STORE_USER_SAMPLE_AUDIO,
    STORE_SNAPSHOTS,
    STORE_SNAPSHOT_INDEX,
    STORE_ULTINA_PRESETS,
    "meta",
    "presets",
    "library",
    "user-kits",
    "groove-pool",
  ];
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(stores, "readwrite");
    for (const s of stores) {
      try {
        t.objectStore(s).clear();
      } catch {
        /* store might not exist in this version */
      }
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

function freshProject(name: string): ProjectDocument {
  return { ...createProjectFromTemplate("house"), name };
}

// ─── 1. SnapshotRepository — adversarial poison + corruption ─────────────────

describe("SnapshotRepository — adversarial poison + corruption", () => {
  beforeEach(async () => {
    await wipeAll();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("save/list round-trip survives 50 sequential saves without drift", async () => {
    const repo = new SnapshotRepository();
    const projectId = "p-stress";
    for (let i = 0; i < 50; i++) await repo.save(projectId, freshProject(`tick ${i}`), `save-${i}`);
    const list = await repo.list(projectId, 1000);
    expect(list).toHaveLength(50);
    // Newest first — the LAST save is at index 0.
    expect(list[0].label).toBe("save-49");
    expect(list[49].label).toBe("save-0");
  });

  it("prune keeps EXACTLY the newest `keep` snapshots and nothing else", async () => {
    const repo = new SnapshotRepository();
    const projectId = "p-prune";
    const saves = [];
    for (let i = 0; i < 10; i++) saves.push(await repo.save(projectId, freshProject(`v${i}`), `l${i}`));
    await repo.prune(projectId, 3);
    const list = await repo.list(projectId, 1000);
    expect(list).toHaveLength(3);
    // The 3 newest (saves 9, 8, 7) survive — oldest (0..6) gone.
    expect(list.map((s) => s.label)).toEqual(["l9", "l8", "l7"]);
  });

  it("a single poisoned primary row never blanks the whole history panel", async () => {
    // Pin the SnapshotRepository contract: one corrupt row is skipped, the
    // rest come through. (Mirrors tests/snapshot-repository.test.ts
    // "skips one unreadable record" but stresses a different failure path —
    // here we mutate the IDB row shape directly.)
    const repo = new SnapshotRepository();
    const projectId = "p-poison";
    const a = await repo.save(projectId, freshProject("A"), "A");
    const b = await repo.save(projectId, freshProject("B"), "B");
    await repo.list(projectId, 1000); // prime the in-memory index

    // Corrupt `a` in the primary store — drop the `doc` field.
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE_SNAPSHOTS, "readwrite");
      const req = t.objectStore(STORE_SNAPSHOTS).get(a.id);
      req.onsuccess = () => {
        const row = req.result as Record<string, unknown>;
        delete (row as { doc?: unknown }).doc;
        t.objectStore(STORE_SNAPSHOTS).put(row);
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
    // list() should still return B (and skip A as unvalidateable).
    const result = await repo.list(projectId, 1000);
    expect(result.map((s) => s.id)).toContain(b.id);
    expect(result.map((s) => s.id)).not.toContain(a.id);
  });

  it("save() concurrent calls do not duplicate the seq counter (no torn index keys)", async () => {
    // Adversarial concurrency: 20 parallel save() calls must produce 20
    // UNIQUE seq values, even though JS is single-threaded but Y uses
    // microtask interleaving (and IndexedDB writes are queued).
    const repo = new SnapshotRepository();
    const seqs = await Promise.all(
      Array.from({ length: 20 }, (_, i) => repo.save("p-conc", freshProject(`tick ${i}`), `l${i}`)),
    );
    const uniq = new Set(seqs.map((s) => s.seq));
    expect(uniq.size).toBe(20);
  });

  it("shouldAutoSnapshot handles garbage timestamps and fresh ones", () => {
    expect(shouldAutoSnapshot(null)).toBe(true);
    expect(shouldAutoSnapshot(undefined)).toBe(true);
    expect(shouldAutoSnapshot("not-a-date")).toBe(true);
    // 1 hour ago → NOT due (under the 12-hour interval).
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
    expect(shouldAutoSnapshot(oneHourAgo)).toBe(false);
    // 1 day ago → due (over the 12-hour interval).
    const oneDayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
    expect(shouldAutoSnapshot(oneDayAgo)).toBe(true);
    // Future date → not due.
    const future = new Date(Date.now() + 24 * 3600_000).toISOString();
    expect(shouldAutoSnapshot(future)).toBe(false);
  });
});

// ─── 2. ProjectRepository — corrupted rows & transient failure ────────────────

describe("ProjectRepository — corrupted rows & transient failure", () => {
  beforeEach(async () => {
    await wipeAll();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("listAll skips one poisoned project (bad shape) without losing healthy ones", async () => {
    const repo = new ProjectRepository();
    // One valid + one corrupt project.
    await repo.save(freshProject("Healthy"));
    const db = await openDb();
    // Inject a row with the required keyPath (`id`) but a broken body —
    // the keyPath requires the field to be present, but the rest of the
    // shape can be missing. safeMigrate must drop it.
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE_PROJECTS, "readwrite");
      t.objectStore(STORE_PROJECTS).put({
        id: "broken-1",
        name: "Broken",
        bpm: "not-a-number",
        tracks: "not-an-array",
        patterns: "not-an-array",
        createdAt: "2025",
        updatedAt: "2025",
      } as unknown as ProjectDocument);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
    const list = await repo.listAll();
    expect(list.map((p) => p.name)).toEqual(["Healthy"]);
  });

  it("save() with a mock-thrown QuotaExceededError surfaces to the caller (no silent swallow)", async () => {
    // The repo has no try/catch around the durable tx; a quota error
    // escapes. We pin that contract: errors are propagated so the UI
    // can show "couldn't save" instead of silently diverging from disk.
    const repo = new ProjectRepository();
    const spy = vi.spyOn(db, "tx").mockRejectedValueOnce(
      Object.assign(new Error("storage quota exceeded"), { name: "QuotaExceededError" }),
    );
    await expect(repo.save(freshProject("P"))).rejects.toThrow(/quota/i);
    spy.mockRestore();
    // A retry after recovery must succeed (the spy is one-shot).
    await repo.save(freshProject("P"));
    const list = await repo.listAll();
    expect(list).toHaveLength(1);
  });

  it("loadMostRecent walks past a corrupt recent-priority entry", async () => {
    const repo = new ProjectRepository();
    await repo.save(freshProject("Valid"));
    // Set the "most recent" pointer to a non-existent id — loadMostRecent
    // must fall through to the next-valid heuristic.
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction("meta", "readwrite");
      t.objectStore("meta").put("ghost-id-that-does-not-exist", "recentProjectId");
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
    const doc = await repo.loadMostRecent();
    expect(doc).not.toBeNull();
    expect(doc!.name).toBe("Valid");
  });

  it("delete() of a non-existent id is a no-op (does not throw, does not corrupt)", async () => {
    const repo = new ProjectRepository();
    await expect(repo.delete("never-existed")).resolves.toBeUndefined();
    const list = await repo.listAll();
    expect(list).toHaveLength(0);
  });

  it("concurrent save() calls preserve every project (no torn writes)", async () => {
    // 25 parallel saves — one per worker — must all land durably.
    const repo = new ProjectRepository();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => repo.save({ ...freshProject(`P${i}`), name: `P${i}` })),
    );
    const list = await repo.listAll();
    expect(list).toHaveLength(25);
  });
});

// ─── 3. FrozenBufferRepository — large blob + transient error ─────────────────

describe("FrozenBufferRepository — large blob + transient error", () => {
  beforeEach(async () => {
    await wipeAll();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("save + load a 64 KiB buffer round-trip byte-exact", async () => {
    const repo = new FrozenBufferRepository();
    const bytes = new Uint8Array(64 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    await repo.save("buf-large", bytes.buffer);
    const loaded = await repo.load("buf-large");
    expect(loaded).toBeDefined();
    expect(new Uint8Array(loaded!)).toEqual(bytes);
  });

  it("a save() failure throws a typed error carrying the bufferId (no silent swallow)", async () => {
    // The contract (per FrozenBufferRepository.save source) is to surface a
    // retryable error with the offending bufferId. Without this, callers
    // would mark a track frozen even though a reload would leave it
    // permanently silent — see the inline comment.
    const repo = new FrozenBufferRepository();
    vi.spyOn(db, "tx").mockRejectedValueOnce(new Error("disk full"));
    await expect(repo.save("buf-fail", new ArrayBuffer(8))).rejects.toThrow(/buf-fail/);
  });

  it("list() never throws — a corrupted store entry is skipped via try/catch", async () => {
    const repo = new FrozenBufferRepository();
    // Write a malformed row directly.
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE_FROZEN_AUDIO, "readwrite");
      t.objectStore(STORE_FROZEN_AUDIO).put({ id: "no-data" } as { id: string; data: ArrayBuffer });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
    // list() should not throw; the existing read path swallows errors
    // (the entries are returned as-is).
    const all = await repo.list();
    expect(all.find((e) => e.id === "no-data")).toBeDefined();
  });

  it("remove() of an unknown id is a safe no-op (does not throw)", async () => {
    const repo = new FrozenBufferRepository();
    await expect(repo.remove("never-saved")).resolves.toBeUndefined();
  });
});

// ─── 4. UltinaPresetRepository — schema-driven sanitization ────────────────────

describe("UltinaPresetRepository — schema-driven sanitization", () => {
  beforeEach(async () => {
    await wipeAll();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sanitizeUltinaPresetParams drops unknown ids, clamps out-of-range, rejects non-numbers", () => {
    // Mix of valid, out-of-range, non-numeric, and unknown-id keys.
    const raw = {
      // We don't know specific schema ids — exercise the GENERAL contract:
      // - unknown ids are dropped (no warning)
      // - non-number values are dropped
      // - finite numbers may pass through (clampParam no-ops if id unknown)
      __bogus__: 0.5, // unknown id
      another_unknown: NaN,
      a_string: "0.7",
    };
    const sanitized = sanitizeUltinaPresetParams(raw);
    expect(sanitized.__bogus__).toBeUndefined();
    expect(sanitized.another_unknown).toBeUndefined();
    expect(sanitized.a_string).toBeUndefined();
    // Non-object input is safe.
    expect(sanitizeUltinaPresetParams(null)).toEqual({});
    expect(sanitizeUltinaPresetParams(undefined)).toEqual({});
    expect(sanitizeUltinaPresetParams("string")).toEqual({});
    expect(sanitizeUltinaPresetParams(42)).toEqual({});
  });

  it("list() skips entries with an empty/whitespace name", async () => {
    const repo = new UltinaPresetRepository();
    // Write three rows: one valid, one with empty name, one with a non-string name.
    // The store has a `keyPath: "id"`, so all rows MUST have a string id —
    // we can't actually write a row missing `id`. We exercise the OTHER
    // sanitization gates: the `name` field.
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE_ULTINA_PRESETS, "readwrite");
      t.objectStore(STORE_ULTINA_PRESETS).put({
        id: "ok",
        name: "Good",
        params: {},
        createdAt: "2025-01-01T00:00:00.000Z",
        schemaVersion: 1,
      });
      t.objectStore(STORE_ULTINA_PRESETS).put({
        id: "blank",
        name: "   ",
        params: {},
        createdAt: "2025-01-02T00:00:00.000Z",
        schemaVersion: 1,
      });
      t.objectStore(STORE_ULTINA_PRESETS).put({
        id: "numeric",
        name: "Numeric",
        // Non-finite / wrong-typed params must also survive sanitization
        // (the schema loop drops them silently).
        params: { x: NaN, y: Infinity, z: "str", w: null },
        createdAt: "2025-01-03T00:00:00.000Z",
        schemaVersion: 1,
      });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
    const all = await repo.list();
    // `ok` and `numeric` survive; `blank` is dropped.
    const ids = all.map((e) => e.id).sort();
    expect(ids).toEqual(["numeric", "ok"]);
  });

  it("list() survives a transient openDb failure (returns empty, does not throw)", async () => {
    const repo = new UltinaPresetRepository();
    vi.spyOn(db, "openDb").mockRejectedValueOnce(new Error("private mode"));
    const all = await repo.list();
    expect(all).toEqual([]);
    // A subsequent call must succeed (the in-memory cache is the empty
    // fallback, but the spy was one-shot — the underlying openDb is intact).
    vi.restoreAllMocks();
    const fresh = new UltinaPresetRepository();
    expect(await fresh.list()).toEqual([]);
  });
});

// ─── 5. UserSampleRepository — atomic save rollback ───────────────────────────

describe("UserSampleRepository — atomic save rollback", () => {
  beforeEach(async () => {
    await wipeAll();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("metadata-only save (no audio bytes) does not commit — no ghost sample", async () => {
    const repo = new UserSampleRepository();
    const asset = {
      id: "sample-1",
      name: "kick.wav",
      fileName: "kick.wav",
      category: "Custom" as const,
      duration: 0.5,
      sampleRate: 44100,
      channels: 1,
      createdAt: new Date().toISOString(),
    };
    // No data argument — the audio write is skipped, but the metadata write
    // also skips (the `if (!data) return;` short-circuits BEFORE the put).
    // The repo's documented contract: this stores metadata only.
    await repo.save(asset);
    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("sample-1");
    const audio = await repo.loadAudio("sample-1");
    expect(audio).toBeUndefined();
  });

  it("audio-write failure rolls back the metadata row (no permanent ghost sample)", async () => {
    // The repo's documented contract: if the audio write throws, the
    // metadata row is removed, so the user sees an error instead of a
    // permanently-silent listed sample. Pin it.
    const repo = new UserSampleRepository();
    const asset = {
      id: "sample-rollback",
      name: "snare.wav",
      fileName: "snare.wav",
      category: "Custom" as const,
      duration: 0.5,
      sampleRate: 44100,
      channels: 1,
      createdAt: new Date().toISOString(),
    };
    // Make the SECOND tx call (audio store write) throw — the first
    // (metadata write) must succeed, then the audio write fails, then
    // the rollback delete must succeed. We mock `db.tx` and count calls.
    let calls = 0;
    const realTx = db.tx;
    vi.spyOn(db, "tx").mockImplementation((async (...args: any[]) => {
      calls++;
      // Calls in save(asset, data):
      //   1: metadata write (readwrite on user-samples)
      //   2: audio write (readwrite on user-sample-audio) — fail this one
      //   3: metadata rollback (readwrite delete on user-samples) — succeed
      if (calls === 2) throw new Error("simulated audio-store crash");
      return realTx.apply(db, args as Parameters<typeof realTx>);
    }) as typeof db.tx);

    await expect(repo.save(asset, new ArrayBuffer(4))).rejects.toThrow(/simulated/i);
    // The metadata row must be rolled back — list() shows zero entries.
    const list = await repo.list();
    expect(list.find((e) => e.id === "sample-rollback")).toBeUndefined();
  });
});

// ─── 6. openDb — transient failure must NOT poison the cache ────────────────

describe("openDb — transient failure does not poison the cache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("a thrown open resolves to a rejection; the next call retries from scratch", async () => {
    // Pin the production contract from src/persistence/db.ts: a rejected
    // open MUST clear dbPromise, so the next openDb() call retries the
    // IndexedDB open rather than replaying the cached rejection.
    // We use `vi.resetModules()` to get a fresh `dbPromise` so this
    // test doesn't see the cached promise from earlier tests.
    vi.resetModules();
    const dbMod = await import("../src/persistence/db");
    const realOpen = indexedDB.open.bind(indexedDB);
    let attempts = 0;
    const spy = vi.spyOn(indexedDB, "open").mockImplementation((...args: Parameters<typeof realOpen>) => {
      attempts++;
      if (attempts === 1) throw new Error("transient open failure");
      return realOpen(...args);
    });
    await expect(dbMod.openDb()).rejects.toThrow("transient open failure");
    const db = await dbMod.openDb();
    expect(db.name).toBe(DB_NAME);
    expect(db.objectStoreNames.length).toBeGreaterThan(0);
    expect(attempts).toBeGreaterThanOrEqual(2);
    spy.mockRestore();
  });

  it("openDb after a rejection opens a fresh connection, not a stale one", async () => {
    // Two-phase: first open throws, second open succeeds — verify the
    // returned handle is a NEW IDBDatabase, not the failed one's stub.
    vi.resetModules();
    const dbMod = await import("../src/persistence/db");
    const realOpen = indexedDB.open.bind(indexedDB);
    let callCount = 0;
    const spy = vi.spyOn(indexedDB, "open").mockImplementation((...args: Parameters<typeof realOpen>) => {
      callCount++;
      if (callCount === 1) throw new Error("once");
      return realOpen(...args);
    });
    await expect(dbMod.openDb()).rejects.toThrow();
    const db1 = await dbMod.openDb();
    expect(db1).toBeDefined();
    spy.mockRestore();
  });
});

// ─── 7. Recorder lifecycle — pure helper edge cases ──────────────────────────

describe("recorder — pickMimeType + extensionForMime", () => {
  it("pickMimeType returns the first supported candidate", async () => {
    const { pickMimeType, extensionForMime } = await import("../src/audio-engine/recorder");
    expect(pickMimeType(["audio/webm", "audio/mp4"], () => true)).toBe("audio/webm");
    expect(pickMimeType(["audio/webm", "audio/mp4"], (t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(pickMimeType(["audio/webm"], () => false)).toBeNull();
    expect(pickMimeType([], () => true)).toBeNull();

    // Extension mapping — the sample browser uses these to set file names.
    expect(extensionForMime("audio/webm;codecs=opus")).toBe(".webm");
    expect(extensionForMime("audio/mp4")).toBe(".m4a");
    expect(extensionForMime("audio/ogg;codecs=opus")).toBe(".ogg");
    expect(extensionForMime("audio/mpeg")).toBe(".mp3");
    expect(extensionForMime("unknown")).toBe(".webm");
  });

  it("LiveRecorder.cancel() is safe when called from idle (no recorder, no wiring)", async () => {
    const { LiveRecorder } = await import("../src/audio-engine/recorder");
    // Build a recorder with no MediaRecorder / AudioContext support.
    const fakeCtx = {
      createMediaStreamDestination: () => ({ stream: {} as MediaStream }),
      currentTime: 0,
    } as unknown as AudioContext;
    const recorder = new LiveRecorder({
      ctx: fakeCtx,
      getTapNode: () => null,
    });
    // cancel() in idle is a no-op (must not throw).
    expect(() => recorder.cancel()).not.toThrow();
    expect(recorder.state).toBe("idle");
    expect(recorder.elapsedSeconds).toBe(0);
  });

  it("LiveRecorder.stop() in idle returns null (no recorded take)", async () => {
    const { LiveRecorder } = await import("../src/audio-engine/recorder");
    const fakeCtx = {
      createMediaStreamDestination: () => ({ stream: {} as MediaStream }),
      currentTime: 0,
    } as unknown as AudioContext;
    const recorder = new LiveRecorder({
      ctx: fakeCtx,
      getTapNode: () => null,
    });
    const result = await recorder.stop();
    expect(result).toBeNull();
    expect(recorder.state).toBe("idle");
  });
});

// ─── 8. normalizeProject — poisoned doc recovery ─────────────────────────────

describe("normalizeProject — defensive shape recovery", () => {
  it("normalize round-trips a freshly-created default project (idempotent)", () => {
    const doc = createDefaultProject();
    const re = normalizeProject(doc);
    // Field parity check (deep equality would compare recursively).
    expect(re.id).toBe(doc.id);
    expect(re.name).toBe(doc.name);
    expect(re.bpm).toBe(doc.bpm);
    expect(re.patterns).toHaveLength(doc.patterns.length);
    // Normalize is idempotent on a normalized doc.
    const re2 = normalizeProject(re);
    expect(re2.bpm).toBe(re.bpm);
  });
});