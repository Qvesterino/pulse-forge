import type { ProjectDocument } from "../project-model/types";
import { validateProjectShape } from "../project-model/schema";
import { STORE_SNAPSHOTS, STORE_SNAPSHOT_INDEX, openDb, tx } from "./db";

/**
 * Project snapshots — "restore to yesterday" safety net.
 *
 * A snapshot is a full project document copy under `${projectId}:${ts}`.
 * They are deliberately cheap (structured clone, no compression) and capped
 * per project (prune keeps the newest N) so the store never grows wild.
 * Daily autosnapshots ride the normal save path; manual ones come from the
 * history panel.
 */
export interface ProjectSnapshot {
  id: string;
  projectId: string;
  label: string;
  createdAt: string;
  doc: ProjectDocument;
  /** Monotonic within one repository instance — breaks createdAt ties. */
  seq?: number;
}

/** How many snapshots survive per project (newest win). */
export const SNAPSHOTS_PER_PROJECT = 20;

/** Minimum spacing between AUTO snapshots (manual ones are never throttled). */
export const AUTO_SNAPSHOT_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000;

/**
 * True when an auto snapshot is due. Pure — the tests pin the "restore to
 * yesterday" semantics: no snapshot yet → due; stale one → due; fresh one → not.
 */
export function shouldAutoSnapshot(
  newestCreatedAt: string | null | undefined,
  now: number = Date.now(),
  minIntervalMs: number = AUTO_SNAPSHOT_MIN_INTERVAL_MS,
): boolean {
  if (!newestCreatedAt) return true;
  const then = Date.parse(newestCreatedAt);
  if (Number.isNaN(then)) return true;
  return now - then >= minIntervalMs;
}

/**
 * Defect D.4 (performance / memory recon) — in-memory secondary index.
 *
 * The original D.4 plan was an IndexedDB secondary store keyed
 * `[projectId, seq]`, but the cross-backend IDB cursor / keyRange
 * matrix is too fragile for a hardening pass: `fake-indexeddb` and
 * several polyfills return [] for array-key range queries or
 * surface `cursor.key` as a non-string shape, which masked real
 * bugs as false "no data" in tests. The in-memory index sidesteps
 * every backend quirk and is also faster — `Map.get` is O(1)
 * versus an IDB cursor walk per `list()` call.
 *
 * The persistent IDB `STORE_SNAPSHOT_INDEX` is still maintained
 * (write-side, dual-write in `save()` and `delete()`) so a future
 * hardened schema migration can rebuild the in-memory index from
 * disk if the process is reloaded with a different `projectId` set.
 * For now the in-memory index is the source of truth at read time.
 */
