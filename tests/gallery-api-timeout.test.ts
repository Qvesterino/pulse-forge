import { afterEach, describe, expect, it, vi } from "vitest";
import { listBeats } from "../src/gallery/galleryApi";

/**
 * The gallery calls used to await a bare `fetch` with no deadline. A relay that
 * accepts the connection but never answers left the feed stuck on "loading"
 * with no error and no RETRY (that branch only renders in the error state).
 * galleryFetch must abort a hung request so the UI can recover.
 */

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("gallery request deadline", () => {
  it("aborts a hung feed request instead of awaiting forever", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      ),
    );

    const pending = listBeats("http://127.0.0.1:1234");
    const rejection = expect(pending).rejects.toThrow();
    // Nothing settles before the deadline...
    await vi.advanceTimersByTimeAsync(14_000);
    // ...and the deadline converts the silent stall into a rejection.
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
  });

  it("does not abort a request that answers in time", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }) as Response),
    );
    await expect(listBeats("http://127.0.0.1:1234")).resolves.toEqual([]);
  });
});
