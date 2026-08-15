import type { ProjectDocument } from "../project-model/types";
import { migrateProject, validateProjectShape } from "../project-model/schema";

const DB_NAME = "pulse-forge";
const DB_VERSION = 1;
const STORE_PROJECTS = "projects";
const STORE_META = "meta";
const KEY_RECENT = "recentProjectId";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) db.createObjectStore(STORE_PROJECTS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = run(transaction.objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export interface SavedProjectMeta {
  id: string;
  name: string;
  updatedAt: string;
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
