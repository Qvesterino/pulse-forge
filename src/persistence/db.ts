export const DB_NAME = "pulse-forge";
export const DB_VERSION = 5;
export const STORE_PROJECTS = "projects";
export const STORE_META = "meta";
export const STORE_PRESETS = "presets";
export const STORE_LIBRARY = "library";
export const STORE_USER_SAMPLES = "user-samples";
export const STORE_USER_SAMPLE_AUDIO = "user-sample-audio";

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) db.createObjectStore(STORE_PROJECTS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
      if (!db.objectStoreNames.contains(STORE_PRESETS)) db.createObjectStore(STORE_PRESETS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_LIBRARY)) db.createObjectStore(STORE_LIBRARY, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_USER_SAMPLES)) db.createObjectStore(STORE_USER_SAMPLES, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_USER_SAMPLE_AUDIO)) db.createObjectStore(STORE_USER_SAMPLE_AUDIO, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

export function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = run(transaction.objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
