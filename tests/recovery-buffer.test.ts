import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRecoveryBuffer,
  isBufferWorthOffering,
  readRecoveryBuffer,
  writeRecoveryBuffer,
} from "../src/persistence/recoveryBuffer";

/**
 * D20 recovery buffer. The module is deliberately synchronous end to end —
 * an async write is the exact thing that does not survive unload.
 */

const KEY = "kyx:recovery-buffer:v1";

describe("recovery buffer", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips a document with its project id and timestamp", () => {
    const doc = { id: "p1", name: "Beat", patterns: [{ rows: { kick: [1, 0] } }] };
    expect(writeRecoveryBuffer(doc, "p1")).toBe(true);

    const buffer = readRecoveryBuffer();
    expect(buffer?.projectId).toBe("p1");
    expect(buffer?.doc).toEqual(doc);
    expect(Number.isFinite(Date.parse(buffer?.savedAt ?? ""))).toBe(true);
  });

  it("reports null when nothing was written", () => {
    expect(readRecoveryBuffer()).toBeNull();
  });

  it("clear removes it", () => {
    writeRecoveryBuffer({ id: "p1" }, "p1");
    clearRecoveryBuffer();
    expect(readRecoveryBuffer()).toBeNull();
  });

  it("drops a corrupt leftover instead of offering to restore garbage", () => {
    window.localStorage.setItem(KEY, "{not json");
    expect(readRecoveryBuffer()).toBeNull();
    // ...and does not leave it lying around to fail again next boot.
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("drops a structurally wrong entry", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ v: 1, projectId: 42 }));
    expect(readRecoveryBuffer()).toBeNull();
    window.localStorage.setItem(KEY, JSON.stringify({ v: 1, savedAt: "2026-10-12T00:00:00.000Z" }));
    expect(readRecoveryBuffer()).toBeNull();
  });

  it("degrades quietly when storage is full rather than throwing", () => {
    // Emulate QuotaExceededError — the real one for a project larger than
    // localStorage will take. The unload path must survive it. jsdom's
    // localStorage is a Proxy, so stub the prototype method rather than the
    // instance property (assigning to the instance is silently ignored).
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    try {
      expect(writeRecoveryBuffer({ id: "p1" }, "p1")).toBe(false);
      expect(readRecoveryBuffer()).toBeNull();
    } finally {
      setItem.mockRestore();
    }
  });

  it("survives a document JSON cannot represent", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(writeRecoveryBuffer(cyclic, "p1")).toBe(false);
  });
});

/**
 * THE BUFFER IS THE ONLY COPY.
 *
 * The unload save flush provably never commits (the module's own header), so
 * the buffer holds the ONLY copy of the work that was uncommitted when the tab
 * died. That makes it precious: nothing may delete it except the user, a
 * corrupt payload, or a save of the project it belongs to.
 *
 * The buffer is ONE global slot, so a project-scoped clear is the only way to
 * honour that. An unconditional clear let the first autosave of an unrelated
 * project destroy another project's uncommitted work — silently, and before
 * the user was ever offered it.
 */
describe("recovery buffer — project scoping", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("a save of ANOTHER project does not destroy this project's buffer", () => {
    expect(writeRecoveryBuffer({ id: "p1", note: "uncommitted work" }, "p1")).toBe(true);

    // Project Q commits a save. Q is not the project the buffer belongs to.
    clearRecoveryBuffer("q-other");

    const buffer = readRecoveryBuffer();
    expect(buffer, "another project's save must not destroy this buffer").not.toBeNull();
    expect(buffer?.projectId).toBe("p1");
    expect(buffer?.doc).toEqual({ id: "p1", note: "uncommitted work" });
  });

  it("a save of the SAME project clears its buffer", () => {
    expect(writeRecoveryBuffer({ id: "p1" }, "p1")).toBe(true);

    clearRecoveryBuffer("p1");

    expect(readRecoveryBuffer(), "the saved project's buffer must not survive its own save").toBeNull();
  });

  it("an UNSCOPED clear still removes it (the user dismissed or recovered it)", () => {
    expect(writeRecoveryBuffer({ id: "p1" }, "p1")).toBe(true);
    clearRecoveryBuffer();
    expect(readRecoveryBuffer()).toBeNull();
  });

  it("a scoped clear of a project with no buffer is a no-op, not a throw", () => {
    expect(() => clearRecoveryBuffer("p1")).not.toThrow();
    expect(readRecoveryBuffer()).toBeNull();
  });

  it("a scoped clear of one project leaves a buffer written for another alone", () => {
    expect(writeRecoveryBuffer({ id: "p2" }, "p2")).toBe(true);
    clearRecoveryBuffer("p1");
    expect(readRecoveryBuffer()?.projectId).toBe("p2");
  });
});

describe("isBufferWorthOffering", () => {
  const buffer = { projectId: "p1", savedAt: "2026-10-12T10:00:00.000Z", doc: {} };

  it("offers the buffer when the saved project is older", () => {
    expect(isBufferWorthOffering(buffer, "2026-10-12T09:00:00.000Z")).toBe(true);
  });

  it("refuses the buffer when a later save already landed", () => {
    // The rule that stops "Recover" from DOWNGRADING current work.
    expect(isBufferWorthOffering(buffer, "2026-10-12T11:00:00.000Z")).toBe(false);
    expect(isBufferWorthOffering(buffer, "2026-10-12T10:00:00.000Z")).toBe(false);
  });

  it("offers it when the project is unknown or the timestamps are unreadable", () => {
    expect(isBufferWorthOffering(buffer, null)).toBe(true);
    expect(isBufferWorthOffering(buffer, "not a date")).toBe(true);
    expect(isBufferWorthOffering({ ...buffer, savedAt: "not a date" }, "2026-10-12T09:00:00.000Z")).toBe(true);
  });
});
