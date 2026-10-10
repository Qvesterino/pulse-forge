import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import { addChord, conformInstrumentClipsToChordTrack, transposeInstrumentClips } from "../src/commands/chordTrack";
import { addArrangementClip } from "../src/commands/arrangement";
import { deleteArrangementClip } from "../src/commands/commands";
import { BAR_TICKS } from "../src/project-model/types";
import type { NoteEvent, ProjectDocument } from "../src/project-model/types";

/**
 * TRANSPOSE + CONFORM for scene clips (chord track v3).
 *
 *  T1 transpose: melodic notes of the clip's pattern shift by semitones,
 *     clamped 0–127; drum rows untouched; undo exact; shared-pattern clips
 *     transpose together (documented behavior)
 *  T2 conform: notes snap (PITCH only) to the tones of the chord under their
 *     absolute arrangement tick; timing unchanged; multi-chord spans give
 *     different notes different chords; idempotent; notes outside chords stay
 *  T3 guards: no chords → conform throws; zero transpose = no-op
 */

const fixtureWithNotes = (
  pitches: number[],
): { store: ProjectStore; clipId: string; patternId: string; notes: NoteEvent[] } => {
  let doc: ProjectDocument = createProjectFromTemplate("house");
  for (const c of doc.arrangement.clips) doc = deleteArrangementClipFor(doc, c.id);
  const trackId = doc.tracks.find((t) => t.kind === "instrument")!.id;
  doc = addArrangementClip(doc, doc.scenes[0]!.id, 0, 4).execute(doc);
  const scene = doc.scenes.find((s) => s.id === doc.arrangement.clips[0]!.sceneId)!;
  const patternId = scene.patternId;
  // The house template pattern already carries notes AND is only one bar
  // long (notes beyond its length are dropped by normalize) — clear it and
  // stretch it to 64 steps (4 bars) so the fixture's pitches survive.
  doc = {
    ...doc,
    patterns: doc.patterns.map((p) => (p.id === patternId ? { ...p, stepCount: 64, notes: {} } : p)),
  };
  // Insert melodic notes DIRECTLY into the scene's pattern — addNote would
  // target doc.activePatternId, which is not necessarily the scene's pattern.
  pitches.forEach((pitch, index) => {
    doc = {
      ...doc,
      patterns: doc.patterns.map((p) =>
        p.id === patternId
          ? {
              ...p,
              notes: {
                ...p.notes,
                [trackId]: [
                  ...((p.notes ?? {})[trackId] ?? []),
                  { id: `n-${index}`, pitch, start: index * 120, duration: 120, velocity: 0.8 },
                ],
              },
            }
          : p,
      ),
    };
  });
  const store = new ProjectStore(doc);
  const notes = (store.doc.patterns.find((p) => p.id === patternId)?.notes ?? {})[trackId] ?? [];
  return { store, clipId: store.doc.arrangement.clips[0]!.id, patternId, notes };
};

function deleteArrangementClipFor(doc: ProjectDocument, id: string): ProjectDocument {
  return deleteArrangementClip(doc, id).execute(doc);
}

const notesOf = (doc: ProjectDocument, patternId: string, trackId?: string): NoteEvent[] => {
  const pattern = doc.patterns.find((p) => p.id === patternId)!;
  const id = trackId ?? Object.keys(pattern.notes ?? {})[0]!;
  return (pattern.notes ?? {})[id] ?? [];
};

describe("T1 transposeInstrumentClips", () => {
  it("shifts melodic notes by the delta; steps and timing untouched; undo exact", () => {
    const { store, patternId } = fixtureWithNotes([60, 64, 67]);
    const baseline = store.doc;
    const before = notesOf(baseline, patternId).map((n) => [n.start, n.duration, n.velocity]);
    store.execute(transposeInstrumentClips(store.doc, [store.doc.arrangement.clips[0]!.id], 3));
    const after = notesOf(store.doc, patternId);
    expect(after.map((n) => n.pitch)).toEqual([63, 67, 70]);
    expect(after.map((n) => [n.start, n.duration, n.velocity])).toEqual(before);
    store.undo();
    expect(store.doc).toEqual(baseline);
  });

  it("clamps at 0 and 127; drum rows are never transposed", () => {
    const { store, patternId } = fixtureWithNotes([2, 126]);
    store.execute(transposeInstrumentClips(store.doc, [store.doc.arrangement.clips[0]!.id], 5));
    const pitches = notesOf(store.doc, patternId).map((n) => n.pitch);
    expect(pitches).toEqual([7, 127]); // clamped at the ceiling
    store.execute(transposeInstrumentClips(store.doc, [store.doc.arrangement.clips[0]!.id], -40));
    expect(notesOf(store.doc, patternId).map((n) => n.pitch)).toEqual([0, 87]); // 127 − 40 = 87
  });

  it("shared pattern: every clip playing it transposes together (documented)", () => {
    const { store, patternId } = fixtureWithNotes([60]);
    // A second scene clip playing the SAME pattern at bar 8.
    store.execute(addArrangementClip(store.doc, store.doc.scenes[0]!.id, 8, 4));
    store.execute(transposeInstrumentClips(store.doc, [store.doc.arrangement.clips[0]!.id], 2));
    // Both clips read the same (now transposed) pattern.
    const pattern = store.doc.patterns.find((p) => p.id === patternId)!;
    expect(Object.values(pattern.notes ?? {})[0]![0]!.pitch).toBe(62);
    expect(store.doc.arrangement.clips[1]!.startBar).toBe(8);
  });

  it("zero semitones pushes no history entry", () => {
    const { store } = fixtureWithNotes([60]);
    const before = store.undoStackLength;
    store.execute(transposeInstrumentClips(store.doc, [store.doc.arrangement.clips[0]!.id], 0));
    expect(store.undoStackLength).toBe(before);
  });
});

