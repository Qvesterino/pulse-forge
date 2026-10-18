/**
 * Worklet asset versioning (deployment cache safety).
 *
 * `public/*-worklet.js` URLs are stable, so a CDN/HTTP cache (and a shell that
 * does not run the service worker) can mix an old bundle with a new app. The
 * build writes a SHA-256 manifest; the loader appends `?v=<hash>` to every
 * `addModule` URL. A missing manifest falls back to the unversioned URL, so a
 * dev/test run without the generator never breaks.
 */
import { assetUrl } from "../shared/assetUrls";

export interface WorkletManifest {
  version: 1;
  assets: Record<string, string>;
}

const HASH_RE = /^[a-f0-9]{8,64}$/;

export function parseWorkletManifest(raw: unknown): WorkletManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { version?: unknown; assets?: unknown };
  if (value.version !== 1 || !value.assets || typeof value.assets !== "object") return null;
  const assets: Record<string, string> = {};
  for (const [name, hash] of Object.entries(value.assets as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9._-]+-worklet\.js$/.test(name)) continue;
    if (typeof hash !== "string" || !HASH_RE.test(hash)) continue;
    assets[name] = hash;
  }
  return Object.keys(assets).length ? { version: 1, assets } : null;
}

export async function loadWorkletManifest(fetchImpl: typeof fetch = fetch): Promise<WorkletManifest | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetchImpl(assetUrl("/worklets-manifest.json"), {
      cache: "no-cache",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return parseWorkletManifest(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let manifestPromise: Promise<WorkletManifest | null> | null = null;

/** Fetch once per page; a failed fetch is cached as null (no retry storm). */
export function getWorkletManifest(fetchImpl: typeof fetch = fetch): Promise<WorkletManifest | null> {
  if (!manifestPromise) manifestPromise = loadWorkletManifest(fetchImpl);
  return manifestPromise;
}

/** Test seam: forget the memoized fetch. */
export function resetWorkletManifestForTests(): void {
  manifestPromise = null;
}

/**
 * Map a logical worklet path (`/core-worklet.js`) to its fetch URL. Hashes are
 * content-derived, so a changed bundle gets a new query and a new HTTP cache
 * entry; an unchanged bundle keeps the same URL.
 */
export function workletFileUrl(file: string, manifest: WorkletManifest | null): string {
  const path = assetUrl(file);
  const name = file.replace(/^\/+/, "");
  const hash = manifest?.assets[name];
  return hash ? `${path}?v=${hash}` : path;
}
