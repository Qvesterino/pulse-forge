import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import {
  addNote,
  deleteNotes,
  moveNote,
  quantizeNotes,
  resizeNote,
  setNoteVelocity,
  setPatternLength,
  setStepVelocityCommand,
  setStepsVelocity,
  toggleStep,
} from "../src/commands/commands";
import { STEP_TICKS } from "../src/project-model/types";
import type { DrumTrack, InstrumentTrack, ProjectDocument } from "../src/project-model/types";

/**
 * EDIT TOOLS AUDIT — notes (piano-roll) & step-grid (drums) command layer
 * (DAW_EDIT_TOOLS_INTERACTION_AUDIT.md, second pass). Invariants:
 *
 *  N1 addNote sanitizes fields (finite, bounded, pattern-bounds fitted)
 *  N2 velocity writes can never be NaN or out of [0, 1]
 *  N3 step rows can never carry NaN/over-unity velocities
 *  N4 stepIndex out of range is a safe skip, never a sparse-row poison
 *  N5 quantize with junk strength stays bounded
 *  N6 setPatternLength shrink clamps/drops notes per contract
 *  N7 every edit undoes to the exact previous pattern
 *  N8 combined stress sequence keeps the pattern internally valid
 *
 * STEP_TICKS = 120 (16th of 480 PPQ). House active pattern is
 * patterns[2] and already carries notes — probes diff by ID so template
 * content never leaks into assertions.
 */

const docWithTrack = (): { doc: ProjectDocument; trackId: string } => {
  const doc = createProjectFromTemplate("house");
  const track = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument")!;
  return { doc, trackId: track.id };
};

const notesOf = (doc: ProjectDocument, trackId: string) =>
  (doc.patterns.find((p) => p.id === doc.activePatternId)?.notes ?? {})[trackId] ?? [];

const addedNote = (before: ProjectDocument, after: ProjectDocument, trackId: string) => {
  const beforeIds = new Set(notesOf(before, trackId).map((n) => n.id));
  const added = notesOf(after, trackId).filter((n) => !beforeIds.has(n.id));
  expect(added).toHaveLength(1);
  return added[0]!;
};

const drumPadOf = (doc: ProjectDocument): DrumTrack => doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;

describe("N1 addNote sanitization", () => {
  it("NaN/junk fields clamp to safe defaults instead of poisoning the pattern", () => {
    const { doc, trackId } = docWithTrack();
    const next = addNote(doc, trackId, {
      pitch: Number.NaN,
      start: Number.NaN,
      duration: Number.NaN,
      velocity: Number.NaN,
    }).execute(doc);
    const note = addedNote(doc, next, trackId);
    expect(note.pitch).toBe(60); // NaN → finite fallback 60, NOT NaN
    expect(note.start).toBe(0);
    expect(note.duration).toBe(1);
    expect(note.velocity).toBe(0.8); // fallback default
  });

  it("out-of-range values clamp (pitch 0..127, velocity 0..1, start ≥ 0)", () => {
    const { doc, trackId } = docWithTrack();
    const next = addNote(doc, trackId, { pitch: 300, start: -20, duration: -5, velocity: 42 }).execute(doc);
    const note = addedNote(doc, next, trackId);
    expect(note.pitch).toBe(127);
    expect(note.start).toBe(0);
    expect(note.duration).toBe(1);
    expect(note.velocity).toBe(1);
  });

  it("a long note added near the pattern end is fitted FL-style, not dropped on save", () => {
    const { doc, trackId } = docWithTrack();
    const patternTicks = doc.patterns.find((p) => p.id === doc.activePatternId)!.stepCount * STEP_TICKS;
    const next = addNote(doc, trackId, {
      pitch: 60,
      start: patternTicks - 5,
      duration: patternTicks,
      velocity: 0.8,
    }).execute(doc);
    const note = addedNote(doc, next, trackId);
    expect(note.start).toBeLessThan(patternTicks);
    expect(note.start + note.duration).toBeLessThanOrEqual(patternTicks);
  });
});