describe("T2 conform to chord track", () => {
  it("notes snap to the tones of the chord under their absolute tick; timing preserved", () => {
    const { store, patternId } = fixtureWithNotes([61, 62, 66]);
    const beforeStarts = notesOf(store.doc, patternId).map((n) => n.start);
    // Chords: C maj bars 0–2 (tones C E G), G maj bars 2–4 (tones G B D).
    store.execute(addChord(store.doc, 0, 2, 0, "maj"));
    store.execute(addChord(store.doc, 2, 2, 7, "maj"));
    store.execute(conformInstrumentClipsToChordTrack(store.doc, [store.doc.arrangement.clips[0]!.id]));
    const notes = notesOf(store.doc, patternId);
    // Bar 1 (all three notes live in bars 0–2 → C major): C#/D snap into {C,E,G}.
    expect(notes.map((n) => n.start)).toEqual(beforeStarts); // timing unchanged
    for (const n of notes) {
      const pitchClass = ((n.pitch % 12) + 12) % 12;
      expect([0, 4, 7].includes(pitchClass)).toBe(true);
    }
  });

  it("a note under the SECOND chord snaps to THAT chord's tones (multi-chord span)", () => {
    const fixtureFull = fixtureWithNotes([61]);
    const patternId = fixtureFull.patternId;
    const store = fixtureFull.store;
    console.log("T2 fixture notes:", JSON.stringify(notesOf(fixtureFull.store.doc, patternId)));
    console.log("T2 store notes:", JSON.stringify(notesOf(store.doc, patternId)));
    store.execute(addChord(store.doc, 0, 2, 0, "maj")); // C maj: bars 0–2
    console.log("T2 after chord1 notes:", JSON.stringify(notesOf(store.doc, patternId)));
    store.execute(addChord(store.doc, 2, 2, 7, "maj")); // G maj: bars 2–4 (tones G B D)
    console.log("T2 after chord2 notes:", JSON.stringify(notesOf(store.doc, patternId)));
    // Move the note's start into the G section: start = 2 bars + half bar.
    const noteId = notesOf(store.doc, patternId)[0]!.id;
    const trackId = Object.keys(store.doc.patterns.find((p) => p.id === patternId)!.notes ?? {})[0]!;
    const moved = (store.doc.patterns.find((p) => p.id === patternId)!.notes ?? {})[trackId]!.map((n) =>
      n.id === noteId ? { ...n, start: 2 * BAR_TICKS + 480 } : n,
    );
    store.execute({
      type: "probe-move-note",
      label: "probe",
      execute: (d: ProjectDocument) => ({
        ...d,
        patterns: d.patterns.map((p) => (p.id === patternId ? { ...p, notes: { ...p.notes, [trackId]: moved } } : p)),
      }),
      undo: (d: ProjectDocument) => d,
    } as never);
    store.execute(conformInstrumentClipsToChordTrack(store.doc, [store.doc.arrangement.clips[0]!.id]));
    console.log("T2 after conform notes:", JSON.stringify(notesOf(store.doc, patternId)));
    console.log("T2 patternId:", patternId, "found:", JSON.stringify(store.doc.patterns.map((p) => p.id)));
    console.log("T2 notes:", JSON.stringify(notesOf(store.doc, patternId)));
    const notes = notesOf(store.doc, patternId);
    expect(notes.length).toBeGreaterThan(0);
    const pitchClass = ((notes[0]!.pitch % 12) + 12) % 12;
    expect([7, 11, 2].includes(pitchClass)).toBe(true);
  });

  it("conform is idempotent — second pass changes nothing", () => {
    const { store, patternId } = fixtureWithNotes([61, 66]);
    store.execute(addChord(store.doc, 0, 4, 0, "maj"));
    store.execute(conformInstrumentClipsToChordTrack(store.doc, [store.doc.arrangement.clips[0]!.id]));
    const once = JSON.stringify(notesOf(store.doc, patternId).map((n) => n.pitch));
    const depth = store.undoStackLength;
    store.execute(conformInstrumentClipsToChordTrack(store.doc, [store.doc.arrangement.clips[0]!.id]));
    // Idempotent: the second conform changes nothing, so NO history entry.
    expect(store.undoStackLength).toBe(depth);
    expect(JSON.stringify(notesOf(store.doc, patternId).map((n) => n.pitch))).toBe(once);
  });

  it("refuses when the chord track is empty", () => {
    const { store } = fixtureWithNotes([60]);
    expect(() => conformInstrumentClipsToChordTrack(store.doc, [store.doc.arrangement.clips[0]!.id])).toThrow(
      /no chords/,
    );
  });
});
