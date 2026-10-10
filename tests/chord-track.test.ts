import { describe, expect, it } from "vitest";
import type { ProjectDocument } from "../src/project-model/types";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject, SCHEMA_VERSION } from "../src/project-model/schema";
import { ProjectStore } from "../src/store/ProjectStore";
import { addChord, moveChord, resizeChord, setChord } from "../src/commands/chordTrack";
import { chordName, chordPitchClasses, nearestChordPitch, suggestChordFromPitches } from "../src/project-model/chords";

/**
 * CHORD TRACK (schema v17) — the arrangement's harmonic skeleton.
 *
 *  C1 chordPitchClasses/chordName: the theory table (Cmaj7 = C,E,G,B …)
 *  C2 addChord: whole-bar events, no-overlap lane, guards (root 0–11,
 *     known quality, ≥ 1 bar, finite bars)
 *  C3 move/resize: no-overlap enforced, no-op pushes no entry, undo exact
 *  C4 setChord: re-root/re-quality in place, position untouched
 *  C5 normalize: valid chords round-trip, shape-invalid ones dropped,
 *     time-sorted; schema is v17
 *  C6 detection + snap: suggestChordFromPitches picks the chord that
 *     explains the input; nearestChordPitch lands on chord tones
 */

describe("C1 theory table", () => {
  it("Cmaj7 = C E G B; Am = A C E; names render", () => {
    expect(chordPitchClasses(0, "maj7")).toEqual([0, 4, 7, 11]);
    expect(chordPitchClasses(9, "min")).toEqual([9, 0, 4]);
    expect(chordName(0, "maj")).toBe("C");
    expect(chordName(9, "min7")).toBe("Am7");
    expect(chordName(6, "maj7")).toBe("F#maj7");
  });
});

const fixture = () => {
  const doc = createProjectFromTemplate("house");
  const store = new ProjectStore(doc);
  store.execute(addChord(store.doc, 0, 4, 0, "maj")); // C at bars 1–4
  return { store, chordId: (store.doc.arrangement.chords ?? [])[0]!.id };
};

describe("C2 addChord", () => {
  it("adds a whole-bar chord; overlaps refuse", () => {
    const { store, chordId } = fixture();
    expect(store.doc.arrangement.chords).toHaveLength(1);
    // Overlaps bars 1–4 → refuse.
    expect(() => addChord(store.doc, 3, 4, 7, "maj")).toThrow(/overlap/);
    // Touching (bar 4 onward) is legal.
    store.execute(addChord(store.doc, 4, 4, 5, "min"));
    expect(store.doc.arrangement.chords).toHaveLength(2);
    void chordId;
  });

  it("guards: fractional bars, root out of range, unknown quality", () => {
    const { store } = fixture();
    expect(() => addChord(store.doc, 4.5, 2, 0, "maj")).not.toThrow(); // rounds to 5
    expect(() => addChord(store.doc, 0, 0, 0, "maj")).toThrow(/at least one whole bar/);
    expect(() => addChord(store.doc, 10, 2, 12, "maj")).toThrow(/pitch class/);
    expect(() => addChord(store.doc, 10, 2, 0, "blues" as never)).toThrow(/quality/);
  });
});

describe("C3 move/resize", () => {
  it("no-overlap enforced; no-op pushes no entry; undo restores exactly", () => {
    const { store, chordId } = fixture();
    store.execute(addChord(store.doc, 4, 4, 7, "maj"));
    const baseline = store.doc;
    // Overlapping move refuses.
    expect(() => moveChord(store.doc, chordId, 3)).toThrow(/overlap/);
    // Legal move.
    store.execute(moveChord(store.doc, chordId, 8));
    expect((store.doc.arrangement.chords ?? []).find((c) => c.id === chordId)!.startBar).toBe(8);
    // No-op move: same position.
    const depth = store.undoStackLength;
    store.execute(moveChord(store.doc, chordId, 8));
    expect(store.undoStackLength).toBe(depth);
    store.undo();
    expect(store.doc).toEqual(baseline);
  });

  it("resize keeps the start; overlap refuses; minimum one bar", () => {
    const { store, chordId } = fixture();
    store.execute(resizeChord(store.doc, chordId, 6));
    const chord = (store.doc.arrangement.chords ?? []).find((c) => c.id === chordId)!;
    expect(chord.startBar).toBe(0);
    expect(chord.lengthBars).toBe(6);
    expect(() => resizeChord(store.doc, chordId, 0)).toThrow(/at least one whole bar/);
  });
});

