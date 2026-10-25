import { beforeEach, describe, expect, it } from "vitest";
import {
  clearRecoveryBuffer,
  prepareRecoveredDocument,
  readRecoveryBuffer,
  recoverProject,
  writeRecoveryBuffer,
  type RecoveryBuffer,
} from "../src/persistence/recoveryBuffer";
import { SCHEMA_VERSION } from "../src/project-model/schema";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * THE RECOVERY MUST NOT BECOME THE DESTRUCTION.
 *
 * `repo.save()` writes the document RAW — no shape check, no migration — while
 * `repo.load()` validates and REFUSES what it cannot read. "Recover" used to
 * hand the buffered document straight to `save()`, so a buffer that was
 * malformed, from another project, or written by a newer app version did not
 * merely fail to restore:
 *
 *     good body  ──save(raw buffer)──▶  body replaced
 *                  ──load()──▶  validate fails ──▶ null ──▶  project gone
 *
 * The crash journal keeps EVENTS, not bodies, so there was nothing to fall
 * back to. The fix is not "save more carefully" — it is "never write a
 * document you cannot vouch for".
 *
 * The buffer itself is UNTRUSTED input: it is a synchronous `localStorage`
 * write (user-writable, and it survives across app versions), and it is the
 * only copy of the work that was uncommitted when the tab died. So a refusal
 * must ALSO keep the buffer — the work is not thrown away either.
 */

function projectDoc(id = "p1"): ProjectDocument {
  return { ...createProjectFromTemplate("house"), id, name: "Recovered Beat" };
}

function bufferFor(doc: unknown, projectId = "p1"): RecoveryBuffer {
  return { projectId, savedAt: new Date().toISOString(), doc };
}

function recordingTarget(): { save: (doc: ProjectDocument) => Promise<void>; saved: ProjectDocument[] } {
  const saved: ProjectDocument[] = [];
  return {
    saved,
    save: async (doc: ProjectDocument) => {
      saved.push(doc);
    },
  };
}

describe("recovery cannot destroy the saved project", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("refuses a malformed buffer and writes NOTHING", async () => {
    const target = recordingTarget();
    const outcome = await recoverProject(target, bufferFor({ id: "p1", tracks: "not-an-array" }));

    expect(outcome.ok).toBe(false);
    expect(target.saved, "a document we cannot read must never reach the repository").toHaveLength(0);
    expect(outcome.ok === false && outcome.reason).toContain("nothing was overwritten");
  });

  it("refuses a buffer that belongs to ANOTHER project", async () => {
    const target = recordingTarget();
    const outcome = await recoverProject(target, bufferFor(projectDoc("somebody-else"), "p1"));

    expect(outcome.ok).toBe(false);
    expect(target.saved).toHaveLength(0);
    expect(outcome.ok === false && outcome.reason).toContain("different project");
  });

  it("refuses a buffer written by a NEWER app version", async () => {
    const target = recordingTarget();
    const future = { ...projectDoc(), schemaVersion: SCHEMA_VERSION + 1 };
    const outcome = await recoverProject(target, bufferFor(future));

    expect(outcome.ok).toBe(false);
    expect(target.saved, "a future schema must not be written raw into the library").toHaveLength(0);
    expect(outcome.ok === false && outcome.reason).toContain("newer version");
  });

  it("recovers a valid buffer — exactly one write, with the document", async () => {
    const target = recordingTarget();
    const doc = projectDoc();
    const outcome = await recoverProject(target, bufferFor(doc));

    expect(outcome.ok).toBe(true);
    expect(target.saved).toHaveLength(1);
    expect(target.saved[0]?.id).toBe("p1");
  });

  it("a refusal KEEPS the buffer — the work is still the only copy", async () => {
    const target = recordingTarget();
    // The buffer is in the STORE, not just in memory: the refusal must not
    // clear it, because it is the only copy of the uncommitted work.
    writeRecoveryBuffer({ id: "p1", tracks: "not-an-array" }, "p1");
    const buffer = readRecoveryBuffer()!;

    await recoverProject(target, buffer);

    expect(readRecoveryBuffer(), "a refused recovery must not throw the work away").not.toBeNull();
    expect(readRecoveryBuffer("p1")?.projectId).toBe("p1");
  });

  it("a recovered buffer is cleared from the store", async () => {
    const target = recordingTarget();
    writeRecoveryBuffer(projectDoc(), "p1");
    const buffer = readRecoveryBuffer()!;

    await recoverProject(target, buffer);
    clearRecoveryBuffer(buffer.projectId);

    expect(readRecoveryBuffer()).toBeNull();
  });
});

