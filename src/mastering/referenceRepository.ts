/**
 * Local-only mastering references. This database is separate from project
 * documents and the shared project schema, so reference audio cannot enter a
 * project, collab session, undo history, or export by accident.
 */

export const MASTERING_REFERENCE_DB = "kyx-mastering-reference";
export const MASTERING_REFERENCE_STORE = "references";

export interface MasteringReferenceRecord {
  projectId: string;
  fileName: string;
  mimeType: string;
  byteLength: number;
  importedAt: string;
  source: Blob;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable."));
  if (dbPromise) return dbPromise;
  const attempt = new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(MASTERING_REFERENCE_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MASTERING_REFERENCE_STORE)) {
        db.createObjectStore(MASTERING_REFERENCE_STORE, { keyPath: "projectId" });
      }
    };
    request.onblocked = () => {
      setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("The local reference database is locked by another KYX tab. Close that tab and retry."));
      }, 5000);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("Could not open the local reference database."));
    };
  });
  dbPromise = attempt;
  attempt.catch(() => {
    if (dbPromise === attempt) dbPromise = null;
  });
  return attempt;
}

function isRecord(value: unknown, projectId: string): value is MasteringReferenceRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MasteringReferenceRecord>;
  const source = candidate.source as
    (Pick<Blob, "size" | "type" | "arrayBuffer" | "slice" | "stream"> & { [key: string]: unknown }) | null | undefined;
  const sourceLooksLikeBlob =
    typeof source === "object" &&
    source !== null &&
    Number.isSafeInteger(source.size) &&
    typeof source.type === "string" &&
    typeof source.arrayBuffer === "function" &&
    typeof source.slice === "function" &&
    typeof source.stream === "function";
  return (
    candidate.projectId === projectId &&
    typeof candidate.fileName === "string" &&
    typeof candidate.mimeType === "string" &&
    Number.isSafeInteger(candidate.byteLength) &&
    typeof candidate.importedAt === "string" &&
    typeof Blob !== "undefined" &&
    sourceLooksLikeBlob &&
    source.size === candidate.byteLength
  );
}

function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let transaction: IDBTransaction;
        try {
          transaction = db.transaction(MASTERING_REFERENCE_STORE, mode);
        } catch (error) {
          reject(error);
          return;
        }
        const store = transaction.objectStore(MASTERING_REFERENCE_STORE);
        let result: T | undefined;
        try {
          const request = run(store);
          if (request) {
            request.onsuccess = () => {
              result = request.result;
            };
            request.onerror = () => reject(request.error ?? new Error("Reference database request failed."));
          }
        } catch (error) {
          try {
            transaction.abort();
          } catch {
            /* already finished */
          }
          reject(error);
          return;
        }
        transaction.oncomplete = () => resolve(result as T);
        transaction.onabort = () => reject(transaction.error ?? new Error("Reference database transaction aborted."));
        transaction.onerror = () => reject(transaction.error ?? new Error("Reference database transaction failed."));
      }),
  );
}

export class MasteringReferenceRepository {
  async get(projectId: string): Promise<MasteringReferenceRecord | null> {
    const value = await transact<unknown>("readonly", (store) => store.get(projectId));
    if (value == null) return null;
    if (!isRecord(value, projectId)) throw new Error("The saved mastering reference record is invalid.");
    return value;
  }

  async put(record: MasteringReferenceRecord): Promise<void> {
    await transact<IDBValidKey>("readwrite", (store) => store.put(record));
  }

  async delete(projectId: string): Promise<void> {
    await transact<undefined>("readwrite", (store) => store.delete(projectId));
  }
}
