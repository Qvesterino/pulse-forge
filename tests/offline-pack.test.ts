import { describe, expect, it, vi } from "vitest";
import { downloadOfflinePack, formatBytes, parseOfflinePackManifest, type OfflinePack } from "../src/pwa/offlinePack";

function pack(files: Array<{ url: string; bytes: number }>): OfflinePack {
  return { id: "factory", label: "Factory", bytes: files.reduce((sum, f) => sum + f.bytes, 0), files };
}

function fakeCache(existing: string[] = []) {
  const store = new Map<string, Response>();
  for (const url of existing) store.set(url, new Response("cached"));
  const cache = {
    match: async (url: string) => store.get(url),
    put: async (url: string, response: Response) => {
      store.set(url, response);
    },
  };
  const cachesImpl = { open: async () => cache } as unknown as CacheStorage;
  return { store, cachesImpl };
}

describe("offline pack manifest", () => {
  it("accepts the generated shape and rejects unsafe or empty packs", () => {
    const parsed = parseOfflinePackManifest({
      version: 1,
      packs: [
        { id: "factory", label: "Factory", bytes: 2, files: [{ url: "/samples/a.wav", bytes: 2 }] },
        { id: "empty", label: "Empty", files: [] },
        { id: "evil", label: "Evil", files: [{ url: "/samples/../secret", bytes: 1 }] },
        { id: "remote", label: "Remote", files: [{ url: "https://evil/x.wav", bytes: 1 }] },
      ],
    });
    expect(parsed?.packs.map((p) => p.id)).toEqual(["factory"]);
    expect(parseOfflinePackManifest({ version: 2, packs: [] })).toBeNull();
    expect(parseOfflinePackManifest(null)).toBeNull();
  });

  it("sorts/derives sizes only from valid numeric file sizes", () => {
    const parsed = parseOfflinePackManifest({
      version: 1,
      packs: [
        {
          id: "p",
          label: "P",
          files: [
            { url: "/samples/a.wav", bytes: 4 },
            { url: "/samples/b.wav", bytes: -1 },
          ],
        },
      ],
    });
    expect(parsed?.packs[0]?.files).toHaveLength(1);
    expect(parsed?.packs[0]?.bytes).toBe(4);
  });

  it("formats sizes for the pack UI", () => {
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("offline pack downloader", () => {
  it("skips cached files and fills the rest with bounded concurrency", async () => {
    const files = ["/samples/a.wav", "/samples/b.wav", "/samples/c.wav"].map((url) => ({ url, bytes: 3 }));
    const { store, cachesImpl } = fakeCache(["/samples/a.wav"]);
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const progress: number[] = [];
    const result = await downloadOfflinePack(pack(files), {
      deps: { cachesImpl, fetchImpl, concurrency: 2 },
      onProgress: (p) => progress.push(p.completed),
    });
    expect(result).toMatchObject({ downloaded: 2, skipped: 1, failed: 0, completed: 3, total: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(3);
    expect(progress.at(-1)).toBe(3);
  });

  it("keeps going after a failed file and reports it", async () => {
    const files = ["/samples/a.wav", "/samples/b.wav"].map((url) => ({ url, bytes: 1 }));
    const { cachesImpl } = fakeCache();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return url.endsWith("a.wav") ? new Response("nope", { status: 404 }) : new Response("ok", { status: 200 });
    });
    const result = await downloadOfflinePack(pack(files), { deps: { cachesImpl, fetchImpl, concurrency: 1 } });
    expect(result).toMatchObject({ downloaded: 1, failed: 1, completed: 2 });
  });

  it("stops cleanly when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const files = ["/samples/a.wav"].map((url) => ({ url, bytes: 1 }));
    const { cachesImpl } = fakeCache();
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const result = await downloadOfflinePack(pack(files), {
      deps: { cachesImpl, fetchImpl },
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails clearly when Cache Storage is unavailable", async () => {
    await expect(
      downloadOfflinePack(pack([{ url: "/samples/a.wav", bytes: 1 }]), { deps: { cachesImpl: undefined } }),
    ).rejects.toThrow(/Cache Storage/);
  });
});
