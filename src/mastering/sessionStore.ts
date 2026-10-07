import { createProjectFromTemplate } from "../project-model/templates";
import { normalizeProject } from "../project-model/schema";
import type { MasterConfig } from "../project-model/types";
import { uid } from "../shared/ids";

export const MASTERING_SESSION_DATABASE = "kyx-mastering-sessions";
export const MASTERING_SESSION_STORE = "sessions";
export const MASTERING_SESSION_SOURCE_STORE = "sources";
export const MASTERING_SESSION_REFERENCE_STORE = "references";
export const MASTERING_SESSION_DATABASE_VERSION = 3;
export const MASTERING_SESSION_SCHEMA_VERSION = 2;
export const MASTERING_SESSION_FILE_LIMIT_BYTES = 96 * 1024 * 1024;
export const MASTERING_SESSION_HISTORY_LIMIT = 50;

export interface MasteringSessionRecord {
  version: 2;
  id: string;
  fileName: string;
  mimeType: string;
  byteLength: number;
  source: Blob;
  sourceHash: string;
  durationSeconds: number;
  channels: 1 | 2;
  sourceSampleRate: number;
  masterConfig: MasterConfig;
  snapshots: MasteringSessionSnapshots;
  /** Optional additive revision label; old session records default to an empty string. */
  deliveryVersion?: string;
  /** Increments on edits and undo/redo so render reports can detect stale state. */
  configRevision: number;
  undoStack: MasterConfig[];
  redoStack: MasterConfig[];
  createdAt: string;
  updatedAt: string;
}

export type MasteringSessionSlot = "A" | "B";

export interface MasteringSessionSnapshot {
  id: string;
  name: string;
  capturedAt: string;
  masterConfig: MasterConfig;
}

export type MasteringSessionSnapshots = Record<MasteringSessionSlot, MasteringSessionSnapshot | null>;

export type MasteringSessionSummary = Omit<MasteringSessionRecord, "source">;

export interface MasteringSessionReferenceRecord {
  sessionId: string;
  fileName: string;
  mimeType: string;
  byteLength: number;
  source: Blob;
  sourceHash: string;
  durationSeconds: number;
  channels: 1 | 2;
  sampleRate: number;
  importedAt: string;
}

