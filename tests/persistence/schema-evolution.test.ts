import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { indexedDB } from "fake-indexeddb";
import {
  DB_VERSION,
  openDb,
  tx,
  STORE_PROJECTS,
  STORE_META,
  STORE_PRESETS,
  STORE_LIBRARY,
  STORE_USER_SAMPLES,
  STORE_USER_SAMPLE_AUDIO,
  STORE_RECORDING_SESSIONS,
  STORE_RECORDING_CHUNKS,
  STORE_FROZEN_AUDIO,
  STORE_USER_KITS,
  STORE_GROOVE_POOL,
  STORE_SNAPSHOTS,
  STORE_SNAPSHOT_INDEX,
  STORE_ULTINA_PRESETS,
  STORE_MORPH_PRESETS,
} from "../../src/persistence/db";
import { KitRepository } from "../../src/persistence/KitRepository";
import { GroovePoolRepository } from "../../src/persistence/GroovePoolRepository";
import { PresetRepository } from "../../src/persistence/PresetRepository";
import { ProjectRepository } from "../../src/persistence/ProjectRepository";
import type { ProjectDocument } from "../../src/project-model/types";

/**
 * GOAL 05 — schema-evolution matrix for the IndexedDB layer.
 *
 * Pins: (1) the upgrade path completes from an OLD store layout to the full
 * set (the v8 incident class: groove-pool was once added without a version
 * bump, so installs stuck at that version never got the store); (2) every
 * declared store exists at DB_VERSION; (3) a FUTURE version fails an open
 * cleanly (platform VersionError semantics — db.ts surfaces it and never
 * caches the rejection); (4) malformed rows in the raw-cast stores and
 * future/malformed project rows behave per contract (skip / quarantine /
 * tolerate, never take the caller down).
 *
 * ORDER MATTERS: db.ts caches its open connection, so version games run
 * first and the future-version bump runs LAST (it poisons the DB version).
 */

const ALL_STORES = [
  STORE_PROJECTS,
  STORE_META,
  STORE_PRESETS,
  STORE_LIBRARY,
  STORE_USER_SAMPLES,
  STORE_USER_SAMPLE_AUDIO,
  STORE_RECORDING_SESSIONS,
  STORE_RECORDING_CHUNKS,
  STORE_FROZEN_AUDIO,
  STORE_USER_KITS,
  STORE_GROOVE_POOL,
  STORE_SNAPSHOTS,
  STORE_SNAPSHOT_INDEX,
  STORE_ULTINA_PRESETS,
  STORE_MORPH_PRESETS,
];

const DB_NAME = "pulse-forge";

async function rawOpen(version: number, stores?: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, version);
    request.onupgradeneeded = () => {
      if (!stores) return;
      const db = request.result;
      for (const name of stores) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
      }
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error ?? new Error("open failed"));
  });
}

function allStoreNames(db: IDBDatabase): string[] {
  return Array.from(db.objectStoreNames);
}

describe("schema evolution — store layout (GOAL 05)", () => {
  it("declares the full store list (compile guard against typos in this file)", () => {
    expect(ALL_STORES).toHaveLength(15);
    expect(new Set(ALL_STORES).size).toBe(ALL_STORES.length);
  });

  it("upgrade from a v8-shaped layout completes to the full store set (groove-pool incident class)", async () => {
    const V8_STORES = [
      STORE_PROJECTS,
      STORE_META,
      STORE_PRESETS,
      STORE_LIBRARY,
      STORE_USER_SAMPLES,
      STORE_USER_SAMPLE_AUDIO,
      STORE_FROZEN_AUDIO,
      STORE_USER_KITS,
      STORE_SNAPSHOTS,
    ];
    await rawOpen(8, V8_STORES);
    const db = await openDb();
    const names = allStoreNames(db);
    for (const store of ALL_STORES) {
      expect(names, `upgrade 8→${DB_VERSION} must create ${store}`).toContain(store);
    }
    expect(names).toHaveLength(ALL_STORES.length);
  });

  it("open at DB_VERSION exposes every declared store", async () => {
    const db = await openDb();
    const names = allStoreNames(db);
    for (const store of ALL_STORES) {
      expect(names, `store missing at DB_VERSION ${DB_VERSION}: ${store}`).toContain(store);
    }
  });
});

describe("schema evolution — malformed-row tolerance (GOAL 05)", () => {
  it("raw-cast stores (kits, groove pool) tolerate garbage rows without throwing", async () => {
    const db = await openDb();
    await tx(db, STORE_USER_KITS, "readwrite", (store) => {
      store.put({ id: "kit-1" });
      store.put({ id: "kit-2", pads: "not-an-array", createdAt: "whenever" });
    });
    await tx(db, STORE_GROOVE_POOL, "readwrite", (store) => {
      store.put({ id: "g-1", timing: { oops: true } });
    });
    const kits = await new KitRepository().list();
    expect(Array.isArray(kits)).toBe(true);
    expect(kits.map((k) => k.id)).toEqual(expect.arrayContaining(["kit-1", "kit-2"]));
    const grooves = await new GroovePoolRepository().list();
    expect(Array.isArray(grooves)).toBe(true);
  });

  it("presets filter rows that fail the light shape gate", async () => {
    const db = await openDb();
    await tx(db, STORE_PRESETS, "readwrite", (store) => {
      store.put({ id: "preset-good", name: "Ok", instrument: "analog", params: {} });
      store.put({ id: "preset-bad" });
    });
    const presets = await new PresetRepository().list();
    expect(presets.map((p) => p.id)).toContain("preset-good");
    expect(presets.map((p) => p.id)).not.toContain("preset-bad");
  });

  it("future-version project rows are quarantined, garbage rows skipped, load never throws", async () => {
    const futureRow = {
      id: "proj-future",
      name: "From a newer install",
      bpm: 120,
      tracks: [],
      patterns: [],
      activePatternId: "p",
      schemaVersion: 99,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as unknown as ProjectDocument;
    const junkRow = { id: "proj-junk", hello: "world" };
    const db = await openDb();
    await tx(db, STORE_PROJECTS, "readwrite", (store) => {
      store.put(futureRow);
      store.put(junkRow);
    });
    const repo = new ProjectRepository();
    const incompatible = await repo.listIncompatible();
    expect(incompatible.map((m) => m.id)).toContain("proj-future");
    const metas = await repo.listAll();
    expect(metas.map((m) => m.id)).not.toContain("proj-future");
    expect(metas.map((m) => m.id)).not.toContain("proj-junk");
    await expect(repo.load("proj-future")).resolves.toBeNull();
    await expect(repo.load("proj-junk")).resolves.toBeNull();
    const recent = await repo.loadMostRecent();
    expect(recent === null || typeof recent === "object").toBe(true);
  });
});

describe("schema evolution — future version (GOAL 05)", () => {
  it("a database at a FUTURE version fails an open at the current version (VersionError, no hang)", async () => {
    // MUST run last: bumps the shared fake database past DB_VERSION.
    await rawOpen(DB_VERSION + 1);
    await expect(
      new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("open failed"));
      }),
    ).rejects.toMatchObject({ name: "VersionError" });
  });
});
