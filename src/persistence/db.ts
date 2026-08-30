export const DB_NAME = "pulse-forge";
export const DB_VERSION = 6;
export const STORE_PROJECTS = "projects";
export const STORE_META = "meta";
export const STORE_PRESETS = "presets";
export const STORE_LIBRARY = "library";
export const STORE_USER_SAMPLES = "user-samples";
export const STORE_USER_SAMPLE_AUDIO = "user-sample-audio";
export const STORE_FROZEN_AUDIO = "frozen-audio";

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const attempt = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) db.createObjectStore(STORE_PROJECTS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
      if (!db.objectStoreNames.contains(STORE_PRESETS)) db.createObjectStore(STORE_PRESETS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_LIBRARY)) db.createObjectStore(STORE_LIBRARY, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_USER_SAMPLES))
        db.createObjectStore(STORE_USER_SAMPLES, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_USER_SAMPLE_AUDIO))
        db.createObjectStore(STORE_USER_SAMPLE_AUDIO, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_FROZEN_AUDIO))
        db.createObjectStore(STORE_FROZEN_AUDIO, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  dbPromise = attempt;
  // Do not cache a rejection: a transient open failure (version-change race,
  // synchronous throw, private-browsing quirks) must not permanently poison
  // every future repository call with the same stale error.
  attempt.catch(() => {
    if (dbPromise === attempt) dbPromise = null;
  });
  return dbPromise;
}

export function tx<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      reject(err ?? new Error(`IndexedDB transaction on "${store}" was aborted`));
    };
    const succeed = (value: T): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(store, mode);
    } catch (err) {
      fail(err);
      return;
    }
    let request: IDBRequest<T>;
    try {
      request = run(transaction.objectStore(store));
    } catch (err) {
      fail(err);
      return;
    }
    // A request's `success` fires BEFORE the commit — resolving there would
    // report saves that were later rolled back (quota pressure, abort during
    // page close). Only `transaction.oncomplete` proves durability.
    request.onsuccess = () => {
      /* wait for commit */
    };
    request.onerror = () => fail(request.error);
    transaction.onabort = () => fail(request.error ?? transaction.error);
    transaction.onerror = () => fail(transaction.error ?? request.error);
    transaction.oncomplete = () => succeed(request.result);
  });
}
