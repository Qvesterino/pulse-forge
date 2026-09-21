/**
 * ProjectStore edge cases — command execution, undo/redo, coalescing, history
 * limit, undo-frame grouping, and replaceDoc interactions.
 *
 * The companion `state-store-adversarial.test.ts` covers listener-lifecycle
 * races; this file pins the **state-machine** contract — that the store
 * stays in a valid invariant under stress and malformed inputs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectStore } from "../src/store/ProjectStore";
import type { Command } from "../src/commands/types";
import { createDefaultProject } from "../src/project-model/schema";
import type { ProjectDocument } from "../src/project-model/types";

/** Default project tempo (the "house" template ships at 124 BPM). */
const DEFAULT_BPM = 124;

function setBpm(doc: ProjectDocument, bpm: number): ProjectDocument {
  return { ...doc, bpm };
}

/**
 * Apply a setBpm command that captures the CURRENT bpm in the undo closure
 * — the store hands undo the post-execute doc, so the command itself is
 * responsible for remembering the pre-execute value.
 */
function applySetBpm(store: ProjectStore, bpm: number, coalesceKey?: string): void {
  const prev = store.doc.bpm;
  store.execute({
    type: "setBpm",
    label: `set BPM to ${bpm}`,
    coalesceKey,
    execute: (d) => setBpm(d, bpm),
    undo: (d) => setBpm(d, prev),
  });
}

describe("ProjectStore — command input edge cases", () => {
  let store: ProjectStore;
  beforeEach(() => {
    store = new ProjectStore(createDefaultProject());
  });
  afterEach(() => {
    store.replaceDoc(createDefaultProject()); // discard history for next test
  });

  it("a throwing command.execute does not advance history", () => {
    // A command whose execute() throws must NOT leave a phantom entry in
    // the undo stack — that would let the user "undo" an apply that never
    // happened and corrupt the doc state.
    const boom: Command = {
      type: "boom",
      label: "boom",
      execute: () => {
        throw new Error("execute failed");
      },
      undo: (d) => d,
    };
    expect(() => store.execute(boom)).toThrow();
    expect(store.undoStackLength).toBe(0);
    expect(store.doc.bpm).toBe(DEFAULT_BPM);
  });

  it("a command whose undo throws leaves the doc in the post-execute state", () => {
    // A broken undo must surface the underlying error rather than swallow
    // it — a swallowed undo silently leaves the doc mutated and confuses
    // the user. Pin that undo() throws and the doc stays at the post-
    // execute bpm.
    const brokenUndo: Command = {
      type: "broken",
      label: "broken undo",
      execute: (d) => setBpm(d, 200),
      undo: () => {
        throw new Error("undo failed");
      },
    };
    store.execute(brokenUndo);
    expect(store.doc.bpm).toBe(200);
    expect(() => store.undo()).toThrow();
    expect(store.doc.bpm).toBe(200);
  });

  it("survives a structurally-malformed command without crashing", () => {
    // The store does NOT validate command fields at runtime — that's the
    // caller's responsibility (TS types guard at compile time, plugin
    // loader guards at import time). A command that happens to slip
    // through must neither crash the store nor leave the doc undefined.
    const malformed = {
      execute: (d: ProjectDocument) => setBpm(d, 999),
      undo: (d: ProjectDocument) => d,
    } as unknown as Command;
    expect(() => store.execute(malformed)).not.toThrow();
    expect(store.doc).toBeDefined();
    // The doc either moves or doesn't — both are acceptable — but position
    // must remain a finite number (the scheduler reads it every tick).
    expect(Number.isFinite(store.doc.bpm)).toBe(true);
  });
});

describe("ProjectStore — undo / redo state machine", () => {
  let store: ProjectStore;
  beforeEach(() => {
    store = new ProjectStore(createDefaultProject());
  });

  it("undo() on an empty stack is a no-op (does not throw)", () => {
    expect(store.undoStackLength).toBe(0);
    expect(() => store.undo()).not.toThrow();
    expect(store.doc.bpm).toBe(DEFAULT_BPM);
  });

  it("redo() on an empty redo stack is a no-op (does not throw)", () => {
    expect(() => store.redo()).not.toThrow();
    expect(store.doc.bpm).toBe(DEFAULT_BPM);
  });

  it("three commands + two undos + two redos restores the third state", () => {
    applySetBpm(store, 130);
    applySetBpm(store, 140);
    applySetBpm(store, 150);
    expect(store.doc.bpm).toBe(150);
    store.undo();
    store.undo();
    expect(store.doc.bpm).toBe(130);
    store.redo();
    store.redo();
    expect(store.doc.bpm).toBe(150);
  });

  it("a new execute() after undo clears the redo stack", () => {
    applySetBpm(store, 140);
    applySetBpm(store, 150);
    store.undo();
    // After undo, canRedo is true. A new edit must clear that.
    expect(store.canRedo).toBe(true);
    applySetBpm(store, 160);
    expect(store.canRedo).toBe(false);
    // The redo stack was reset — calling redo() now is a no-op, not a jump
    // back to 150 (the old undo branch is gone).
    store.redo();
    expect(store.doc.bpm).toBe(160);
  });
});

