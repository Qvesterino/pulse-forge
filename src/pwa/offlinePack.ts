/**
 * Optional offline audio packs (ADR 0051 mobile install diet).
 *
 * The PWA install precaches only the app shell. Curated WAVs are fetched on
 * first use through the `kyx-samples` runtime cache. This module lets the user
 * explicitly prefill the SAME cache for a whole pack when they want offline
 * audio, with progress and per-file failure accounting instead of one giant
 * `cache.addAll`.
 */
import { assetUrl } from "../shared/assetUrls";

export const OFFLINE_SAMPLE_CACHE = "kyx-samples";

export interface OfflinePackFile {
  url: string;
  bytes: number;
}

export interface OfflinePack {
  id: string;
  label: string;
  bytes: number;
  files: OfflinePackFile[];
}

export interface OfflinePackManifest {
  version: 1;
  packs: OfflinePack[];
}

export interface OfflinePackProgress {
  completed: number;
  total: number;
  downloadedBytes: number;
  downloaded: number;
  skipped: number;
  failed: number;
}

export interface OfflinePackResult extends OfflinePackProgress {
  aborted: boolean;
}

export interface OfflinePackDeps {
  fetchImpl?: typeof fetch;
  cachesImpl?: CacheStorage;
  concurrency?: number;
}

const SAMPLE_URL_RE = /^\/samples\/[A-Za-z0-9._/-]+$/;

function finiteBytes(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/** Defensive parse of the generated manifest (it is served JSON, still data). */
export function parseOfflinePackManifest(raw: unknown): OfflinePackManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { version?: unknown; packs?: unknown };
  if (value.version !== 1 || !Array.isArray(value.packs)) return null;
  const packs: OfflinePack[] = [];
  for (const candidate of value.packs) {
    if (!candidate || typeof candidate !== "object") continue;
    const pack = candidate as { id?: unknown; label?: unknown; bytes?: unknown; files?: unknown };
    if (typeof pack.id !== "string" || !pack.id || typeof pack.label !== "string") continue;
    if (!Array.isArray(pack.files)) continue;
    const files: OfflinePackFile[] = [];
    for (const fileCandidate of pack.files) {
      if (!fileCandidate || typeof fileCandidate !== "object") continue;
      const file = fileCandidate as { url?: unknown; bytes?: unknown };
      if (typeof file.url !== "string" || !SAMPLE_URL_RE.test(file.url) || file.url.includes("..")) continue;
      const bytes = finiteBytes(file.bytes);
      if (bytes === null) continue;
      files.push({ url: file.url, bytes });
    }
    if (!files.length) continue;
    const bytes = finiteBytes(pack.bytes) ?? files.reduce((sum, file) => sum + file.bytes, 0);
    packs.push({ id: pack.id, label: pack.label, bytes, files });
  }
  return packs.length ? { version: 1, packs } : null;
}

export async function loadOfflinePackManifest(fetchImpl: typeof fetch = fetch): Promise<OfflinePackManifest | null> {
  try {
    const response = await fetchImpl(assetUrl("/samples/offline-pack.json"), { cache: "no-cache" });
    if (!response.ok) return null;
    return parseOfflinePackManifest(await response.json());
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Prefill the runtime sample cache for one pack. Cached files are skipped, so
 * a repeated action only fills gaps. A failed file increments `failed` and the
 * worker continues; the caller can retry the same pack.
 */
export async function downloadOfflinePack(
  pack: OfflinePack,
  options: {
    onProgress?: (progress: OfflinePackProgress) => void;
    signal?: AbortSignal;
    deps?: OfflinePackDeps;
  } = {},
): Promise<OfflinePackResult> {
  const fetchImpl = options.deps?.fetchImpl ?? fetch;
  const cacheStorage = options.deps?.cachesImpl ?? (typeof caches === "undefined" ? undefined : caches);
  if (!cacheStorage) throw new Error("This browser does not expose the Cache Storage API.");
  const cache = await cacheStorage.open(OFFLINE_SAMPLE_CACHE);
  const total = pack.files.length;
  const concurrency = Math.max(1, Math.min(options.deps?.concurrency ?? 6, total || 1));
  let next = 0;
  let completed = 0;
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  let downloadedBytes = 0;
  let aborted = false;

  const report = () => options.onProgress?.({ completed, total, downloadedBytes, downloaded, skipped, failed });

  const worker = async () => {
    while (true) {
      if (options.signal?.aborted) {
        aborted = true;
        return;
      }
      const index = next++;
      if (index >= total) return;
      const file = pack.files[index];
      const url = assetUrl(file.url);
      try {
        const existing = await cache.match(url);
        if (existing) {
          skipped += 1;
          downloadedBytes += file.bytes;
        } else {
          const response = await fetchImpl(url, { signal: options.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          await cache.put(url, response.clone());
          downloaded += 1;
          const length = Number(response.headers.get("content-length"));
          downloadedBytes += Number.isFinite(length) && length > 0 ? length : file.bytes;
        }
      } catch {
        if (options.signal?.aborted) {
          aborted = true;
          return;
        }
        failed += 1;
      }
      completed += 1;
      report();
    }
  };

  report();
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { completed, total, downloadedBytes, downloaded, skipped, failed, aborted };
}
