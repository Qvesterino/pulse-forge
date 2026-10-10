import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import {
  addChord,
  generateChordProgression,
} from "../src/commands/chordTrack";
import { chordName, chordPitchClasses } from "../src/project-model/chords";
import { PROGRESSIONS_BY_GENRE } from "../src/ai/harmony";

/**
 * CHORD PROGRESSION GENERATION (chord track v2) — the AI harmony library's
 * genre progressions laid directly onto the chord lane.
 *
 *  GP1 layout: the span fills exactly — no gaps, no overflow, whole bars
 *  GP2 degree→pitch: roots resolve through the mode's scale from the tonic
 *     (I-vi-IV-V in C minor → C, Ab, Eb, Bb pitch classes)
 *  GP3 replace-in-range: chords inside the span are regenerated, chords
 *     outside survive; one undoable entry; undo restores exactly
 *  GP4 deterministic: same options → same chords; progressionIndex picks a
 *     different progression from the genre table
 *  GP5 every generated chord is a legal pitch-class set (chordName renders,
 *     pitch classes within 0–11)
 */

const store = () => new ProjectStore(createProjectFromTemplate("house"));

describe("GP1/GP2 layout and harmony", () => {
  it("I-vi-IV-V in C minor over 8 bars: 4 chords × 2 bars, minor-scale roots", () => {
    const s = store();
    s.execute(generateChordProgression(s.doc, 0, 8, { tonic: 0, mode: "minor", genre: "house", progressionIndex: 0 }));
    const chords = s.doc.arrangement.chords ?? [];
    // House progression index 0 = I-vi-IV-V: degrees 0, 5, 3, 4.
    const minor = [0, 2, 3, 5, 7, 8, 10];
    const expectedRoots = [0, 5, 3, 4].map((degree) => (minor[degree]! + 0) % 12);
    expect(chords.map((c) => c.root)).toEqual(expectedRoots);
    // Adjacent, spanning exactly 8 bars: 2 + 2 + 2 + 2.
    expect(chords.map((c) => [c.startBar, c.lengthBars])).toEqual([
      [0, 2],
      [2, 2],
      [4, 2],
      [6, 2],
    ]);
    // Names render (no "?"): roots are legal pitch classes.
    for (const c of chords) expect(chordName(c.root, c.quality)).not.toContain("?");
  });

  it("the span always fills exactly — 7 bars over a 4-chord progression", () => {
    const s = store();
    s.execute(generateChordProgression(s.doc, 0, 7, { tonic: 2, mode: "major", genre: "house" }));
    const chords = s.doc.arrangement.chords ?? [];
    expect(chords.length).toBeGreaterThanOrEqual(3);
    // No gaps, no overflow: each starts where the previous ends; total = 7.
    let cursor = 0;
    for (const c of chords) {
      expect(c.startBar).toBe(cursor);
      cursor += c.lengthBars;
    }
    expect(cursor).toBe(7);
  });
});

describe("GP3 replace-in-range", () => {
  it("chords inside the span regenerate; chords outside survive; undo exact", () => {
    const s = store();
    s.execute(addChord(s.doc, 0, 2, 0, "maj")); // inside the span
    s.execute(addChord(s.doc, 12, 2, 5, "maj")); // outside the span
    s.execute(generateChordProgression(s.doc, 0, 8, { tonic: 0, mode: "minor", genre: "house" }));
    const chords = s.doc.arrangement.chords ?? [];
    // The 8-bar span is fully regenerated; the bar-12 chord survives.
    expect(chords.every((c) => c.startBar < 8 || c.startBar === 12)).toBe(true);
    expect(chords.find((c) => c.startBar === 12)?.root).toBe(5);
    s.undo();
    // Undo restores BOTH hand-placed chords and removes the generation.
    expect((s.doc.arrangement.chords ?? []).find((c) => c.startBar === 0)?.root).toBe(0);
    expect((s.doc.arrangement.chords ?? []).find((c) => c.startBar === 12)?.root).toBe(5);
    expect(s.doc.arrangement.chords).toHaveLength(2);
  });
});

describe("GP4 determinism", () => {
  it("same options → same chords; progressionIndex selects a different table entry", () => {
    const a = store();
    const b = store();
    a.execute(generateChordProgression(a.doc, 0, 8, { tonic: 0, mode: "minor", genre: "house", progressionIndex: 1 }));
    b.execute(generateChordProgression(b.doc, 0, 8, { tonic: 0, mode: "minor", genre: "house", progressionIndex: 1 }));
    expect(a.doc.arrangement.chords).toEqual(b.doc.arrangement.chords);

    a.execute(generateChordProgression(a.doc, 0, 8, { tonic: 0, mode: "minor", genre: "house", progressionIndex: 2 }));
    const first = JSON.stringify(a.doc.arrangement.chords);
    a.execute(generateChordProgression(a.doc, 0, 8, { tonic: 0, mode: "minor", genre: "house", progressionIndex: 3 }));
    const second = JSON.stringify(a.doc.arrangement.chords);
    // House has several progressions — indices 2 and 3 must differ.
    expect(first).not.toBe(second);
  });

  it("every genre table produces a legal layout (21 genres)", () => {
    for (const genre of Object.keys(PROGRESSIONS_BY_GENRE)) {
      const s = store();
      s.execute(generateChordProgression(s.doc, 0, 8, { tonic: 3, mode: "minor", genre }));
      const chords = s.doc.arrangement.chords ?? [];
      expect(chords.length, genre).toBeGreaterThan(0);
      let cursor = 0;
      for (const c of chords) {
        expect(c.startBar, genre).toBe(cursor);
        expect(c.root >= 0 && c.root <= 11, genre).toBe(true);
        cursor += c.lengthBars;
      }
      expect(cursor, genre).toBe(8);
    }
  });
});

describe("GP5 guards", () => {
  it("zero span and unknown genre refuse", () => {
    const s = store();
    expect(() => generateChordProgression(s.doc, 0, 0, { tonic: 0 })).toThrow(/at least one whole bar/);
    expect(() => generateChordProgression(s.doc, 0, 8, { tonic: 0, genre: "gregorian" })).toThrow(/Unknown genre/);
  });

  it("generated chords are legal pitch-class sets (render + snap safe)", () => {
    const s = store();
    s.execute(generateChordProgression(s.doc, 0, 8, { tonic: 9, mode: "minor", genre: "dnb" }));
    for (const chord of s.doc.arrangement.chords ?? []) {
      for (const pc of chordPitchClasses(chord.root, chord.quality)) {
        expect(pc >= 0 && pc <= 11).toBe(true);
      }
      expect(chordName(chord.root, chord.quality)).not.toContain("?");
    }
  });
});
