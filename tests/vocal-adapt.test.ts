import { describe, expect, it } from "vitest";
import { testDoc } from "./fixtures/doc";
import { applyVocalKeyCommand, applyVocalTempoCommand, keyTransposeDelta } from "../src/vocal/adapt";
import type { VocalProfile } from "../src/vocal/types";

/**
 * V1 VOCAL ADAPT — key transpose + tempo match as one-undo commands.
 *
 * Profiles here are hand-built (analysis is covered in vocal-profile.test);
 * what matters: semitone math, drum immunity, clamping, honest throws on
 * unmeasured fields, and undo restoring the document.
 */

function profileWith(overrides: Partial<VocalProfile>): VocalProfile {
  return {
    version: 1,
    key: null,
    keyConfidence: 0,
    keyMeasured: false,
    tempoBpm: null,
    tempoConfidence: 0,
    tempoMeasured: false,
    energyCurve: [],
    phrases: [],
    silenceRatio: 0,
    snrDb: 20,
    durationSec: 10,
    bars: 5,
    bpm: 120,
    measured: true,
    profileHash: "deadbeef",
    ...overrides,
  };
}

describe("keyTransposeDelta (shortest path)", () => {
  it("moves the short way around the circle", () => {
    expect(keyTransposeDelta(0, 2)).toBe(2); // C → D up a tone
    expect(keyTransposeDelta(2, 0)).toBe(-2); // D → C down a tone
    expect(keyTransposeDelta(0, 9)).toBe(-3); // C → A down a minor third, not +9
    expect(keyTransposeDelta(0, 11)).toBe(-1); // C → B down a semitone
    expect(keyTransposeDelta(5, 5)).toBe(0);
  });
});

describe("applyVocalKeyCommand", () => {
  it("sets the key and transposes melodic notes, drums untouched", () => {
    const doc = { ...testDoc(), key: "C Major" as const };
    // Drum rows are unpitched — transpose must leave every row untouched.
    const rowsBefore = JSON.stringify(doc.patterns.map((p) => p.rows));
    const before = doc.patterns.flatMap((p) =>
      Object.values(p.notes)
        .flat()
        .map((n) => n.pitch),
    );

    const cmd = applyVocalKeyCommand(doc, profileWith({ key: "D Major", keyMeasured: true }));
    const next = cmd.execute(doc);

    expect(next.key).toBe("D Major");
    const after = next.patterns.flatMap((p) =>
      Object.values(p.notes)
        .flat()
        .map((n) => n.pitch),
    );
    expect(before.length).toBeGreaterThan(0);
    expect(after).toEqual(before.map((pitch) => Math.min(127, pitch + 2)));
    expect(JSON.stringify(next.patterns.map((p) => p.rows))).toBe(rowsBefore);

    // One undo step restores everything.
    const undone = cmd.undo(next);
    expect(undone.key).toBe("C Major");
    expect(
      undone.patterns.flatMap((p) =>
        Object.values(p.notes)
          .flat()
          .map((n) => n.pitch),
      ),
    ).toEqual(before);
  });

  it("transpose:false sets the key without moving notes (regenerate flow)", () => {
    const doc = { ...testDoc(), key: "C Major" as const };
    const pitches = doc.patterns.flatMap((p) =>
      Object.values(p.notes)
        .flat()
        .map((n) => n.pitch),
    );
    const next = applyVocalKeyCommand(doc, profileWith({ key: "G Major", keyMeasured: true }), {
      transpose: false,
    }).execute(doc);
    expect(next.key).toBe("G Major");
    expect(
      next.patterns.flatMap((p) =>
        Object.values(p.notes)
          .flat()
          .map((n) => n.pitch),
      ),
    ).toEqual(pitches);
  });

  it("clamps transposed pitches into MIDI range", () => {
    const doc = { ...testDoc(), key: "C Major" as const };
    const targetTrackId = doc.tracks.find((t) => t.kind === "instrument")!.id;
    // C (0) → F (5) is +5 by shortest path: 126 + 5 clamps to 127.
    const withHigh = {
      ...doc,
      patterns: doc.patterns.map((p, i) =>
        i === 0
          ? {
              ...p,
              notes: {
                ...p.notes,
                [targetTrackId]: [
                  ...(p.notes[targetTrackId] ?? []),
                  { id: "n", pitch: 126, start: 0, duration: 120, velocity: 0.8 },
                ],
              },
            }
          : p,
      ),
    };
    const next = applyVocalKeyCommand(withHigh, profileWith({ key: "F Major", keyMeasured: true })).execute(withHigh);
    const moved = next.patterns[0].notes[targetTrackId];
    expect(moved[moved.length - 1].pitch).toBe(127);
  });

  it("throws honestly on an unmeasured key", () => {
    const doc = testDoc();
    expect(() => applyVocalKeyCommand(doc, profileWith({}))).toThrow(/no measurable key/);
  });
});

describe("applyVocalTempoCommand", () => {
  it("matches the transport tempo in one undo step", () => {
    const doc = testDoc();
    const cmd = applyVocalTempoCommand(doc, profileWith({ tempoBpm: 96, tempoMeasured: true }));
    expect(cmd.execute(doc).bpm).toBe(96);
    expect(cmd.undo(cmd.execute(doc)).bpm).toBe(doc.bpm);
  });

  it("throws honestly on an unmeasured tempo", () => {
    expect(() => applyVocalTempoCommand(testDoc(), profileWith({}))).toThrow(/no measurable tempo/);
  });
});
