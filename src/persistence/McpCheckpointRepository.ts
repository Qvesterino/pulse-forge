/**
 * MCP CHECKPOINT REPOSITORY — durable half of the agent time machine
 * (architecture hardening C7).
 *
 * Agent checkpoints (kyx_checkpoint) live in a session-scoped in-memory map
 * inside src/mcp/tools.ts. This repository is their best-effort WRITE-
 * THROUGH target so checkpoints survive a reload/crash: own tiny database
 * (`qvester-mcp-checkpoints`), OWN lifecycle — deliberately NOT a store in
 * the shared `pulse-forge` DB, because that would bump DB_VERSION for every
 * repo on a pure agent-utility feature (the qvester-audio-handoff DB set
 * the small-own-DB precedent).
 *
 * Records are keyed `${projectId}::${name}` so two projects never collide.
 * All methods throw on IDB failure — the CALLER decides best-effort policy
 * (the tool answers "session only" and moves on).
 */

export const MCP_CHECKPOINTS_DB = "qvester-mcp-checkpoints";
export const MCP_CHECKPOINTS_STORE = "checkpoints";

export interface McpCheckpointRecord {
  key: string;
  projectId: string;
  name: string;
  /** Human summary stored in the checkpoint list ("3 tracks · …"). */
  label: string;
  auto: boolean;
  savedAt: string;
  doc: import("../project-model/types").ProjectDocument;
}

function defaultOpen(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is not available in this environment"));
  }
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(MCP_CHECKPOINTS_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MCP_CHECKPOINTS_STORE)) {
        db.createObjectStore(MCP_CHECKPOINTS_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("checkpoint db open failed"));
  });
}

export function checkpointKey(projectId: string, name: string): string {
  return `${projectId}::${name}`;
}

export class McpCheckpointRepository {
  constructor(private readonly openDatabase: () => Promise<IDBDatabase> = defaultOpen) {}

  private async withStore<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T> | void,
  ): Promise<T> {
    const db = await this.openDatabase();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(MCP_CHECKPOINTS_STORE, mode);
      const store = tx.objectStore(MCP_CHECKPOINTS_STORE);
      const request = run(store);
      let result: T | undefined;
      if (request != null) {
        request.onsuccess = () => {
          result = request.result;
        };
      }
      tx.oncomplete = () => resolve(result as T);
      tx.onerror = () => reject(tx.error ?? new Error("checkpoint tx failed"));
      tx.onabort = () => reject(tx.error ?? new Error("checkpoint tx aborted"));
    });
  }

  checkpointKey(projectId: string, name: string): string {
    return checkpointKey(projectId, name);
  }

  async put(record: McpCheckpointRecord): Promise<void> {
    await this.withStore("readwrite", (store) => store.put(record, record.key));
  }

  async list(projectId: string): Promise<McpCheckpointRecord[]> {
    const all = await this.withStore<McpCheckpointRecord[]>("readonly", (store) => store.getAll());
    return (all ?? [])
      .filter((record) => record.projectId === projectId)
      .sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
  }

  async remove(projectId: string, name: string): Promise<void> {
    await this.withStore("readwrite", (store) => void store.delete(checkpointKey(projectId, name)));
  }
}