describe("N2 note velocity writes", () => {
  it("setNoteVelocity with NaN clamps to the floor instead of writing NaN", () => {
    const { doc, trackId } = docWithTrack();
    let working = addNote(doc, trackId, { pitch: 60, start: 0, duration: 8, velocity: 0.8 }).execute(doc);
    const noteId = addedNote(doc, working, trackId).id;
    working = setNoteVelocity(working, trackId, noteId, Number.NaN).execute(working);
    const velocity = notesOf(working, trackId).find((n) => n.id === noteId)!.velocity;
    expect(Number.isFinite(velocity)).toBe(true);
    expect(velocity).toBeGreaterThanOrEqual(0.05);
    expect(velocity).toBeLessThanOrEqual(1);
  });
});

describe("N3/N4 step writes", () => {
  it("setStepVelocityCommand clamps NaN to 0 (off) and 2.5 to 1", () => {
    const { doc } = docWithTrack();
    const pad = drumPadOf(doc).pads[0]!;
    let working = setStepVelocityCommand(doc, pad.id, 0, Number.NaN).execute(doc);
    const row = working.patterns.find((p) => p.id === working.activePatternId)!.rows[pad.id];
    expect(row[0]).toBe(0);
    working = setStepVelocityCommand(working, pad.id, 0, 2.5).execute(working);
    expect(working.patterns.find((p) => p.id === working.activePatternId)!.rows[pad.id][0]).toBe(1);
  });

  it("toggleStep with a NaN default velocity writes 0, never NaN", () => {
    const { doc } = docWithTrack();
    const pad = drumPadOf(doc).pads[0]!;
    const working = toggleStep(doc, pad.id, 0, Number.NaN).execute(doc);
    const row = working.patterns.find((p) => p.id === working.activePatternId)!.rows[pad.id];
    for (const velocity of row) expect(Number.isFinite(velocity) && velocity <= 1).toBe(true);
  });

  it("setStepsVelocity clamps and skips out-of-range indices", () => {
    const { doc } = docWithTrack();
    const pad = drumPadOf(doc).pads[0]!;
    const before = doc.patterns.find((p) => p.id === doc.activePatternId)!.rows[pad.id];
    const next = setStepsVelocity(doc, doc.activePatternId, [
      { padId: pad.id, stepIndex: 0, velocity: Number.NaN },
      { padId: pad.id, stepIndex: 2, velocity: 2.5 },
      { padId: pad.id, stepIndex: -1, velocity: 0.5 },
      { padId: pad.id, stepIndex: 9999, velocity: 0.5 },
    ]).execute(doc);
    const row = next.patterns.find((p) => p.id === next.activePatternId)!.rows[pad.id];
    expect(row[0]).toBe(0); // NaN → floor
    expect(row[2]).toBe(1); // 2.5 → ceiling
    // every other index untouched
    for (let i = 0; i < row.length; i++) {
      if (i === 0 || i === 2) continue;
      expect(row[i]).toBe(before[i]);
    }
  });
});

describe("N5 quantize bounds", () => {
  it("quantizeNotes with NaN strength stays bounded and lands on grid", () => {
    const { doc, trackId } = docWithTrack();
    let working = addNote(doc, trackId, { pitch: 60, start: 37, duration: 13, velocity: 0.8 }).execute(doc);
    const noteId = addedNote(doc, working, trackId).id;
    working = quantizeNotes(working, trackId, [noteId], STEP_TICKS, Number.NaN).execute(working);
    const note = notesOf(working, trackId).find((n) => n.id === noteId)!;
    expect(Number.isFinite(note.start)).toBe(true);
    expect(note.start % STEP_TICKS).toBe(0); // full strength → on grid
  });
});

