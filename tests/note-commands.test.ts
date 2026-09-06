/**
 * Reliability ratchet — note manipulation commands.
 *
 * Coverage gap found by `scripts/_coverage.py` (run 2026-09-06):
 *   - 5 of 181 commands in src/commands/commands.ts had 0 regression tests:
 *     splitNotes, glueNotes, quantizeNotes, nudgeNotes, duplicateNotes.
 *   - These commands mutate the in-memory `Pattern.notes[trackId]` array and
 *     are consumed by every piano-roll / sequencer surface in the UI.
 *
 * Defect found during test-first regression hunting (R9.D1):
 *   - `duplicateNotes` wraps the copy's `start` via `% patternTicks` but
 *     preserves the original `duration`. A long note whose wrapped start
 *     lands near the end of the pattern therefore produces a copy that
 *     extends past `patternTicks` — violating the project invariant
 *     `n.start + n.duration <= patternTicks` enforced by
 *     `normalizeProject` in `src/project-model/schema.ts`.
 *   - Effect: a user who duplicates a long note near the end of a pattern
 *     silently loses the duplicate on the next save/load (normalizeProject
 *     filters the out-of-bounds copy). This is the same
 *     "silent user-data loss" class the A03.D1 audit hardened against for
 *     incoming JSON, but split/quantize/duplicate do not honour the same
 *     invariant on their way OUT.
 *
 * Fix: clamp each copy's `duration` so that `copy.start + copy.duration <=
 * patternTicks` (the `start` is already wrapped). Undo is unaffected — the
 * previous array is stored verbatim and the original notes were valid.
 *
 * Note: the default House project seeds the bass track with 4 starter notes
 * at steps 0/2/4/6, so tests that need a "clean" note use the LAST entry
 * of `notes[]` (the one just added) rather than `[0]`.
 */
import { describe, expect, it } from "vitest";
import { createDefaultProject, normalizeProject } from "../src/project-model/schema";
import { ProjectStore } from "../src/store/ProjectStore";
import { addNote, duplicateNotes, glueNotes, nudgeNotes, quantizeNotes, splitNotes } from "../src/commands/commands";
import { STEP_TICKS, type InstrumentTrack, type NoteEvent } from "../src/project-model/types";

function bassTrack(store: ProjectStore): InstrumentTrack {
  const t = store.doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument");
  if (!t) throw new Error("default project has no instrument track");
  return t;
}

function activePatternNotes(store: ProjectStore, trackId: string): NoteEvent[] {
  return store.doc.patterns[0].notes[trackId] ?? [];
}

function patternTicks(store: ProjectStore): number {
  return store.doc.patterns[0].stepCount * STEP_TICKS;
}

function lastNote(notes: NoteEvent[]): NoteEvent {
  const last = notes[notes.length - 1];
  if (!last) throw new Error("expected at least one note");
  return last;
}

describe("splitNotes", () => {
  it("splits a 4-step note in half and keeps both halves inside the pattern", () => {
    const store = new ProjectStore(createDefaultProject());
    const bass = bassTrack(store);
    const lenBefore = activePatternNotes(store, bass.id).length;
    store.execute(addNote(store.doc, bass.id, { pitch: 36, start: 480, duration: 480, velocity: 0.8 }));
    const addedId = activePatternNotes(store, bass.id).slice(-1)[0].id;

    store.execute(splitNotes(store.doc, bass.id, [addedId]));
    const after = activePatternNotes(store, bass.id);
    expect(after).toHaveLength(lenBefore + 2);
    // half = Math.floor(480/2) = 240
    // a = (480, 240), b = (720, 240)
    const split = after.filter((n) => n.id === addedId || n.start === 720);
    expect(split).toHaveLength(2);
    for (const n of split) {
      expect(n.start + n.duration).toBeLessThanOrEqual(patternTicks(store));
    }
  });

  it("skips notes shorter than 2 steps (no split possible)", () => {
    const store = new ProjectStore(createDefaultProject());
    const bass = bassTrack(store);
    store.execute(addNote(store.doc, bass.id, { pitch: 36, start: 480, duration: 120, velocity: 0.8 }));
    const addedId = lastNote(activePatternNotes(store, bass.id)).id;

    store.execute(splitNotes(store.doc, bass.id, [addedId]));
    const after = activePatternNotes(store, bass.id);
    // The added note is still there with its original duration
    const added = after.find((n) => n.id === addedId);
    expect(added?.duration).toBe(120);
  });

  it("undo restores the original single note", () => {
    const store = new ProjectStore(createDefaultProject());
    const bass = bassTrack(store);
    const before = [...activePatternNotes(store, bass.id)];
    store.execute(addNote(store.doc, bass.id, { pitch: 36, start: 480, duration: 480, velocity: 0.8 }));
    const addedId = lastNote(activePatternNotes(store, bass.id)).id;

    store.execute(splitNotes(store.doc, bass.id, [addedId]));
    store.undo();
    const after = activePatternNotes(store, bass.id);
    expect(after).toHaveLength(before.length + 1);
    const restored = after.find((n) => n.id === addedId);
    expect(restored).toBeDefined();
    expect(restored?.start).toBe(480);
    expect(restored?.duration).toBe(480);
  });
});

