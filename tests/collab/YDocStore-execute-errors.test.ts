/**
 * Regression tests for the YDocStore.execute() error guard.
 *
 * Bug: when applyToYDoc / command.execute / applyProjectToYMap throws
 * inside yDoc.transact(), Y.Doc was left half-applied, afterMutation()
 * never fired, and listeners were stuck on a stale snapshot. The fix
 * surfaces the error via console.error, calls emit() so listeners
 * re-render, and skips undo/history advancement (do NOT throw out —
 * the UI is not exception-safe).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YDocStore } from "../../src/collab/YDocStore";
import { setBpm } from "../../src/commands/commands";
import { createDefaultProject, normalizeProject } from "../../src/project-model/schema";
import type { Command } from "../../src/commands/types";

function makeStore(): YDocStore {
  return YDocStore.fromDocument(createDefaultProject());
}

beforeEach(() => {
  // Silence the intentional console.error spam; we assert it fires below.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("YDocStore.execute() error guard", () => {
  it("catches applyToYDoc throws, logs and emits so listeners do not freeze", () => {
    const store = makeStore();
    // emit() is private; subscribe to the public API to detect re-renders.
    let emitCount = 0;
    store.subscribe(() => {
      emitCount += 1;
    });
    const baselineEmits = emitCount;
    const baselineBpm = store.doc.bpm;

    const boom: Command = {
      type: "test/boom",
      label: "Boom",
      execute: (d) => d,
      undo: (d) => d,
      applyToYDoc: () => {
        throw new Error("boom from yjs helper");
      },
    };

    expect(() => store.execute(boom)).not.toThrow();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(`[YDocStore] command "test/boom" threw`),
      expect.any(Error),
    );
    // Listener still fired — the UI gets a chance to re-render against the
    // (unchanged) projection, instead of being stuck on a stale snapshot.
    expect(emitCount).toBeGreaterThan(baselineEmits);

    // State must be intact: the bpm baseline is preserved and the doomed
    // command did not land a phantom undo step.
    expect(store.doc.bpm).toBe(baselineBpm);
    expect(store.canUndo).toBe(false);
  });

  it("does not advance the undo stack when a command throws", () => {
    const store = makeStore();
    // A successful command lands on the undo stack.
    store.execute(setBpm(store.doc, 130));
    expect(store.canUndo).toBe(true);
    const undoDepthBefore = store.undoStackLength;

    const boom: Command = {
      type: "test/boom-2",
      label: "Boom 2",
      execute: () => {
        throw new Error("boom from plain command");
      },
      undo: (d) => d,
    };
    store.execute(boom);

    // Undo stack depth must not have grown.
    expect(store.undoStackLength).toBe(undoDepthBefore);
    // The prior successful command is still on the undo stack and undoable.
    expect(store.canUndo).toBe(true);
  });

  it("survives a throwing fallback (no applyToYDoc) command too", () => {
    const store = makeStore();
    const boom: Command = {
      type: "test/boom-3",
      label: "Boom 3",
      // No applyToYDoc → store.execute() will call command.execute(this.doc_)
      // and then applyProjectToYMap(). Force the error inside command.execute
      // itself.
      execute: () => {
        throw new Error("boom from command.execute");
      },
      undo: (d) => d,
    };
    expect(() => store.execute(boom)).not.toThrow();
    // Normalization is safe on the unchanged doc — the test is just that the
    // store still projects a usable document.
    const projected = normalizeProject(store.doc);
    expect(projected).toBeDefined();
  });
});
