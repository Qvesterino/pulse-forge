/**
 * Unload recovery buffer (editor audit D20).
 *
 * The unload save flush does not work. Measured in Chromium against the
 * production build: `installSaveUnloadGuards` answers BOTH
 * `visibilitychange`→hidden and `pagehide` with `flushSave()`, and neither
 * IndexedDB transaction commits before the document is torn down. A click on a
 * sequencer step, then closing the tab, loses the edit - the stored document
 * silently reverts to its pre-click value.
 *
 * The constraint is that IndexedDB is async and gets no time during unload,
 * while a SYNCHRONOUS `localStorage` write in the same handler provably
 * survives (measured with localStorage markers alongside the failing IDB
 * writes). So the buffer is a second, deliberately synchronous store holding
 * only the work that had NOT been committed yet.
 *
 * Contract:
 * - written on unload, and ONLY while the project is dirty;
 * - cleared the moment a save of the same project commits, and when the user
 *   recovers or dismisses it - so a stale buffer never shadows newer work;
 * - best-effort everywhere: a full or unavailable localStorage must never throw
 *   into the unload path, and it degrades to exactly today's behaviour.
 */

const RECOVERY_KEY = "kyx:recovery-buffer:v1";

export interface RecoveryBuffer {
  /** Which saved project the document belongs to. */
  projectId: string;
  /** ISO timestamp of the moment the buffer was taken. */
  savedAt: string;
  /** The uncommitted document. Shape-checked by the reader, not trusted. */
  doc: unknown;
}

function storage(): Storage | null {
  try {
    // Private mode and storage-blocked contexts throw on access, not on write.
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Take the buffer. Synchronous on purpose — an async write is the exact thing
 * that does not survive unload. Returns false when the payload could not be
 * stored (quota, private mode, serialization failure); the caller treats that
 * as "no protection this time", never as an error.
 */
export function writeRecoveryBuffer(doc: unknown, projectId: string): boolean {
  const store = storage();
  if (!store) return false;
  let payload: string;
  try {
    payload = JSON.stringify({ v: 1, projectId, savedAt: new Date().toISOString(), doc });
  } catch {
    // Circular structure or a value JSON cannot represent.
    return false;
  }
  try {
    store.setItem(RECOVERY_KEY, payload);
    return true;
  } catch {
    // QuotaExceededError: the document is larger than localStorage will take.
    // Losing the buffer is strictly better than losing the unload handler.
    return false;
  }
}

/** Read the buffer, or null when absent, unreadable or malformed. */
export function readRecoveryBuffer(): RecoveryBuffer | null {
  const store = storage();
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(RECOVERY_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt leftover - drop it rather than offering to restore garbage.
    clearRecoveryBuffer();
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    clearRecoveryBuffer();
    return null;
  }
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.projectId !== "string" || typeof rec.savedAt !== "string" || rec.doc == null) {
    clearRecoveryBuffer();
    return null;
  }
  return { projectId: rec.projectId, savedAt: rec.savedAt, doc: rec.doc };
}

/**
 * Drop the buffer.
 *
 * `projectId` scopes the clear to ONE project. The buffer holds the ONLY copy
 * of the work that was uncommitted when the tab died (the unload IndexedDB
 * flush provably never commits), so a save of project Q must NOT destroy
 * project P's buffer — P's work is still the only copy of itself. The
 * contract above ("cleared the moment a save of THE SAME project commits")
 * depends on this check; without it, the first autosave of any other project
 * silently threw the user's uncommitted work away.
 *
 * Omit `projectId` to drop the buffer unconditionally — the user recovered it,
 * dismissed it, or it is corrupt and must not be offered.
 */
export function clearRecoveryBuffer(projectId?: string): void {
  const store = storage();
  if (!store) return;
  if (projectId !== undefined) {
    const buffer = readRecoveryBuffer();
    // A missing or unreadable buffer is already gone; a buffer belonging to
    // another project must survive this project's save.
    if (buffer && buffer.projectId !== projectId) return;
  }
  try {
    store.removeItem(RECOVERY_KEY);
  } catch {
    /* nothing to do - the buffer is best-effort by construction */
  }
}

/**
 * Decide whether a buffer is still worth offering.
 *
 * The buffer is only meaningful if the SAVED project is older than it: if the
 * user reopened the project and a later save committed, that save already
 * contains everything the buffer held and offering it would be a downgrade.
 * `savedAt` is compared against the project's own `updatedAt`.
 */
export function isBufferWorthOffering(buffer: RecoveryBuffer, savedProjectUpdatedAt: string | null): boolean {
  if (!savedProjectUpdatedAt) return true; // project not found - offer it
  const buffered = Date.parse(buffer.savedAt);
  const saved = Date.parse(savedProjectUpdatedAt);
  if (!Number.isFinite(buffered)) return true; // unreadable clock - offer it
  if (!Number.isFinite(saved)) return true;
  return buffered > saved;
}
