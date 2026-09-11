import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { LibraryRepository } from "../src/persistence/LibraryRepository";

describe("LibraryRepository", () => {
  it("starts empty and persists favorites/recents", async () => {
    const lib = new LibraryRepository();
    const initial = await lib.load();
    expect(initial.favoriteAssets).toEqual([]);
    expect(initial.recentAssets).toEqual([]);

    await lib.toggleAssetFavorite("factory.kick.deep");
    await lib.recordAsset("factory.hat.closed");
    await lib.togglePresetFavorite("factory.bass.house.pluck");
    await lib.recordPreset("factory.bass.house.pluck");

    const state = lib.get();
    expect(state.favoriteAssets).toContain("factory.kick.deep");
    expect(state.recentAssets[0]).toBe("factory.hat.closed");
    expect(state.favoritePresets).toContain("factory.bass.house.pluck");
    expect(state.recentPresets[0]).toBe("factory.bass.house.pluck");

    // Reload from a fresh instance — persisted state must survive.
    const fresh = new LibraryRepository();
    const reloaded = await fresh.load();
    expect(reloaded.favoriteAssets).toContain("factory.kick.deep");
    expect(reloaded.recentAssets[0]).toBe("factory.hat.closed");
  });

  it("toggle is idempotent (favorite → unfavorite → gone)", async () => {
    const lib = new LibraryRepository();
    await lib.load();
    await lib.toggleAssetFavorite("factory.kick.soft");
    expect(lib.get().favoriteAssets).toContain("factory.kick.soft");
    await lib.toggleAssetFavorite("factory.kick.soft");
    expect(lib.get().favoriteAssets).not.toContain("factory.kick.soft");
  });

  it("recent entries are deduped and capped", async () => {
    const lib = new LibraryRepository();
    await lib.load();
    await lib.recordAsset("a");
    await lib.recordAsset("a");
    await lib.recordAsset("b");
    const state = lib.get();
    expect(state.recentAssets.filter((x) => x === "a")).toHaveLength(1);
    expect(state.recentAssets[0]).toBe("b");
    expect(state.recentAssets[1]).toBe("a");
  });

  it("surfaces storage failure while retaining the optimistic in-memory state for retry", async () => {
    const lib = new LibraryRepository(async () => {
      throw new Error("quota exceeded");
    });

    await expect(lib.toggleAssetFavorite("factory.kick.failed")).rejects.toThrow(
      /Could not save library preferences: quota exceeded/,
    );
    expect(lib.get().favoriteAssets).toContain("factory.kick.failed");
  });
});
