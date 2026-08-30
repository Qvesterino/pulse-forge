import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { openDb, DB_NAME } from "../../src/persistence/db";

describe("openDb failure recovery", () => {
  it("does not cache a rejected open — the next call retries (regression: one transient failure poisoned all later repository calls)", async () => {
    const realOpen = indexedDB.open.bind(indexedDB);
    let failedOnce = false;
    const spy = vi.spyOn(indexedDB, "open").mockImplementation((...args: Parameters<typeof realOpen>) => {
      if (!failedOnce) {
        failedOnce = true;
        throw new Error("transient open failure");
      }
      return realOpen(...args);
    });

    await expect(openDb()).rejects.toThrow("transient open failure");
    // A second call must retry the open, not replay the cached rejection.
    const db = await openDb();
    expect(db.name).toBe(DB_NAME);
    expect(db.objectStoreNames.length).toBeGreaterThan(0);
    spy.mockRestore();
  });
});
