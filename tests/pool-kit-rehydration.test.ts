import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { GroovePoolRepository, type GroovePoolEntry } from "../src/persistence/GroovePoolRepository";
import { KitRepository, type UserKit } from "../src/persistence/KitRepository";
import { DB_NAME, DB_VERSION } from "../src/persistence/db";

/**
 * GOAL 05 (re-run 4) — rehydration-boundary sanitize for the groove-pool and
 * user-kit stores. Both repos previously returned raw IndexedDB records cast
 * to their interfaces: a malformed persisted entry would booby-trap command
 * execution (applyGroove indexes `map.timing.length`; applyKitToDrumTrack
 * maps over `pads`; RackStrip dereferences `kit.pads.length`). The
 * Morph/Ultina preset stores already modeled the right pattern — this pins
 * it onto the two older repos: malformed records are DROPPED, valid ones
 * survive, and save round-trips still work.
 *
 * One sequential test per store — fake-indexeddb is per-process and the
 * main db.ts open has a 5 s blocked-open backstop, so the DB is never
 * deleted mid-file.
 */

async function putRaw(store: string, value: unknown): Promise<void> {
  const open = indexedDB.open(DB_NAME, DB_VERSION);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value as never);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

function validGroove(overrides?: Partial<GroovePoolEntry>): GroovePoolEntry {
  return {
    id: "g1",
    name: "Steal the groove",
    timing: [0, 0.1, 0.2, -0.05],
    accent: [1, 0, 0.5, 0],
    createdAt: "2026-09-25T00:00:00.000Z",
    ...overrides,
  };
}

function validKit(overrides?: Partial<UserKit>): UserKit {
  return {
    id: "k1",
    name: "My kit",
    genre: "house",
    description: "punchy",
    createdAt: "2026-09-25T00:00:00.000Z",
    pads: [
      { idx: 0, assetId: "factory.kick.deep", synth: null },
      { idx: 4, assetId: null, synth: null, gain: 0.8 },
    ],
    ...overrides,
  };
}

describe("GroovePoolRepository rehydration sanitize", () => {
  it("drops malformed records, keeps valid ones, round-trips saves", async () => {
    // First open goes through db.ts so the upgrade creates all stores.
    await new GroovePoolRepository().list();
    await putRaw("groove-pool", validGroove({ id: "ok" }));
    await putRaw("groove-pool", { id: "no-timing", name: "x", accent: [], createdAt: "" });
    await putRaw("groove-pool", validGroove({ id: "nan", timing: [0, Number.NaN, 1] }));
    await putRaw("groove-pool", validGroove({ id: "huge", timing: new Array(129).fill(0) }));
    await putRaw("groove-pool", validGroove({ id: "bad-accent", accent: ["loud"] as never }));
    // A record with an id but nothing else — the corrupted-record class a
    // keyPath store can actually persist (keyless junk throws at put time).
    await putRaw("groove-pool", { id: "empty-shell" });

    const pool = await new GroovePoolRepository().list();
    expect(pool.map((e) => e.id)).toEqual(["ok"]);

    // A record missing accent/createdAt keeps usable defaults.
    await putRaw("groove-pool", { id: "bare", name: "no accent", timing: [0, 1] });
    const bare = (await new GroovePoolRepository().list()).find((e) => e.id === "bare");
    expect(bare).toBeDefined();
    expect(bare!.accent).toEqual([]);
    expect(bare!.createdAt).toBe("");

    // Save round-trip still works through the sanitize gate.
    const repo = new GroovePoolRepository();
    await repo.save(validGroove({ id: "fresh" }));
    expect((await repo.list()).map((e) => e.id)).toContain("fresh");
  });
});

describe("KitRepository rehydration sanitize", () => {
  it("drops malformed kits, keeps valid ones with optional fields, round-trips saves", async () => {
    // First open goes through db.ts so the upgrade creates all stores.
    await new KitRepository().list();
    await putRaw("user-kits", validKit({ id: "ok" }));
    await putRaw("user-kits", validKit({ id: "no-pads", pads: [] }));
    await putRaw("user-kits", validKit({ id: "junk-pads", pads: [{ idx: 0 }] as never }));
    await putRaw("user-kits", validKit({ id: "bad-idx", pads: [{ idx: 16, assetId: null }] as never }));
    await putRaw("user-kits", validKit({ id: "nan-gain", pads: [{ idx: 0, assetId: null, gain: "loud" }] as never }));
    await putRaw("user-kits", validKit({ id: "no-name", name: "  " }));

    const kits = await new KitRepository().list();
    expect(kits.map((k) => k.id)).toEqual(["ok"]);

    // Optional pad fields survive when present and valid.
    await putRaw(
      "user-kits",
      validKit({
        id: "full",
        pads: [{ idx: 2, assetId: "factory.snare.main", synth: null, gain: 0.9, pan: -0.3, pitch: 2, chokeGroup: 1 }],
      }),
    );
    const full = (await new KitRepository().list()).find((k) => k.id === "full");
    expect(full).toBeDefined();
    expect(full!.pads[0]).toMatchObject({ idx: 2, gain: 0.9, pan: -0.3, pitch: 2, chokeGroup: 1 });

    // Save round-trip still works through the sanitize gate.
    const repo = new KitRepository();
    await repo.save(validKit({ id: "fresh" }));
    expect((await repo.list()).map((k) => k.id)).toContain("fresh");
  });
});
