/**
 * Model pack download manager (ROADMAP-FULL-DAW Phase 5 contract: explicit
 * request, size, license, hash, progress, cancellation, cache, offline
 * fallback).
 *
 * Contract:
 *  - `downloadPack` runs ONLY on explicit user action (the UI card). Each
 *    file is fetched from the pinned upstream release, streamed for
 *    progress, SHA-256-verified against the registry, and only then written
 *    into the dedicated Cache Storage bucket. A cancelled, failed or
 *    tampered download leaves no partial entries behind.
 *  - `packFileResponse` is the loading bridge: cache-first lookup for a
 *    pack-relative URL. The semantic client/worker consult it before the
 *    network so an installed pack works offline and a deployment without
 *    the dev-only public/ folder still runs the model.
 *  - `packStatus` distinguishes ready / partial / absent for honest UI.
 *
 * The Cache API bucket survives reloads and complements the boot-time
 * `navigator.storage.persist()` call (mobile-readiness GOAL 10).
 */

import { assetUrl } from "../../shared/assetUrls";
import { type ModelPack, PACK_MANIFEST_PATH } from "./registry";

export const MODEL_PACK_CACHE = "pf:model-packs";

export type ModelPackStatus = "absent" | "partial" | "ready";

export interface PackProgress {
  /** Bytes transferred so far across all files of the pack. */
  bytesDone: number;
  /** Total bytes when the server reported lengths for every file, else null. */
  totalBytes: number | null;
  /** Index (0-based) of the file currently streaming. */
  fileIndex: number;
  fileCount: number;
}

export interface PackDeps {
  fetchImpl?: typeof fetch;
  cacheStorage?: CacheStorage;
  digestImpl?: (algorithm: "SHA-256", data: ArrayBuffer) => Promise<ArrayBuffer>;
  /** Yield between files so long downloads never block the UI thread. */
  yieldImpl?: () => Promise<void>;
}

interface ResolvedDeps {
  fetchImpl: typeof fetch;
  cacheStorage: CacheStorage | undefined;
  digestImpl: ((algorithm: "SHA-256", data: ArrayBuffer) => Promise<ArrayBuffer>) | undefined;
  yieldImpl: () => Promise<void>;
}

function resolveDeps(deps: PackDeps = {}): ResolvedDeps {
  return {
    fetchImpl: deps.fetchImpl ?? ((input, init) => fetch(input, init)),
    cacheStorage: deps.cacheStorage ?? (typeof caches !== "undefined" ? caches : undefined),
    digestImpl:
      deps.digestImpl ??
      (typeof crypto !== "undefined" && crypto.subtle
        ? (algorithm, data) => crypto.subtle.digest(algorithm, data)
        : undefined),
    yieldImpl: deps.yieldImpl ?? (() => Promise.resolve()),
  };
}

