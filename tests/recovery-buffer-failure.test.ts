import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStatus,
  readFailedStatuses,
  readRecoveryBuffer,
  readStatus,
  recoveryBufferFits,
  recoveryBufferSize,
  recoveryCapacityStatus,
  recoveryFailureMessage,
  writeRecoveryBuffer,
  writeStatus,
  RECOVERY_STORAGE_BUDGET_CHARS,
  type RecoveryFailureReason,
} from "../src/persistence/recoveryBuffer";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * THE CRASH BUFFER MUST NOT FAIL SILENTLY (audit S-4).
 *
 * The buffer is the ONLY copy of the work that was uncommitted when the tab
 * died — the unload IndexedDB flush provably never commits, so the module's
 * own header says so. When the write failed, the crash safety net simply did
 * not exist, and the failure was DISCARDED: the writer returned a bare
 * `false` and the unload handler ignored it. The user's work was gone and
 * nobody had been told.
 *
 * Three things have to hold now:
 *
 * 1. THE WRITE ANSWERS WITH A REASON. A boolean cannot say "the quota" or
 *    "the document cannot be serialised", and the caller cannot act on one.
 * 2. THE FAILURE IS PERSISTED. It has to survive the tab close, because the
 *    tab close is the moment the user needs to be told.
 * 3. THE CAPACITY IS KNOWABLE EARLY. The user has to be warned while they can
 *    still save — a warning that arrives after the loss explains nothing.
 *
 * And the payload is COMPRESSED, because the raw JSON is what exhausted the
 * storage quota in the first place — and with one slot PER PROJECT the raw
 * payloads compete with each other for the same budget.
 */

const BUFFER_KEY_PREFIX = "kyx:recovery-buffer:v1:";

/**
 * Emulate a payload that does not fit while the SMALL records still do.
 *
 * That is the realistic case: the quota has room for the explanation, not for
 * the megabyte. The original `setItem` is captured before the spy replaces it,
 * so the records really land — a mock that swallowed them would make every
 * assertion about persistence pass without proving anything.
 */
function refuseLargePayloads(): () => void {
  const original = Storage.prototype.setItem;
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string, value: string) => {
    if (key.startsWith(BUFFER_KEY_PREFIX)) {
      throw new DOMException("quota", "QuotaExceededError");
    }
    original.call(window.localStorage, key, value);
  });
  return () => spy.mockRestore();
}

/** Emulate a store that is completely full — nothing can be written at all. */
function refuseEveryWrite(): () => void {
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("quota", "QuotaExceededError");
  });
  return () => spy.mockRestore();
}

function projectDoc(id = "p1"): ProjectDocument {
  return { ...createProjectFromTemplate("house"), id, name: "Protected Beat" };
}

/** A project big enough that raw JSON would dominate the storage quota. */
function largeProject(id = "p1"): ProjectDocument {
  const doc = projectDoc(id) as ProjectDocument & { automation: unknown[] };
  doc.automation = [];
  for (let index = 0; index < 4000; index += 1) {
    doc.automation.push({
      id: `ap-${index}`,
      trackId: "t1",
      param: "gain",
      bar: index % 64,
      beat: (index % 4) + 1,
      value: (index % 1000) / 1000,
      curve: "linear",
    });
  }
  return doc;
}

describe("the write answers with a reason, not a boolean", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("a refused write names the quota", () => {
    // The payload does not fit; the small status record still does. That is
    // the realistic case — the quota has room for the explanation, not for
    // the megabyte.
    const restore = refuseLargePayloads();
    try {
      const result = writeRecoveryBuffer(projectDoc(), "p1");
      expect(result.ok, "the failure must be visible, not a discarded boolean").toBe(false);
      expect(result.ok === false && result.reason).toBe("quota");
      expect(result.ok === false && result.bytes).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it("a completely full store still names the reason — the report cannot depend on the store", () => {
    const restore = refuseEveryWrite();
    try {
      const result = writeRecoveryBuffer(projectDoc(), "p1");
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toBe("quota");
    } finally {
      restore();
    }
  });

  it("a document JSON cannot represent says so", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = writeRecoveryBuffer(cyclic, "p1");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("unserializable");
  });

  it("a successful write reports what it stored", () => {
    const result = writeRecoveryBuffer(projectDoc(), "p1");
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.bytes).toBeGreaterThan(0);
    expect(result.ok === true && result.encoded).toBe("compressed");
  });
});

