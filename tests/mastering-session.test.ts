import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { beforeEach, describe, expect, it } from "vitest";
import {
  captureMasteringSnapshot,
  loadMasteringABSession,
  replaceSnapshot,
  saveMasteringABSession,
} from "../src/mastering/snapshots";
import { MasteringReferenceRepository } from "../src/mastering/referenceRepository";
import type { MasteringReferenceRecord } from "../src/mastering/referenceRepository";
import {
  captureMasteringSessionSnapshot,
  clearMasteringSessionSnapshot,
  createMasteringSessionRecord,
  MASTERING_SESSION_DATABASE,
  MASTERING_SESSION_DATABASE_VERSION,
  MASTERING_SESSION_REFERENCE_STORE,
  MASTERING_SESSION_SCHEMA_VERSION,
  MASTERING_SESSION_SOURCE_STORE,
  MASTERING_SESSION_STORE,
  MasteringSessionRepository,
  updateMasteringSessionConfig,
  undoMasteringSessionConfig,
} from "../src/mastering/sessionStore";
import {
  assertMasteringSessionWorkingSetBudget,
  createMasteringSessionRenderDocument,
  estimateMasteringSessionComparisonBytes,
  estimateMasteringSessionWorkingSetBytes,
  masteringSessionTimelineSeconds,
  MAX_MASTERING_SESSION_WORKING_SET_BYTES,
} from "../src/mastering/sessionRender";
import { testDoc } from "./fixtures/doc";

function projectWithId(id: string) {
  return { ...testDoc(), id };
}

function createTestMasteringSession(id: string) {
  const now = "2026-10-07T12:00:00.000Z";
  return createMasteringSessionRecord({
    id,
    fileName: `${id}.wav`,
    mimeType: "audio/wav",
    source: new NodeBlob([new Uint8Array([1, 2, 3, 4])], { type: "audio/wav" }) as unknown as Blob,
    sourceHash: "a".repeat(64),
    durationSeconds: 1,
    channels: 2,
    sourceSampleRate: 44_100,
    masterConfig: testDoc().master,
    createdAt: now,
  });
}

async function seedVersionOneMasteringDatabase(): Promise<void> {
  const now = "2026-10-07T12:00:00.000Z";
  const config = testDoc().master;
  const oldSummary = {
    version: 1,
    id: "legacy-v1-session",
    fileName: "legacy.wav",
    mimeType: "audio/wav",
    byteLength: 4,
    sourceHash: "b".repeat(64),
    durationSeconds: 1,
    channels: 2,
    sourceSampleRate: 44_100,
    masterConfig: config,
    configRevision: 0,
    undoStack: [],
    redoStack: [],
    createdAt: now,
    updatedAt: now,
  };
  const open = indexedDB.open(MASTERING_SESSION_DATABASE, 1);
  open.onupgradeneeded = () => {
    open.result.createObjectStore(MASTERING_SESSION_STORE, { keyPath: "id" });
    open.result.createObjectStore(MASTERING_SESSION_SOURCE_STORE, { keyPath: "id" });
  };
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("Could not seed the v1 mastering database."));
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([MASTERING_SESSION_STORE, MASTERING_SESSION_SOURCE_STORE], "readwrite");
    tx.objectStore(MASTERING_SESSION_STORE).put(oldSummary);
    tx.objectStore(MASTERING_SESSION_SOURCE_STORE).put({
      id: oldSummary.id,
      source: new NodeBlob([new Uint8Array([1, 2, 3, 4])], { type: "audio/wav" }),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not store the v1 mastering fixture."));
    tx.onabort = () => reject(tx.error ?? new Error("The v1 mastering fixture transaction was aborted."));
  });
  db.close();
}

