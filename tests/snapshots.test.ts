/**
 * Project snapshots — "restore to yesterday" safety net.
 *
 * Repository runs against fake-indexeddb; the restore path is tested as the
 * real command both stores execute (functional execute/undo), so collab
 * stores are covered by the same semantics.
 */
import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach } from "vitest";
import {
  AUTO_SNAPSHOT_MIN_INTERVAL_MS,
  SnapshotRepository,
  shouldAutoSnapshot,
} from "../src/persistence/SnapshotRepository";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";

describe("shouldAutoSnapshot policy", () => {
  const NOW = 1_800_000_000_000;

  it("is due when there is no snapshot yet", () => {
    expect(shouldAutoSnapshot(null, NOW)).toBe(true);
    expect(shouldAutoSnapshot(undefined, NOW)).toBe(true);
    expect(shouldAutoSnapshot("garbage", NOW)).toBe(true);
  });

  it("is due once the newest snapshot is older than the interval", () => {
    const stale = new Date(NOW - AUTO_SNAPSHOT_MIN_INTERVAL_MS - 1).toISOString();
    expect(shouldAutoSnapshot(stale, NOW)).toBe(true);
    const fresh = new Date(NOW - AUTO_SNAPSHOT_MIN_INTERVAL_MS / 2).toISOString();
    expect(shouldAutoSnapshot(fresh, NOW)).toBe(false);
  });
});

describe("SnapshotRepository", () => {
  let repo: SnapshotRepository;

  beforeEach(() => {
    repo = new SnapshotRepository();
  });

  it("saves and lists newest-first", async () => {
    const doc = createProjectFromTemplate("house");
    await repo.save(doc.id, doc, "Auto — session start");
    const edited = { ...doc, name: "Edited" };
    await repo.save(doc.id, edited, "Manual — now");

    const list = await repo.list(doc.id);
    expect(list).toHaveLength(2);
    expect(list[0].label).toBe("Manual — now"); // newest first
    expect(list[1].label).toBe("Auto — session start");
    expect(list[0].doc.name).toBe("Edited");
  });

  it("prunes to the newest N per project and keeps other projects untouched", async () => {
    const a = createProjectFromTemplate("house");
    const b = createProjectFromTemplate("techno");
    for (let i = 0; i < 25; i++) {
      await repo.save(a.id, { ...a, name: `v${i}` }, `snap ${i}`);
    }
    await repo.save(b.id, b, "other project");

    await repo.prune(a.id, 20);
    const listA = await repo.list(a.id);
    expect(listA).toHaveLength(20);
    expect(listA[0].label).toBe("snap 24"); // newest survive
    expect(listA[19].label).toBe("snap 5"); // oldest five pruned

    const listB = await repo.list(b.id);
    expect(listB).toHaveLength(1);
    expect(listB[0].label).toBe("other project");
  });

  it("get + delete round-trip", async () => {
    const doc = createProjectFromTemplate("house");
    const snap = await repo.save(doc.id, doc, "manual");
    expect((await repo.get(snap.id))?.label).toBe("manual");
    await repo.delete(snap.id);
    expect(await repo.get(snap.id)).toBeNull();
  });
});

describe("restore as an undoable command", () => {
  it("swaps the document and undoes back to the broken state", () => {
    const original = createProjectFromTemplate("house");
    const current = { ...original, name: "I broke the mix" };
    const store = new ProjectStore(current);

    const restored = structuredClone(original);
    store.execute({
      type: "restoreSnapshot",
      label: 'Restore "Auto — yesterday"',
      execute: () => restored,
      undo: () => current,
    } as never);

    expect(store.doc.name).toBe(original.name);
    expect(store.canUndo).toBe(true);
    store.undo();
    expect(store.doc.name).toBe("I broke the mix");
  });

  it("keeps the stored snapshot untouched for future restores", () => {
    const original = createProjectFromTemplate("house");
    const snapshotDoc = structuredClone(original);
    const store = new ProjectStore({ ...original, name: "current" });

    store.execute({ type: "restoreSnapshot", label: "restore", execute: () => snapshotDoc, undo: () => original } as never);
    // Rename the restored doc through a follow-up command — the snapshot copy must not change.
    store.execute({
      type: "rename",
      label: "rename",
      execute: (d: typeof original) => ({ ...d, name: "renamed after restore" }),
    } as never);

    expect(snapshotDoc.name).toBe(original.name);
  });
});
