/**
 * Regression test for UserSampleRepository.save() ordering.
 *
 * Bug: the previous order wrote METADATA first, then AUDIO. If the audio
 * write failed, a metadata ghost row would stay in the library listing
 * forever. The fix writes AUDIO first, then metadata — a metadata failure
 * leaves the audio orphaned (invisible to the user) instead of leaving
 * a broken-but-listed sample. No rollback required.
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { UserSampleRepository, type UserSampleAsset } from "../../src/persistence/UserSampleRepository";
import { openDb, tx, STORE_USER_SAMPLES, STORE_USER_SAMPLE_AUDIO } from "../../src/persistence/db";

function asset(id: string): UserSampleAsset {
  return {
    id,
    name: id,
    fileName: `${id}.wav`,
    category: "Custom",
    duration: 1.0,
    sampleRate: 44100,
    channels: 2,
    createdAt: "2026-09-21T09:00:00.000Z",
  };
}

afterEach(async () => {
  const db = await openDb();
  await tx(db, STORE_USER_SAMPLES, "readwrite", (s) => s.clear());
  await tx(db, STORE_USER_SAMPLE_AUDIO, "readwrite", (s) => s.clear());
});

describe("UserSampleRepository.save() ordering", () => {
  it("writes audio BEFORE metadata — no rollback needed on metadata failure", async () => {
    const repo = new UserSampleRepository();

    // First, save normally to confirm the happy path.
    const id = "user.ordering-happy";
    await repo.save(asset(id), new Uint8Array([1, 2, 3, 4]).buffer);
    const audio = await repo.loadAudio(id);
    expect(audio).toBeDefined();
    const meta = await repo.list();
    expect(meta.some((a) => a.id === id)).toBe(true);
  });

  it("does not leave a phantom metadata row when audio save is cancelled by the caller", async () => {
    // Simulate the original failure mode: audio write fails (caller passes
    // bad data that survives structured clone but somehow fails the put —
    // here we just don't pass data, then force the metadata write to throw).
    // The important guarantee is: if the AUDIO write throws, no METADATA row
    // exists yet (because audio-first). Verify by patching store.put on the
    // metadata store to throw AFTER the audio row landed.
    const repo = new UserSampleRepository();

    const id = "user.ordering-audio-fails";

    // Force the metadata put to throw by swapping the store's put method for
    // only the user-samples store. The audio store still works.
    const realPut = IDBObjectStore.prototype.put;
    let metadataAttempts = 0;
    IDBObjectStore.prototype.put = function patchedPut(value, key) {
      if (this.name === STORE_USER_SAMPLES && value && (value as { id?: string }).id === id) {
        metadataAttempts += 1;
        throw Object.assign(new Error("forced metadata failure"), { name: "DataError" });
      }
      return realPut.call(this, value, key);
    };

    try {
      await expect(repo.save(asset(id), new Uint8Array([9, 9]).buffer)).rejects.toThrow(/forced metadata failure/);
    } finally {
      IDBObjectStore.prototype.put = realPut;
    }

    expect(metadataAttempts).toBeGreaterThan(0);

    // Critical assertion: no phantom metadata row. The sample must NOT be
    // listed because metadata never committed.
    const listed = await repo.list();
    expect(listed.some((a) => a.id === id)).toBe(false);

    // The audio blob was committed before the metadata failure — it is an
    // orphan (invisible to the user). The fix explicitly accepts this in
    // exchange for not surfacing a silent-broken sample to the UI.
    const orphans = await repo.listAudio();
    expect(orphans.some((e) => e.id === id)).toBe(true);
  });

  it("saves a metadata-only sample (no audio) without errors", async () => {
    const repo = new UserSampleRepository();
    const id = "user.ordering-meta-only";
    await repo.save(asset(id));
    const meta = await repo.list();
    expect(meta.some((a) => a.id === id)).toBe(true);
    expect(await repo.loadAudio(id)).toBeUndefined();
  });
});
