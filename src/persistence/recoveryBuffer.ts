import { compressToUTF16, decompressFromUTF16 } from "lz-string";
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
 *
 * THE WRITE MUST NOT FAIL SILENTLY (audit S-4). The buffer is the ONLY copy of
 * the work that was uncommitted when the tab died. When the write failed, the
 * crash safety net simply did not exist - and the failure was discarded: the
 * writer returned `false` and the unload handler ignored it. The user was
 * never told, so "your last session's work is gone" had no explanation and no
 * warning while they could still have saved. Three things changed:
 *
 * 1. THE PAYLOAD IS COMPRESSED. Measured 2026-10-25 (lz-string, the codec
 *    this repository already uses for share codes): a project with 4 000
 *    automation points is 321 KB raw and 19 KB compressed - a 17x win - and
 *    the ratio grows with size (3.2 MB raw -> 147 KB). Raw JSON is what
 *    exhausted the per-origin storage quota, and with one slot PER PROJECT
 *    the raw payloads compete with each other for the same budget. The
 *    compression is bounded by `RECOVERY_COMPRESSION_LIMIT_BYTES` because it
 *    runs INSIDE the unload handler, where a slow synchronous write risks the
 *    tab being killed before the write lands - and a killed tab loses the
 *    payload AND the failure record.
 * 2. THE RESULT IS STRUCTURED. `writeRecoveryBuffer` answers with a reason,
 *    never with a bare boolean.
 * 3. THE FAILURE IS PERSISTED. A failure record survives the tab close, so
 *    the NEXT session can tell the user that their last session was not
 *    protected - instead of the work vanishing without a word.
 */

/** The pre-per-project key. Read for backwards compatibility; never written. */
const LEGACY_RECOVERY_KEY = "kyx:recovery-buffer:v1";
/** One slot per project: `kyx:recovery-buffer:v1:<projectId>`. */
const RECOVERY_KEY_PREFIX = "kyx:recovery-buffer:v1:";
/**
 * One protection status per project: `kyx:recovery-status:v1:<projectId>`.
 * A SEPARATE key family on purpose - the status is not a buffer, and a
 * scanner looking for buffer slots must not pick it up.
 */
const STATUS_KEY_PREFIX = "kyx:recovery-status:v1:";

/**
 * Above this raw size the payload is stored UNCOMPRESSED.
 *
 * Measured 2026-10-25: lz-string costs ~0.5 ms per KB of raw JSON on this
 * machine, so 1 MB is ~370-500 ms - acceptable inside an unload handler.
 * Beyond that the compression cost grows linearly and the tab can be killed
 * mid-write, which would lose the payload AND the failure record; the raw
 * write is then both faster and honest about what it costs.
 */
export const RECOVERY_COMPRESSION_LIMIT_BYTES = 1024 * 1024;

/**
 * How much room the stored payload may take before the crash buffer is
 * reported as NOT fitting.
 *
 * Chrome, Firefox and Safari all cap localStorage at ~5 MB per origin, and
 * Chrome charges 2 bytes per UTF-16 code unit - so 2 M code units is ~4 MB
 * and leaves headroom for the other keys the origin keeps (layout, theme,
 * pad bindings). Measured stored sizes for real projects: 6 KB (a house
 * template), 13-25 KB (a working session), 147 KB (a 3.2 MB project) - all
 * far inside the budget. Only a project past a megabyte of raw JSON comes
 * close.
 */
export const RECOVERY_STORAGE_BUDGET_CHARS = 2_000_000;

/** Why the crash buffer could not be written. */
export type RecoveryWriteFailure = "no-storage" | "unserializable" | "quota";

/**
 * Why a project is not crash-protected.
 *
 * `too-large` is a CAPACITY verdict computed before any write — the payload
 * does not fit the storage budget, so the write would fail. The other three
 * are the WRITE's own reasons. The two are kept apart because the user's
 * next move differs: a project that is too large needs a smaller project or
 * fewer saves, while a refused write is the browser's storage.
 */
export type RecoveryFailureReason = RecoveryWriteFailure | "too-large";

/**
 * The one owner of the wording.
 *
 * The studio chip, the browser banner and the diagnostics all have to say the
 * SAME thing about the same reason — a second spelling would drift.
 */
export function recoveryFailureMessage(reason: RecoveryFailureReason): string {
  switch (reason) {
    case "too-large":
      return "this project is too large for the browser's crash buffer";
    case "quota":
      return "the browser refused to store the crash buffer (storage is full)";
    case "no-storage":
      return "the browser blocked local storage, so no crash buffer can exist";
    case "unserializable":
      return "this project could not be serialised for the crash buffer";
    default:
      return "the crash buffer could not be written";
  }
}

/** What a write attempt concluded. Never a bare boolean - the reason matters. */
export type RecoveryWriteResult =
  | { ok: true; bytes: number; encoded: "compressed" | "raw" }
  | { ok: false; reason: RecoveryWriteFailure; bytes: number };

