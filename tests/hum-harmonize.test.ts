import { describe, it, expect } from "vitest";
import { buildHumHarmonyNotes, humAndHarmonizeCommand } from "../src/midi/hum-harmonize";
import { testDoc } from "./fixtures/doc";

/**
 * HUM & HARMONIZE — the one-undo command: a hummed take becomes the lead
 * line PLUS its key-snapped diatonic backing stack (third above + below).
 * The analysis is the real YIN tracker over a synthetic sine take.
 */

const SR = 44100;

/** 1.5 s of a steady sine at the given frequency (the hum). */
function sineTone(freq: number, seconds = 1.5): Float32Array {
  const data = new Float32Array(Math.floor(SR * seconds));
  for (let i = 0; i < data.length; i++) {
    data[i] = 0.6 * Math.sin((2 * Math.PI * freq * i) / SR);
  }
  return data;
}

describe("buildHumHarmonyNotes", () => {
  it("extracts the hummed melody and stacks the backing third pair", () => {
    // A3 (220 Hz) over A Natural Minor — the root, the friendliest hum
    const { melody, backing } = buildHumHarmonyNotes(sineTone(220), SR, {
      bpm: 120,
      key: "A Natural Minor",
      patternLengthTicks: 1920,
      clarityGate: 0.5,
    });
    expect(melody.length).toBeGreaterThan(0);
    expect(backing.length).toBeGreaterThan(0);
    // every backing note is diatonic to A natural minor
    const allowed = new Set([9, 11, 0, 2, 4, 5, 7]); // A B C D E F G pitch classes
    for (const note of backing) {
      expect(allowed.has(((note.pitch % 12) + 12) % 12)).toBe(true);
    }
    // backing sits under the lead velocity (0.75/0.7 multipliers on ≤1)
    const maxBacking = Math.max(...backing.map((n) => n.velocity));
    const maxLead = Math.max(...melody.map((n) => n.velocity));
    expect(maxBacking).toBeLessThan(maxLead);
  });

  it("is deterministic for the same take", () => {
    const pcm = sineTone(220);
    const a = buildHumHarmonyNotes(pcm, SR, { bpm: 120, key: "A Natural Minor", patternLengthTicks: 1920 });
    const b = buildHumHarmonyNotes(pcm, SR, { bpm: 120, key: "A Natural Minor", patternLengthTicks: 1920 });
    const strip = (notes: { pitch: number; start: number; duration: number; velocity: number }[]) =>
      notes.map((n) => ({ pitch: n.pitch, start: n.start, duration: n.duration, velocity: n.velocity }));
    expect(strip(a.melody)).toEqual(strip(b.melody));
    expect(strip(a.backing)).toEqual(strip(b.backing));
  });

  it("silence produces no notes (honest deafness)", () => {
    const { melody, backing } = buildHumHarmonyNotes(new Float32Array(SR), SR, {
      bpm: 120,
      key: "A Natural Minor",
      patternLengthTicks: 1920,
    });
    expect(melody.length).toBe(0);
    expect(backing.length).toBe(0);
  });
});

describe("humAndHarmonizeCommand", () => {
  const melody = [
    { id: "m1", pitch: 69, start: 0, duration: 480, velocity: 0.9 },
    { id: "m2", pitch: 72, start: 480, duration: 480, velocity: 0.85 },
  ];
  const backing = [
    { id: "b1", pitch: 72, start: 0, duration: 480, velocity: 0.6 },
    { id: "b2", pitch: 76, start: 0, duration: 480, velocity: 0.55 },
    { id: "b3", pitch: 64, start: 480, duration: 480, velocity: 0.6 },
  ];

  it("installs lead + backing on two tracks in one undo step", () => {
    const doc = testDoc();
    const lead = doc.tracks.find((t) => t.kind === "instrument")!;
    const backingTrack = doc.tracks.filter((t) => t.kind === "instrument")[1]!;
    const cmd = humAndHarmonizeCommand(doc, melody, backing, {
      patternId: doc.patterns[0]!.id,
      leadTrackId: lead.id,
      backingTrackId: backingTrack.id,
    });
    const next = cmd.execute(doc);
    const notesOf = (trackId: string) => next.patterns[0]!.notes[trackId] ?? [];
    expect(notesOf(lead.id)).toHaveLength(2);
    expect(notesOf(backingTrack.id)).toHaveLength(3);
    const undone = cmd.undo(next);
    expect(undone).toEqual(doc);
  });

  it("same-track mode merges and dedupes by pitch+start", () => {
    const doc = testDoc();
    const lead = doc.tracks.find((t) => t.kind === "instrument")!;
    // this backing note collides with lead m1 (69@0) — deduped away
    const colliding = [{ id: "b1", pitch: 69, start: 0, duration: 480, velocity: 0.6 }];
    const cmd = humAndHarmonizeCommand(doc, melody, colliding, {
      patternId: doc.patterns[0]!.id,
      leadTrackId: lead.id,
      backingTrackId: lead.id,
    });
    const next = cmd.execute(doc);
    // 2 lead notes survive, the colliding backing note is absorbed
    const notes = next.patterns[0]!.notes[lead.id] ?? [];
    expect(notes.length).toBe(2);
  });

  it("throws honestly on empty hum or missing targets", () => {
    const doc = testDoc();
    const lead = doc.tracks.find((t) => t.kind === "instrument")!;
    expect(() =>
      humAndHarmonizeCommand(doc, [], [], {
        patternId: doc.patterns[0]!.id,
        leadTrackId: lead.id,
        backingTrackId: lead.id,
      }),
    ).toThrow(/No hummed notes/);
    expect(() =>
      humAndHarmonizeCommand(doc, melody, backing, {
        patternId: "nope",
        leadTrackId: lead.id,
        backingTrackId: lead.id,
      }),
    ).toThrow(/no longer exists/);
  });
});
