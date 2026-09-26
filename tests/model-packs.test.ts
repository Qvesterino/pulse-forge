import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { MODEL_PACKS, SEMANTIC_PACK, PACK_MANIFEST_PATH, type ModelPack } from "../src/ai/packs/registry";
import {
  canonicalPackUrl,
  downloadPack,
  evictPack,
  installedPackResponseForUrl,
  MODEL_PACK_CACHE,
  packFileResponse,
  packStatus,
  type PackDeps,
} from "../src/ai/packs/modelPackManager";

/**
 * Model pack manager contract (ROADMAP-FULL-DAW Phase 5): explicit-request
 * downloads with size/license/hash/progress/cancellation/cache/offline
 * fallback. The registry is pinned against the dev-time fetch script's
 * manifest (public/models/semantic/manifest.json) so the CDN hash set can
 * never drift from what the loader validates.
 */

// ── Test doubles ─────────────────────────────────────────────────────────

class FakeCache {
  store = new Map<string, Response>();
  async match(request: string | Request): Promise<Response | undefined> {
    const url = typeof request === "string" ? request : request.url;
    return this.store.get(url);
  }
  async put(request: string | Request, response: Response): Promise<void> {
    const url = typeof request === "string" ? request : request.url;
    this.store.set(url, response);
  }
  async delete(request: string | Request): Promise<boolean> {
    const url = typeof request === "string" ? request : request.url;
    return this.store.delete(url);
  }
  async keys(): Promise<Request[]> {
    return [...this.store.keys()].map((url) => new Request(url));
  }
}

class FakeCacheStorage {
  caches = new Map<string, FakeCache>();
  async open(name: string): Promise<Cache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.caches.set(name, cache);
    }
    return cache as unknown as Cache;
  }
}

/** Real SHA-256 via node:crypto — the manager's verification path must match. */
const nodeDigest = async (algorithm: "SHA-256", data: ArrayBuffer): Promise<ArrayBuffer> => {
  const digest = createHash(algorithm.toLowerCase()).update(new Uint8Array(data)).digest();
  return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength) as ArrayBuffer;
};

function streamResponse(bytes: Uint8Array, chunkSize = 64): Response {
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
  return new Response(stream, { headers: { "content-length": String(bytes.length) } });
}

function makeDeps(responder: (url: string) => Response | null): { deps: PackDeps; storage: FakeCacheStorage } {
  const storage = new FakeCacheStorage();
  const deps: PackDeps = {
    cacheStorage: storage as unknown as CacheStorage,
    digestImpl: nodeDigest,
    yieldImpl: () => Promise.resolve(),
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const response = responder(url);
      if (!response) throw new Error(`unexpected fetch in test: ${url}`);
      return response;
    }) as typeof fetch,
  };
  return { deps, storage };
}

function validFileBytes(index: number): Uint8Array {
  // Deterministic per-file payload — seeded by INDEX ONLY so the bytes stay
  // stable while makeConsistentPack() rewrites the hash column.
  const size = 256 + index * 128;
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + index * 7) & 0xff;
  return bytes;
}

/** Build a pack whose file hashes match the deterministic payloads above. */
async function makeConsistentPack(): Promise<ModelPack> {
  const files = await Promise.all(
    SEMANTIC_PACK.files.map(async (file, index) => {
      const bytes = validFileBytes(index);
      const hash = createHash("sha256").update(bytes).digest("hex");
      return { ...file, sha256: hash };
    }),
  );
  return { ...SEMANTIC_PACK, files };
}

// ── Registry pins ────────────────────────────────────────────────────────

describe("model pack registry", () => {
  const manifestPath = path.resolve(import.meta.dirname ?? ".", "..", "public", "models", "semantic", "manifest.json");

  it("file hashes mirror the dev-time fetch manifest (single source of truth)", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      modelId: string;
      files: Record<string, string>;
    };
    for (const [file, hash] of Object.entries(manifest.files)) {
      // Exact path match — "config.json" must not match "tokenizer_config.json".
      const entry = SEMANTIC_PACK.files.find((f) => f.path === `${manifest.modelId}/${file}`);
      expect(entry, `registry entry for ${file}`).toBeDefined();
      expect(entry!.sha256).toBe(hash);
    }
    expect(SEMANTIC_PACK.files).toHaveLength(Object.keys(manifest.files).length);
  });

  it("manifestContent parses and pins the loader contract", () => {
    const parsed = JSON.parse(SEMANTIC_PACK.manifestContent) as {
      semanticVersion: string;
      modelId: string;
      dtype: string;
      files: Record<string, string>;
    };
    expect(parsed.semanticVersion).toBe("semantic-embed.v1");
    expect(parsed.dtype).toBe("q8");
    expect(parsed.files).toEqual(JSON.parse(readFileSync(manifestPath, "utf-8")).files);
  });

  it("every downloadable file has a pinned upstream URL and 64-hex hash", () => {
    for (const file of SEMANTIC_PACK.files) {
      expect(file.sourceUrl).toMatch(/^https:\/\/huggingface\.co\/Xenova\//);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.path.startsWith("Xenova/")).toBe(true); // repository-shaped loader path
    }
  });

  it("registry is exported and non-empty", () => {
    expect(MODEL_PACKS.length).toBeGreaterThan(0);
    expect(MODEL_PACKS[0]!.id).toBe("semantic-embed");
  });
});

// ── Manager contract ─────────────────────────────────────────────────────

