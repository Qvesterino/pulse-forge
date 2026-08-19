import type { ProjectDocument } from "../project-model/types";
import { migrateProject, validateProjectShape } from "../project-model/schema";
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
    await tx(db, STORE_PROJECTS, "readwrite", (store) => store.put(stamped) as IDBRequest<IDBValidKey>);
    await tx(db, STORE_META, "readwrite", (store) => store.put(doc.id, KEY_RECENT) as unknown as IDBRequest<undefined>);
  }

  async load(id: string): Promise<ProjectDocument | null> {
    const db = await this.db();
    const result = await tx<ProjectDocument | undefined>(db, STORE_PROJECTS, "readonly", (store) => store.get(id));
    if (!result || !validateProjectShape(result)) return null;
    return migrateProject(result);
  }

  /** All saved projects as lightweight metadata, most recently updated first. */
  async listAll(): Promise<SavedProjectMeta[]> {
    const db = await this.db();
    const all = await tx<ProjectDocument[]>(db, STORE_PROJECTS, "readonly", (store) => store.getAll());
    return all
      .filter(validateProjectShape)
      .map((doc) => migrateProject(doc))
      .map(metaOf)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  async delete(id: string): Promise<void> {
    const db = await this.db();
    await tx(db, STORE_PROJECTS, "readwrite", (store) => store.delete(id) as unknown as IDBRequest<undefined>);
    const recentId = await tx<string | undefined>(db, STORE_META, "readonly", (store) => store.get(KEY_RECENT));
    if (recentId === id) {
      await tx(db, STORE_META, "readwrite", (store) => store.delete(KEY_RECENT) as unknown as IDBRequest<undefined>);
    }
  }

  /** Rename a saved project in place. Returns the updated document, or null if missing/invalid. */
  async rename(id: string, name: string): Promise<ProjectDocument | null> {
    const doc = await this.load(id);
    if (!doc) return null;
    const trimmed = name.trim();
    const next = { ...doc, name: trimmed.length > 0 ? trimmed : doc.name };
    await this.save(next);
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
    if (all.length === 0) return null;
    const sorted = all
      .filter(validateProjectShape)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return sorted.length > 0 ? migrateProject(sorted[0]) : null;
  }
}