export interface RecoveryBuffer {
  /** Which saved project the document belongs to. */
  projectId: string;
  /** ISO timestamp of the moment the buffer was taken. */
  savedAt: string;
  /** The uncommitted document. Shape-checked by the reader, not trusted. */
  doc: unknown;
}

/**
 * The persisted protection state of a project.
 *
 * `state` is the CURRENT answer ("can the crash buffer hold this project?").
 * `lastFailureAt` is the HISTORICAL one ("when did it last refuse?") and
 * survives a later success - a buffer that works again does not un-happen the
 * session that was lost.
 */
export interface RecoveryStatus {
  state: "protected" | "unprotected";
  /** When this status was last computed. */
  checkedAt: string;
  /** The stored size of the payload, in UTF-16 code units. */
  bytes: number;
  /** Why the buffer could not be written (unprotected only). */
  reason?: RecoveryFailureReason;
  /** When the buffer last failed to write. */
  lastFailureAt?: string;
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

function statusKey(projectId: string): string {
  return `${STATUS_KEY_PREFIX}${projectId}`;
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

/** Every per-project status key currently in the store. */
function statusKeys(store: Storage): string[] {
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key != null && key.startsWith(STATUS_KEY_PREFIX)) keys.push(key);
  }
  return keys;
}

/**
 * Take the buffer. Synchronous on purpose — an async write is the exact thing
 * that does not survive unload. Returns the REASON when the payload could not
 * be stored (quota, private mode, a document JSON cannot represent); the
 * caller treats that as "no protection this time", never as an error — but it
 * must not be thrown away either.
 */
export function writeRecoveryBuffer(doc: unknown, projectId: string): RecoveryWriteResult {
  const store = storage();
  if (!store) return { ok: false, reason: "no-storage", bytes: 0 };

  const savedAt = new Date().toISOString();
  const prepared = preparePayload(doc, projectId, savedAt);
  if ("error" in prepared) return { ok: false, reason: prepared.error, bytes: 0 };

  try {
    store.setItem(recoveryKey(projectId), prepared.stored);
  } catch {
    // The browser refused the write - the per-origin quota. The crash safety
    // net does not exist for this project. The status is persisted HERE, so
    // every caller gets the record for free: the next session can tell the
    // user what happened instead of the work vanishing without a word.
    const checkedAt = new Date().toISOString();
    writeStatus(projectId, {
      state: "unprotected",
      checkedAt,
      bytes: prepared.bytes,
      reason: "quota",
      lastFailureAt: checkedAt,
    });
    return { ok: false, reason: "quota", bytes: prepared.bytes };
  }

  // The legacy slot held THIS project's buffer; the per-project slot is
  // newer, so the legacy copy is stale. A legacy slot belonging to ANOTHER
  // project is untouched — that is the other project's only copy.
  const legacy = readKey(store, LEGACY_RECOVERY_KEY);
  if (legacy != null && legacy.projectId === projectId) store.removeItem(LEGACY_RECOVERY_KEY);

  // The buffer exists now, so the project IS protected. The historical
  // failure (if any) is carried forward rather than erased.
  writeStatus(projectId, { state: "protected", checkedAt: savedAt, bytes: prepared.bytes });
  return { ok: true, bytes: prepared.bytes, encoded: prepared.encoding };
}

/** The payload as it will be stored, or the reason it cannot be built. */
type PreparedPayload =
  { encoding: "compressed" | "raw"; stored: string; bytes: number } | { error: RecoveryWriteFailure };

function preparePayload(doc: unknown, projectId: string, savedAt: string): PreparedPayload {
  let raw: string | undefined;
  try {
    raw = JSON.stringify(doc);
  } catch {
    // Circular structure, a BigInt, or a value JSON cannot represent.
    return { error: "unserializable" };
  }
  if (typeof raw !== "string") return { error: "unserializable" };

  if (raw.length <= RECOVERY_COMPRESSION_LIMIT_BYTES) {
    const payload = compressToUTF16(raw);
    const stored = JSON.stringify({ v: 2, encoding: "lz-utf16", projectId, savedAt, payload });
    return { encoding: "compressed", stored, bytes: stored.length };
  }
  // Too big to compress inside the unload handler. The raw write is faster,
  // and it either fits or the caller learns that it did not.
  const stored = JSON.stringify({ v: 2, encoding: "raw", projectId, savedAt, doc });
  return { encoding: "raw", stored, bytes: stored.length };
}

/**
 * How much room the crash buffer needs for this document.
 *
 * This is the EARLY WARNING: the capacity is knowable long before the tab
 * closes, so a project that cannot be protected can say so while the user can
 * still save. It answers with the stored size, which is the thing the quota
 * actually charges.
 */
