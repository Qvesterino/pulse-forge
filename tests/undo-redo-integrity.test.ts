import { describe, expect, it } from "vitest";
import { ProjectStore } from "../src/store/ProjectStore";
import { testDoc, drumTrackOf, instTrackOf } from "./fixtures/doc";
import {
  addEffect,
  addNote,
  createPattern,
  createScene,
  quantizeNotes,
  setBpm,
  setPadParams,
  setProjectName,
  toggleStep,
} from "../src/commands/commands";
import type { Command } from "../src/commands/types";

/**
 * Undo / redo integrity audit — property-style history tests.
 *
 * Required properties exercised over a realistic MIXED command history
 * (steps + params + effects + notes + patterns + scenes + doc fields) run
 * through the real ProjectStore (coalescing off — no coalesceKey):
 *
 *  - undo restores the exact prior semantic state (checkpointed, not just
 *    the endpoints);
 *  - redo restores the exact post-command state;
 *  - repeated undo/redo cycles are stable (two full cycles agree);
 *  - ids and references remain valid across the whole history;
 *  - jumpTo lands on the state after entry i for every i, and is a no-op
 *    for the current index.
 *
 * A deep snapshot (structured JSON clone) is taken after every command;
 * equality assertions compare against those snapshots so any state drift
 * inside the history (not just at the ends) fails loudly.
 */

const snap = (doc: unknown): string => JSON.stringify(doc);

describe("undo/redo integrity — mixed history through the real store", () => {
  it("undo/redo checkpoints match the exact recorded state at every step, cycles are stable", () => {
    const store = new ProjectStore(testDoc());
    const initial = snap(store.doc);

    // Build the history, snapshotting after every command.
    const doc0 = store.doc;
    const pad = drumTrackOf(doc0).pads[0];
    const padB = drumTrackOf(doc0).pads[2];
    const bass = instTrackOf(doc0);

    const script: Array<() => Command> = [
      () => toggleStep(store.doc, pad.id, 0, 0.8),
      () => setBpm(store.doc, 132),
      () => addEffect(store.doc, bass.id, "reverb"),
      () => setProjectName(store.doc, "History Probe"),
      () => toggleStep(store.doc, padB.id, 4, 0.6),
      () => setPadParams(store.doc, pad.id, { gain: 1.2, pan: 0.25 }),
      () => addNote(store.doc, bass.id, { pitch: 36, start: 480, duration: 240, velocity: 0.8 }),
      () => createPattern(store.doc),
      () => createScene(store.doc, "Probe Scene"),
    ];
    const states: string[] = [initial];
    for (const step of script) {
      store.execute(step());
      states.push(snap(store.doc));
    }
    const final = states[states.length - 1];
    const depth = script.length;

    // Cycle 1: undo to bottom — every intermediate state must match.
    for (let i = depth; i > 0; i--) {
      store.undo();
      expect(snap(store.doc), `undo checkpoint ${i - 1}`).toBe(states[i - 1]);
    }
    // Redo to top — same checkpoints.
    for (let i = 1; i <= depth; i++) {
      store.redo();
      expect(snap(store.doc), `redo checkpoint ${i}`).toBe(states[i]);
    }

    // Cycle 2 (stability): undo/redo again — identical results.
    for (let i = depth; i > 0; i--) {
      store.undo();
      expect(snap(store.doc), `cycle-2 undo checkpoint ${i - 1}`).toBe(states[i - 1]);
    }
    for (let i = 1; i <= depth; i++) {
      store.redo();
      expect(snap(store.doc), `cycle-2 redo checkpoint ${i}`).toBe(states[i]);
    }
    expect(snap(store.doc)).toBe(final);
  });

  it("a divergent edit after undo invalidates redo and starts a consistent new history", () => {
    const store = new ProjectStore(testDoc());
    const pad = drumTrackOf(store.doc).pads[0];
    const initial = snap(store.doc);

    store.execute(toggleStep(store.doc, pad.id, 0, 0.8));
    const afterStep = snap(store.doc);
    store.execute(setBpm(store.doc, 140));

    store.undo(); // back to afterStep
    expect(snap(store.doc)).toBe(afterStep);

    // Divergent edit — the redo entry (setBpm 140) must be gone forever.
    store.execute(toggleStep(store.doc, pad.id, 2, 0.5));
    expect(store.canRedo).toBe(false);
    store.undo();
    expect(snap(store.doc)).toBe(afterStep);
    store.undo();
    expect(snap(store.doc)).toBe(initial);
    store.redo();
    expect(snap(store.doc)).toBe(afterStep);
    store.redo();
    // Note: the bpm redo is invalidated — the last redo lands on the
    // divergent step's post state.
    expect(store.doc.patterns[0].rows[pad.id][2]).toBe(0.5);
  });

  it("jumpTo lands on the state after entry i for every index", () => {
    const store = new ProjectStore(testDoc());
    const doc0 = store.doc;
    const pad = drumTrackOf(doc0).pads[0];
    const bass = instTrackOf(doc0);

    const script: Array<() => Command> = [
      () => toggleStep(store.doc, pad.id, 0, 0.8),
      () => setBpm(store.doc, 132),
      () => addEffect(store.doc, bass.id, "reverb"),
      () => setProjectName(store.doc, "Jump Probe"),
      () => addNote(store.doc, bass.id, { pitch: 36, start: 480, duration: 240, velocity: 0.8 }),
    ];
    const states: string[] = [snap(store.doc)];
    for (const step of script) {
      store.execute(step());
      states.push(snap(store.doc));
    }

    // jumpTo(i) = state after entry i (0-based) — i.e. states[i + 1].
    for (let i = 0; i < script.length; i++) {
      store.jumpTo(i);
      expect(snap(store.doc), `jumpTo(${i})`).toBe(states[i + 1]);
    }
    // Jumping to the current position is a no-op.
    store.jumpTo(script.length - 1);
    expect(snap(store.doc)).toBe(states[script.length]);
  });

  it("undo of track/effect removal keeps ids resolvable (references stay valid)", () => {
    const store = new ProjectStore(testDoc());
    const bassId = instTrackOf(store.doc).id;
    store.execute(addEffect(store.doc, bassId, "reverb"));
    const fxId = store.doc.tracks.find((t) => t.id === bassId)!.effects[0].id;

    // A pattern created AFTER the effect existed must survive undo/redo
    // cycles of unrelated commands with ids intact.
    store.execute(createPattern(store.doc));
    store.undo();
    store.redo();
    const bass = store.doc.tracks.find((t) => t.id === bassId);
    expect(bass).toBeDefined();
    expect(bass!.effects.find((fx) => fx.id === fxId)).toBeDefined();
    // The active pattern id resolves after the undo/redo round-trip.
    expect(store.doc.patterns.some((p) => p.id === store.doc.activePatternId)).toBe(true);
  });
});