describe("quantizeNotes", () => {
  it("aligns note starts to the grid at full strength", () => {
    const store = new ProjectStore(createDefaultProject());
    const bass = bassTrack(store);
    store.execute(addNote(store.doc, bass.id, { pitch: 36, start: 500, duration: 240, velocity: 0.8 }));
    const addedId = lastNote(activePatternNotes(store, bass.id)).id;

    store.execute(quantizeNotes(store.doc, bass.id, [addedId], STEP_TICKS, 1));
    const after = activePatternNotes(store, bass.id).find((n) => n.id === addedId)!;
    // 500 rounded to nearest 120 = 480
    expect(after.start).toBe(480);
    // Duration is at least gridTicks after full quantize
    expect(after.duration).toBeGreaterThanOrEqual(STEP_TICKS);
    expect(after.start + after.duration).toBeLessThanOrEqual(patternTicks(store));
  });

  it("leaves the note in place at strength 0", () => {
    const store = new ProjectStore(createDefaultProject());
    const bass = bassTrack(store);
    store.execute(addNote(store.doc, bass.id, { pitch: 36, start: 500, duration: 240, velocity: 0.8 }));
    const addedId = lastNote(activePatternNotes(store, bass.id)).id;

    store.execute(quantizeNotes(store.doc, bass.id, [addedId], STEP_TICKS, 0));
    const after = activePatternNotes(store, bass.id).find((n) => n.id === addedId)!;
    expect(after.start).toBe(500);
    expect(after.duration).toBe(240);
  });

  it("undo restores the pre-quantize note", () => {
    const store = new ProjectStore(createDefaultProject());
    const bass = bassTrack(store);
    store.execute(addNote(store.doc, bass.id, { pitch: 36, start: 500, duration: 240, velocity: 0.8 }));
    const addedId = lastNote(activePatternNotes(store, bass.id)).id;
    const before = activePatternNotes(store, bass.id).find((n) => n.id === addedId)!;

    store.execute(quantizeNotes(store.doc, bass.id, [addedId], STEP_TICKS, 1));
    store.undo();
    const restored = activePatternNotes(store, bass.id).find((n) => n.id === addedId)!;
    expect(restored.start).toBe(before.start);
    expect(restored.duration).toBe(before.duration);
  });
});

describe("nudgeNotes", () => {
  it("shifts a note by deltaTicks", () => {
    const store = new ProjectStore(createDefaultProject());
    const bass = bassTrack(store);
    store.execute(addNote(store.doc, bass.id, { pitch: 36, start: 480, duration: 240, velocity: 0.8 }));
    const addedId = lastNote(activePatternNotes(store, bass.id)).id;

    store.execute(nudgeNotes(store.doc, bass.id, [addedId], 120, 0));
    const after = activePatternNotes(store, bass.id).find((n) => n.id === addedId)!;
    expect(after.start).toBe(600);
  });

  it("clamps to 0 when deltaTicks is very negative", () => {
    const store = new ProjectStore(createDefaultProject());
    const bass = bassTrack(store);
    store.execute(addNote(store.doc, bass.id, { pitch: 36, start: 480, duration: 240, velocity: 0.8 }));
    const addedId = lastNote(activePatternNotes(store, bass.id)).id;

    store.execute(nudgeNotes(store.doc, bass.id, [addedId], -10_000, 0));
    const after = activePatternNotes(store, bass.id).find((n) => n.id === addedId)!;
    expect(after.start).toBe(0);
  });

  it("clamps pitch to the MIDI range [0, 127]", () => {
    const store = new ProjectStore(createDefaultProject());
    const bass = bassTrack(store);
    store.execute(addNote(store.doc, bass.id, { pitch: 60, start: 480, duration: 240, velocity: 0.8 }));
    const addedId = lastNote(activePatternNotes(store, bass.id)).id;

    store.execute(nudgeNotes(store.doc, bass.id, [addedId], 0, 200));
    expect(activePatternNotes(store, bass.id).find((n) => n.id === addedId)!.pitch).toBe(127);
    store.undo();
    store.execute(nudgeNotes(store.doc, bass.id, [addedId], 0, -200));
    expect(activePatternNotes(store, bass.id).find((n) => n.id === addedId)!.pitch).toBe(0);
  });
});