describe("prepareRecoveredDocument — the verdict, without a repository", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("migrates an OLD schema into this build", () => {
    const doc = { ...projectDoc(), schemaVersion: SCHEMA_VERSION - 1 };
    const verdict = prepareRecoveredDocument(bufferFor(doc));
    expect(verdict.ok).toBe(true);
    expect(verdict.ok === true && verdict.doc.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("refuses a document that is not a project at all", () => {
    expect(prepareRecoveredDocument(bufferFor(null)).ok).toBe(false);
    expect(prepareRecoveredDocument(bufferFor("nope")).ok).toBe(false);
    expect(prepareRecoveredDocument(bufferFor({})).ok).toBe(false);
  });
});

/**
 * ONE SLOT PER PROJECT.
 *
 * The buffer used to live under a single global key, so the second dirty tab
 * to close destroyed the first tab's only copy of its uncommitted work — the
 * exact loss the buffer exists to prevent.
 */
describe("recovery buffer — one slot per project", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("a second project's buffer does not destroy the first project's", () => {
    expect(writeRecoveryBuffer({ id: "p1", note: "work in tab one" }, "p1")).toBe(true);
    expect(writeRecoveryBuffer({ id: "p2", note: "work in tab two" }, "p2")).toBe(true);

    expect(readRecoveryBuffer("p1")?.doc).toEqual({ id: "p1", note: "work in tab one" });
    expect(readRecoveryBuffer("p2")?.doc).toEqual({ id: "p2", note: "work in tab two" });
  });

  it("a project-scoped clear leaves the other project's buffer alone", () => {
    writeRecoveryBuffer({ id: "p1" }, "p1");
    writeRecoveryBuffer({ id: "p2" }, "p2");

    clearRecoveryBuffer("p1");

    expect(readRecoveryBuffer("p1")).toBeNull();
    expect(readRecoveryBuffer("p2")?.projectId).toBe("p2");
  });

  it("an unscoped clear drops every slot", () => {
    writeRecoveryBuffer({ id: "p1" }, "p1");
    writeRecoveryBuffer({ id: "p2" }, "p2");

    clearRecoveryBuffer();

    expect(readRecoveryBuffer("p1")).toBeNull();
    expect(readRecoveryBuffer("p2")).toBeNull();
  });

  it("still reads the LEGACY global key — an upgrade must not lose the buffer", () => {
    window.localStorage.setItem(
      "kyx:recovery-buffer:v1",
      JSON.stringify({ v: 1, projectId: "p1", savedAt: new Date().toISOString(), doc: { id: "p1" } }),
    );

    expect(readRecoveryBuffer("p1")?.projectId).toBe("p1");
    expect(readRecoveryBuffer()?.projectId).toBe("p1");
  });

  it("the legacy key is dropped once the project's own slot is written", () => {
    window.localStorage.setItem(
      "kyx:recovery-buffer:v1",
      JSON.stringify({ v: 1, projectId: "p1", savedAt: new Date().toISOString(), doc: { id: "p1", stale: true } }),
    );

    writeRecoveryBuffer({ id: "p1", fresh: true }, "p1");

    expect(window.localStorage.getItem("kyx:recovery-buffer:v1")).toBeNull();
    expect(readRecoveryBuffer("p1")?.doc).toEqual({ id: "p1", fresh: true });
  });
});
