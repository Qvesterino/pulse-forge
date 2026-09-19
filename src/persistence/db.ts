export const DB_NAME = "pulse-forge";
export const DB_VERSION = 11;
export const STORE_PROJECTS = "projects";
export const STORE_META = "meta";
export const STORE_PRESETS = "presets";
export const STORE_LIBRARY = "library";
export const STORE_USER_SAMPLES = "user-samples";
export const STORE_USER_SAMPLE_AUDIO = "user-sample-audio";
export const STORE_RECORDING_SESSIONS = "recording-sessions";
export const STORE_RECORDING_CHUNKS = "recording-chunks";
export const STORE_FROZEN_AUDIO = "frozen-audio";
export const STORE_USER_KITS = "user-kits";
export const STORE_GROOVE_POOL = "groove-pool";
export const STORE_SNAPSHOTS = "project-snapshots";
/**
 * Defect D.4 (performance / memory recon): secondary index for
 * `STORE_SNAPSHOTS` so `SnapshotRepository.list(projectId)` and
 * `prune(projectId)` do not have to `getAll()` every snapshot of
 * every project on every call. The store holds out-of-line keys
 * shaped `[projectId, seq]` (lexicographic ordering matches
 * "all of one project, ordered by seq"), with the value being the
 * snapshot id (foreign key into `STORE_SNAPSHOTS`).
 */
export const STORE_SNAPSHOT_INDEX = "project-snapshot-index";
export const STORE_ULTINA_PRESETS = "ultina-presets";

let dbPromise: Promise<IDBDatabase> | null = null;

/** How long to wait on a blocked open (another tab holds an old version). */
const OPEN_BLOCKED_TIMEOUT_MS = 5000;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const attempt = new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
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
      if (!db.objectStoreNames.contains(STORE_RECORDING_SESSIONS))
        db.createObjectStore(STORE_RECORDING_SESSIONS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_RECORDING_CHUNKS)) {
        const chunks = db.createObjectStore(STORE_RECORDING_CHUNKS, { keyPath: ["sessionId", "sequence"] });
        chunks.createIndex("by-session", "sessionId", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_FROZEN_AUDIO))
        db.createObjectStore(STORE_FROZEN_AUDIO, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_USER_KITS)) db.createObjectStore(STORE_USER_KITS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_GROOVE_POOL)) db.createObjectStore(STORE_GROOVE_POOL, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) db.createObjectStore(STORE_SNAPSHOTS, { keyPath: "id" });
      // D.4: out-of-line keys, no keyPath. `tx(db, STORE_SNAPSHOT_INDEX, ...)`
      // uses `store.put(id, [projectId, seq])`.
      if (!db.objectStoreNames.contains(STORE_SNAPSHOT_INDEX)) db.createObjectStore(STORE_SNAPSHOT_INDEX);
      if (!db.objectStoreNames.contains(STORE_ULTINA_PRESETS))
        db.createObjectStore(STORE_ULTINA_PRESETS, { keyPath: "id" });
    };
    // Another tab still holds an older DB version — the open stays pending
    // until that tab closes. Fail with an actionable message instead of
    // hanging forever, and let the rejection-reset below allow a retry.
    request.onblocked = () => {
      setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Database is locked by another KYX tab — close it and try again"));
      }, OPEN_BLOCKED_TIMEOUT_MS);
    };
    request.onsuccess = () => {
      if (settled) return;
      settled = true;
      // If yet another tab requests a future version, yield our connection
      // immediately — otherwise WE become the blocker for everyone else.
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error);
    };
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
  run: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T>;
export function tx<T>(
  db: IDBDatabase,
  stores: readonly string[],
  mode: IDBTransactionMode,
  run: (stores: Record<string, IDBObjectStore>) => IDBRequest<T> | void,
): Promise<T>;
export function tx<T>(
  db: IDBDatabase,
  storeOrStores: string | readonly string[],
  mode: IDBTransactionMode,
  // The implementation accepts both single-store and multi-store call
  // shapes; the public overloads pin the precise type at the call site.
  // Using `any` here is safe because we hand the callback a value
  // whose shape exactly matches the selected overload. A `void`
  // return is allowed for multi-put transactions — we wait on
  // `transaction.oncomplete` instead of a specific request.
  run: (arg: any) => IDBRequest<T> | void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      reject(err ?? new Error(`IndexedDB transaction was aborted`));
    };
    const succeed = (value: T): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let transaction: IDBTransaction;
    try {
      const scope: string | string[] = Array.isArray(storeOrStores) ? [...storeOrStores] : (storeOrStores as string);
      transaction = db.transaction(scope, mode);
    } catch (err) {
      fail(err);
      return;
    }
    let arg: IDBObjectStore | Record<string, IDBObjectStore>;
    if (Array.isArray(storeOrStores)) {
      const map: Record<string, IDBObjectStore> = {};
      for (const s of storeOrStores) map[s] = transaction.objectStore(s);
      arg = map;
    } else {
      arg = transaction.objectStore(storeOrStores as string);
    }
    const result = run(arg);
    // A request's `success` fires BEFORE the commit — resolving there would
    // report saves that were later rolled back (quota pressure, abort during
    // page close). Only `transaction.oncomplete` proves durability.
    //
    // The callback may legitimately return `null`/`undefined` for multi-store
    // transactions (the caller issues several `put`s and only needs the
    // commit signal). We only attach `onsuccess`/`onerror` when an actual
    // request object is returned; otherwise we wait on the transaction
    // directly.
    if (result != null) {
      const request = result as IDBRequest<T>;
      request.onsuccess = () => {
        /* wait for commit */
      };
      request.onerror = () => fail(request.error);
      transaction.onabort = () => fail(request.error ?? transaction.error);
      transaction.onerror = () => fail(transaction.error ?? request.error);
      transaction.oncomplete = () => succeed(request.result);
    } else {
      transaction.onabort = () => fail(transaction.error);
      transaction.onerror = () => fail(transaction.error);
      transaction.oncomplete = () => succeed(undefined as unknown as T);
    }
  });
}
