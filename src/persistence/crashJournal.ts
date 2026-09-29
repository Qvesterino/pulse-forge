/**
 * Crash journal — session/save lifecycle telemetry in the meta store.
 *
 * ProjectRepository.save already commits the project body and the
 * "most recent" pointer in ONE IndexedDB transaction, so the data layer is
 * crash-safe by construction: a project is either fully saved or not at
 * all. What no record answers today is "what happened to the previous
 * session?" — if the tab dies (crash, force-quit, battery pull, iOS
 * termination without pagehide), the next boot boots straight into the
 * Project Browser as if nothing happened, and the user has no way to know
 * their last edits may be missing.
 *
 * This journal appends tiny lifecycle events into the existing key-value
 * meta store (no schema bump, no new object store):
 *
 *   session-open → (…saves: save-ok / save-fail…) → session-close
 *
 * A journal whose LAST event is NOT session-close is the unclean-shutdown
 * fingerprint. `analyzeCrashJournal` turns raw events into that verdict;
 * the Project Browser renders it as a banner so the user knows to check
 * the project's saved state.
 *
 * Journaling trails the data on purpose: save-ok is recorded AFTER the
 * save transaction commits, never inside it. The journal is observability
 * only — every writer here is best-effort and NEVER throws into the save
 * or open path. Corrupt or foreign records in the journal key are survived
 * (defensive parse, fallback to empty history).
 */

import { openDb, STORE_META, tx } from "./db";

export const CRASH_JOURNAL_KEY = "crashJournal";

/** Bounded history: drop oldest beyond this. Events are tiny (≤ ~120 B). */
export const CRASH_JOURNAL_MAX_EVENTS = 50;

export type CrashJournalEventKind = "session-open" | "save-ok" | "save-fail" | "session-close";

export interface CrashJournalEvent {
  /** ISO-8601 timestamp of the event. */
  t: string;
  kind: CrashJournalEventKind;
  projectId: string;
  /** Failure detail (save-fail only). */
  message?: string;
}

export interface CrashJournalReport {
  /**
   * True when the journal is empty or ends on session-close — the previous
   * session shut down deliberately. False means the tab died mid-session.
   */
  lastSessionClean: boolean;
  /** Most recent event overall, null for an empty/absent journal. */
  lastEvent: CrashJournalEvent | null;
  /** Most recent save-ok, null when no save ever completed. */
  lastSaveOk: CrashJournalEvent | null;
}

/** Pure append with cap: returns a NEW array, oldest events dropped first. */
export function appendCrashJournalEvent(events: CrashJournalEvent[], event: CrashJournalEvent): CrashJournalEvent[] {
  const next = [...events, event];
  return next.length > CRASH_JOURNAL_MAX_EVENTS ? next.slice(next.length - CRASH_JOURNAL_MAX_EVENTS) : next;
}

/**
 * Defensive parse of the stored value: anything that is not a well-shaped
 * event is dropped individually, a non-array/corrupt record falls back to
 * an empty history. Written by an older/foreign build must never take the
 * boot path down.
 */
export function parseCrashJournal(value: unknown): CrashJournalEvent[] {
  if (!Array.isArray(value)) return [];
  const events: CrashJournalEvent[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const rec = raw as Record<string, unknown>;
    if (typeof rec.t !== "string") continue;
    if (typeof rec.projectId !== "string") continue;
    if (
      rec.kind !== "session-open" &&
      rec.kind !== "save-ok" &&
      rec.kind !== "save-fail" &&
      rec.kind !== "session-close"
    ) {
      continue;
    }
    const event: CrashJournalEvent = {
      t: rec.t,
      kind: rec.kind,
      projectId: rec.projectId,
    };
    if (typeof rec.message === "string") event.message = rec.message;
    events.push(event);
  }
  return events;
}

/** Pure verdict over the raw events. */
export function analyzeCrashJournal(events: CrashJournalEvent[]): CrashJournalReport {
  if (events.length === 0) {
    return { lastSessionClean: true, lastEvent: null, lastSaveOk: null };
  }
  const lastEvent = events[events.length - 1];
  let lastSaveOk: CrashJournalEvent | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === "save-ok") {
      lastSaveOk = events[i];
      break;
    }
  }
  return {
    lastSessionClean: lastEvent.kind === "session-close",
    lastEvent,
    lastSaveOk,
  };
}

/**
 * Meta-store repository for the journal. Every writer swallows its own
 * errors — a failing journal must never fail the save, open, or close
 * path it observes.
 */
export class CrashJournalRepository {
  constructor(private readonly openDatabase: typeof openDb = openDb) {}

  async record(kind: CrashJournalEventKind, projectId: string, message?: string): Promise<void> {
    try {
      const db = await this.openDatabase();
      await tx(db, STORE_META, "readwrite", (store) => {
        const read = store.get(CRASH_JOURNAL_KEY) as IDBRequest<unknown>;
        read.onsuccess = () => {
          const event: CrashJournalEvent = { t: new Date().toISOString(), kind, projectId };
          if (message !== undefined) event.message = message;
          const next = appendCrashJournalEvent(parseCrashJournal(read.result), event);
          store.put(next, CRASH_JOURNAL_KEY);
        };
        // Return void on purpose: the tx helper settles on
        // transaction.oncomplete for void callbacks and leaves request
        // handlers alone, so the chained put inside read.onsuccess lands
        // inside the same transaction.
      });
    } catch {
      // Journal is observability — never surface into callers.
    }
  }

  /** Read + verdict. Fails closed to "clean" (no journal = nothing to report). */
  async read(): Promise<CrashJournalReport> {
    try {
      const db = await this.openDatabase();
      let raw: unknown = undefined;
      await tx(db, STORE_META, "readonly", (store) => {
        const read = store.get(CRASH_JOURNAL_KEY) as IDBRequest<unknown>;
        read.onsuccess = () => {
          raw = read.result;
        };
      });
      return analyzeCrashJournal(parseCrashJournal(raw));
    } catch {
      return { lastSessionClean: true, lastEvent: null, lastSaveOk: null };
    }
  }
}