describe("C4 setChord", () => {
  it("re-roots in place; position and length untouched; no-op pushes nothing", () => {
    const { store, chordId } = fixture();
    store.execute(setChord(store.doc, chordId, { root: 9, quality: "min7" }));
    const chord = (store.doc.arrangement.chords ?? []).find((c) => c.id === chordId)!;
    expect(chord.root).toBe(9);
    expect(chord.quality).toBe("min7");
    expect(chord.startBar).toBe(0);
    expect(chord.lengthBars).toBe(4);
    const depth = store.undoStackLength;
    store.execute(setChord(store.doc, chordId, { root: 9, quality: "min7" }));
    expect(store.undoStackLength).toBe(depth);
  });
});

describe("C5 normalize round-trip", () => {
  it("valid chords survive sorted; invalid shapes drop; schema includes the chord track", () => {
    expect(SCHEMA_VERSION).toBe(20);
    const { store, chordId } = fixture();
    store.execute(addChord(store.doc, 4, 4, 7, "min7"));
    const normalized = normalizeProject(store.doc);
    const chords = normalized.arrangement.chords ?? [];
    expect(chords.map((c) => c.startBar)).toEqual([0, 4]);
    expect(chords.find((c) => c.id === chordId)!.quality).toBe("maj");
    // Shape-invalid chords are dropped by normalize.
    const polluted = {
      ...store.doc,
      arrangement: {
        ...store.doc.arrangement,
        chords: [
          ...chords,
          { id: "bad-root", startBar: 10, lengthBars: 2, root: 14, quality: "maj" },
          { id: "bad-quality", startBar: 12, lengthBars: 2, root: 0, quality: "blues" },
          { id: "bad-length", startBar: 14, lengthBars: 0, root: 0, quality: "maj" },
        ],
      },
    } as unknown as ProjectDocument;
    const normalized2 = normalizeProject(polluted);
    expect(
      (normalized2.arrangement.chords ?? []).every((c) =>
        ["bad-root", "bad-quality", "bad-length"].every((bad) => c.id !== bad),
      ),
    ).toBe(true);
  });
});

describe("C6 detection + snap helpers", () => {
  it("suggestChordFromPitches finds the chord explaining C-E-G", () => {
    const suggestion = suggestChordFromPitches([0, 4, 7]);
    expect(suggestion).not.toBeNull();
    expect(suggestion!.root).toBe(0);
    expect(["maj", "dom7", "maj7"].includes(suggestion!.quality)).toBe(true);
  });

  it("an A-minor pentatonic input suggests an A-rooted chord", () => {
    const suggestion = suggestChordFromPitches([9, 0, 4, 7]); // A C E G
    expect(suggestion).not.toBeNull();
    expect(suggestion!.root).toBe(9);
  });

  it("fewer than two pitch classes → null", () => {
    expect(suggestChordFromPitches([0])).toBeNull();
    expect(suggestChordFromPitches([])).toBeNull();
  });

  it("nearestChordPitch lands on chord tones within an octave neighborhood", () => {
    const cMaj = { root: 0, quality: "maj" as const };
    expect(nearestChordPitch(60, cMaj)).toBe(60); // C is a tone
    expect(nearestChordPitch(61, cMaj)).toBe(60); // C# → C
    // Tie-break (equidistant) resolves DOWN to the lower tone: D → C.
    expect(nearestChordPitch(62, cMaj)).toBe(60);
    expect(nearestChordPitch(59, cMaj)).toBe(60); // B → C (up)
    expect(nearestChordPitch(58, cMaj)).toBe(60); // A#: C(60) is 2 away, G(55) is 3 — nearer wins
    // Range clamps.
    expect(nearestChordPitch(63, cMaj, { min: 0, max: 60 })).toBe(60);
  });
});
