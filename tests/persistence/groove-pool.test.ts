import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { GroovePoolRepository } from "../../src/persistence/GroovePoolRepository";
import { openDb, STORE_GROOVE_POOL, tx } from "../../src/persistence/db";

/**
 * GOAL 08 — GroovePoolRepository had no dedicated suite (raw-cast reads).
 * Pins: round-trip + ordering, garbage-row tolerance, quota rejection
 * surfaced (never swallowed) — the failure contract a future backend must
 * reproduce.
 */

function entry(id: string, createdAt: number) {
  // createdAt is an ISO string in the store — ordering is lexicographic.
  return {
    id,
    name: `Groove ${id}`,
    timing: [0, 0.5, 0.25],
    accent: [1, 0.6],
    createdAt: new Date(createdAt).toISOString(),
  };
}

describe("GroovePoolRepository (GOAL 08 risk coverage)", () => {
  it("save → list round-trips and lists newest-first by createdAt", async () => {
    const repo = new GroovePoolRepository();
    await repo.save(entry("old", 100));
    await repo.save(entry("new", 900));
    const list = await repo.list();
    expect(list.map((g) => g.id)).toEqual(["new", "old"]);
    await repo.remove("old");
    expect((await repo.list()).map((g) => g.id)).toEqual(["new"]);
  });

  it("garbage rows do not throw on list (raw-cast tolerance is the documented contract)", async () => {
    const db = await openDb();
    await tx(db, STORE_GROOVE_POOL, "readwrite", (store) => {
      store.put({ id: "junk-1", timing: { nope: 1 } });
      store.put({ id: "junk-2" });
    });
    const list = await new GroovePoolRepository().list();
    expect(Array.isArray(list)).toBe(true);
    expect(list.map((g) => g.id)).toEqual(expect.arrayContaining(["junk-1", "junk-2"]));
  });

  it("save/remove invalidate the list cache — the next list re-reads the store", async () => {
    const repo = new GroovePoolRepository();
    await repo.save(entry("cache-a", 100));
    await repo.save(entry("cache-b", 200));
    // The store may also contain junk rows from the tolerance test above —
    // the pin here is cache invalidation: removed rows disappear, saved rows
    // appear, without constructing a new repository.
    expect((await repo.list()).map((g) => g.id)).toContain("cache-a");
    expect((await repo.list()).map((g) => g.id)).toContain("cache-b");
    await repo.remove("cache-b");
    expect((await repo.list()).map((g) => g.id)).not.toContain("cache-b");
  });
  // RECORDED (GOAL 08): this repo hardcodes openDb — the openDatabase
  // injection seam exists on only 3 of 11 repos, so quota-rejection
  // behavior is not testable here. Generalizing the seam is the queued
  // GOAL 03 follow-up; save/remove REJECT by contract (no internal catch).
});