function isMasteringSessionReference(value: unknown): value is MasteringSessionReferenceRecord {
  if (!isObject(value)) return false;
  const source = value.source;
  return (
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    value.sessionId.length <= 160 &&
    typeof value.fileName === "string" &&
    value.fileName.length > 0 &&
    value.fileName.length <= 255 &&
    typeof value.mimeType === "string" &&
    value.mimeType.length <= 120 &&
    Number.isSafeInteger(value.byteLength) &&
    (value.byteLength as number) > 0 &&
    (value.byteLength as number) <= MASTERING_SESSION_FILE_LIMIT_BYTES &&
    isBlobLike(source) &&
    source.size === value.byteLength &&
    typeof value.sourceHash === "string" &&
    /^[a-f0-9]{64}$/i.test(value.sourceHash) &&
    typeof value.durationSeconds === "number" &&
    Number.isFinite(value.durationSeconds) &&
    value.durationSeconds >= 0.8 &&
    value.durationSeconds <= 12 * 60 &&
    (value.channels === 1 || value.channels === 2) &&
    typeof value.sampleRate === "number" &&
    Number.isInteger(value.sampleRate) &&
    value.sampleRate >= 8000 &&
    value.sampleRate <= 192000 &&
    typeof value.importedAt === "string" &&
    Number.isFinite(Date.parse(value.importedAt))
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBlobLike(value: unknown): value is Blob {
  if (typeof Blob === "undefined" || !isObject(value)) return false;
  const candidate = value as Partial<Blob>;
  const tag = Object.prototype.toString.call(value);
  return (
    (value instanceof Blob || tag === "[object Blob]" || tag === "[object File]") &&
    Number.isSafeInteger(candidate.size) &&
    (candidate.size as number) >= 0 &&
    typeof candidate.type === "string" &&
    typeof candidate.arrayBuffer === "function" &&
    typeof candidate.slice === "function"
  );
}

export function cloneSessionMasterConfig(config: MasterConfig): MasterConfig {
  return JSON.parse(JSON.stringify(config)) as MasterConfig;
}

function normalizeSessionMasterConfig(value: unknown): MasterConfig | null {
  if (!isObject(value)) return null;
  try {
    const base = createProjectFromTemplate("empty");
    const normalized = normalizeProject({ ...base, master: value as unknown as MasterConfig });
    if (!Number.isFinite(normalized.master.masterGain) || !Number.isFinite(normalized.master.ceilingDb)) return null;
    return cloneSessionMasterConfig(normalized.master);
  } catch {
    return null;
  }
}

function normalizeSessionSnapshots(value: unknown): MasteringSessionSnapshots | null {
  if (!isObject(value)) return null;
  const result: MasteringSessionSnapshots = { A: null, B: null };
  for (const slot of ["A", "B"] as const) {
    const raw = value[slot];
    if (raw == null) continue;
    if (!isObject(raw)) return null;
    const config = normalizeSessionMasterConfig(raw.masterConfig);
    if (
      !config ||
      typeof raw.id !== "string" ||
      raw.id.length === 0 ||
      raw.id.length > 160 ||
      typeof raw.name !== "string" ||
      raw.name.trim().length === 0 ||
      raw.name.length > 64 ||
      typeof raw.capturedAt !== "string" ||
      !Number.isFinite(Date.parse(raw.capturedAt))
    ) {
      return null;
    }
    result[slot] = {
      id: raw.id,
      name: raw.name.trim(),
      capturedAt: raw.capturedAt,
      masterConfig: config,
    };
  }
  return result;
}

function isMasteringSessionSummary(value: unknown): value is MasteringSessionSummary {
  if (!isObject(value)) return false;
  const validTime = (raw: unknown) => typeof raw === "string" && Number.isFinite(Date.parse(raw));
  const validHistory = (raw: unknown): raw is MasterConfig[] =>
    Array.isArray(raw) &&
    raw.length <= MASTERING_SESSION_HISTORY_LIMIT &&
    raw.every((item) => normalizeSessionMasterConfig(item) !== null);
  return (
    value.version === MASTERING_SESSION_SCHEMA_VERSION &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 160 &&
    typeof value.fileName === "string" &&
    value.fileName.length > 0 &&
    value.fileName.length <= 255 &&
    typeof value.mimeType === "string" &&
    value.mimeType.length <= 120 &&
    Number.isSafeInteger(value.byteLength) &&
    (value.byteLength as number) > 0 &&
    (value.byteLength as number) <= MASTERING_SESSION_FILE_LIMIT_BYTES &&
    typeof value.sourceHash === "string" &&
    /^[a-f0-9]{64}$/i.test(value.sourceHash) &&
    typeof value.durationSeconds === "number" &&
    Number.isFinite(value.durationSeconds) &&
    value.durationSeconds >= 0.8 &&
    value.durationSeconds <= 12 * 60 &&
    (value.channels === 1 || value.channels === 2) &&
    typeof value.sourceSampleRate === "number" &&
    Number.isInteger(value.sourceSampleRate) &&
    value.sourceSampleRate >= 8000 &&
    value.sourceSampleRate <= 192000 &&
    normalizeSessionMasterConfig(value.masterConfig) !== null &&
    normalizeSessionSnapshots(value.snapshots) !== null &&
    (value.deliveryVersion === undefined ||
      (typeof value.deliveryVersion === "string" && value.deliveryVersion.length <= 32)) &&
    Number.isSafeInteger(value.configRevision) &&
    (value.configRevision as number) >= 0 &&
    validHistory(value.undoStack) &&
    validHistory(value.redoStack) &&
    validTime(value.createdAt) &&
    validTime(value.updatedAt)
  );
}

function isMasteringSessionRecord(value: unknown): value is MasteringSessionRecord {
  if (!isMasteringSessionSummary(value)) return false;
  const source = (value as unknown as Record<string, unknown>).source;
  return isBlobLike(source) && source.size === value.byteLength;
}

export function createMasteringSessionRecord(input: {
  id: string;
  fileName: string;
  mimeType: string;
  source: Blob;
  sourceHash: string;
  durationSeconds: number;
  channels: 1 | 2;
  sourceSampleRate: number;
  masterConfig: MasterConfig;
  createdAt?: string;
}): MasteringSessionRecord {
  const now = input.createdAt ?? new Date().toISOString();
  const record: MasteringSessionRecord = {
    version: MASTERING_SESSION_SCHEMA_VERSION,
    id: input.id,
    fileName: input.fileName,
    mimeType: input.mimeType,
    byteLength: input.source.size,
    source: input.source,
    sourceHash: input.sourceHash.toLowerCase(),
    durationSeconds: input.durationSeconds,
    channels: input.channels,
    sourceSampleRate: input.sourceSampleRate,
    masterConfig: cloneSessionMasterConfig(input.masterConfig),
    snapshots: { A: null, B: null },
    deliveryVersion: "",
    configRevision: 0,
    undoStack: [],
    redoStack: [],
    createdAt: now,
    updatedAt: now,
  };
  if (!isMasteringSessionRecord(record)) throw new Error("The external mastering session details are invalid.");
  const normalized = normalizeSessionMasterConfig(record.masterConfig);
  if (!normalized) throw new Error("The external mastering session processing state is invalid.");
  return { ...record, masterConfig: normalized };
}

export function captureMasteringSessionSnapshot(
  session: MasteringSessionRecord,
  slot: MasteringSessionSlot,
  name: string,
  now = new Date().toISOString(),
): MasteringSessionRecord {
  const normalizedName = name.trim();
  if (normalizedName.length === 0 || normalizedName.length > 64) {
    throw new Error("A mastering version name must contain 1 to 64 characters.");
  }
  const snapshot: MasteringSessionSnapshot = {
    id: uid("mastering-version"),
    name: normalizedName,
    capturedAt: now,
    masterConfig: cloneSessionMasterConfig(session.masterConfig),
  };
  return {
    ...session,
    snapshots: { ...session.snapshots, [slot]: snapshot },
    updatedAt: now,
  };
}

export function clearMasteringSessionSnapshot(
  session: MasteringSessionRecord,
  slot: MasteringSessionSlot,
  now = new Date().toISOString(),
): MasteringSessionRecord {
  if (session.snapshots[slot] === null) return session;
  return { ...session, snapshots: { ...session.snapshots, [slot]: null }, updatedAt: now };
}

export function updateMasteringSessionConfig(
  session: MasteringSessionRecord,
  nextConfig: MasterConfig,
  now = new Date().toISOString(),
): MasteringSessionRecord {
  const normalized = normalizeSessionMasterConfig(nextConfig);
  if (!normalized) throw new Error("The mastering session processing state is invalid.");
  if (JSON.stringify(normalized) === JSON.stringify(session.masterConfig)) return session;
  return {
    ...session,
    masterConfig: normalized,
    configRevision: session.configRevision + 1,
    undoStack: [...session.undoStack, cloneSessionMasterConfig(session.masterConfig)].slice(
      -MASTERING_SESSION_HISTORY_LIMIT,
    ),
    redoStack: [],
    updatedAt: now,
  };
}

export function undoMasteringSessionConfig(
  session: MasteringSessionRecord,
  now = new Date().toISOString(),
): MasteringSessionRecord {
  const previous = session.undoStack.at(-1);
  if (!previous) return session;
  return {
    ...session,
    masterConfig: cloneSessionMasterConfig(previous),
    configRevision: session.configRevision + 1,
    undoStack: session.undoStack.slice(0, -1),
    redoStack: [...session.redoStack, cloneSessionMasterConfig(session.masterConfig)].slice(
      -MASTERING_SESSION_HISTORY_LIMIT,
    ),
    updatedAt: now,
  };
}

export function redoMasteringSessionConfig(
  session: MasteringSessionRecord,
  now = new Date().toISOString(),
): MasteringSessionRecord {
  const next = session.redoStack.at(-1);
  if (!next) return session;
  return {
    ...session,
    masterConfig: cloneSessionMasterConfig(next),
    configRevision: session.configRevision + 1,
    undoStack: [...session.undoStack, cloneSessionMasterConfig(session.masterConfig)].slice(
      -MASTERING_SESSION_HISTORY_LIMIT,
    ),
    redoStack: session.redoStack.slice(0, -1),
    updatedAt: now,
  };
}

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable."));
  if (databasePromise) return databasePromise;
  const requestPromise = new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(MASTERING_SESSION_DATABASE, MASTERING_SESSION_DATABASE_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MASTERING_SESSION_STORE)) {
        db.createObjectStore(MASTERING_SESSION_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(MASTERING_SESSION_SOURCE_STORE)) {
        db.createObjectStore(MASTERING_SESSION_SOURCE_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(MASTERING_SESSION_REFERENCE_STORE)) {
        db.createObjectStore(MASTERING_SESSION_REFERENCE_STORE, { keyPath: "sessionId" });
      }
      if ((event as IDBVersionChangeEvent).oldVersion < 2) {
        const sessions = request.transaction?.objectStore(MASTERING_SESSION_STORE);
        const cursorRequest = sessions?.openCursor();
        if (cursorRequest) {
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const value = cursor.value;
            if (isObject(value) && value.version === 1) {
              cursor.update({ ...value, version: 2, snapshots: { A: null, B: null } });
            }
            cursor.continue();
          };
        }
      }
    };
    request.onblocked = () => {
      setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error("The local mastering-session database is locked by another KYX tab. Close that tab and retry."),
        );
      }, 5000);
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      request.result.onversionchange = () => {
        request.result.close();
        databasePromise = null;
      };
      resolve(request.result);
    };
    request.onerror = () => {
      if (!settled) reject(request.error ?? new Error("Could not open the local mastering-session database."));
    };
  });
  databasePromise = requestPromise;
  requestPromise.catch(() => {
    if (databasePromise === requestPromise) databasePromise = null;
  });
  return requestPromise;
}