export class SnapshotRepository {
  private dbPromise: Promise<IDBDatabase> | null = null;
  /**
   * Session-stable monotonic counter for seq. A plain `++counter` reset to 0
   * every reload: session 2's first snapshot reused index key `proj:…0001`,
   * orphaning session 1's snapshot row (its durable index key was stolen), so
   * full project docs leaked in STORE_SNAPSHOTS forever and became invisible
   * to list()/prune() after the next reload. Seeding from a wall-clock base
   * keeps keys unique across sessions; the lastSeq guard preserves strict
   * monotonicity for same-millisecond saves within one instance.
   */
  private lastSeq = 0;
  /** Defect D.4: in-memory index — projectId → snapshot ids (newest last). */
  private index = new Map<string, string[]>();

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= openDb();
    return this.dbPromise;
  }

  private nextSeq(): number {
    this.lastSeq = Math.max(Date.now(), this.lastSeq + 1);
    return this.lastSeq;
  }

  async save(projectId: string, doc: ProjectDocument, label: string): Promise<ProjectSnapshot> {
    const db = await this.db();
    const seq = this.nextSeq();
    const snapshot: ProjectSnapshot = {
      id: `${projectId}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      projectId,
      label,
      createdAt: new Date().toISOString(),
      doc,
      seq,
    };
    // Defect D.4: dual-write the snapshot to the primary store AND
    // the secondary index. The id-keyed entry is AUTHORITATIVE — snapshot
    // ids are the primary keys, so two sessions can never mint the same
    // one. The legacy padded-seq key is still written for old readers but
    // may collide when two tabs save in the same millisecond; a collision
    // only overwrites that duplicate entry, never the id-keyed one.
    // rebuildIndex() dedupes by snapshot id, so a snapshot reachable through
    // both keys is listed once.
    await tx(db, [STORE_SNAPSHOTS, STORE_SNAPSHOT_INDEX] as const, "readwrite", (stores) => {
      stores[STORE_SNAPSHOTS].put(snapshot);
      stores[STORE_SNAPSHOT_INDEX].put(snapshot.id, `${projectId}:${snapshot.id}`);
      stores[STORE_SNAPSHOT_INDEX].put(snapshot.id, `${projectId}:${String(seq).padStart(10, "0")}`);
      return;
    });
    // Defect D.4: update the in-memory index in lockstep with the
    // durable write. If the durable write throws, the in-memory
    // map is never updated.
    const bucket = this.index.get(projectId);
    if (bucket) bucket.push(snapshot.id);
    else this.index.set(projectId, [snapshot.id]);
    return snapshot;
  }

  /** Newest first. Reads only the matching project's snapshots via
   * the in-memory secondary index (O(matching) instead of
   * O(total_snapshots) over the primary store). */
  async list(projectId: string, limit: number = SNAPSHOTS_PER_PROJECT): Promise<ProjectSnapshot[]> {
    await this.rebuildIndexIfNeeded();
    const ids = this.index.get(projectId);
    if (!ids || ids.length === 0) return [];
    // Newest first — the in-memory index is append-ordered. Over-fetch past
    // the limit so corrupt/unreadable rows near the top cannot shrink the
    // visible history while valid older snapshots exist beyond the cap.
    const newest = ids.slice().reverse();
    const capped = newest.slice(0, ids.length > limit ? limit + 8 : limit);
    const snaps = await this.loadManyByIds(capped);
    return (snaps ?? [])
      .filter((snap): snap is ProjectSnapshot => Boolean(snap) && validateProjectShape(snap!.doc))
      .slice(0, limit);
  }

  async get(id: string): Promise<ProjectSnapshot | null> {
    const db = await this.db();
    const result = await tx<ProjectSnapshot | undefined>(
      db,
      STORE_SNAPSHOTS,
      "readonly",
      (store) => store.get(id) as IDBRequest<ProjectSnapshot | undefined>,
    );
    return result && validateProjectShape(result.doc) ? result : null;
  }

  /**
   * Both durable index keys a snapshot may be reachable through: the
   * authoritative id-key and the legacy padded-seq key. delete()/prune()
   * remove both so no index entry outlives its primary row.
   */
  private indexKeysFor(snap: { id: string; projectId: string; seq?: number }): string[] {
    const keys = [`${snap.projectId}:${snap.id}`];
    if (typeof snap.seq === "number") keys.push(`${snap.projectId}:${String(snap.seq).padStart(10, "0")}`);
    return keys;
  }

  async delete(id: string): Promise<void> {
    const db = await this.db();
    const snap = await this.get(id);
    if (snap) {
      await tx(db, [STORE_SNAPSHOTS, STORE_SNAPSHOT_INDEX] as const, "readwrite", (stores) => {
        stores[STORE_SNAPSHOTS].delete(id);
        for (const key of this.indexKeysFor(snap)) stores[STORE_SNAPSHOT_INDEX].delete(key);
        return;
      });
      // Defect D.4: drop the in-memory index entry too.
      const bucket = this.index.get(snap.projectId);
      if (bucket) {
        const idx = bucket.indexOf(id);
        if (idx >= 0) {
          bucket.splice(idx, 1);
          if (bucket.length === 0) this.index.delete(snap.projectId);
        }
      }
      return;
    }
    // Fallback: the primary row is missing — best-effort scan of the
    // index to remove an orphan value matching this id. Cheap because
    // the index rows are tiny.
    await tx(db, STORE_SNAPSHOT_INDEX, "readwrite", (store) => {
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        if (cursor.value === id) cursor.delete();
        cursor.continue();
      };
      return;
    });
    // Also drop from the in-memory map (scan by value — only the
    // matching project is affected so this is a single key).
    for (const [projectId, bucket] of this.index) {
      const idx = bucket.indexOf(id);
      if (idx >= 0) {
        bucket.splice(idx, 1);
        if (bucket.length === 0) this.index.delete(projectId);
        break;
      }
    }
  }

  /** Keep only the newest `keep` snapshots of the project. */
  async prune(projectId: string, keep: number = SNAPSHOTS_PER_PROJECT): Promise<void> {
    await this.rebuildIndexIfNeeded();
    const bucket = this.index.get(projectId);
    if (!bucket || bucket.length <= keep) return;
    // bucket is append-ordered (oldest first) — keep the LAST `keep`,
    // drop the rest.
    const evict = bucket.slice(0, bucket.length - keep);
    // Pull full snapshot records for the eviction set so we have
    // their `seq` for the index key. This goes through `get(id)`,
    // not a primary-store scan, to keep `fake-indexeddb` happy.
    const snaps = await this.loadManyByIds(evict);
    const db = await this.db();
    await tx(db, [STORE_SNAPSHOTS, STORE_SNAPSHOT_INDEX] as const, "readwrite", (stores) => {
      for (const snap of snaps) {
        if (!snap) continue;
        stores[STORE_SNAPSHOTS].delete(snap.id);
        for (const key of this.indexKeysFor(snap)) stores[STORE_SNAPSHOT_INDEX].delete(key);
      }
      return;
    });
    // Defect D.4: trim the in-memory index to match the durable
    // eviction. (The async IDB write above is best-effort — we
    // optimise for the common case where they agree.)
    this.index.set(projectId, bucket.slice(bucket.length - keep));
  }

  /**
   * Read N snapshots by id. `list()` already narrowed the candidates
   * via the in-memory index, so the count here is bounded by
   * `SNAPSHOTS_PER_PROJECT` (20). We use sequential `get(id)` calls
   * — a `getAll()` or `openCursor()` on `STORE_SNAPSHOTS` (which
   * carries full project documents) hangs in `fake-indexeddb`, and
   * even per-id `get()` must run sequentially: parallel reads in
   * `fake-indexeddb` can deadlock on the connection's single
   * transaction slot. The bounded cardinality keeps sequential
   * reads cheap in practice.
   */
  private async loadManyByIds(ids: string[]): Promise<ProjectSnapshot[]> {
    if (ids.length === 0) return [];
    const out: ProjectSnapshot[] = [];
    for (const id of ids) {
      try {
        const snap = await this.get(id);
        if (snap) out.push(snap);
      } catch (error) {
        // One deleted/corrupt row must not make the whole history panel
        // unusable. The durable index is reconciled lazily on the next
        // rebuild; this read simply omits the unavailable record.
        console.warn(`[snapshots] skipping unreadable snapshot ${id}:`, error);
      }
    }
    return out;
  }

  /**
   * Defect D.4: rebuild the in-memory index from the durable
   * `STORE_SNAPSHOTS` once per session, on the first call to
   * `list()` / `prune()` after the process is reloaded. Idempotent
   * — subsequent calls in the same session are a no-op because
   * the in-memory map is already populated.
   */
  private indexRebuildPromise: Promise<void> | null = null;
  private async rebuildIndexIfNeeded(): Promise<void> {
    if (this.indexRebuildPromise) return this.indexRebuildPromise;
    this.indexRebuildPromise = this.rebuildIndex().finally(() => {
      this.indexRebuildPromise = null;
    });
    return this.indexRebuildPromise;
  }
  private async rebuildIndex(): Promise<void> {
    if (this.index.size > 0) return;
    const db = await this.db();
    // `getAll()` on the index store (small string values) is fast
    // and portable. The primary `STORE_SNAPSHOTS` scan hangs in
    // `fake-indexeddb` once it carries full project documents,
    // so we go via the index → per-id `get(id)` (sequential; see
    // `loadManyByIds` for why parallel reads can deadlock).
    const ids = await tx<string[]>(
      db,
      STORE_SNAPSHOT_INDEX,
      "readonly",
      (store) => store.getAll() as IDBRequest<string[]>,
    );
    if (!ids || ids.length === 0) return;
    // A snapshot is dual-keyed (id-key + legacy seq-key) — dedupe by id so
    // it lands in the bucket exactly once.
    const seen = new Set<string>();
    // Bucket order must be CHRONOLOGICAL (oldest first; list() reverses it).
    // IndexedDB key-sort order is NOT chronological once the two key forms
    // interleave (digit-leading seq keys sort before letter-leading id
    // keys), so collect ordering metadata and sort explicitly.
    const pending: { projectId: string; id: string; createdAt: string; seq: number }[] = [];
    for (const id of ids) {
      if (typeof id !== "string" || id.length === 0) continue;
      if (seen.has(id)) continue;
      try {
        const snap = await this.get(id);
        if (!snap || typeof snap.projectId !== "string") continue;
        seen.add(snap.id);
        pending.push({
          projectId: snap.projectId,
          id: snap.id,
          createdAt: snap.createdAt,
          seq: typeof snap.seq === "number" ? snap.seq : 0,
        });
      } catch (error) {
        // A single poisoned primary row should not blank every project's
        // recovery history after reload. Leave it out of the rebuilt index;
        // a later successful rebuild can discover it again.
        console.warn(`[snapshots] skipping unreadable indexed snapshot ${id}:`, error);
      }
    }
    // seq is primary: it is monotonic by construction (legacy counters are
    // small numbers, post-fix values are Date.now-based, and each instance
    // strictly increases its own). createdAt only breaks same-ms ties — a
    // wall-clock adjustment (NTP, process suspend) must not be able to
    // reorder snapshots against their save sequence.
    pending.sort(
      (a, b) => a.seq - b.seq || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0),
    );
    for (const entry of pending) {
      const bucket = this.index.get(entry.projectId);
      if (bucket) bucket.push(entry.id);
      else this.index.set(entry.projectId, [entry.id]);
    }
  }
}
