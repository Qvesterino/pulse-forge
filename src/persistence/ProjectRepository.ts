import type { ProjectDocument } from "../project-model/types";
import { SCHEMA_VERSION, migrateProject, validateProjectShape } from "../project-model/schema";
import { uid } from "../shared/ids";
import { STORE_META, STORE_PROJECTS, openDb, tx } from "./db";

const KEY_RECENT = "recentProjectId";

export interface SavedProjectMeta {
  id: string;
  name: string;
  bpm: number;
  trackCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A project written by a NEWER app version: it exists in storage and must be
 * visible (it is the user's work), but it cannot be opened, renamed, or
 * duplicated until the app is updated. Deletion stays available.
 */
export interface IncompatibleProjectMeta {
  id: string;
  name: string;
  updatedAt: string;
  schemaVersion: number;
}

function metaOf(doc: ProjectDocument): SavedProjectMeta {
  return {
    id: doc.id,
    name: doc.name,
    bpm: doc.bpm,
    trackCount: doc.tracks.length,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export class ProjectRepository {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= openDb();
    return this.dbPromise;
  }

  async save(doc: ProjectDocument): Promise<void> {
    const db = await this.db();
    const stamped = { ...doc, updatedAt: new Date().toISOString() };
    // Atomic write: project body and "most recent" pointer must commit
    // together. Two separate transactions could leave a saved project
    // with a stale recent pointer if the page is closed (or the tab is
    // terminated on mobile) between the two writes — "Continue last
    // project" would then resume the wrong project on the next boot.
    await tx(db, [STORE_PROJECTS, STORE_META] as const, "readwrite", (stores) => {
      stores[STORE_PROJECTS].put(stamped) as IDBRequest<IDBValidKey>;
      return stores[STORE_META].put(doc.id, KEY_RECENT) as unknown as IDBRequest<undefined>;
    });
  }

  async load(id: string): Promise<ProjectDocument | null> {
    const db = await this.db();
    const result = await tx<ProjectDocument | undefined>(db, STORE_PROJECTS, "readonly", (store) => store.get(id));
    if (!result || !validateProjectShape(result)) return null;
    try {
      return migrateProject(result);
    } catch (err) {
      // Incompatible record (e.g. written by a newer app version). It must not
      // take down callers that merely wanted "this project or nothing".
      console.warn(`[repo] project ${id} could not be migrated:`, err);
      return null;
    }
  }

  /** Migrate one stored record; returns null instead of throwing on bad records. */
  private safeMigrate(doc: ProjectDocument): SavedProjectMeta | null {
    if (!validateProjectShape(doc)) return null;
    try {
      return metaOf(migrateProject(doc));
    } catch (err) {
      console.warn(`[repo] skipping unmigratable project ${doc.id}:`, err);
      return null;
    }
  }

  /** All saved projects as lightweight metadata, most recently updated first. */
  async listAll(): Promise<SavedProjectMeta[]> {
    const db = await this.db();
    const all = await tx<ProjectDocument[]>(db, STORE_PROJECTS, "readonly", (store) => store.getAll());
    // One poisoned record (corrupted row, future schema version from a newer
    // install) must never blank the whole library — skip it.
    return all
      .map((doc) => this.safeMigrate(doc))
      .filter((meta): meta is SavedProjectMeta => meta !== null)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  /**
   * Projects saved by a newer app version. They are skipped by listAll/load
   * (they cannot be migrated), but silently HIDING the user's own work makes
   * it look lost — the browser lists these with a "newer version" badge.
   */
  async listIncompatible(): Promise<IncompatibleProjectMeta[]> {
    const db = await this.db();
    const all = await tx<ProjectDocument[]>(db, STORE_PROJECTS, "readonly", (store) => store.getAll());
    return all
      .filter(
        (doc) =>
          validateProjectShape(doc) &&
          typeof doc.schemaVersion === "number" &&
          doc.schemaVersion > SCHEMA_VERSION,
      )
      .map((doc) => ({
        id: doc.id,
        name: typeof doc.name === "string" && doc.name.length > 0 ? doc.name : "Untitled project",
        updatedAt: typeof doc.updatedAt === "string" ? doc.updatedAt : new Date(0).toISOString(),
        schemaVersion: doc.schemaVersion as number,
      }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  /**
   * Frozen-buffer ids referenced by ANY stored project. The `frozen-audio`
   * store is shared across projects, so orphan GC must consider every
   * document — deleting by the open project's references alone destroys the
   * other projects' frozen audio irreversibly.
   */
  async referencedFrozenBufferIds(): Promise<Set<string>> {
    const db = await this.db();
    const all = await tx<ProjectDocument[]>(db, STORE_PROJECTS, "readonly", (store) => store.getAll());
    const ids = new Set<string>();
    for (const doc of all) {
      for (const track of Array.isArray(doc?.tracks) ? doc.tracks : []) {
        const frozen = (track as { frozen?: { bufferId?: unknown } }).frozen;
        if (frozen && typeof frozen.bufferId === "string") ids.add(frozen.bufferId);
      }
    }
    return ids;
  }

  async delete(id: string): Promise<void> {
    const db = await this.db();
    await tx(db, STORE_PROJECTS, "readwrite", (store) => store.delete(id) as unknown as IDBRequest<undefined>);
    const recentId = await tx<string | undefined>(db, STORE_META, "readonly", (store) => store.get(KEY_RECENT));
    if (recentId === id) {
      await tx(db, STORE_META, "readwrite", (store) => store.delete(KEY_RECENT) as unknown as IDBRequest<undefined>);
    }
  }

  /**
   * Rename a saved project in place. Returns the updated document, or null if
   * missing/invalid. Deliberately bypasses `save()` — a rename must not
   * repoint the global "most recent" resume pointer at whatever project
   * happened to be renamed (same contract as `duplicate`).
   */
  async rename(id: string, name: string): Promise<ProjectDocument | null> {
    const doc = await this.load(id);
    if (!doc) return null;
    const trimmed = name.trim();
    const next: ProjectDocument = {
      ...doc,
      name: trimmed.length > 0 ? trimmed : doc.name,
      updatedAt: new Date().toISOString(),
    };
    const db = await this.db();
    await tx(db, STORE_PROJECTS, "readwrite", (store) => store.put(next) as IDBRequest<IDBValidKey>);
    return next;
  }

  /**
   * Duplicate a saved project under a new id. The copy does not take over the
   * "most recent" pointer — the original stays the quick-resume project.
   */
  async duplicate(id: string): Promise<ProjectDocument | null> {
    const db = await this.db();
    const doc = await this.load(id);
    if (!doc) return null;
    const now = new Date().toISOString();
    const copy: ProjectDocument = {
      ...doc,
      id: uid("project"),
      name: `${doc.name} (copy)`,
      createdAt: now,
      updatedAt: now,
    };
    await tx(db, STORE_PROJECTS, "readwrite", (store) => store.put(copy) as IDBRequest<IDBValidKey>);
    return copy;
  }

  async loadMostRecent(): Promise<ProjectDocument | null> {
    const db = await this.db();
    const recentId = await tx<string | undefined>(db, STORE_META, "readonly", (store) => store.get(KEY_RECENT));
    if (recentId) {
      const doc = await this.load(recentId);
      if (doc) return doc;
    }
    const all = await tx<ProjectDocument[]>(db, STORE_PROJECTS, "readonly", (store) => store.getAll());
    // Most recent VALID project — bad records are skipped, not fatal.
    const sorted = all
      .filter(validateProjectShape)
      .sort((a, b) => ((a.updatedAt ?? "") < (b.updatedAt ?? "") ? 1 : -1));
    for (const candidate of sorted) {
      try {
        return migrateProject(candidate);
      } catch {
        // skip incompatible record
      }
    }
    return null;
  }
}