describe("glueNotes", () => {
  it("merges same-pitch notes into one note spanning the selection", () => {
    const store = new ProjectStore(createDefaultProject());
    const bass = bassTrack(store);
    store.execute(addNote(store.doc, bass.id, { pitch: 36, start: 480, duration: 240, velocity: 0.8 }));
    store.execute(addNote(store.doc, bass.id, { pitch: 36, start: 720, duration: 240, velocity: 0.6 }));
    const ids = activePatternNotes(store, bass.id)
      .filter((n) => n.start === 480 || n.start === 720)
      .map((n) => n.id);

    store.execute(glueNotes(store.doc, bass.id, ids));
    const after = activePatternNotes(store, bass.id);
    // The two original notes are replaced by a single glued note
    expect(after.filter((n) => ids.includes(n.id)).length).toBe(0);
    // Latest end (720 + 240 = 960) minus earliest start (480) = 480
    const glued = after.find((n) => n.start === 480 && n.duration === 480);
    expect(glued).toBeDefined();
  });

  it("throws when notes have different pitches", () => {
    const store = new ProjectStore(createDefaultProject());
    const bass = bassTrack(store);
    store.execute(addNote(store.doc, bass.id, { pitch: 36, start: 480, duration: 240, velocity: 0.8 }));
    store.execute(addNote(store.doc, bass.id, { pitch: 40, start: 720, duration: 240, velocity: 0.8 }));
    const ids = activePatternNotes(store, bass.id)
      .filter((n) => n.start === 480 || n.start === 720)
      .map((n) => n.id);

    expect(() => store.execute(glueNotes(store.doc, bass.id, ids))).toThrowError(/same pitch/);
  });
});

describe("duplicateNotes (R9.D1 regression)", () => {
  it("clamps the duplicate's duration so the copy never exceeds patternTicks", () => {
    // Original: start = 0, duration = 1900 in a 16-step pattern (1920 ticks).
    // Valid (end = 1900 <= 1920). width = 1900, so the copy's start =
    // (0 + 1900) % 1920 = 1900. Without the fix the copy would be
    // (1900, 1900), end = 3800, far past patternTicks — silently dropped
    // by the next normalizeProject() pass.
    const store = new ProjectStore(createDefaultProject());
    const bass = bassTrack(store);
    store.execute(addNote(store.doc, bass.id, { pitch: 36, start: 0, duration: 1900, velocity: 0.8 }));
    const original = lastNote(activePatternNotes(store, bass.id));
    const beforeIds = new Set(activePatternNotes(store, bass.id).map((n) => n.id));

    store.execute(duplicateNotes(store.doc, bass.id, [original.id]));
    const after = activePatternNotes(store, bass.id);
    const copy = after.find((n) => !beforeIds.has(n.id));
    expect(copy).toBeDefined();
    // Invariant: copy's end is clamped to patternTicks
    expect(copy!.start + copy!.duration).toBeLessThanOrEqual(patternTicks(store));
    // The copy's duration is shorter than the original (truncated to fit)
    expect(copy!.duration).toBeLessThanOrEqual(original.duration);
  });

  it("survives a normalizeProject round-trip without losing the duplicate", () => {
    const store = new ProjectStore(createDefaultProject());
    const bass = bassTrack(store);
    store.execute(addNote(store.doc, bass.id, { pitch: 36, start: 0, duration: 1900, velocity: 0.8 }));
    const original = lastNote(activePatternNotes(store, bass.id));
    const beforeCount = activePatternNotes(store, bass.id).length;
    const beforeIds = new Set(activePatternNotes(store, bass.id).map((n) => n.id));

    store.execute(duplicateNotes(store.doc, bass.id, [original.id]));
    expect(activePatternNotes(store, bass.id)).toHaveLength(beforeCount + 1);

    const normalized = normalizeProject(store.doc);
    const normalizedNotes = normalized.patterns[0].notes[bass.id] ?? [];
    // Both the original and the duplicate survive the normalize round-trip
    expect(normalizedNotes).toHaveLength(beforeCount + 1);
    expect(normalizedNotes.every((n) => n.start + n.duration <= patternTicks(store))).toBe(true);
    // The duplicate (the id not in the pre-duplicate set) survives specifically
    const copy = normalizedNotes.find((n) => !beforeIds.has(n.id));
    expect(copy).toBeDefined();
  });

  it("keeps both notes within the pattern boundary for a short selection (no clamping needed)", () => {
    const store = new ProjectStore(createDefaultProject());
    const bass = bassTrack(store);
    store.execute(addNote(store.doc, bass.id, { pitch: 36, start: 480, duration: 240, velocity: 0.8 }));
    const original = lastNote(activePatternNotes(store, bass.id));
    const beforeCount = activePatternNotes(store, bass.id).length;
    const beforeIds = new Set(activePatternNotes(store, bass.id).map((n) => n.id));

    store.execute(duplicateNotes(store.doc, bass.id, [original.id]));
    const after = activePatternNotes(store, bass.id);
    expect(after).toHaveLength(beforeCount + 1);
    // The copy is the only note whose id is NOT in the pre-duplicate id set.
    const copy = after.find((n) => !beforeIds.has(n.id))!;
    expect(copy).toBeDefined();
    // width = 240, copy starts at (480 + 240) % 1920 = 720, duration unchanged
    expect(copy.start).toBe(720);
    expect(copy.duration).toBe(240);
  });
});