describe("ProjectStore — coalescing of continuous gestures", () => {
  let store: ProjectStore;
  beforeEach(() => {
    store = new ProjectStore(createDefaultProject());
  });

  it("three commands with the same coalesceKey within the window collapse into one history entry", () => {
    // MIDI macro sweep scenario: a single user gesture fires 3 setBpm commands
    // back-to-back. They must coalesce into ONE undo step — undoing returns to
    // the pre-gesture state (BPM DEFAULT_BPM), not to the first intermediate BPM.
    applySetBpm(store, 125, "midi:macro:bpm");
    applySetBpm(store, 135, "midi:macro:bpm");
    applySetBpm(store, 145, "midi:macro:bpm");
    expect(store.doc.bpm).toBe(145);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.bpm).toBe(DEFAULT_BPM);
  });

  it("commands with different coalesceKey do not coalesce", () => {
    applySetBpm(store, 125, "gesture:A");
    applySetBpm(store, 135, "gesture:B");
    applySetBpm(store, 145, "gesture:C");
    expect(store.undoStackLength).toBe(3);
    store.undo();
    expect(store.doc.bpm).toBe(135);
    store.undo();
    expect(store.doc.bpm).toBe(125);
    store.undo();
    expect(store.doc.bpm).toBe(DEFAULT_BPM);
  });

  it("a coalesced group preserves the final state in the redo chain", () => {
    applySetBpm(store, 125, "macro");
    applySetBpm(store, 135, "macro");
    store.undo();
    // After undo of the coalesced group, redo should land back at the
    // final BPM (135), not the first one.
    store.redo();
    expect(store.doc.bpm).toBe(135);
  });
});

describe("ProjectStore — undo-frame grouping", () => {
  let store: ProjectStore;
  beforeEach(() => {
    store = new ProjectStore(createDefaultProject());
  });

  it("beginUndoFrame + 3 commands + endUndoFrame collapses into one history entry", () => {
    store.beginUndoFrame("macro");
    applySetBpm(store, 125);
    applySetBpm(store, 135);
    applySetBpm(store, 145);
    store.endUndoFrame();
    expect(store.doc.bpm).toBe(145);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.bpm).toBe(DEFAULT_BPM);
  });

  it("nested beginUndoFrame is a no-op (prevents accidental recursion)", () => {
    store.beginUndoFrame("outer");
    store.beginUndoFrame("inner"); // ignored
    applySetBpm(store, 140);
    store.endUndoFrame();
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.bpm).toBe(DEFAULT_BPM);
  });

  it("endUndoFrame on an empty frame is a no-op (no spurious history entry)", () => {
    store.beginUndoFrame("empty");
    store.endUndoFrame();
    expect(store.undoStackLength).toBe(0);
  });
});

describe("ProjectStore — history-limit eviction", () => {
  it("does not grow the undo stack beyond HISTORY_LIMIT (oldest evicted)", () => {
    // The store caps undo stack at HISTORY_LIMIT (256 in src/store/ProjectStore.ts).
    // Pushing 400 commands must not OOM — the oldest 144 entries are evicted
    // and the remaining 256 stay addressable by undo/redo.
    const store = new ProjectStore(createDefaultProject());
    for (let i = 0; i < 400; i++) {
      applySetBpm(store, DEFAULT_BPM + (i % 80));
    }
    expect(store.undoStackLength).toBeLessThanOrEqual(256);
    expect(Number.isFinite(store.doc.bpm)).toBe(true);
  });
});

describe("ProjectStore — replaceDoc clears history", () => {
  it("replaceDoc(doc) wipes undo and redo stacks (new doc = new history)", () => {
    // Replacing the doc must also drop the undo/redo chain — otherwise a
    // user can undo INTO the pre-replace state and lose the new project
    // they just loaded. The contract is "new doc = new history".
    const store = new ProjectStore(createDefaultProject());
    applySetBpm(store, 140);
    applySetBpm(store, 150);
    store.undo();
    expect(store.undoStackLength).toBeGreaterThan(0);
    expect(store.canRedo).toBe(true);

    const newDoc = createDefaultProject();
    store.replaceDoc(newDoc);
    expect(store.undoStackLength).toBe(0);
    expect(store.canRedo).toBe(false);
    expect(() => store.undo()).not.toThrow();
    expect(() => store.redo()).not.toThrow();
  });
});

describe("ProjectStore — subscribe notifies on every mutation", () => {
  it("listener fires once per execute() and once per undo()/redo()", () => {
    const store = new ProjectStore(createDefaultProject());
    const listener = vi.fn();
    store.subscribe(listener);
    applySetBpm(store, 140);
    applySetBpm(store, 150);
    store.undo();
    store.redo();
    // 4 mutations → 4 notifications (no coalescing without a coalesceKey).
    expect(listener).toHaveBeenCalledTimes(4);
  });
});
