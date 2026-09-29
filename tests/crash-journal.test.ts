import { describe, expect, it, vi, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  analyzeCrashJournal,
  appendCrashJournalEvent,
  parseCrashJournal,
  CRASH_JOURNAL_MAX_EVENTS,
} from "../src/persistence/crashJournal";
import type { CrashJournalEvent } from "../src/persistence/crashJournal";

/**
 * Crash journal (Wave 1 robustness — atomic saves + crash journal).
 *
 * The data layer is already crash-safe (project body + recent pointer
 * commit in ONE IndexedDB transaction). This suite pins the detection
 * layer above it: the journal must fingerprint a session that died
 * without a deliberate close, must survive corrupt records, and must be
 * bounded — while never being allowed to throw into the callers that
 * merely observe it.
 */

const ev = (kind: CrashJournalEvent["kind"], projectId = "p1", t = "2026-09-29T10:00:00.000Z"): CrashJournalEvent => ({
  t,
  kind,
  projectId,
});

// ═══════════════════════════════════════════════════════════
// Pure: append / parse / analyze
// ═══════════════════════════════════════════════════════════

describe("appendCrashJournalEvent (pure)", () => {
  it("appends and bounds the history to CRASH_JOURNAL_MAX_EVENTS, oldest dropped first", () => {
    let events: CrashJournalEvent[] = [];
    for (let i = 0; i < CRASH_JOURNAL_MAX_EVENTS + 10; i++) {
      events = appendCrashJournalEvent(events, ev("save-ok", "p1", `t${i}`));
    }
    expect(events.length).toBe(CRASH_JOURNAL_MAX_EVENTS);
    expect(events[0].t).toBe("t10");
    expect(events[events.length - 1].t).toBe(`t${CRASH_JOURNAL_MAX_EVENTS + 9}`);
  });

  it("does not mutate the input array", () => {
    const original = [ev("session-open")];
    const next = appendCrashJournalEvent(original, ev("session-close"));
    expect(original.length).toBe(1);
    expect(next.length).toBe(2);
  });
});

describe("parseCrashJournal (defensive)", () => {
  it("survives non-array and corrupt records", () => {
    expect(parseCrashJournal(undefined)).toEqual([]);
    expect(parseCrashJournal(null)).toEqual([]);
    expect(parseCrashJournal("garbage")).toEqual([]);
    expect(parseCrashJournal({})).toEqual([]);
  });

  it("drops malformed entries individually, keeps well-shaped ones", () => {
    const stored = [
      ev("session-open"),
      { t: 123, kind: "save-ok", projectId: "p" }, // bad t
      { t: "t", kind: "wednesday", projectId: "p" }, // bad kind
      { t: "t", kind: "save-ok" }, // missing projectId
      "not an object",
      { ...ev("save-fail", "p2", "t2"), message: "QuotaExceeded" },
    ];
    expect(parseCrashJournal(stored)).toEqual([
      ev("session-open"),
      { t: "t2", kind: "save-fail", projectId: "p2", message: "QuotaExceeded" },
    ]);
  });
});

describe("analyzeCrashJournal (verdicts)", () => {
  it("empty journal → clean, nothing to report", () => {
    expect(analyzeCrashJournal([])).toEqual({
      lastSessionClean: true,
      lastEvent: null,
      lastSaveOk: null,
    });
  });

  it("ends on session-close → clean shutdown", () => {
    const report = analyzeCrashJournal([ev("session-open"), ev("save-ok"), ev("session-close")]);
    expect(report.lastSessionClean).toBe(true);
    expect(report.lastSaveOk).not.toBeNull();
  });

  it("ends on session-open → tab died mid-session, no save ever completed", () => {
    const report = analyzeCrashJournal([ev("session-open", "p1")]);
    expect(report.lastSessionClean).toBe(false);
    expect(report.lastEvent?.kind).toBe("session-open");
    expect(report.lastSaveOk).toBeNull();
  });

  it("ends on save-ok → tab died after a save (the crash fingerprint the banner is for)", () => {
    const report = analyzeCrashJournal([ev("session-open"), ev("save-ok", "p1", "t9")]);
    expect(report.lastSessionClean).toBe(false);
    expect(report.lastSaveOk?.t).toBe("t9");
  });

  it("ends on save-fail → unclean with the failure as last event", () => {
    const report = analyzeCrashJournal([ev("session-open"), ev("save-fail")]);
    expect(report.lastSessionClean).toBe(false);
    expect(report.lastEvent?.kind).toBe("save-fail");
  });
});