describe("the payload is compressed, so the net exists for a large project", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("a large project is stored far smaller than its raw JSON", () => {
    const doc = largeProject();
    const raw = JSON.stringify(doc).length;

    const result = writeRecoveryBuffer(doc, "p1");

    expect(result.ok).toBe(true);
    const stored = window.localStorage.getItem(`${BUFFER_KEY_PREFIX}p1`) ?? "";
    expect(stored.length, "the raw payload is what exhausted the quota").toBeLessThan(raw / 2);
  });

  it("and it still round-trips — compression must not cost the document", () => {
    const doc = largeProject();
    writeRecoveryBuffer(doc, "p1");

    const buffer = readRecoveryBuffer("p1");
    expect(buffer).not.toBeNull();
    expect((buffer?.doc as { automation: unknown[] }).automation).toHaveLength(4000);
  });

  it("the legacy v1 slot is still readable — an upgrade must not lose a buffer", () => {
    const doc = projectDoc();
    window.localStorage.setItem(
      "kyx:recovery-buffer:v1",
      JSON.stringify({ v: 1, projectId: "p1", savedAt: new Date().toISOString(), doc }),
    );

    const buffer = readRecoveryBuffer("p1");
    expect(buffer?.projectId).toBe("p1");
    expect((buffer?.doc as ProjectDocument).id).toBe("p1");
  });
});

describe("the failure is persisted — it survives the tab close", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("a refused write leaves a record the NEXT session can read", () => {
    const restore = refuseLargePayloads();
    try {
      writeRecoveryBuffer(projectDoc(), "p1");
    } finally {
      restore();
    }

    const failures = readFailedStatuses();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.projectId).toBe("p1");
    expect(failures[0]?.state).toBe("unprotected");
    expect(failures[0]?.reason).toBe("quota");
    expect(failures[0]?.lastFailureAt).toBeTruthy();
  });

  it("the record survives a LATER success — a buffer that works again does not un-happen the loss", () => {
    const restore = refuseLargePayloads();
    try {
      writeRecoveryBuffer(projectDoc(), "p1");
    } finally {
      restore();
    }
    const failedAt = readStatus("p1")?.lastFailureAt;
    expect(failedAt, "the first write must have left a record").toBeTruthy();

    writeRecoveryBuffer(projectDoc(), "p1");

    expect(readStatus("p1")?.state).toBe("protected");
    expect(readStatus("p1")?.lastFailureAt, "the historical loss must not be erased").toBe(failedAt);
  });

  it("the record lives in its own key family — a slot scan must not pick it up", () => {
    writeStatus("p1", { state: "unprotected", checkedAt: new Date().toISOString(), bytes: 10, reason: "quota" });

    expect(readRecoveryBuffer(), "the status is not a buffer").toBeNull();
    expect(readStatus("p1")?.state).toBe("unprotected");
  });

  it("the user can be told once and then let go of it", () => {
    writeStatus("p1", { state: "unprotected", checkedAt: new Date().toISOString(), bytes: 10, reason: "quota" });
    expect(readFailedStatuses()).toHaveLength(1);

    clearStatus("p1");

    expect(readFailedStatuses()).toHaveLength(0);
  });
});

describe("the capacity is knowable before the tab closes", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("a project that fits is protected", () => {
    const status = recoveryCapacityStatus(projectDoc());
    expect(status.state).toBe("protected");
    expect(status.reason).toBeUndefined();
    expect(recoveryBufferFits(projectDoc())).toBe(true);
  });

  it("a project over the budget is unprotected — and says why", () => {
    // A payload past the budget cannot be protected, and the verdict must
    // arrive while the user can still save.
    const huge = { blob: "x".repeat(RECOVERY_STORAGE_BUDGET_CHARS * 2) };
    const status = recoveryCapacityStatus(huge);
    expect(status.state).toBe("unprotected");
    expect(status.reason).toBe("too-large");
    expect(recoveryBufferFits(huge)).toBe(false);
  });

  it("the measured size is the thing the quota charges", () => {
    const size = recoveryBufferSize(projectDoc());
    expect(size.bytes).toBeGreaterThan(0);
    expect(size.bytes).toBeLessThan(JSON.stringify(projectDoc()).length);
  });
});

describe("the wording has one owner", () => {
  it("every reason has a message — the chip and the banner must say the same thing", () => {
    const reasons: RecoveryFailureReason[] = ["too-large", "quota", "no-storage", "unserializable"];
    for (const reason of reasons) {
      expect(recoveryFailureMessage(reason).length).toBeGreaterThan(0);
    }
    expect(new Set(reasons.map(recoveryFailureMessage)).size, "two reasons must not share a sentence").toBe(
      reasons.length,
    );
  });
});