function transactAcross<T>(
  storeNames: string[],
  run: (transaction: IDBTransaction, complete: (result: T) => void, fail: (error: unknown) => void) => void,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let transaction: IDBTransaction;
        let result: T | undefined;
        let hasResult = false;
        try {
          transaction = db.transaction(storeNames, "readwrite");
        } catch (error) {
          reject(error);
          return;
        }
        try {
          run(
            transaction,
            (value) => {
              result = value;
              hasResult = true;
            },
            (error) => {
              try {
                transaction.abort();
              } catch {
                /* already completed */
              }
              reject(error);
            },
          );
        } catch (error) {
          try {
            transaction.abort();
          } catch {
            /* already completed */
          }
          reject(error);
          return;
        }
        transaction.oncomplete = () => {
          if (hasResult) resolve(result as T);
          else reject(new Error("Mastering session transaction completed without a result."));
        };
        transaction.onabort = () => reject(transaction.error ?? new Error("Mastering session storage was aborted."));
        transaction.onerror = () => reject(transaction.error ?? new Error("Mastering session storage failed."));
      }),
  );
}

function transact<T>(run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return transactAcross<T>([MASTERING_SESSION_STORE], (transaction, complete) => {
    const request = run(transaction.objectStore(MASTERING_SESSION_STORE));
    if (!request) {
      complete(undefined as T);
      return;
    }
    request.onsuccess = () => complete(request.result);
    request.onerror = () => {
      try {
        transaction.abort();
      } catch {
        /* already completed */
      }
    };
  });
}

