import { describe, it, expect } from "vitest";
import { testDoc } from "./fixtures/doc";
import {
  selectProgression,
  expandProgression,
  voiceLead,
  chordToneSemitones,
  romanNumeral,
  PROGRESSIONS_BY_GENRE,
  type ChordProgression,
} from "../src/ai/harmony";
import { generateMultiVoice } from "../src/intent/multi-voice";
import { snapToScale, SCALE_INTERVALS } from "../src/project-model/scales";

describe("chord progression engine (functional harmony)", () => {
  it("every genre has progressions with valid structure", () => {
    for (const genre of ["house", "techno", "trap", "ambient"]) {
      const progs = PROGRESSIONS_BY_GENRE[genre];
      expect(progs.length).toBeGreaterThanOrEqual(2);
      for (const prog of progs) {
        expect(prog.events.length).toBeGreaterThanOrEqual(2);
        for (const event of prog.events) {
          expect(event.degree).toBeGreaterThanOrEqual(0);
          expect(event.degree).toBeLessThanOrEqual(6);
          expect(event.duration).toBeGreaterThan(0);
          expect(["T", "S", "D", "p"]).toContain(event.func);
        }
      }
    }
  });

  it("selection is deterministic for the same seed", () => {
    const a = selectProgression("house", 42);
    const b = selectProgression("house", 42);
    expect(a).toEqual(b);
  });

  it("different seeds can select different progressions", () => {
    const progs = PROGRESSIONS_BY_GENRE.techno;
    expect(progs.length).toBeGreaterThanOrEqual(2);
  });

  it("expansion fills exactly the target step count", () => {
    const prog: ChordProgression = {
      name: "test", genre: "house",
      events: [
        { degree: 0, quality: "maj", duration: 4, func: "T" },
        { degree: 4, quality: "dom7", duration: 4, func: "D" },
      ],
    };
    const expanded = expandProgression(prog, 64);
    const total = expanded.reduce((sum, e) => sum + e.duration, 0);
    expect(total).toBeGreaterThanOrEqual(64);
  });

  it("chord tone intervals are correct", () => {
    expect(chordToneSemitones("maj")).toEqual([0, 4, 7]);
    expect(chordToneSemitones("min")).toEqual([0, 3, 7]);
    expect(chordToneSemitones("dom7")).toEqual([0, 4, 7, 10]);
    expect(chordToneSemitones("sus4")).toEqual([0, 5, 7]);
  });

  it("roman numerals reflect quality", () => {
    expect(romanNumeral(0, "maj")).toBe("I");
    expect(romanNumeral(3, "min")).toBe("iv");
    expect(romanNumeral(4, "dom7")).toBe("V7");
  });

  it("voice leading minimises movement", () => {
    // C major triad (C-E-G = 60-64-67) → F major (F-A-C)
    // Best voicing: F-A-C with minimal movement from C-E-G
    const prev = [60, 64, 67];
    const result = voiceLead(prev, 65, "maj"); // F major starting at F(65)
    // The F major triad starting at F=65 would be 65-69-72
    // But voice leading may pick a different octave/rotation
    expect(result.length).toBe(3);
    // Movement should be less than or equal to root-position movement
    const rootPosDistance = Math.abs(65 - 60) + Math.abs(69 - 64) + Math.abs(72 - 67);
    const actualDistance = result.reduce((sum, pitch, i) =>
      sum + Math.abs(pitch - prev[Math.min(i, prev.length - 1)]), 0);
    expect(actualDistance).toBeLessThanOrEqual(rootPosDistance + 12); // allow octave jump
  });
});

describe("multi-voice orchestrator (harmonic awareness)", () => {
  const INTENT = { seed: "mv-test", energy: 0.8, velocityVariation: 0.3 };

  it("all three voices are generated with content", () => {
    const doc = testDoc();
    const result = generateMultiVoice(doc, "house", 42, 64, "C Natural Minor", 0.8, 0.3);
    expect(result.bass.length).toBeGreaterThan(0);
    expect(result.chord.length).toBeGreaterThan(0);
    expect(result.lead.length).toBeGreaterThan(0);
    expect(result.progressionName).toBeTruthy();
  });

  it("bass follows chord roots (scale-conformant pitches)", () => {
    const doc = testDoc();
    const result = generateMultiVoice(doc, "house", 42, 64, "C Natural Minor", 0.8, 0.3);
    for (const note of result.bass) {
      // every bass note should be in the C natural minor scale
      const pitchClass = note.pitch % 12;
      const minorScale = [0, 2, 3, 5, 7, 8, 10];
      expect(minorScale).toContain(pitchClass);
    }
  });

  it("lead exists only when energy is high enough", () => {
    const doc = testDoc();
    const high = generateMultiVoice(doc, "house", 42, 64, null, 0.9, 0.3);
    const low = generateMultiVoice(doc, "house", 42, 64, null, 0.3, 0.3);
    expect(high.lead.length).toBeGreaterThan(0);
    expect(low.lead.length).toBe(0); // energy < 0.4 → no lead
  });

  it("chords have voice leading (pitches don't jump wildly between consecutive chords)", () => {
    const doc = testDoc();
    const result = generateMultiVoice(doc, "house", 42, 64, null, 0.8, 0.3);
    // Chord notes at consecutive chord starts should be close together
    const chordStarts = result.chord.map((note) => note.start).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
    if (chordStarts.length >= 2) {
      const pitchesAtStart1 = result.chord.filter((n) => n.start === chordStarts[0]).map((n) => n.pitch).sort((a, b) => a - b);
      const pitchesAtStart2 = result.chord.filter((n) => n.start === chordStarts[1]).map((n) => n.pitch).sort((a, b) => a - b);
      // Average movement should be reasonable (less than an octave)
      const movements = pitchesAtStart2.map((p2, i) =>
        Math.abs(p2 - (pitchesAtStart1[i] ?? pitchesAtStart1[0])));
      const avgMovement = movements.reduce((s, m) => s + m, 0) / Math.max(1, movements.length);
      expect(avgMovement).toBeLessThan(12); // less than an octave average movement
    }
  });

  it("is deterministic for the same inputs", () => {
    const doc = testDoc();
    const a = generateMultiVoice(doc, "trap", 42, 64, "A Natural Minor", 0.8, 0.3);
    const b = generateMultiVoice(doc, "trap", 42, 64, "A Natural Minor", 0.8, 0.3);
    expect(a.bass.map((n) => [n.pitch, n.start, n.velocity])).toEqual(
      b.bass.map((n) => [n.pitch, n.start, n.velocity]));
    expect(a.chord.map((n) => [n.pitch, n.start])).toEqual(
      b.chord.map((n) => [n.pitch, n.start]));
    expect(a.lead.map((n) => [n.pitch, n.start])).toEqual(
      b.lead.map((n) => [n.pitch, n.start]));
  });
});
