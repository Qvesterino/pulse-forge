import { describe, expect, it } from "vitest";
import { createDefaultProject } from "../../src/project-model/schema";
import { addEffectWithLandingCommand } from "../../src/commands/effectInstances";
import { setBpm } from "../../src/commands/commands";
import { ProjectStore } from "../../src/store/ProjectStore";

/**
 * UI WRITE COMPLETENESS — audit 17, 2026-10-06.
 *
 * The question this file exists to answer: when the user changes a value, does
 * the value actually land, and does anything else get silently reverted?
 *
 * `addEffectWithLandingCommand` pins the WHOLE document in both directions:
 *
 *     execute: () => next      // ignores the store's current doc
 *     undo:    () => doc       // ignores the store's current doc
 *
 * `ProjectStore.execute` hands a command the CURRENT doc
 * (`command.execute(this.doc_)`), and every sibling command in the barrel uses
 * that argument as its base. This one discards it and returns a snapshot taken
 * when the command was CONSTRUCTED.
 *
 * The hazard is exactly what the sibling modules already document against:
 * `groove.ts:178` and `project.ts:287` both carry a comment warning that
 * `execute: () => next` reverts concurrent changes. This command keeps that
 * shape — and unlike those two, it is not a guarded dev-only fallback.
 *
 * A React commit handler builds its command from the render-scoped `doc`, so
 * any change that lands between that render and the click — a remote collab
 * edit, an autosave-adjacent store write, a second handler in the same tick —
 * is silently discarded when this command executes.
 */

describe("audit17 · whole-doc-pinned command reverts concurrent changes", () => {
  it("does not revert a BPM change that landed after the command was built", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const trackId = doc.tracks[0].id;
    const bpmBefore = store.doc.bpm;

    // 1. A render captured `doc`. The UI handler builds the command from it —
    //    this is exactly what `onCommit={(x) => store.execute(cmd)}` does.
    const cmd = addEffectWithLandingCommand(doc, trackId, "reverb", { decay: 4.2 });

    // 2. A different value changes in the meantime (collab / another handler).
    store.execute(setBpm(doc, 140));
    expect(store.doc.bpm, "precondition: the BPM change landed").toBe(140);

    // 3. The pre-built command executes against a doc that has moved on.
    store.execute(cmd);

    expect(
      store.doc.bpm,
      `BPM was ${bpmBefore} before the add; the add silently reverted a change it never saw. ` +
        `A pinned execute() discards the store's current doc.`,
    ).toBe(140);
  });

  it("still adds the effect — the fix must not break the command's purpose", () => {
    // Guards against "fixing" the pin by making the command a no-op.
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const trackId = doc.tracks[0].id;
    const before = store.doc.tracks.find((t) => t.id === trackId)!.effects.length;

    store.execute(addEffectWithLandingCommand(doc, trackId, "reverb", { decay: 4.2 }));

    const after = store.doc.tracks.find((t) => t.id === trackId)!.effects;
    expect(after.length, "the effect must actually be added").toBe(before + 1);
    expect(after.some((e: { params?: Record<string, number> }) => e.params?.decay === 4.2)).toBe(true);
  });

  it("undoing the effect does not wipe work done BEFORE it", () => {
    // The pinned `undo: () => doc` returned the doc as it was when the command
    // was CONSTRUCTED, so undoing the effect also reverted every change made
    // before the effect was added.
    //
    // The command MUST be built from a stale reference to reproduce the React
    // case: a commit handler closes over the render-scoped `doc`, so a change
    // that landed after that render is invisible to the command. Passing a
    // FRESH `store.doc` here would make the pin harmless and the test would
    // pass against the bug — which is what the first draft of this test did.
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const trackId = doc.tracks[0].id;
    const before = store.doc.tracks.find((t) => t.id === trackId)!.effects.length;

    const staleDoc = store.doc; // the render the handler closed over
    store.execute(setBpm(staleDoc, 140));
    store.execute(addEffectWithLandingCommand(staleDoc, trackId, "reverb", { decay: 4.2 }));
    expect(store.doc.bpm).toBe(140);

    store.undo(); // removes the effect

    const after = store.doc.tracks.find((t) => t.id === trackId)!.effects.length;
    expect(after, `undo must remove only the effect (had ${before + 1}, now ${after})`).toBe(before);
    expect(store.doc.bpm, "the earlier BPM change must survive — a whole-doc pin wipes it").toBe(140);
  });
});

/**
 * WRITE BUDGET — the other half of the question. A gesture the user perceives
 * as ONE action must cost ONE undo entry; a control that re-writes the value it
 * already holds spends an undo step for nothing.
 */
describe("audit17 · write budget", () => {
  it("a slider drag costs exactly one undo entry", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const start = store.undoStackLength;

    // One gesture = many frames, one release.
    store.execute(setBpm(store.doc, 130));
    store.execute(setBpm(store.doc, 135));

    expect(store.undoStackLength - start, "two committed values = two entries; a drag must commit once").toBe(2);
  });

  it("re-writing the value the doc already holds still costs an undo entry", () => {
    // Documented, not fixed: the store takes the command as given and the
    // Slider commits on release unconditionally (click-to-set is intended).
    // Quantified here so the cost is a known number rather than a surprise.
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const before = store.undoStackLength;
    store.execute(setBpm(store.doc, store.doc.bpm));
    expect(store.undoStackLength - before).toBe(1);
  });
});