function validateLoadedSession(value: unknown): MasteringSessionRecord {
  if (!isMasteringSessionSummary(value))
    throw new Error("The saved mastering session summary is invalid or unsupported.");
  const source = (value as unknown as Record<string, unknown>).source;
  if (!isBlobLike(source)) {
    const details = isObject(source)
      ? `(${Object.prototype.toString.call(source)}; ${Object.keys(source).join(",")}; size=${String(source.size)}; type=${String(source.type)})`
      : `(${typeof source})`;
    throw new Error(`The saved mastering session source is not a supported Blob ${details}.`);
  }
  if (source.size !== value.byteLength)
    throw new Error("The saved mastering session source size does not match its metadata.");
  return { ...validateLoadedSummary(value), source };
}

function validateLoadedSummary(value: unknown): MasteringSessionSummary {
  if (!isMasteringSessionSummary(value)) throw new Error("The saved mastering session is invalid or unsupported.");
  const masterConfig = normalizeSessionMasterConfig(value.masterConfig);
  const snapshots = normalizeSessionSnapshots(value.snapshots);
  const undoStack = value.undoStack.map((config) => normalizeSessionMasterConfig(config));
  const redoStack = value.redoStack.map((config) => normalizeSessionMasterConfig(config));
  if (
    !masterConfig ||
    !snapshots ||
    undoStack.some((config) => config === null) ||
    redoStack.some((config) => config === null)
  ) {
    throw new Error("The saved mastering session has invalid processing state.");
  }
  return {
    ...value,
    masterConfig,
    snapshots,
    deliveryVersion: typeof value.deliveryVersion === "string" ? value.deliveryVersion : "",
    undoStack: undoStack as MasterConfig[],
    redoStack: redoStack as MasterConfig[],
  };
}

