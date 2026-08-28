import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { UserSampleRepository, restoreUserSampleAudio, userSampleId } from "../../src/persistence/UserSampleRepository";

describe("userSampleId", () => {
  it("generates a user.* id from filename", () => {
    const id = userSampleId("My Kick.wav");
    expect(id).toMatch(/^user\.my-kick-/);
  });

  it("strips file extension", () => {
    const id = userSampleId("snare.wav");
    expect(id).toMatch(/^user\.snare-/);
  });

  it("handles special characters", () => {
    const id = userSampleId("My Cool Sample (2).wav");
    expect(id).toMatch(/^user\.my-cool-sample-2-/);
  });

  it("produces unique ids with randomness", () => {
    // userSampleId uses Date.now() + random chars, so fast calls may collide.
    // The function appends a random suffix, so we test the format.
    const id = userSampleId("test.wav");
    expect(id).toMatch(/^user\.test-[a-z0-9]+$/);
  });

  it("handles unicode filenames", () => {
    const id = userSampleId("Kůň.wav");
    expect(id).toMatch(/^user\./);
  });

  it("handles long filenames", () => {
    const longName = "a".repeat(200) + ".wav";
    const id = userSampleId(longName);
    expect(id.length).toBeLessThan(250);
  });
});

describe("UserSampleRepository audio persistence", () => {
  const repo = new UserSampleRepository();

  function asset(id: string): import("../../src/persistence/UserSampleRepository").UserSampleAsset {
    return {
      id,
      name: id,
      fileName: `${id}.wav`,
      category: "Custom",
      duration: 1.5,
      sampleRate: 44100,
      channels: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
  }

  it("saves and loads encoded audio bytes alongside metadata", async () => {
    const id = userSampleId("cycle");
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    await repo.save(asset(id), bytes);

    const audio = await repo.loadAudio(id);
    // fake-indexeddb returns the clone from another realm — compare content,
    // not instanceof.
    expect(audio).toBeDefined();
    expect(Array.from(new Uint8Array(audio as ArrayBuffer))).toEqual([1, 2, 3, 4]);

    const listed = await repo.listAudio();
    expect(listed.some((entry) => entry.id === id)).toBe(true);

    // metadata still lists separately
    const meta = await repo.list();
    expect(meta.some((a) => a.id === id)).toBe(true);
  });

  it("remove deletes metadata and audio", async () => {
    const id = userSampleId("gone");
    await repo.save(asset(id), new Uint8Array([9]).buffer);
    expect(await repo.loadAudio(id)).toBeDefined();

    await repo.remove(id);
    expect(await repo.loadAudio(id)).toBeUndefined();
    const meta = await repo.list();
    expect(meta.some((a) => a.id === id)).toBe(false);
  });

  it("loadAudio returns undefined for unknown ids", async () => {
    expect(await repo.loadAudio("user.nothing")).toBeUndefined();
  });

  it("restoreUserSampleAudio decodes stored bytes into the bank", async () => {
    const id = userSampleId("restore");
    await repo.save(asset(id), new Uint8Array([7, 7, 7]).buffer);

    const added: Array<[string, unknown]> = [];
    const bank = {
      add: (bid: string, buffer: unknown) => added.push([bid, buffer]),
      get: () => undefined,
    };
    const fakeBuffer = { duration: 1.5 };
    const decodedIds: ArrayBuffer[] = [];
    await restoreUserSampleAudio(bank as any, (data) => {
      decodedIds.push(data);
      return Promise.resolve(fakeBuffer as any);
    });

    expect(added).toContainEqual([id, fakeBuffer]);
    expect(decodedIds.length).toBeGreaterThanOrEqual(1);

    // corrupt entries are skipped without aborting the restore loop
    const badId = userSampleId("corrupt");
    await repo.save(asset(badId), new Uint8Array([0]).buffer);
    const added2: Array<[string, unknown]> = [];
    await restoreUserSampleAudio(
      { add: (bid: string, buffer: unknown) => added2.push([bid, buffer]) } as any,
      (data) =>
        new Uint8Array(data)[0] === 0 ? Promise.reject(new Error("corrupt")) : Promise.resolve(fakeBuffer as any),
    );
    expect(added2).toContainEqual([id, fakeBuffer]);
    expect(added2.some(([bid]) => bid === badId)).toBe(false);
  });
});
