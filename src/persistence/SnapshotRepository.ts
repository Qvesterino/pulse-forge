import type { ProjectDocument } from "../project-model/types";
import { validateProjectShape } from "../project-model/schema";
import { STORE_SNAPSHOTS, openDb, tx } from "./db";

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

export class SnapshotRepository {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private counter = 0;

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= openDb();
    return this.dbPromise;
  }

  async save(projectId: string, doc: ProjectDocument, label: string): Promise<ProjectSnapshot> {
    const db = await this.db();
    const snapshot: ProjectSnapshot = {
      id: `${projectId}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      projectId,
      label,
      createdAt: new Date().toISOString(),
      doc,
      seq: ++this.counter,
    };
    await tx(db, STORE_SNAPSHOTS, "readwrite", (store) => store.put(snapshot) as IDBRequest<IDBValidKey>);
    return snapshot;
  }

  /** Newest first. Corrupt entries (wrong shape) are skipped, not thrown. */
  async list(projectId: string, limit: number = SNAPSHOTS_PER_PROJECT): Promise<ProjectSnapshot[]> {
    const db = await this.db();
    const all = await tx<ProjectSnapshot[]>(db, STORE_SNAPSHOTS, "readonly", (store) =>
      store.getAll() as IDBRequest<ProjectSnapshot[]>,
    );
    return (all ?? [])
      .filter((snap) => snap?.projectId === projectId && validateProjectShape(snap.doc))
      .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0) || (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  async get(id: string): Promise<ProjectSnapshot | null> {
    const db = await this.db();
    const result = await tx<ProjectSnapshot | undefined>(db, STORE_SNAPSHOTS, "readonly", (store) =>
      store.get(id) as IDBRequest<ProjectSnapshot | undefined>,
    );
    return result && validateProjectShape(result.doc) ? result : null;
  }

  async delete(id: string): Promise<void> {
    const db = await this.db();
    await tx(db, STORE_SNAPSHOTS, "readwrite", (store) => store.delete(id) as unknown as IDBRequest<undefined>);
  }

  /** Keep only the newest `keep` snapshots of the project. */
  async prune(projectId: string, keep: number = SNAPSHOTS_PER_PROJECT): Promise<void> {
    const newest = await this.list(projectId, Number.MAX_SAFE_INTEGER);
    for (const stale of newest.slice(keep)) await this.delete(stale.id);
  }
}
