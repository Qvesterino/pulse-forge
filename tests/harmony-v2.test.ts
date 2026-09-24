import { describe, expect, it } from "vitest";
import { testDoc } from "./fixtures/doc";
import { CHORD_INTERVALS, PROGRESSIONS_BY_GENRE, selectProgression } from "../src/ai/harmony";
import { generateMultiVoice } from "../src/intent/multi-voice";
import type { NoteEvent } from "../src/project-model/types";

/**
 * P3 HARMONY 2.0 — bigger progression library, bass passing tones, lead motif.
 *
 * Library: 36 progressions (core genres 6 each, drill/phonk/jersey/dnb 3 each
 * — the latter previously fell through to the house set). New entries are
 * APPENDED, so seeds 0..2 keep their legacy progression.
 *
 * Figures: density-gated chromatic bass passing tones into chord changes
 * (deterministic, rand-free) and a bar-0 lead motif replayed every 4th bar
 * transposed onto that bar's chord. At 64 steps + default density the output
 * is unchanged (no 4th-bar replay, no passing tones) — existing tests pin that.
 */

const CORE_GENRES = ["house", "techno", "trap", "ambient"];
const NEW_GENRES = ["drill", "phonk", "jersey", "dnb"];
const MAJOR_PITCH_CLASSES = [0, 2, 4, 5, 7, 9, 11];

function relativeStarts(notes: NoteEvent[], bar: number): number[] {
  return notes
    .filter((n) => n.start >= bar * 16 * 120 && n.start < (bar + 1) * 16 * 120)
    .map((n) => n.start - bar * 16 * 120)
    .sort((a, b) => a - b);
}

describe("P3 progression library (36 progressions, 8 genres)", () => {
  it("covers every intent genre; core genres keep 6, new ones have 3", () => {
    for (const genre of [...CORE_GENRES, ...NEW_GENRES]) {
      const list = PROGRESSIONS_BY_GENRE[genre];
      expect(list, genre).toBeDefined();
      expect(list.length).toBeGreaterThanOrEqual(3);
    }
    for (const genre of CORE_GENRES) {
      expect(PROGRESSIONS_BY_GENRE[genre].length).toBeGreaterThanOrEqual(6);
    }
  });

  it("every progression is a valid 16-step loop", () => {
    for (const [genre, list] of Object.entries(PROGRESSIONS_BY_GENRE)) {
      for (const prog of list) {
        const total = prog.events.reduce((sum, e) => sum + e.duration, 0);
        expect(total, `${genre}/${prog.name}`).toBe(16);
        for (const event of prog.events) {
          expect(event.degree).toBeGreaterThanOrEqual(0);
          expect(event.degree).toBeLessThanOrEqual(6);
          expect(Object.keys(CHORD_INTERVALS)).toContain(event.quality);
          expect(["T", "S", "D", "p"]).toContain(event.func);
        }
      }
    }
  });

  it("append-only discipline: seeds 0..2 keep their legacy progression", () => {
    expect(selectProgression("house", 0).name).toBe("I-vi-IV-V (pop hook)");
    expect(selectProgression("techno", 2).name).toBe("i-♭II (phrygian, industrial)");
    expect(selectProgression("trap", 0).name).toBe("i-VI-III-VII (emotional trap loop)");
    expect(selectProgression("ambient", 1).name).toBe("i7-iv7 (modal drift)");
  });

  it("new genres speak their own harmony (no house fallback)", () => {
    for (const genre of NEW_GENRES) {
      expect(selectProgression(genre, 0).genre).toBe(genre);
      expect(selectProgression(genre, 5).genre).toBe(genre);
    }
  });

  it("new genre sets generate full bands", () => {
    const doc = testDoc();
    for (const genre of NEW_GENRES) {
      const result = generateMultiVoice(doc, genre, 42, 64, null, 0.8, 0.3);
      expect(result.bass.length, genre).toBeGreaterThan(0);
      expect(result.chord.length, genre).toBeGreaterThan(0);
      expect(result.lead.length, genre).toBeGreaterThan(0);
    }
  });
});

describe("P3 bass passing tones (chromatic approach, density-gated)", () => {
  it("adds out-of-scale approach notes at high density, none at default", () => {
    const doc = testDoc();
    const dense = generateMultiVoice(doc, "house", 42, 64, "C Major", 0.8, 0.3, 0.9, 0.5);
    const chromatic = dense.bass.filter((n) => !MAJOR_PITCH_CLASSES.includes(n.pitch % 12));
    expect(chromatic.length).toBeGreaterThan(0);

    const plain = generateMultiVoice(doc, "house", 42, 64, "C Major", 0.8, 0.3);
    expect(plain.bass.every((n) => MAJOR_PITCH_CLASSES.includes(n.pitch % 12))).toBe(true);
  });

  it("is deterministic for the same inputs", () => {
    const doc = testDoc();
    const a = generateMultiVoice(doc, "house", 42, 96, "C Major", 0.8, 0.3, 0.9, 0.5);
    const b = generateMultiVoice(doc, "house", 42, 96, "C Major", 0.8, 0.3, 0.9, 0.5);
    const sig = (notes: NoteEvent[]) => notes.map((n) => [n.pitch, n.start, n.duration, n.velocity]);
    expect(sig(a.bass)).toEqual(sig(b.bass));
    expect(sig(a.chord)).toEqual(sig(b.chord));
    expect(sig(a.lead)).toEqual(sig(b.lead));
  });
});

describe("P3 lead motif carry (bar 0 replayed every 4th bar)", () => {
  it("bar 4 replays the bar-0 motif (rhythm + transposed pitches)", () => {
    const doc = testDoc();
    const result = generateMultiVoice(doc, "house", 42, 96, null, 0.8, 0.3);
    expect(result.lead.length).toBe(36); // 6 bars × 6-note rhythm
    expect(relativeStarts(result.lead, 4)).toEqual(relativeStarts(result.lead, 0));
    const pitchesOf = (bar: number) =>
      result.lead
        .filter((n) => n.start >= bar * 16 * 120 && n.start < (bar + 1) * 16 * 120)
        .sort((a, b) => a.start - b.start)
        .map((n) => n.pitch);
    // Same loop position (16-step progression) + same tone choices = same pitches.
    expect(pitchesOf(4)).toEqual(pitchesOf(0));
    // A varied bar samples freely — its pitches differ from the motif.
    expect(pitchesOf(1)).not.toEqual(pitchesOf(0));
  });
});