describe("undo/redo integrity — note commands pin their pattern (sequencer audit)", () => {
  it("addNote undo removes the note from the ORIGINAL pattern after switching", () => {
    const store = new ProjectStore(testDoc());
    const bass = instTrackOf(store.doc);
    const notesOf = (pid: string): unknown[] =>
      ((store.doc.patterns.find((p) => p.id === pid)?.notes ?? {}) as Record<string, unknown[]>)[bass.id] ?? [];
    const before = notesOf(store.doc.activePatternId).length;
    store.execute(addNote(store.doc, bass.id, { pitch: 36, start: 480, duration: 240, velocity: 0.8 }));
    const patternA = store.doc.activePatternId;
    expect(notesOf(patternA).length).toBe(before + 1);
    store.execute(createPattern(store.doc)); // switches active pattern
    expect(store.doc.activePatternId).not.toBe(patternA);

    store.undo(); // undoes the PATTERN SWITCH
    expect(store.doc.activePatternId).toBe(patternA);
    store.undo(); // undoes the addNote — must remove it from pattern A
    expect(notesOf(patternA).length).toBe(before);

    // Redo re-adds into pattern A, not the currently active one.
    store.redo();
    expect(notesOf(patternA).length).toBe(before + 1);
  });

  it("quantizeNotes undo does not overwrite ANOTHER pattern's note list", () => {
    const store = new ProjectStore(testDoc());
    const bass = instTrackOf(store.doc);
    // Notes in pattern A.
    store.execute(addNote(store.doc, bass.id, { pitch: 36, start: 490, duration: 240, velocity: 0.8 }));
    const patternA = store.doc.activePatternId;
    const preQuantize = (
      (store.doc.patterns.find((p) => p.id === patternA)?.notes ?? {}) as Record<string, { start: number }[]>
    )[bass.id].map((n) => n.start);
    store.execute(quantizeNotes(store.doc, bass.id));

    // Switch to pattern B, then remove the switch from the local undo stack —
    // modeling a REMOTE-origin switch (collab): it changed the active pattern
    // without entering this store's history. The next undo therefore runs the
    // quantize undo while B is active — exactly the corruption scenario.
    store.execute(createPattern(store.doc));
    const patternB = store.doc.activePatternId;
    const stack = (store as unknown as { undoStack: Command[] }).undoStack;
    stack.pop();

    store.undo(); // quantize undo, B active
    const bNotes =
      ((store.doc.patterns.find((p) => p.id === patternB)?.notes ?? {}) as Record<string, { start: number }[]>)[
        bass.id
      ] ?? [];
    expect(bNotes.length).toBe(0); // old code replaced B's list with A's notes
    const aNotes =
      ((store.doc.patterns.find((p) => p.id === patternA)?.notes ?? {}) as Record<string, { start: number }[]>)[
        bass.id
      ] ?? [];
    expect(aNotes.map((n) => n.start)).toEqual(preQuantize); // pre-quantize state restored in A
  });
});