// ═══════════════════════════════════════════════════════════
// Repository against a fresh fake-indexeddb per test
// ═══════════════════════════════════════════════════════════

/**
 * db.ts caches its IDBDatabase promise at module scope; resetting the
 * module registry plus the global factory gives every test a private DB.
 */
async function freshRepo() {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  const mod = await import("../src/persistence/crashJournal");
  return new mod.CrashJournalRepository();
}

async function drain(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("CrashJournalRepository (fake-indexeddb)", () => {
  beforeEach(() => {
    vi.resetModules();
    globalThis.indexedDB = new IDBFactory();
  });

  it("full lifecycle: open → save-ok → close reads back CLEAN", async () => {
    const repo = await freshRepo();
    await repo.record("session-open", "p1");
    await repo.record("save-ok", "p1");
    await repo.record("session-close", "p1");
    const report = await repo.read();
    expect(report.lastSessionClean).toBe(true);
    expect(report.lastEvent?.kind).toBe("session-close");
  });

  it("crash mid-session: open → save-ok → (no close) reads UNCLEAN with lastSaveOk", async () => {
    const repo = await freshRepo();
    await repo.record("session-open", "p1");
    await repo.record("save-ok", "p1", "saved");
    await drain();
    const report = await repo.read();
    expect(report.lastSessionClean).toBe(false);
    expect(report.lastEvent?.kind).toBe("save-ok");
    expect(report.lastSaveOk?.projectId).toBe("p1");
  });

  it("crash with zero completed saves: unclean, lastSaveOk null", async () => {
    const repo = await freshRepo();
    await repo.record("session-open", "p1");
    await drain();
    const report = await repo.read();
    expect(report.lastSessionClean).toBe(false);
    expect(report.lastSaveOk).toBeNull();
  });

  it("survives a corrupt record written under the journal key (older/foreign build)", async () => {
    const repo = await freshRepo();
    const { CRASH_JOURNAL_KEY } = await import("../src/persistence/crashJournal");
    const { openDb, STORE_META } = await import("../src/persistence/db");
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, "readwrite");
      tx.objectStore(STORE_META).put("i am not an array", CRASH_JOURNAL_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    // Corrupt record + a fresh event: parse drops the garbage, history
    // restarts from the new event, nothing throws.
    await repo.record("session-open", "p1");
    const report = await repo.read();
    expect(report.lastSessionClean).toBe(false);
    expect(report.lastEvent?.kind).toBe("session-open");
  });

  it("bounded history through the repository (oldest events dropped)", async () => {
    const repo = await freshRepo();
    // record() awaits the transaction's oncomplete, so each append is
    // durable before the next one starts — no extra draining needed.
    for (let i = 0; i < CRASH_JOURNAL_MAX_EVENTS + 8; i++) {
      await repo.record("save-ok", "p1");
    }
    const report = await repo.read();
    expect(report.lastSessionClean).toBe(false);
    expect(report.lastSaveOk).not.toBeNull();
    // The full raw history is capped.
    const { CRASH_JOURNAL_KEY } = await import("../src/persistence/crashJournal");
    const { openDb, STORE_META } = await import("../src/persistence/db");
    const db = await openDb();
    const raw = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE_META, "readonly");
      const req = tx.objectStore(STORE_META).get(CRASH_JOURNAL_KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(Array.isArray(raw)).toBe(true);
    expect((raw as unknown[]).length).toBe(CRASH_JOURNAL_MAX_EVENTS);
  }, 15000);
});