describe("external mastering session persistence", () => {
  it("migrates saved v1 sessions to the named A/B snapshot slots", async () => {
    await seedVersionOneMasteringDatabase();
    const repository = new MasteringSessionRepository();
    const listed = await repository.list();
    const loaded = await repository.get("legacy-v1-session");
    expect(MASTERING_SESSION_DATABASE_VERSION).toBe(3);
    expect(MASTERING_SESSION_SCHEMA_VERSION).toBe(2);
    expect(listed[0]).toMatchObject({ version: 2, snapshots: { A: null, B: null } });
    expect(loaded?.snapshots).toEqual({ A: null, B: null });
    expect(loaded?.source.size).toBe(4);
    await repository.delete("legacy-v1-session");
  });

  it("keeps named snapshots independent while loading them remains undoable", () => {
    const session = createTestMasteringSession("named-version-session");
    const a = captureMasteringSessionSnapshot(session, "A", "Warm / open", "2026-10-07T12:01:00.000Z");
    const changed = updateMasteringSessionConfig(a, { ...a.masterConfig, masterGain: 1.25 });
    const b = captureMasteringSessionSnapshot(changed, "B", "Punchier", "2026-10-07T12:02:00.000Z");

    expect(b.snapshots.A?.name).toBe("Warm / open");
    expect(b.snapshots.A?.masterConfig.masterGain).not.toBe(1.25);
    expect(b.snapshots.B).toMatchObject({ name: "Punchier", masterConfig: { masterGain: 1.25 } });
    expect(undoMasteringSessionConfig(b).masterConfig.masterGain).toBe(session.masterConfig.masterGain);
    expect(clearMasteringSessionSnapshot(b, "A").snapshots.A).toBeNull();
    expect(() => captureMasteringSessionSnapshot(session, "A", "   ")).toThrow(/1 to 64 characters/);
  });

  it("round-trips the immutable source with saved A/B session versions", async () => {
    const repository = new MasteringSessionRepository();
    const id = `round-trip-${Date.now()}`;
    const original = createTestMasteringSession(id);
    const withSnapshot = captureMasteringSessionSnapshot(original, "A", "Approved master");
    let stage = "put";
    try {
      await repository.put(withSnapshot);
      stage = "list";
      const listed = await repository.list();
      stage = "get";
      const loaded = await repository.get(id);
      expect(listed.find((item) => item.id === id)?.snapshots.A?.name).toBe("Approved master");
      expect(loaded?.snapshots.A?.masterConfig).toEqual(original.masterConfig);
      expect(loaded?.source.size).toBe(original.source.size);
      stage = "delete";
      await repository.delete(id);
      await expect(repository.get(id)).resolves.toBeNull();
    } catch (error) {
      throw new Error(`Mastering session repository failed during ${stage}: ${String(error)}`);
    }
  });

  it("persists each reference in a separate session store and deletes it with its session", async () => {
    const repository = new MasteringSessionRepository();
    const id = `reference-session-${Date.now()}`;
    const session = createTestMasteringSession(id);
    await repository.put(session);
    const reference = {
      sessionId: id,
      fileName: "reference.wav",
      mimeType: "audio/wav",
      byteLength: 4,
      source: new NodeBlob([new Uint8Array([5, 6, 7, 8])], { type: "audio/wav" }) as unknown as Blob,
      sourceHash: "c".repeat(64),
      durationSeconds: 1,
      channels: 2 as const,
      sampleRate: 44_100,
      importedAt: "2026-10-07T12:03:00.000Z",
    };
    await repository.putReference(reference);
    await expect(repository.getReference(id)).resolves.toMatchObject({
      sessionId: id,
      fileName: "reference.wav",
      sourceHash: "c".repeat(64),
      source: { size: 4 },
    });
    expect(await repository.list()).toEqual(expect.arrayContaining([expect.objectContaining({ id })]));

    const dbRequest = indexedDB.open(MASTERING_SESSION_DATABASE, MASTERING_SESSION_DATABASE_VERSION);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      dbRequest.onsuccess = () => resolve(dbRequest.result);
      dbRequest.onerror = () => reject(dbRequest.error ?? new Error("Could not inspect mastering stores."));
    });
    expect(db.objectStoreNames.contains(MASTERING_SESSION_REFERENCE_STORE)).toBe(true);
    db.close();

    await repository.delete(id);
    await expect(repository.getReference(id)).resolves.toBeNull();
  });

  it("preserves IndexedDB quota errors from asynchronous reference writes", async () => {
    const repository = new MasteringSessionRepository();
    const id = `reference-quota-${Date.now()}`;
    await repository.put(createTestMasteringSession(id));
    const reference = {
      sessionId: id,
      fileName: "reference.wav",
      mimeType: "audio/wav",
      byteLength: 4,
      source: new NodeBlob([new Uint8Array([5, 6, 7, 8])], { type: "audio/wav" }) as unknown as Blob,
      sourceHash: "d".repeat(64),
      durationSeconds: 1,
      channels: 2 as const,
      sampleRate: 44_100,
      importedAt: "2026-10-07T12:04:00.000Z",
    };
    const originalPut = IDBObjectStore.prototype.put;
    Object.defineProperty(IDBObjectStore.prototype, "put", {
      configurable: true,
      writable: true,
      value: function (this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
        if (this.name === MASTERING_SESSION_REFERENCE_STORE) {
          throw new DOMException("Simulated storage exhaustion", "QuotaExceededError");
        }
        if (arguments.length > 1) return originalPut.call(this, value, key);
        return originalPut.call(this, value);
      },
    });
    try {
      await expect(repository.putReference(reference)).rejects.toMatchObject({ name: "QuotaExceededError" });
      await expect(repository.getReference(id)).resolves.toBeNull();
    } finally {
      Object.defineProperty(IDBObjectStore.prototype, "put", {
        configurable: true,
        writable: true,
        value: originalPut,
      });
    }
    await repository.delete(id);
  });
});

