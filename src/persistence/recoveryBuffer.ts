import { migrateProject, validateProjectShape } from "../project-model/schema";
import type { ProjectDocument } from "../project-model/types";

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
 *
 * ONE SLOT PER PROJECT. The buffer used to live under a single global key, so
 * the second dirty tab to close destroyed the first tab's only copy of its
 * uncommitted work. Each project now has its own slot; the legacy global key
 * is still READ (a user upgrading mid-session must not lose the buffer they
 * already had) and is cleared as soon as it is offered, recovered or discarded.
 */

/** The pre-per-project key. Read for backwards compatibility; never written. */
const LEGACY_RECOVERY_KEY = "kyx:recovery-buffer:v1";
/** One slot per project: `kyx:recovery-buffer:v1:<projectId>`. */
const RECOVERY_KEY_PREFIX = "kyx:recovery-buffer:v1:";

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

function recoveryKey(projectId: string): string {
  return `${RECOVERY_KEY_PREFIX}${projectId}`;
}

/** Every per-project slot key currently in the store. */
function slotKeys(store: Storage): string[] {
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key != null && key.startsWith(RECOVERY_KEY_PREFIX)) keys.push(key);
  }
  return keys;
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
    store.setItem(recoveryKey(projectId), payload);
    // The legacy slot held THIS project's buffer; the per-project slot is
    // newer, so the legacy copy is stale. A legacy slot belonging to ANOTHER
    // project is untouched — that is the other project's only copy.
    const legacy = readKey(store, LEGACY_RECOVERY_KEY);
    if (legacy != null && legacy.projectId === projectId) store.removeItem(LEGACY_RECOVERY_KEY);
    return true;
  } catch {
    // QuotaExceededError: the document is larger than localStorage will take.
    // Losing the buffer is strictly better than losing the unload handler.
    return false;
  }
}

/** Parse one slot. A malformed slot is dropped rather than offered. */
function readKey(store: Storage, key: string): RecoveryBuffer | null {
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt leftover - drop it rather than offering to restore garbage.
    try {
      store.removeItem(key);
    } catch {
      /* best-effort */
    }
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    try {
      store.removeItem(key);
    } catch {
      /* best-effort */
    }
    return null;
  }
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.projectId !== "string" || typeof rec.savedAt !== "string" || rec.doc == null) {
    try {
      store.removeItem(key);
    } catch {
      /* best-effort */
    }
    return null;
  }
  return { projectId: rec.projectId, savedAt: rec.savedAt, doc: rec.doc };
}

function newerThan(a: RecoveryBuffer, b: RecoveryBuffer): boolean {
  const left = Date.parse(a.savedAt);
  const right = Date.parse(b.savedAt);
  if (!Number.isFinite(left)) return false;
  if (!Number.isFinite(right)) return true;
  return left > right;
}

/**
 * Read the buffer, or null when absent, unreadable or malformed.
 *
 * With a projectId, that project's own slot is read (plus the legacy slot
 * when it belongs to the same project). Without one, the NEWEST buffer across
 * every slot is returned — the browser asks "is there anything to offer?"
 * without knowing which project it belongs to.
 */
export function readRecoveryBuffer(projectId?: string): RecoveryBuffer | null {
  const store = storage();
  if (!store) return null;
  if (projectId !== undefined) {
    const own = readKey(store, recoveryKey(projectId));
    if (own != null) return own;
    const legacy = readKey(store, LEGACY_RECOVERY_KEY);
    return legacy != null && legacy.projectId === projectId ? legacy : null;
  }
  let best: RecoveryBuffer | null = null;
  for (const key of slotKeys(store)) {
    const buffer = readKey(store, key);
    if (buffer != null && (best === null || newerThan(buffer, best))) best = buffer;
  }
  const legacy = readKey(store, LEGACY_RECOVERY_KEY);
  if (legacy != null && (best === null || newerThan(legacy, best))) best = legacy;
  return best;
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
 * Omit `projectId` to drop EVERY buffer — the user recovered or dismissed
 * them all, or they are corrupt and must not be offered.
 */
export function clearRecoveryBuffer(projectId?: string): void {
  const store = storage();
  if (!store) return;
  if (projectId !== undefined) {
    const own = readKey(store, recoveryKey(projectId));
    if (own != null) {
      try {
        store.removeItem(recoveryKey(projectId));
      } catch {
        /* best-effort */
      }
    }
    const legacy = readKey(store, LEGACY_RECOVERY_KEY);
    if (legacy != null && legacy.projectId === projectId) {
      try {
        store.removeItem(LEGACY_RECOVERY_KEY);
      } catch {
        /* best-effort */
      }
    }
    return;
  }
  for (const key of slotKeys(store)) {
    try {
      store.removeItem(key);
    } catch {
      /* best-effort */
    }
  }
  try {
    store.removeItem(LEGACY_RECOVERY_KEY);
  } catch {
    /* best-effort */
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

/** What a recovery attempt concluded. */
export type RecoveryVerdict = { ok: true; doc: ProjectDocument } | { ok: false; reason: string };

/**
 * Decide whether the buffered document may REPLACE the saved project.
 *
 * The buffer is UNTRUSTED input. It is a synchronous `localStorage` write —
 * user-writable, and it survives across app versions — while the saved
 * project body is the one copy of the user's work. `repo.save()` writes the
 * document RAW (no shape check, no migration), while `repo.load()` validates
 * and refuses what it cannot read. So a buffer that is malformed, from a
 * different project, or written by a NEWER app version did not merely fail to
 * restore: it OVERWROTE the good body with something the loader then
 * refused, and the project was gone. The crash journal keeps events, not
 * bodies, so there was nothing to fall back to.
 *
 * Three checks, all before any write:
 *   1. the document must be a project at all (`validateProjectShape`);
 *   2. it must belong to the project it claims (`doc.id === projectId`);
 *   3. it must be migratable to this build (`migrateProject` throws for a
 *      newer schema).
 */
export function prepareRecoveredDocument(buffer: RecoveryBuffer): RecoveryVerdict {
  if (!validateProjectShape(buffer.doc)) {
    return {
      ok: false,
      reason: "the recovered work is not a readable project — nothing was overwritten",
    };
  }
  const doc = buffer.doc;
  if (doc.id !== buffer.projectId) {
    return {
      ok: false,
      reason: `the recovered work belongs to a different project ("${doc.id}") — nothing was overwritten`,
    };
  }
  try {
    return { ok: true, doc: migrateProject(doc) };
  } catch {
    return {
      ok: false,
      reason: "the recovered work was written by a newer version of KYX — nothing was overwritten",
    };
  }
}

/** The write target — the project repository, or anything that can save. */
export interface RecoveryTarget {
  save(doc: ProjectDocument): Promise<void>;
}

/**
 * Recover the buffered work INTO the project repository — but only when it is
 * safe to do so. The refusal path never writes: the saved body stays exactly
 * as it was, and the buffer stays in place so the work is not thrown away.
 */
export async function recoverProject(target: RecoveryTarget, buffer: RecoveryBuffer): Promise<RecoveryVerdict> {
  const verdict = prepareRecoveredDocument(buffer);
  if (!verdict.ok) return verdict;
  await target.save(verdict.doc);
  return verdict;
}