describe("model pack manager", () => {
  let pack: ModelPack;

  beforeAll(async () => {
    pack = await makeConsistentPack();
  });

  it("downloads, verifies and installs every file (progress reaches 100%)", async () => {
    const { deps, storage } = makeDeps((url) => {
      const index = pack.files.findIndex((file) => file.sourceUrl === url);
      return index >= 0 ? streamResponse(validFileBytes(index)) : null;
    });
    const reports: number[] = [];
    await downloadPack(pack, { onProgress: (p) => reports.push(p.bytesDone) }, deps);

    const cache = storage.caches.get(MODEL_PACK_CACHE)!;
    expect(cache.store.size).toBe(pack.files.length + 1); // + inline manifest
    expect(await packStatus(pack, deps)).toBe("ready");
    // Progress is monotonic and reaches the full byte total.
    expect(reports).toEqual([...reports].sort((a, b) => a - b));
    const totalBytes = pack.files.reduce((sum, _file, index) => sum + validFileBytes(index).length, 0);
    expect(reports[reports.length - 1]).toBe(totalBytes);

    // The inline manifest is served byte-identical.
    const manifest = await packFileResponse(pack, PACK_MANIFEST_PATH, deps);
    expect(manifest).not.toBeNull();
    expect(await manifest!.text()).toBe(pack.manifestContent);
  });

  it("a hash mismatch discards the whole download (no partial install)", async () => {
    const { deps, storage } = makeDeps((url) => {
      const index = pack.files.findIndex((file) => file.sourceUrl === url);
      if (index < 0) return null;
      const bytes = validFileBytes(index);
      bytes[0] = bytes[0]! ^ 0xff; // corrupt the first byte
      return streamResponse(bytes);
    });
    await expect(downloadPack(pack, {}, deps)).rejects.toThrow(/integrity mismatch/);
    expect(storage.caches.get(MODEL_PACK_CACHE)?.store.size ?? 0).toBe(0);
    expect(await packStatus(pack, deps)).toBe("absent");
  });

  it("cancellation evicts partial state and surfaces AbortError", async () => {
    const controller = new AbortController();
    const { deps, storage } = makeDeps((url) => {
      const index = pack.files.findIndex((file) => file.sourceUrl === url);
      if (index < 0) return null;
      const bytes = validFileBytes(index);
      // A stream that errors on the next pull once the signal aborts.
      let offset = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controllerInner) {
          if (controller.signal.aborted) {
            controllerInner.error(new DOMException("Aborted", "AbortError"));
            return;
          }
          if (offset >= bytes.length) {
            controllerInner.close();
            return;
          }
          const end = Math.min(offset + 16, bytes.length);
          controllerInner.enqueue(bytes.slice(offset, end));
          offset = end;
        },
      });
      return new Response(stream, { headers: { "content-length": String(bytes.length) } });
    });
    let aborted = false;
    await expect(
      downloadPack(
        pack,
        {
          signal: controller.signal,
          onProgress: () => {
            // Deterministic: cancel as soon as the first bytes arrive.
            if (!aborted) {
              aborted = true;
              controller.abort();
            }
          },
        },
        deps,
      ),
    ).rejects.toThrow();
    expect(storage.caches.get(MODEL_PACK_CACHE)?.store.size ?? 0).toBe(0);
    expect(await packStatus(pack, deps)).toBe("absent");
  });

  it("packFileResponse / installedPackResponseForUrl answer cache-first, null when absent", async () => {
    const { deps } = makeDeps((url) => {
      const index = pack.files.findIndex((file) => file.sourceUrl === url);
      return index >= 0 ? streamResponse(validFileBytes(index)) : null;
    });
    expect(await packFileResponse(pack, pack.files[0]!.path, deps)).toBeNull();
    expect(await installedPackResponseForUrl(canonicalPackUrl(pack, pack.files[0]!.path), [pack], deps)).toBeNull();
    await downloadPack(pack, {}, deps);
    const hit = await installedPackResponseForUrl(canonicalPackUrl(pack, pack.files[0]!.path), [pack], deps);
    expect(hit).not.toBeNull();
    // Non-pack URLs never match.
    expect(await installedPackResponseForUrl("https://example.com/other.js", [pack], deps)).toBeNull();
  });

  it("evictPack removes exactly the pack's entries", async () => {
    const { deps, storage } = makeDeps((url) => {
      const index = pack.files.findIndex((file) => file.sourceUrl === url);
      return index >= 0 ? streamResponse(validFileBytes(index)) : null;
    });
    await downloadPack(pack, {}, deps);
    const cache = storage.caches.get(MODEL_PACK_CACHE)!;
    cache.store.set("https://example.com/unrelated.js", new Response("x"));
    await evictPack(pack, deps);
    expect(cache.store.size).toBe(1);
    expect(cache.store.has("https://example.com/unrelated.js")).toBe(true);
  });

  it("reports partial when only some files are present", async () => {
    const { deps, storage } = makeDeps((url) => {
      const index = pack.files.findIndex((file) => file.sourceUrl === url);
      if (index < 0) return null;
      // Serve only the FIRST file, fail the rest.
      if (index > 0) return new Response("gone", { status: 404 });
      return streamResponse(validFileBytes(index));
    });
    await expect(downloadPack(pack, {}, deps)).rejects.toThrow(/HTTP 404/);
    // Failed downloads evict — partial state only arises from external
    // interference; simulate it by hand to pin the status classification.
    const cache = storage.caches.get(MODEL_PACK_CACHE)!;
    cache.store.set(canonicalPackUrl(pack, PACK_MANIFEST_PATH), new Response(pack.manifestContent));
    expect(await packStatus(pack, deps)).toBe("partial");
  });
});
