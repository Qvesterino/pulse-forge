import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { ProjectStore } from "../src/store/ProjectStore";
import { computeDocDelta, deepEqualRef, applyDocDelta } from "../src/commands/docDelta";
import { addArrangementClip, moveArrangementClip, resizeArrangementClip } from "../src/commands/commands";

/**
 * AUDIT 01 — Editing & Timeline: dead undo entries from no-op geometry edits.
 *
 * `transitionsForClips()` returns `undefined` when an arrangement has no
 * transitions, and the move/resize/ripple factories wrote that `undefined` as
 * an explicit own key. The delta engine read the added key as a real change,
 * so the store pushed a history entry whose undo produced a byte-identical
 * document — a Ctrl+Z the user has to press for no edit.
 *
 * The user-facing route: drag a scene clip by less than half a bar. The panel's
 * guard compares the UNROUNDED drag value (`finalDrag.startBar !==
 * current.origStart`), but `moveArrangementClip` rounds to a whole bar, so a
 * 0.1–0.49 bar drag passes the guard and lands exactly where it started.
 *
 * Fixed by making ABSENT ≡ `undefined` in both `deepEqualRef` and
 * `diffObject`: a key present with an `undefined` value is not a change the
 * JSON-persisted document can carry.
 */

function storeWithClip(startBar = 4, lengthBars = 2) {
  const store = new ProjectStore(normalizeProject({ ...createProjectFromTemplate("house"), arrangement: { clips: [] } }));
  const sceneId = store.getDoc().scenes[0]!.id;
  store.execute(addArrangementClip(store.getDoc(), sceneId, startBar, lengthBars));
  return store;
}

/** Execute, then undo — report whether a history entry was pushed for nothing. */
function deadUndoStep(make: (store: ProjectStore) => void): boolean {
  const store = storeWithClip();
  const before = JSON.stringify(store.getDoc());
  const depth0 = store.undoStackLength;
  make(store);
  const depth1 = store.undoStackLength;
  if (depth1 === depth0) return false; // no entry pushed — not a dead step
  const after = JSON.stringify(store.getDoc());
  if (before !== after) return false; // the edit was real — undo is meaningful
  store.undo();
  return JSON.stringify(store.getDoc()) === after; // undo changed nothing
}

describe("no-op geometry edits push no undo entry (audit 01)", () => {
  it("does not push a history entry when a scene clip is moved onto its own bar", () => {
    expect(deadUndoStep((s) => s.execute(moveArrangementClip(s.getDoc(), s.getDoc().arrangement.clips[0]!.id, 4)))).toBe(
      false,
    );
  });

  it("does not push a history entry for the sub-bar drag that rounds back to the origin", () => {
    // The UI-reachable case: 4 → 4.1 passes `finalDrag.startBar !== origStart`
    // (ArrangementPanel.tsx:2749) but rounds back to bar 4 inside the command.
    for (const dragged of [4.1, 4.25, 4.49]) {
      expect(deadUndoStep((s) => s.execute(moveArrangementClip(s.getDoc(), s.getDoc().arrangement.clips[0]!.id, dragged)))).toBe(
        false,
      );
    }
  });

  it("does not push a history entry for a sub-bar resize that rounds back", () => {
    expect(
      deadUndoStep((s) => s.execute(resizeArrangementClip(s.getDoc(), s.getDoc().arrangement.clips[0]!.id, 2.4))),
    ).toBe(false);
  });

  it("still records a REAL move — the fix must not swallow meaningful history", () => {
    const store = storeWithClip();
    const clipId = store.getDoc().arrangement.clips[0]!.id;
    const depth0 = store.undoStackLength;
    store.execute(moveArrangementClip(store.getDoc(), clipId, 8));
    expect(store.undoStackLength).toBe(depth0 + 1);
    expect(store.getDoc().arrangement.clips[0]!.startBar).toBe(8);
    store.undo();
    expect(store.getDoc().arrangement.clips[0]!.startBar).toBe(4);
  });

  it("still records a REAL resize", () => {
    const store = storeWithClip();
    const clipId = store.getDoc().arrangement.clips[0]!.id;
    const depth0 = store.undoStackLength;
    store.execute(resizeArrangementClip(store.getDoc(), clipId, 6));
    expect(store.undoStackLength).toBe(depth0 + 1);
    expect(store.getDoc().arrangement.clips[0]!.lengthBars).toBe(6);
    store.undo();
    expect(store.getDoc().arrangement.clips[0]!.lengthBars).toBe(2);
  });
});

describe("absent ≡ undefined in the delta engine (audit 01)", () => {
  it("deepEqualRef treats a key present with undefined as equal to the key being absent", () => {
    expect(deepEqualRef({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(deepEqualRef({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(deepEqualRef({}, { a: undefined })).toBe(true);
  });

  it("deepEqualRef still distinguishes a REAL missing key from a present one", () => {
    expect(deepEqualRef({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqualRef({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(deepEqualRef({ a: 1 }, { a: 2 })).toBe(false);
    // null is NOT undefined — only `undefined` is equivalent to absence
    expect(deepEqualRef({ a: 1 }, { a: 1, b: null })).toBe(false);
  });

  it("computeDocDelta emits no op for an undefined-valued key", () => {
    const before = { arrangement: { clips: [] } } as never;
    const after = { arrangement: { clips: [], transitions: undefined } } as never;
    expect(computeDocDelta(before, after).ops).toHaveLength(0);
    // …and the same in reverse, for the undo direction
    expect(computeDocDelta(after, before).ops).toHaveLength(0);
  });

  it("computeDocDelta still emits ops for real additions and removals", () => {
    const before = { arrangement: { clips: [] } } as never;
    const after = { arrangement: { clips: [], transitions: [{ id: "t1" }] } } as never;
    expect(computeDocDelta(before, after).ops.length).toBeGreaterThan(0);
    expect(applyDocDelta(before, computeDocDelta(before, after).ops)).toEqual(after);
    expect(computeDocDelta(after, before).ops.length).toBeGreaterThan(0);
    expect(applyDocDelta(after, computeDocDelta(after, before).ops)).toEqual(before);
  });
});