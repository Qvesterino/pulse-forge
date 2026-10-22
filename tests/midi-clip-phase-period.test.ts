import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { midiPhraseLengthTicks } from "../src/project-model/midiTime";
import { splitMidiClipAtTick, trimMidiClipStart } from "../src/commands/midiClips";
import type { MidiClip, ProjectDocument } from "../src/project-model/types";

/**
 * A MIDI CLIP'S PHASE MUST BE WRAPPED AGAINST THE PERIOD IT PLAYS AT.
 *
 * THE DEFECT (P1 — the notes after a trim or a split were the wrong notes).
 *
 *   A MIDI clip plays its source pattern REPEATED, and it carries a
 *   `phaseOffsetTicks` — the pattern-relative tick already elapsed when the
 *   clip begins. That phase is only meaningful against a PERIOD, and the
 *   period is the PHRASE length: a MIDI note may outlive the 16-step grid, and
 *   both the renderer (`MidiClipLanes`) and the scheduler
 *   (`noteEventsInWindow`) repeat the pattern at
 *   `midiPhraseLengthTicks(stepCount, notes)` — the phrase length, not the
 *   grid.
 *
 *   `trimMidiClipStart` and `splitMidiClipAtTick` wrapped the phase against
 *   `pattern.stepCount * STEP_TICKS` — the GRID. For any pattern whose notes
 *   outlive the grid, the two periods differ, so:
 *
 *     - the phase the command wrote was not the phase the clip plays, and
 *     - the note phase was off by (phrase - grid) forever after the edit.
 *
 *   The audible result: trim or split a phrase that runs past its bar, and
 *   the notes after the edit are DIFFERENT notes at DIFFERENT times than the
 *   phrase would have played.
 *
 * WHAT THIS TEST PINS.
 *
 *   The phase a trimmed or split clip carries is the phase the renderer and
 *   the scheduler compute for the same pattern and track.
 */

const STEP_TICKS = 120;

/** A document whose pattern's notes outlive the 16-step grid. */
function docWithLongPhrase(): { doc: ProjectDocument; clipId: string; notesLengthTicks: number } {
  const base = createProjectFromTemplate("house");
  const pattern = base.patterns[0]!;
  const trackId = base.tracks[0]!.id;
  // A note that starts inside the grid but ends well past it: the phrase is
  // then longer than the grid, so the two periods differ.
  const notes = [{ id: "n1", start: 0, duration: STEP_TICKS * 40, pitch: 60, velocity: 1 }];
  const doc: ProjectDocument = {
    ...base,
    patterns: base.patterns.map((candidate) =>
      candidate.id === pattern.id ? { ...candidate, notes: { ...candidate.notes, [trackId]: notes } } : candidate,
    ),
  };
  const midiClip: MidiClip = {
    id: "midi-clip-1",
    trackId,
    patternId: pattern.id,
    startTick: 0,
    // A long clip, so a trim can land past the grid — the point where the two
    // candidate periods disagree.
    lengthTicks: STEP_TICKS * 64,
  };
  const withClip: ProjectDocument = {
    ...doc,
    arrangement: { ...doc.arrangement, midiClips: [...(doc.arrangement.midiClips ?? []), midiClip] },
  };
  return { doc: withClip, clipId: midiClip.id, notesLengthTicks: STEP_TICKS * 40 };
}

describe("a MIDI clip's phase is wrapped against the period it plays at", () => {
  it("the phrase period is longer than the grid for a pattern that outlives it", () => {
    const { doc, notesLengthTicks } = docWithLongPhrase();
    const pattern = doc.patterns[0]!;
    const trackId = doc.tracks[0]!.id;
    const grid = pattern.stepCount * STEP_TICKS;
    const phrase = midiPhraseLengthTicks(pattern.stepCount, pattern.notes?.[trackId] ?? []);
    expect(phrase, "the phrase must outlive the grid for this fixture").toBeGreaterThan(grid);
    expect(phrase).toBeGreaterThanOrEqual(notesLengthTicks);
  });

  it("a trimmed MIDI clip carries the phase the renderer would compute", () => {
    const { doc, clipId } = docWithLongPhrase();
    const pattern = doc.patterns[0]!;
    const trackId = doc.tracks[0]!.id;
    const phrase = midiPhraseLengthTicks(pattern.stepCount, pattern.notes?.[trackId] ?? []);

    // Trim the clip's start forward by 5 steps.
    const trimmed = trimMidiClipStart(doc, clipId, STEP_TICKS * 5).execute(doc);
    const clip = trimmed.arrangement.midiClips!.find((c) => c.id === clipId)!;

    // The phase is the pattern-relative tick already elapsed, wrapped against
    // the phrase period.
    const expected = (((clip.phaseOffsetTicks ?? 0) % phrase) + phrase) % phrase;
    expect(clip.phaseOffsetTicks ?? 0).toBe(expected);
    // The trim moved the phase by exactly the trimmed amount, modulo the
    // period. With the GRID as the modulus the value differs by (phrase -
    // grid) once the amount exceeds the grid.
    expect(clip.phaseOffsetTicks ?? 0).toBe((STEP_TICKS * 5) % phrase);
  });

  it("a split MIDI clip carries the phase the renderer would compute", () => {
    const { doc, clipId } = docWithLongPhrase();
    const pattern = doc.patterns[0]!;
    const trackId = doc.tracks[0]!.id;
    const phrase = midiPhraseLengthTicks(pattern.stepCount, pattern.notes?.[trackId] ?? []);

    const split = splitMidiClipAtTick(doc, clipId, STEP_TICKS * 5);
    const after = split.execute(doc);
    const right = after.arrangement.midiClips!.find((c) => c.id !== clipId && c.startTick === STEP_TICKS * 5);
    expect(right, "the split must produce a right-hand fragment").toBeDefined();

    const phase = right!.phaseOffsetTicks ?? 0;
    expect(phase).toBe(((phase % phrase) + phrase) % phrase);
    expect(phase).toBe((STEP_TICKS * 5) % phrase);
  });

  it("a phase past the grid is wrapped against the PHRASE, not the grid", () => {
    const { doc, clipId } = docWithLongPhrase();
    const pattern = doc.patterns[0]!;
    const trackId = doc.tracks[0]!.id;
    const grid = pattern.stepCount * STEP_TICKS;
    const phrase = midiPhraseLengthTicks(pattern.stepCount, pattern.notes?.[trackId] ?? []);

    // Trim by more than the grid: the two moduli now disagree, and the grid
    // would have wrapped the phase to a value the clip never plays.
    const trimmed = trimMidiClipStart(doc, clipId, grid + STEP_TICKS * 3).execute(doc);
    const clip = trimmed.arrangement.midiClips!.find((c) => c.id === clipId)!;
    const phase = clip.phaseOffsetTicks ?? 0;

    expect(phrase).not.toBe(grid);
    expect(phase, "the phase must be wrapped against the phrase period").toBe((grid + STEP_TICKS * 3) % phrase);
    expect(phase).not.toBe((grid + STEP_TICKS * 3) % grid);
  });
});
