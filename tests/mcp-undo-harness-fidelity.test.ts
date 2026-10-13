import { describe, it, expect } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { splitAudioClipAtTick } from "../src/commands/clipEditing";
import { ProjectStore } from "../src/store/ProjectStore";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * UNDO-HARNESS FIDELITY.
 *
 * `snapshot()` builds a DELTA command: `undo: (d) => applyDocDelta(d,
 * backward.ops)`. It ignores the identity of `d` and applies its inverse
 * operations to whatever document it is handed. The real `ProjectStore.undo`
 * therefore passes `this.doc_` — the CURRENT document — and three MCP test
 * harnesses passed the PREVIOUS one instead.
 *
 * That is not a cosmetic mismatch. Handing a delta command the pre-mutation
 * document makes undo re-apply "restore this parent" on top of a document that
 * never left it, so a split's undo returned TWO copies of the parent clip
 * instead of removing the fragments. Any MCP test asserting undo through that
 * harness was asserting fiction.
 *
 * These specs pin the harness CONTRACT, not one command's behaviour, so the
 * next harness that reintroduces the mistake fails here.
 */

function docWithOneAudioClip(): ProjectDocument {
  const base = createProjectFromTemplate("house");
  const drum = base.tracks.find((t) => t.kind === "drum")!;
  return {
    ...base,
    arrangement: {
      ...base.arrangement,
      clips: [],
      audioClips: [
        {
          id: "audio-clip-1",
          trackId: drum.id,
          bufferId: "factory.kick.main",
          startBar: 0,
          lengthBars: 4,
          offsetSec: 0,
          trimStart: 0,
          trimEnd: 0,
          gain: 1,
          fadeIn: 0,
          fadeOut: 0,
          stretchRate: 1,
          reverse: false,
        } as never,
      ],
    },
  } as ProjectDocument;
}

const ids = (doc: ProjectDocument): string[] => (doc.arrangement.audioClips ?? []).map((c) => c.id);

/** The shape every MCP test harness must reproduce: undo applies to `current`. */
function harnessStore(): ProjectDocument {
  let current = docWithOneAudioClip();
  const undoStack: Array<{ undo: () => ProjectDocument }> = [];
  const ctx = {
    doc: () => current,
    execute: (command: {
      execute: (d: ProjectDocument) => ProjectDocument;
      undo: (d: ProjectDocument) => ProjectDocument;
    }) => {
      current = command.execute(current);
      undoStack.push({ undo: () => command.undo(current) });
    },
    undo: () => {
      const entry = undoStack.pop();
      if (entry) current = entry.undo();
    },
  };
  ctx.execute(splitAudioClipAtTick(ctx.doc(), "audio-clip-1", 2 * 4 * 480));
  ctx.undo();
  return ctx.doc();
}

/** The shape that was committed: undo applies to `prev` (the pre-mutation doc). */
function brokenHarnessStore(): ProjectDocument {
  let current = docWithOneAudioClip();
  const undoStack: Array<{ undo: () => ProjectDocument }> = [];
  const ctx = {
    doc: () => current,
    execute: (command: {
      execute: (d: ProjectDocument) => ProjectDocument;
      undo: (d: ProjectDocument) => ProjectDocument;
    }) => {
      const prev = current;
      current = command.execute(current);
      undoStack.push({ undo: () => command.undo(prev) });
    },
    undo: () => {
      const entry = undoStack.pop();
      if (entry) current = entry.undo();
    },
  };
  ctx.execute(splitAudioClipAtTick(ctx.doc(), "audio-clip-1", 2 * 4 * 480));
  ctx.undo();
  return ctx.doc();
}

describe("undo harness fidelity — the MCP test context must mirror ProjectStore", () => {
  it("CONTROL: the product undo is correct (real ProjectStore)", () => {
    const store = new ProjectStore(docWithOneAudioClip());
    store.execute(splitAudioClipAtTick(store.doc, "audio-clip-1", 2 * 4 * 480));
    expect(store.doc.arrangement.audioClips).toHaveLength(2);
    store.undo();
    expect(ids(store.doc)).toEqual(["audio-clip-1"]);
  });

  it("a harness that calls undo with the CURRENT document observes a real undo", () => {
    expect(ids(harnessStore())).toEqual(["audio-clip-1"]);
  });

  it("FALSIFICATION: the committed harness shape (undo with `prev`) does NOT observe a real undo", () => {
    // This spec is the reason the fix is trustworthy: it demonstrates the
    // defect the harness had, using the harness shape itself. It asserts the
    // BROKEN result on purpose - if a future change made `prev` correct, this
    // goes red and someone has to re-derive the claim.
    const idsAfterBrokenUndo = ids(brokenHarnessStore());
    expect(idsAfterBrokenUndo).toEqual(["audio-clip-1", "audio-clip-1"]);
    expect(new Set(idsAfterBrokenUndo).size).toBe(1); // one id, duplicated
  });

  it("redo re-applies onto the undone document (both harnesses must round-trip)", () => {
    const doc = docWithOneAudioClip();
    let current = doc;
    const stack: Array<{ undo: () => ProjectDocument; redo: () => ProjectDocument }> = [];
    const cmd = splitAudioClipAtTick(current, "audio-clip-1", 2 * 4 * 480);
    current = cmd.execute(current);
    stack.push({ undo: () => cmd.undo(current), redo: () => cmd.execute(current) });

    current = stack[0].undo();
    expect(ids(current)).toEqual(["audio-clip-1"]);
    current = stack[0].redo();
    expect(current.arrangement.audioClips).toHaveLength(2);
    expect(new Set(ids(current)).size).toBe(2); // fragments carry distinct ids
  });
});