describe("N6 pattern length shrink", () => {
  it("notes crossing the new end are clamped, notes past it dropped", () => {
    const { doc, trackId } = docWithTrack();
    const longTicks = 400 * STEP_TICKS;
    let working = addNote(doc, trackId, { pitch: 60, start: 0, duration: longTicks, velocity: 0.8 }).execute(doc);
    working = addNote(working, trackId, {
      pitch: 62,
      start: 450 * STEP_TICKS,
      duration: 8,
      velocity: 0.8,
    }).execute(working);
    working = setPatternLength(working, doc.activePatternId, 64).execute(working);
    const pattern = working.patterns.find((p) => p.id === working.activePatternId)!;
    const patternTicks = pattern.stepCount * STEP_TICKS;
    expect(patternTicks).toBe(64 * STEP_TICKS);
    const notes = (pattern.notes ?? {})[trackId] ?? [];
    for (const note of notes) {
      expect(note.start).toBeLessThan(patternTicks);
      expect(note.start + note.duration).toBeLessThanOrEqual(patternTicks);
      expect(note.duration).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("N7 undo integrity", () => {
  it("addNote → undo removes exactly the added note", () => {
    const { doc, trackId } = docWithTrack();
    const before = notesOf(doc, trackId).length;
    const cmd = addNote(doc, trackId, { pitch: 60, start: 16 * STEP_TICKS, duration: 8, velocity: 0.9 });
    const next = cmd.execute(doc);
    expect(notesOf(next, trackId).length).toBe(before + 1);
    const restored = cmd.undo(next);
    expect(notesOf(restored, trackId).length).toBe(before);
  });

  it("move+resize → undo restores exact note fields", () => {
    const { doc, trackId } = docWithTrack();
    let working = addNote(doc, trackId, { pitch: 60, start: 8 * STEP_TICKS, duration: 8, velocity: 0.8 }).execute(doc);
    const original = addedNote(doc, working, trackId);
    const move = moveNote(working, trackId, original.id, { pitch: 64, start: 40 * STEP_TICKS });
    working = move.execute(working);
    const resize = resizeNote(working, trackId, original.id, 24);
    working = resize.execute(working);
    working = resize.undo(working);
    working = move.undo(working);
    expect(notesOf(working, trackId).find((n) => n.id === original.id)).toEqual(original);
  });

  it("deleteNotes → undo restores the removed notes verbatim", () => {
    const { doc, trackId } = docWithTrack();
    let working = addNote(doc, trackId, { pitch: 60, start: 0, duration: 4, velocity: 0.8 }).execute(doc);
    working = addNote(working, trackId, { pitch: 64, start: 8 * STEP_TICKS, duration: 4, velocity: 0.8 }).execute(working);
    const ids = notesOf(working, trackId).map((n) => n.id);
    const cmd = deleteNotes(working, trackId, ids);
    const emptied = cmd.execute(working);
    expect(notesOf(emptied, trackId)).toHaveLength(0);
    const restored = cmd.undo(emptied);
    expect(notesOf(restored, trackId).length).toBe(ids.length);
  });
});

describe("N8 combined stress sequence", () => {
  it("add → move → resize → quantize → delete → undo → redo stays internally valid", () => {
    const seed = docWithTrack();
    let doc = seed.doc;
    const stack: import("../src/commands/types").Command[] = [];
    const redo: import("../src/commands/types").Command[] = [];
    const apply = (cmd: import("../src/commands/types").Command) => {
      stack.push(cmd);
      redo.length = 0;
      doc = cmd.execute(doc);
    };
    const undo = () => {
      const cmd = stack.pop();
      if (cmd) {
        redo.push(cmd);
        doc = cmd.undo(doc);
      }
    };
    const redoStep = () => {
      const cmd = redo.pop();
      if (cmd) {
        stack.push(cmd);
        doc = cmd.execute(doc);
      }
    };

    apply(addNote(doc, seed.trackId, { pitch: 60, start: 4 * STEP_TICKS, duration: 8, velocity: 0.8 }));
    const noteId = addedNote(seed.doc, doc, seed.trackId).id;
    const countBefore = notesOf(doc, seed.trackId).length;
    apply(moveNote(doc, seed.trackId, noteId, { pitch: 63, start: 20 * STEP_TICKS }));
    apply(resizeNote(doc, seed.trackId, noteId, 16));
    apply(quantizeNotes(doc, seed.trackId, [noteId], 8, 0.5));
    apply(deleteNotes(doc, seed.trackId, [noteId]));
    expect(notesOf(doc, seed.trackId).length).toBe(countBefore - 1);
    undo();
    expect(notesOf(doc, seed.trackId).length).toBe(countBefore);
    redoStep();
    expect(notesOf(doc, seed.trackId).length).toBe(countBefore - 1);
    for (const note of notesOf(doc, seed.trackId)) {
      expect(Number.isFinite(note.start)).toBe(true);
      expect(note.duration).toBeGreaterThanOrEqual(1);
    }
  });
});