export function recoveryBufferSize(doc: unknown): { bytes: number; encoded: "compressed" | "raw" } {
  const prepared = preparePayload(doc, "measure", new Date().toISOString());
  if ("error" in prepared) return { bytes: 0, encoded: "raw" };
  return { bytes: prepared.bytes, encoded: prepared.encoding };
}

/** Does the crash buffer have room for this document? */
export function recoveryBufferFits(doc: unknown): boolean {
  return recoveryBufferSize(doc).bytes <= RECOVERY_STORAGE_BUDGET_CHARS;
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
    return dropKey(store, key);
  }
  if (typeof parsed !== "object" || parsed === null) return dropKey(store, key);
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.projectId !== "string" || typeof rec.savedAt !== "string") return dropKey(store, key);

  if (rec.v === 2 && rec.encoding === "lz-utf16") {
    if (typeof rec.payload !== "string") return dropKey(store, key);
    const plain = decompressFromUTF16(rec.payload);
    if (plain == null) return dropKey(store, key);
    let doc: unknown;
    try {
      doc = JSON.parse(plain);
    } catch {
      return dropKey(store, key);
    }
    return { projectId: rec.projectId, savedAt: rec.savedAt, doc };
  }
  // v2 raw and the legacy v1 envelope carry the document inline.
  if (rec.doc == null) return dropKey(store, key);
  return { projectId: rec.projectId, savedAt: rec.savedAt, doc: rec.doc };
}

/** Drop a slot that cannot be read. The payload is already unreadable. */
function dropKey(store: Storage, key: string): null {
  try {
    store.removeItem(key);
  } catch {
    /* best-effort */
  }
  return null;
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
 * The protection state of a project, computed from its size.
 *
 * The capacity is knowable long before the tab closes, so this is the EARLY
 * WARNING: a project that cannot be protected can say so while the user can
 * still save. One owner — the studio chip, the browser banner and the
 * persisted record all read this answer, so they cannot disagree.
 */
export function recoveryCapacityStatus(doc: unknown): RecoveryStatus {
  const size = recoveryBufferSize(doc);
  const checkedAt = new Date().toISOString();
  if (size.bytes > RECOVERY_STORAGE_BUDGET_CHARS) {
    return { state: "unprotected", checkedAt, bytes: size.bytes, reason: "too-large" };
  }
  return { state: "protected", checkedAt, bytes: size.bytes };
}

/**
 * Record the protection state of a project.
 *
 * The status is NOT the buffer: it is the answer to "can the crash buffer
 * hold this project?", and it survives a session. That answer is what lets
 * the studio warn the user while they can still save, and what lets the next
 * session explain a loss instead of hiding it.
 */
export function writeStatus(projectId: string, status: RecoveryStatus): void {
  const store = storage();
  if (!store) return;
  // The historical failure survives a later success: a buffer that works
  // again does not un-happen the session that was lost.
  const previous = readStatus(projectId);
  const lastFailureAt =
    status.state === "unprotected" ? (status.lastFailureAt ?? status.checkedAt) : previous?.lastFailureAt;
  const merged: RecoveryStatus = { ...status, ...(lastFailureAt != null ? { lastFailureAt } : {}) };
  try {
    store.setItem(statusKey(projectId), JSON.stringify(merged));
  } catch {
    // A full store cannot hold the status either. The buffer write that
    // triggered this already reported the quota; there is nowhere left to
    // write the explanation.
  }
}

/** The persisted protection state of a project, or null when there is none. */
export function readStatus(projectId: string): RecoveryStatus | null {
  const store = storage();
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(statusKey(projectId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RecoveryStatus>;
    if (parsed?.state !== "protected" && parsed?.state !== "unprotected") return null;
    if (typeof parsed.checkedAt !== "string" || typeof parsed.bytes !== "number") return null;
    return {
      state: parsed.state,
      checkedAt: parsed.checkedAt,
      bytes: parsed.bytes,
      ...(parsed.reason != null ? { reason: parsed.reason } : {}),
      ...(parsed.lastFailureAt != null ? { lastFailureAt: parsed.lastFailureAt } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Every project whose crash buffer could not hold the work.
 *
 * The newest failure first — it is the one the user most likely lost.
 */
export function readFailedStatuses(): Array<RecoveryStatus & { projectId: string }> {
  const store = storage();
  if (!store) return [];
  const failed: Array<RecoveryStatus & { projectId: string }> = [];
  for (const key of statusKeys(store)) {
    const projectId = key.slice(STATUS_KEY_PREFIX.length);
    const status = readStatus(projectId);
    if (status != null && status.state === "unprotected") failed.push({ ...status, projectId });
  }
  failed.sort((a, b) => Date.parse(b.lastFailureAt ?? b.checkedAt) - Date.parse(a.lastFailureAt ?? a.checkedAt));
  return failed;
}

/** Forget the protection state of a project (the user has been told). */
export function clearStatus(projectId: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(statusKey(projectId));
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