export class MasteringSessionRepository {
  async list(): Promise<MasteringSessionSummary[]> {
    const rows = await transact<unknown[]>((store) => store.getAll());
    return rows.map(validateLoadedSummary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<MasteringSessionRecord | null> {
    return transactAcross<MasteringSessionRecord | null>(
      [MASTERING_SESSION_STORE, MASTERING_SESSION_SOURCE_STORE],
      (transaction, complete, fail) => {
        let summary: unknown;
        let sourceRow: unknown;
        let completedRequests = 0;
        const onComplete = () => {
          completedRequests++;
          if (completedRequests !== 2) return;
          if (!isObject(summary) || !isObject(sourceRow)) {
            complete(null);
            return;
          }
          try {
            complete(validateLoadedSession({ ...summary, source: sourceRow.source }));
          } catch (error) {
            fail(error);
          }
        };
        const summaryRequest = transaction.objectStore(MASTERING_SESSION_STORE).get(id);
        const sourceRequest = transaction.objectStore(MASTERING_SESSION_SOURCE_STORE).get(id);
        summaryRequest.onsuccess = () => {
          summary = summaryRequest.result;
          onComplete();
        };
        summaryRequest.onerror = () => {
          try {
            transaction.abort();
          } catch {
            /* already completed */
          }
        };
        sourceRequest.onsuccess = () => {
          sourceRow = sourceRequest.result;
          onComplete();
        };
        sourceRequest.onerror = () => {
          try {
            transaction.abort();
          } catch {
            /* already completed */
          }
        };
      },
    );
  }

  async put(session: MasteringSessionRecord): Promise<void> {
    const validated = validateLoadedSession(session);
    const { source, ...summary } = validated;
    void source;
    await transactAcross<undefined>(
      [MASTERING_SESSION_STORE, MASTERING_SESSION_SOURCE_STORE],
      (transaction, complete, fail) => {
        const summaryStore = transaction.objectStore(MASTERING_SESSION_STORE);
        const summaryRequest = summaryStore.put(summary);
        summaryRequest.onerror = () => fail(summaryRequest.error ?? new Error("Could not save the session summary."));
        const sourceStore = transaction.objectStore(MASTERING_SESSION_SOURCE_STORE);
        const existingSource = sourceStore.get(validated.id);
        existingSource.onsuccess = () => {
          if (existingSource.result == null) {
            try {
              const sourceRequest = sourceStore.put({ id: validated.id, source: validated.source });
              sourceRequest.onerror = () =>
                fail(sourceRequest.error ?? new Error("Could not save the original mastering source."));
            } catch (error) {
              fail(error);
            }
          }
        };
        existingSource.onerror = () =>
          fail(existingSource.error ?? new Error("Could not check the existing mastering source."));
        complete(undefined);
      },
    );
  }

  async updateDeliveryVersion(sessionId: string, deliveryVersion: string): Promise<void> {
    const normalizedVersion = deliveryVersion.slice(0, 32);
    await transactAcross<undefined>([MASTERING_SESSION_STORE], (transaction, complete, fail) => {
      const store = transaction.objectStore(MASTERING_SESSION_STORE);
      const request = store.get(sessionId);
      request.onsuccess = () => {
        if (!isMasteringSessionSummary(request.result)) {
          fail(new Error("The mastering session was closed before its delivery version could be saved."));
          return;
        }
        const updated: MasteringSessionSummary = {
          ...validateLoadedSummary(request.result),
          deliveryVersion: normalizedVersion,
          updatedAt: new Date().toISOString(),
        };
        try {
          const write = store.put(updated);
          write.onerror = () => fail(write.error ?? new Error("Could not save the mastering delivery version."));
          complete(undefined);
        } catch (error) {
          fail(error);
        }
      };
      request.onerror = () =>
        fail(request.error ?? new Error("Could not load the session for its delivery version update."));
    });
  }

  async delete(id: string): Promise<void> {
    await transactAcross<undefined>(
      [MASTERING_SESSION_STORE, MASTERING_SESSION_SOURCE_STORE, MASTERING_SESSION_REFERENCE_STORE],
      (transaction, complete) => {
        transaction.objectStore(MASTERING_SESSION_STORE).delete(id);
        transaction.objectStore(MASTERING_SESSION_SOURCE_STORE).delete(id);
        transaction.objectStore(MASTERING_SESSION_REFERENCE_STORE).delete(id);
        complete(undefined);
      },
    );
  }

  async getReference(sessionId: string): Promise<MasteringSessionReferenceRecord | null> {
    return transactAcross<MasteringSessionReferenceRecord | null>(
      [MASTERING_SESSION_REFERENCE_STORE],
      (transaction, complete, fail) => {
        const request = transaction.objectStore(MASTERING_SESSION_REFERENCE_STORE).get(sessionId);
        request.onsuccess = () => {
          if (request.result == null) {
            complete(null);
            return;
          }
          if (!isMasteringSessionReference(request.result)) {
            fail(new Error("The saved mastering-session reference is invalid or unsupported."));
            return;
          }
          complete(request.result);
        };
        request.onerror = () => {
          try {
            transaction.abort();
          } catch {
            /* already completed */
          }
        };
      },
    );
  }

  async putReference(reference: MasteringSessionReferenceRecord): Promise<void> {
    if (!isMasteringSessionReference(reference)) throw new Error("The mastering-session reference is invalid.");
    await transactAcross<undefined>(
      [MASTERING_SESSION_STORE, MASTERING_SESSION_REFERENCE_STORE],
      (transaction, complete, fail) => {
        const sessionRequest = transaction.objectStore(MASTERING_SESSION_STORE).get(reference.sessionId);
        sessionRequest.onsuccess = () => {
          if (sessionRequest.result == null) {
            fail(new Error("The mastering session was closed before its reference could be saved."));
            return;
          }
          try {
            const referenceRequest = transaction.objectStore(MASTERING_SESSION_REFERENCE_STORE).put(reference);
            referenceRequest.onerror = () =>
              fail(referenceRequest.error ?? new Error("Could not save the comparison reference."));
            complete(undefined);
          } catch (error) {
            fail(error);
          }
        };
        sessionRequest.onerror = () =>
          fail(sessionRequest.error ?? new Error("Could not verify the mastering session for this reference."));
      },
    );
  }

  async deleteReference(sessionId: string): Promise<void> {
    await transactAcross<undefined>([MASTERING_SESSION_REFERENCE_STORE], (transaction, complete) => {
      transaction.objectStore(MASTERING_SESSION_REFERENCE_STORE).delete(sessionId);
      complete(undefined);
    });
  }
}
