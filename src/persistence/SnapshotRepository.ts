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
  private counter = 0;
  /** Defect D.4: in-memory index — projectId → snapshot ids (newest last). */
  private index = new Map<string, string[]>();

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= openDb();
    return this.dbPromise;
  }

  async save(projectId: string, doc: ProjectDocument, label: string): Promise<ProjectSnapshot> {
    const db = await this.db();
    const seq = ++this.counter;
    const snapshot: ProjectSnapshot = {
      id: `${projectId}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      projectId,
      label,
      createdAt: new Date().toISOString(),
      doc,
      seq,
    };
    // Defect D.4: dual-write the snapshot to the primary store AND
    // the secondary index. The index is the source of truth for
    // list() / prune() / delete() in this implementation; the IDB
    // copy is only consulted by rebuildIndex() (post-restart).
    await tx(db, [STORE_SNAPSHOTS, STORE_SNAPSHOT_INDEX] as const, "readwrite", (stores) => {
      stores[STORE_SNAPSHOTS].put(snapshot);
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
    // Newest first — the in-memory index is append-ordered.
    const newest = ids.slice().reverse();
    const capped = newest.slice(0, limit);
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

  async delete(id: string): Promise<void> {
    const db = await this.db();
    const snap = await this.get(id);
    if (snap && typeof snap.seq === "number") {
      const key = `${snap.projectId}:${String(snap.seq).padStart(10, "0")}`;
      await tx(db, [STORE_SNAPSHOTS, STORE_SNAPSHOT_INDEX] as const, "readwrite", (stores) => {
        stores[STORE_SNAPSHOTS].delete(id);
        stores[STORE_SNAPSHOT_INDEX].delete(key);
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
        if (!snap || typeof snap.seq !== "number") continue;
        stores[STORE_SNAPSHOTS].delete(snap.id);
        stores[STORE_SNAPSHOT_INDEX].delete(`${snap.projectId}:${String(snap.seq).padStart(10, "0")}`);
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
    for (const id of ids) {
      if (typeof id !== "string" || id.length === 0) continue;
      try {
        const snap = await this.get(id);
        if (!snap || typeof snap.projectId !== "string") continue;
        const bucket = this.index.get(snap.projectId);
        if (bucket) bucket.push(snap.id);
        else this.index.set(snap.projectId, [snap.id]);
      } catch (error) {
        // A single poisoned primary row should not blank every project's
        // recovery history after reload. Leave it out of the rebuilt index;
        // a later successful rebuild can discover it again.
        console.warn(`[snapshots] skipping unreadable indexed snapshot ${id}:`, error);
      }
    }
  }
}