describe("mastering A/B session snapshots", () => {
  beforeEach(() => sessionStorage.clear());

  it("round-trips complete, cloned master configurations per project", () => {
    const doc = projectWithId("snapshot-project-a");
    const config = {
      ...doc.master,
      masterGain: 1.35,
      deliveryProfileId: "vinyl" as const,
      deliveryTruePeakDb: -2,
      effects: [
        {
          id: "master-zenit-snapshot",
          type: "zenit" as const,
          bypassed: false,
          params: { ceiling: -1.5, limit: 0.25, glue: 0.2 },
        },
      ],
    };
    const snapshot = captureMasteringSnapshot(config);
    const session = replaceSnapshot(loadMasteringABSession(doc), "A", snapshot);

    config.effects[0]!.params.ceiling = -4;
    expect(saveMasteringABSession(session)).toBe(true);

    const loaded = loadMasteringABSession(doc);
    expect(loaded.a?.id).toBe(snapshot.id);
    expect(loaded.a?.config).toMatchObject({
      masterGain: 1.35,
      deliveryProfileId: "vinyl",
      deliveryTruePeakDb: -2,
      effects: [{ id: "master-zenit-snapshot", type: "zenit", params: { ceiling: -1.5 } }],
    });
    expect(loadMasteringABSession(projectWithId("snapshot-project-b"))).toMatchObject({ a: null, b: null });
    expect(doc.master).not.toBe(loaded.a?.config);
  });

  it("fails closed on malformed, foreign-project, or future-version storage", () => {
    const doc = projectWithId("snapshot-corruption");
    const key = `kyx.mastering.ab.v1:${doc.id}`;
    const empty = { version: 1, projectId: doc.id, a: null, b: null };

    sessionStorage.setItem(key, "{");
    expect(loadMasteringABSession(doc)).toEqual(empty);
    sessionStorage.setItem(key, JSON.stringify({ ...empty, version: 2 }));
    expect(loadMasteringABSession(doc)).toEqual(empty);
    sessionStorage.setItem(key, JSON.stringify({ ...empty, projectId: "another-project" }));
    expect(loadMasteringABSession(doc)).toEqual(empty);
  });
});

describe("mastering reference repository", () => {
  it("rejects an invalid persisted reference record", async () => {
    const repository = new MasteringReferenceRepository();
    const projectId = `mastering-reference-corrupt-${Date.now()}`;
    const corrupt = {
      projectId,
      fileName: "broken.wav",
      mimeType: "audio/wav",
      byteLength: 99,
      importedAt: new Date().toISOString(),
      source: { size: 3, type: "audio/wav" },
    } as MasteringReferenceRecord;

    await repository.put(corrupt);
    await expect(repository.get(projectId)).rejects.toThrow("saved mastering reference record is invalid");
  });
});

describe("external mastering session render document", () => {
  it("routes only the immutable source through a cloned master config at exact source duration", () => {
    const original = testDoc();
    const master = {
      ...original.master,
      masterGain: 1.25,
      tiltDb: 1.5,
      effects: [
        {
          id: "session-compressor",
          type: "compressor" as const,
          bypassed: false,
          params: { threshold: -24, ratio: 2 },
        },
      ],
    };
    const durationSeconds = 237.125;
    const scratch = createMasteringSessionRenderDocument(durationSeconds, master, "mastering-session-source-a");
    const clip = scratch.arrangement.audioClips?.[0];

    expect(clip).toMatchObject({
      bufferId: "mastering-session-source-a",
      startBar: 0,
      offsetSec: 0,
      trimStart: 0,
      trimEnd: 1,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
      reverse: false,
    });
    expect(scratch.arrangement.clips).toEqual([]);
    expect(scratch.returns).toEqual([]);
    expect(scratch.tracks).toHaveLength(1);
    expect(scratch.tracks[0]).toMatchObject({ kind: "drum", name: "Source Mix", gain: 1, effects: [] });
    expect(scratch.master).toEqual(master);
    expect(scratch.master).not.toBe(master);
    expect(scratch.master.effects?.[0]).not.toBe(master.effects[0]);
    expect(scratch.master.effects?.[0]?.params).not.toBe(master.effects[0]?.params);
    expect(master.masterGain).toBe(1.25);
    expect(masteringSessionTimelineSeconds(scratch)).toBeCloseTo(durationSeconds, 10);
  });

  it("rejects an invalid source duration or buffer identity", () => {
    const master = testDoc().master;
    expect(() => createMasteringSessionRenderDocument(0.79, master, "source")).toThrow(/between 0.8 seconds/);
    expect(() => createMasteringSessionRenderDocument(721, master, "source")).toThrow(/between 0.8 seconds/);
    expect(() => createMasteringSessionRenderDocument(1, master, "")).toThrow(/buffer id is invalid/);
  });

  it("preflights decoded source, render, and float WAV working memory", () => {
    const master = testDoc().master;
    const smallSource = { duration: 1, length: 48_000, numberOfChannels: 2, sampleRate: 48_000 };
    const estimatedBytes = estimateMasteringSessionWorkingSetBytes(smallSource, master, 48_000);
    expect(estimatedBytes).toBeGreaterThan(0);
    expect(estimateMasteringSessionComparisonBytes(smallSource, master, master, 48_000)).toBeGreaterThan(
      estimatedBytes,
    );
    expect(() => assertMasteringSessionWorkingSetBudget(estimatedBytes)).not.toThrow();
    expect(() => assertMasteringSessionWorkingSetBudget(MAX_MASTERING_SESSION_WORKING_SET_BYTES + 1)).toThrow(
      /above KYX's 512 MiB session limit/,
    );
    expect(estimateMasteringSessionWorkingSetBytes({ ...smallSource, duration: Number.NaN }, master, 48_000)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});
