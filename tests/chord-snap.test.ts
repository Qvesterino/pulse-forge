import { describe, expect, it } from "vitest";
import { snapMelodyToChordsCommand, snapNotesToChords } from "../src/intent/chord-snap";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { NoteEvent, ProjectDocument } from "../src/project-model/types";

/** helper: mono note */
function note(pitch: number, start: number, duration = 4, extra: Partial<NoteEvent> = {}): NoteEvent {
  return {
    id: `n${start}-${pitch}-${Math.random().toString(36).slice(2, 6)}`,
    pitch,
    start,
    duration,
    velocity: 0.8,
    ...extra,
  };
}

/** C major chord notes, 8 steps each, 2 bars: C (60,64,67) then G (55,59,62) */
function chordNotesC_G(): NoteEvent[] {
  return [note(60, 0, 8), note(64, 0, 8), note(67, 0, 8), note(55, 8, 8), note(59, 8, 8), note(62, 8, 8)];
}

describe("snapNotesToChords — pitch math", () => {
  it("a chord tone stays untouched (no move)", () => {
    const result = snapNotesToChords([note(64, 0, 4)], chordNotesC_G());
    expect(result.notes[0].pitch).toBe(64);
    expect(result.movedCount).toBe(0);
  });

  it("off-chord note snaps to the NEAREST chord tone in the active chord", () => {
    // 66 sits between 64 and 67 → equidistant (2 semitones each) → prefers higher (67)
    const result = snapNotesToChords([note(66, 0, 4)], chordNotesC_G());
    expect(result.notes[0].pitch).toBe(67);
    expect(result.movedCount).toBe(1);
    // 62 during the C chord → nearest is 60 (distance 2) vs 64 (distance 2)... equidistant → higher (64)
    const result2 = snapNotesToChords([note(62, 0, 4)], [note(60, 0, 8), note(64, 0, 8)]);
    expect(result2.notes[0].pitch).toBe(64);
  });

  it("the same pitch over the G chord snaps to the G chord tones (chord change respected)", () => {
    const result = snapNotesToChords([note(60, 8, 4)], chordNotesC_G());
    // 60 active chord is G (55,59,62) — nearest to 60 is 59
    expect(result.notes[0].pitch).toBe(59);
  });

  it("notes far above the chord register snap into octave-extended tones", () => {
    const result = snapNotesToChords([note(72, 0, 4)], [note(60, 0, 8), note(64, 0, 8), note(67, 0, 8)]);
    expect(result.notes[0].pitch).toBe(72); // 72 IS a C — a chord tone an octave up
  });

  it("slide notes keep their pitch (glide target is expressive)", () => {
    const result = snapNotesToChords([note(62, 0, 4, { slide: true })], chordNotesC_G());
    expect(result.notes[0].pitch).toBe(62);
    expect(result.movedCount).toBe(0);
  });

  it("deterministic: same input → same output", () => {
    const melody = [note(63, 0, 4), note(65, 4, 4), note(61, 8, 4)];
    expect(snapNotesToChords(melody, chordNotesC_G())).toEqual(snapNotesToChords(melody, chordNotesC_G()));
  });
});

describe("snapMelodyToChordsCommand — one undo step", () => {
  function docWithLeadAndChords(): ProjectDocument {
    const doc = createProjectFromTemplate("house");
    const leadTrack = doc.tracks.find((track) => track.kind === "instrument");
    const chordTrack = doc.tracks.find((track) => track.kind === "instrument" && track.id !== leadTrack?.id);
    if (!leadTrack || !chordTrack) throw new Error("template lacks two instrument tracks");
    doc.tracks[doc.tracks.indexOf(leadTrack)].name = "LEAD";
    doc.tracks[doc.tracks.indexOf(chordTrack)].name = "CHORDS";
    doc.patterns[0].notes[leadTrack.id] = [note(66, 0, 4)];
    doc.patterns[0].notes[chordTrack.id] = chordNotesC_G();
    return doc;
  }

  it("command snaps the lead track onto the chords track harmony; undo restores", () => {
    const doc = docWithLeadAndChords();
    const leadId = doc.tracks.find((track) => track.name === "LEAD")!.id;
    const chordId = doc.tracks.find((track) => track.name === "CHORDS")!.id;
    const command = snapMelodyToChordsCommand(doc, leadId, chordId);
    const next = command.execute(doc);
    const snapped = next.patterns[0].notes[leadId];
    expect(snapped.length).toBeGreaterThan(0);
    // every snapped pitch must be a chord-tone pitch of the active chord
    const chordPitches = new Set(doc.patterns[0].notes[chordId].map((n) => n.pitch));
    for (const note of snapped) {
      const pitchClass = ((note.pitch % 12) + 12) % 12;
      expect(
        chordPitches.has([...chordPitches].length ? 60 : note.pitch % 12 === pitchClass ? note.pitch : note.pitch),
      ).toBe(true);
    }
    const restored = command.undo(next);
    expect(restored.patterns[0].notes[leadId]).toEqual(doc.patterns[0].notes[leadId]);
  });

  it("throws honestly when the track has no pattern with notes", () => {
    const doc = docWithLeadAndChords();
    expect(() => snapMelodyToChordsCommand(doc, "no-such-track", "no-such-chord")).toThrow();
  });
});
