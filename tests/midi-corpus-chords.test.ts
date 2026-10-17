import { describe, expect, it } from "vitest";
import type { MidiNote } from "../src/midi/midiFile";
import { deriveCorpusChordEvents, harmonicFunctionOfDegree } from "../src/ai/midi-corpus-ingest";

/**
 * W1 bridge — chord track → ChordEvent[] derivation (the missing corpus→v3
 * adapter). Pins: joint root+quality matching reads INVERSIONS correctly
 * (the lowest-note shortcut mislabels {C,E,G} as min@E), function follows
 * the harmony.ts convention (I/vi=T, ii/IV=S, V=D), unknown-key/empty input
 * is honestly empty, and slices cap at maxSteps.
 */

const STEP = 120; // 16th @ 120bpm, 480 PPQ

function note(pitch: number, startTick: number, endTick: number): MidiNote {
  return { pitch, startTick, endTick, velocity: 100 };
}

const C_MAJOR = "C Major";

describe("deriveCorpusChordEvents (W1 corpus→v3 bridge)", () => {
  it("a C major triad slice reads as degree 0, maj, T", () => {
    const events = deriveCorpusChordEvents(
      [note(60, 0, STEP * 8), note(64, 0, STEP * 8), note(67, 0, STEP * 8)],
      C_MAJOR,
      128,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ degree: 0, quality: "maj", func: "T" });
    expect(events[0]!.duration).toBe(8);
  });

  it("an INVERSION reads as the same chord (joint root+quality, not lowest-note)", () => {
    // C major first inversion: E4 G4 C5 — lowest pc is E, but the set is maj@C.
    const events = deriveCorpusChordEvents(
      [note(64, 0, STEP * 8), note(67, 0, STEP * 8), note(72, 0, STEP * 8)],
      C_MAJOR,
      128,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ degree: 0, quality: "maj", func: "T" });
  });

  it("G7 reads as degree 4 dom7 D; A minor as degree 5 min T", () => {
    const g7 = deriveCorpusChordEvents(
      [note(55, 0, STEP * 4), note(59, 0, STEP * 4), note(62, 0, STEP * 4), note(65, 0, STEP * 4)],
      C_MAJOR,
      128,
    );
    expect(g7).toHaveLength(1);
    expect(g7[0]).toMatchObject({ degree: 4, quality: "dom7", func: "D" });

    const aMin = deriveCorpusChordEvents(
      [note(57, 0, STEP * 4), note(60, 0, STEP * 4), note(64, 0, STEP * 4)],
      C_MAJOR,
      128,
    );
    expect(aMin[0]).toMatchObject({ degree: 5, quality: "min", func: "T" });
  });

  it("a progression becomes ordered slices with step-true durations", () => {
    // C (1 beat) then G7 (1 beat): two slices, 4 steps each.
    const events = deriveCorpusChordEvents(
      [
        note(60, 0, STEP * 4),
        note(64, 0, STEP * 4),
        note(67, 0, STEP * 4),
        note(55, STEP * 4, STEP * 8),
        note(59, STEP * 4, STEP * 8),
        note(62, STEP * 4, STEP * 8),
        note(65, STEP * 4, STEP * 8),
      ],
      C_MAJOR,
      128,
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ degree: 0, quality: "maj", duration: 4 });
    expect(events[1]).toMatchObject({ degree: 4, quality: "dom7", duration: 4 });
  });

  it("honest empties: no notes, no key, or an unrecognizable cluster produce no invented chords", () => {
    expect(deriveCorpusChordEvents([], C_MAJOR, 128)).toEqual([]);
    const cluster = deriveCorpusChordEvents(
      [note(60, 0, STEP * 4), note(61, 0, STEP * 4), note(66, 0, STEP * 4)],
      C_MAJOR,
      128,
    );
    // {C,C#,F#} — no chord template covers 2/3 of itself inside this set
    // ({C,D} would have been a legitimate sus2 subset; this is not that).
    expect(cluster).toEqual([]);
    // Null key → no tonic → no derivation.
    expect(deriveCorpusChordEvents([note(60, 0, STEP * 8), note(64, 0, STEP * 8)], null, 128)).toEqual([]);
  });

  it("slices cap at maxSteps (the 8-bar corpus cap)", () => {
    const long = deriveCorpusChordEvents(
      [note(60, 0, STEP * 200), note(64, 0, STEP * 200), note(67, 0, STEP * 200)],
      C_MAJOR,
      128,
    );
    expect(events_durationSum(long)).toBeLessThanOrEqual(128);
  });

  it("harmonicFunctionOfDegree follows the harmony.ts convention", () => {
    expect(harmonicFunctionOfDegree(0)).toBe("T");
    expect(harmonicFunctionOfDegree(5)).toBe("T");
    expect(harmonicFunctionOfDegree(1)).toBe("S");
    expect(harmonicFunctionOfDegree(3)).toBe("S");
    expect(harmonicFunctionOfDegree(4)).toBe("D");
    expect(harmonicFunctionOfDegree(2)).toBe("p");
    expect(harmonicFunctionOfDegree(6)).toBe("p");
  });
});

function events_durationSum(events: Array<{ duration: number }>): number {
  return events.reduce((sum, e) => sum + e.duration, 0);
}
