import { storeRevision, type RevisionSource } from "./revision";

/**
 * E10 (MUG-10) — the revision-keyed evidence cache.
 *
 * Every render-backed analyzer recomputes from scratch per call, so a
 * diagnose → fix → verify loop pays full render cost at every step and no
 * measurement can be referenced across turns. This module caches ANALYZER
 * OUTPUT (small metric envelopes, never audio buffers) keyed on
 *
 *     (family, projectId, docRevision, request identity)
 *
 * so the invalidation contract is structural: ANY document change bumps the
 * revision (ADR 0065), the key changes, the old entry can never be served.
 * A stale hit is not prevented by discipline — it is impossible by keying.
 *
 * Design constraints, each with its reason:
 *
 * - ONE cache per STORE (WeakMap keyed on the store object), not one global
 *   map keyed by project id: two stores can hold the same project at the
 *   same revision with different in-memory content (headless host vs live
 *   app, two tests). Keying by store makes cross-store contamination
 *   impossible and lets the cache die with its store.
 * - A store without a revision (Yjs-backed) DISABLES caching and computes
 *   every time — the same honesty rule `storeRevision` uses for staleness
 *   ("skips the rule rather than inventing a revision"). A revision is the
 *   invalidation contract; without one there is no contract.
 * - IN-FLIGHT COALESCING: concurrent identical calls share one compute
 *   promise, so N parallel agents do not render N times. A failed compute
 *   is evicted — a thrown render must never be served as evidence.
 * - LRU bound (64 envelopes): entries are small metric objects; the bound
 *   mirrors the stretch/warp cache policy and keeps memory flat on long
 *   agent sessions.
 * - The known (pre-existing, freshness-field-documented) race is unchanged:
 *   a mutation landing between doc capture and compute labels the result
 *   "stale" through the analyzer's own revision fields. This cache neither
 *   widens nor narrows that window; it only avoids REPEATING completed work.
 *
 * Cached values are returned BY REFERENCE on a hit. Every current consumer
 * formats or forwards them without mutation; a future consumer that wants
 * to edit an envelope must clone it first.
 */

export type EvidenceCacheMode = "hit" | "miss" | "disabled";

/**
 * The minimum a store must expose to take part in the revision-keyed cache:
 * a document (for the project id) and an optional revision (the invalidation
 * contract).
 *
 * Narrower than `ProjectStore | YDocStore` on purpose. The cache only READS
 * the store — it never mutates it — so a minimal structural double is a valid
 * participant. Typing the parameter as the whole store union forced the unit
 * tests to either fake 70+ unrelated members or cast the mismatch away, and a
 * cast is exactly how a real contract break hides from the compiler.
 */
export type EvidenceSource = RevisionSource;

interface CacheEntry {
  promise: Promise<unknown>;
}

const EVIDENCE_CACHE_LIMIT = 64;

const caches = new WeakMap<object, Map<string, CacheEntry>>();

/** Canonical request identity for a cache key (stable key order by construction). */
export function evidenceCacheKey(
  store: EvidenceSource,
  family: string,
  identity: Record<string, unknown>,
): string | null {
  const revision = storeRevision(store);
  if (revision === null) return null;
  const docId = store.getDoc().id;
  return JSON.stringify([family, docId, revision, identity]);
}

/**
 * Run `compute` under the revision-keyed cache. Returns the evidence plus
 * how it was obtained: "miss" (freshly computed), "hit" (served from this
 * revision's entry), or "disabled" (the store reports no revision — the
 * compute ran directly and nothing was stored).
 */
export async function cachedEvidence<T>(
  store: EvidenceSource,
  family: string,
  identity: Record<string, unknown>,
  compute: () => Promise<T>,
): Promise<{ data: T; cache: EvidenceCacheMode }> {
  const revision = storeRevision(store);
  if (revision === null) {
    return { data: await compute(), cache: "disabled" };
  }
  const docId = store.getDoc().id;
  const key = JSON.stringify([family, docId, revision, identity]);
  let cache = caches.get(store);
  if (!cache) {
    cache = new Map();
    caches.set(store, cache);
  }
  const existing = cache.get(key);
  if (existing) {
    // LRU refresh: re-insert so the entry reads as most-recently used.
    cache.delete(key);
    cache.set(key, existing);
    return { data: (await existing.promise) as T, cache: "hit" };
  }
  const entry: CacheEntry = { promise: compute() };
  cache.set(key, entry);
  while (cache.size > EVIDENCE_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  try {
    const data = (await entry.promise) as T;
    return { data, cache: "miss" };
  } catch (error) {
    // A failed compute is not evidence. Evict so the next call retries
    // instead of replaying the rejection forever.
    if (cache.get(key) === entry) cache.delete(key);
    throw error;
  }
}

/** Test/diagnostic hook: drop every cached envelope for one store. */
export function clearEvidenceCache(store: EvidenceSource): void {
  caches.delete(store);
}