/** Resolve any URL (root-absolute or absolute) to an absolute canonical form. */
function absoluteUrl(url: string): string {
  const base =
    (typeof self !== "undefined" && (self as { location?: Location }).location?.href) ||
    (typeof location !== "undefined" ? location.href : undefined) ||
    "http://kyx.local/";
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

/** Deploy-base-aware absolute URL a pack file occupies once installed (cache key). */
export function canonicalPackUrl(pack: ModelPack, packRelativePath: string): string {
  return absoluteUrl(assetUrl(`${pack.baseDir}/${packRelativePath}`));
}

async function openCache(deps: ResolvedDeps): Promise<Cache> {
  if (!deps.cacheStorage) {
    throw new Error("Cache Storage unavailable (private mode or unsupported context)");
  }
  return deps.cacheStorage.open(MODEL_PACK_CACHE);
}

async function sha256Hex(deps: ResolvedDeps, bytes: ArrayBuffer): Promise<string> {
  if (!deps.digestImpl) throw new Error("WebCrypto unavailable — cannot verify pack integrity");
  const digest = await deps.digestImpl("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Cache-first lookup used by loading paths. Returns a fresh Response clone
 * when the pack file is installed, null otherwise (caller falls back to the
 * network / origin static file — the dev-time behavior).
 */
export async function packFileResponse(
  pack: ModelPack,
  packRelativePath: string,
  deps: PackDeps = {},
): Promise<Response | null> {
  const resolved = resolveDeps(deps);
  if (!resolved.cacheStorage) return null;
  try {
    const cache = await openCache(resolved);
    const cached = await cache.match(canonicalPackUrl(pack, packRelativePath));
    return cached ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve an absolute request URL against installed packs (the worker-side
 * fetch shim helper): returns the cached Response when the URL is a file of
 * an installed pack, null otherwise.
 */
export async function installedPackResponseForUrl(
  url: string,
  packs: readonly ModelPack[],
  deps: PackDeps = {},
): Promise<Response | null> {
  for (const pack of packs) {
    const candidates = [...pack.files.map((file) => file.path), PACK_MANIFEST_PATH];
    for (const path of candidates) {
      if (canonicalPackUrl(pack, path) === url) {
        const hit = await packFileResponse(pack, path, deps);
        if (hit) return hit;
      }
    }
  }
  return null;
}

export async function packStatus(pack: ModelPack, deps: PackDeps = {}): Promise<ModelPackStatus> {
  const resolved = resolveDeps(deps);
  if (!resolved.cacheStorage) return "absent";
  try {
    const cache = await openCache(resolved);
    let present = 0;
    for (const file of pack.files) {
      if (await cache.match(canonicalPackUrl(pack, file.path))) present += 1;
    }
    if (await cache.match(canonicalPackUrl(pack, PACK_MANIFEST_PATH))) present += 1;
    const wanted = pack.files.length + 1; // + manifest
    if (present === 0) return "absent";
    return present === wanted ? "ready" : "partial";
  } catch {
    return "absent";
  }
}

export async function evictPack(pack: ModelPack, deps: PackDeps = {}): Promise<void> {
  const cache = await openCache(resolveDeps(deps));
  // Delete by exact canonical keys — the real Cache API normalizes stored
  // request URLs to absolute form, so a prefix scan on raw keys is brittle.
  const targets = [...pack.files.map((file) => file.path), PACK_MANIFEST_PATH];
  await Promise.all(targets.map((p) => cache.delete(canonicalPackUrl(pack, p))));
}

/**
 * Download and install a pack. Throws on network failure, cancellation
 * (AbortError) or hash mismatch; any failure evicts everything this call
 * wrote so a retry starts clean (no half-installed packs).
 */
export async function downloadPack(
  pack: ModelPack,
  options: { onProgress?: (progress: PackProgress) => void; signal?: AbortSignal } = {},
  deps: PackDeps = {},
): Promise<void> {
  const resolved = resolveDeps(deps);
  const { onProgress, signal } = options;
  const cache = await openCache(resolved);

  const report = (bytesDone: number, totalBytes: number | null, fileIndex: number) => {
    onProgress?.({ bytesDone, totalBytes, fileIndex, fileCount: pack.files.length });
  };

  // 1) Install our own manifest first — a deployment has no copy on origin.
  await cache.put(canonicalPackUrl(pack, PACK_MANIFEST_PATH), new Response(pack.manifestContent));
  report(0, null, 0);

  let bytesDone = 0;
  const contentLengths: (number | null)[] = [];

  try {
    for (let i = 0; i < pack.files.length; i++) {
      const file = pack.files[i];
      const response = await resolved.fetchImpl(file.sourceUrl, { signal });
      if (!response.ok) throw new Error(`${file.path}: HTTP ${response.status}`);
      const declared = response.headers.get("content-length");
      const parsed = declared !== null ? Number(declared) : NaN;
      contentLengths.push(Number.isFinite(parsed) ? parsed : null);

      const totalBytes = contentLengths.every((n) => n !== null)
        ? (contentLengths.reduce((a, b) => a! + b!, 0) as number)
        : null;

      // Stream for progress; hash verification needs the full buffer
      // anyway before a single byte is allowed into the cache.
      const chunks: Uint8Array[] = [];
      let fileBytes = 0;
      const reader = response.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          fileBytes += value.byteLength;
          bytesDone += value.byteLength;
          report(bytesDone, totalBytes, i);
        }
      } else {
        const buffer = await response.arrayBuffer();
        chunks.push(new Uint8Array(buffer));
        fileBytes = buffer.byteLength;
        bytesDone += fileBytes;
        report(bytesDone, totalBytes, i);
      }

      const assembled = new Uint8Array(fileBytes);
      let offset = 0;
      for (const chunk of chunks) {
        assembled.set(chunk, offset);
        offset += chunk.byteLength;
      }

      const expected = file.sha256.toLowerCase();
      const actual = await sha256Hex(resolved, assembled.buffer as ArrayBuffer);
      if (actual !== expected) {
        throw new Error(
          `${file.path}: integrity mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…) — download discarded`,
        );
      }

      await cache.put(canonicalPackUrl(pack, file.path), new Response(assembled.buffer as ArrayBuffer));
      await resolved.yieldImpl();
    }
  } catch (error) {
    // No partial state: evict everything belonging to this pack.
    await evictPack(pack, deps).catch(() => undefined);
    throw error;
  }
}
