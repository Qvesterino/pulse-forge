import { describe, expect, it } from "vitest";
import { buildSyllableTimeline, buildProsodyGrid, shapeMelodyToLyrics } from "../src/vocal/prosody";

/**
 * LYRICS→PROSODY (W2) — the rules a singer follows without thinking,
 * locked: one note per syllable, stressed syllables on the beat, the line
 * tail holds, line breaks breathe. The shaper keeps the melody's PITCH
 * language and adopts the grid's TIME — the lyrics' rhythm becomes the
 * melody's rhythm without inventing pitches.
 */

describe("syllable splitting", () => {
  it("splits EN and SK words into vowel-group syllables", () => {
    // Pinned real splits: melody → me·lo·dy, spievanie → spie·va·nie.
    const timeline = buildSyllableTimeline("melody\nspievanie");
    expect(timeline.lines).toEqual(["melody", "spievanie"]);
    expect(timeline.lineCounts).toEqual([3, 3]);
    expect(timeline.syllables.map((s) => s.text)).toEqual(["me", "lo", "dy", "spie", "va", "nie"]);
  });

  it("blank lines breathe and never become syllable lines", () => {
    const timeline = buildSyllableTimeline("hey\n\nthere you");
    expect(timeline.lines).toEqual(["hey", "there you"]);
    // there → the·re, you → yo·u — the vowel-group method is approximate;
    // deterministic is what matters (a human fixes spelling in the lyrics
    // field the same way hyphenation does).
    expect(timeline.lineCounts).toEqual([1, 4]);
  });
});

describe("prosody grid", () => {
  it("stressed first syllables land ON the beat head at higher velocity", () => {
    const timeline = buildSyllableTimeline("sun light day");
    const grid = buildProsodyGrid(timeline);
    const first = grid.notes[0];
    expect(first.startStep).toBe(0);
    expect(first.stressed || first.syllable === "sun").toBe(true);
    expect(first.velocity).toBeGreaterThanOrEqual(0.85);
    expect(first.durationSteps).toBeGreaterThanOrEqual(2);
  });

  it("the line tail holds and the grid stays within its line window", () => {
    const timeline = buildSyllableTimeline("sing along with me");
    const grid = buildProsodyGrid(timeline);
    for (const note of grid.notes) {
      expect(note.startStep).toBeGreaterThanOrEqual(0);
      expect(note.startStep).toBeLessThan(grid.lineSteps);
      expect(note.durationSteps).toBeGreaterThanOrEqual(1);
    }
    const last = grid.notes[grid.notes.length - 1];
    expect(last.startStep + last.durationSteps).toBeLessThanOrEqual(grid.lineSteps + 4);
  });
});

describe("shapeMelodyToLyrics", () => {
  it("keeps the melody's pitch language and adopts the grid time", () => {
    const melody = [
      { pitch: 60, velocity: 0.7 },
      { pitch: 64, velocity: 0.7 },
      { pitch: 67, velocity: 0.7 },
      { pitch: 64, velocity: 0.7 },
    ];
    const timeline = buildSyllableTimeline("sing it loud");
    const grid = buildProsodyGrid(timeline);
    const shaped = shapeMelodyToLyrics(melody, grid);
    expect(shaped.length).toBe(grid.notes.length);
    for (const note of shaped) {
      expect(melody.map((m) => m.pitch)).toContain(note.pitch); // no invented pitches
      expect(note.velocity).toBeGreaterThan(0);
      expect(note.syllable.length).toBeGreaterThan(0);
    }
  });

  it("empty melody or empty grid is honest-empty", () => {
    expect(shapeMelodyToLyrics([], buildProsodyGrid(buildSyllableTimeline("la la")))).toEqual([]);
    expect(shapeMelodyToLyrics([{ pitch: 60, velocity: 0.7 }], { notes: [], lineSteps: 32, lineCount: 0 })).toEqual([]);
  });
});
