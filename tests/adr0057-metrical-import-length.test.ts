/**
 * ADR 0057 Stage 2d — the IMPORT speaks the document's bars.
 *
 * ADR 0057 moved the step GRID onto the document's meter. One producer was left
 * behind: the MIDI import padded an imported phrase to a multiple of SIXTEEN
 * steps — 4/4's bar — whatever the document declared. In a 6/8 project that
 * produced a 1.33-bar groove whose downbeat reached the bar line only every
 * fourth bar, and the transfer dialog had to warn about it.
 *
 * The import now pads UP to a whole number of the DOCUMENT's bars
 * (`stepsForWholeBars`, `src/project-model/grid.ts`). Two things must hold, and
 * they are different questions:
 *
 *   1. The LENGTH becomes a whole number of the document's bars. That is the fix.
 *   2. The MATERIAL does not move. A note keeps its absolute tick, a drum hit
 *      keeps its step. Only the loop's length changes — the padding, not the
 *      content. A change that moved the user's notes would be a rewrite, not a
 *      rounding, and the repo's rule is that stored content is never re-expressed.
 *
 * The 4/4 case is the negative control and it is not optional: in 4/4 the old
 * and the new padding are the same arithmetic, and a change that moved 4/4
 * would break every existing project.
 */
import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { isWholeBarPatternFor, stepsForWholeBars, stepsPerBar } from "../src/project-model/grid";
import { importMidiCommand } from "../src/midi/midiProject";
import { writeMidiFile } from "../src/midi/midiFile";
import { STEP_TICKS, type ProjectDocument, type TimeSignature } from "../src/project-model/types";

const FOUR_FOUR: TimeSignature = { numerator: 4, denominator: 4 };
const SIX_EIGHT: TimeSignature = { numerator: 6, denominator: 8 };

function docWithMeter(sig: TimeSignature): ProjectDocument {
  return normalizeProject({
    ...createProjectFromTemplate("empty"),
    timeSignature: sig,
    bpm: 120,
    arrangement: { clips: [] },
  });
}

/**
 * A one-bar-and-a-bit phrase: the longest note ends at 20 sixteenth steps
 * (2400 project ticks at division 96), and a snare hit sits on step 19.
 */
function phraseFile(): Uint8Array {
  return writeMidiFile({
    division: 96, // quarter = 96 ticks → ×5 into our PPQ 480
    bpm: 120,
    tracks: [
      {
        name: "Drums",
        channel: 9,
        notes: [
          { pitch: 36, startTick: 0, endTick: 12, velocity: 0.9 }, // kick, step 0
          { pitch: 38, startTick: 468, endTick: 480, velocity: 0.6 }, // snare, step 19
        ],
      },
      {
        name: "Bass",
        channel: 0,
        notes: [{ pitch: 36, startTick: 0, endTick: 480, velocity: 0.8 }], // ends at step 20
      },
    ],
  });
}

/** Every step that carries a hit, across all the pattern's rows. */
function hitSteps(pattern: ProjectDocument["patterns"][number]): number[] {
  const steps: number[] = [];
  for (const row of Object.values(pattern.rows)) {
    for (const [step, velocity] of row.entries()) {
      if (velocity > 0) steps.push(step);
    }
  }
  return steps.sort((a, b) => a - b);
}

function importInto(sig: TimeSignature): {
  pattern: ProjectDocument["patterns"][number];
  notes: Array<{ pitch: number; start: number; duration: number; velocity: number }>;
} {
  const doc = docWithMeter(sig);
  const next = importMidiCommand(doc, phraseFile(), "phrase").execute(doc);
  const pattern = next.patterns.find((p) => p.id === next.activePatternId)!;
  const drum = next.tracks.find((t) => t.kind === "drum" && !doc.tracks.some((b) => b.id === t.id));
  const bass = next.tracks.find((t) => t.kind === "instrument" && !doc.tracks.some((b) => b.id === t.id));
  const notes = bass ? (pattern.notes[bass.id] ?? []) : [];
  expect(drum).toBeTruthy();
  return { pattern, notes };
}

describe("ADR 0057 Stage 2d — the imported pattern is a whole number of the document's bars", () => {
  it("NEGATIVE CONTROL: in 4/4 the imported length is exactly what it always was", () => {
    const { pattern } = importInto(FOUR_FOUR);
    // The material ends at step 20; 4/4 pads to the next multiple of 16 → 32.
    expect(pattern.stepCount).toBe(32);
    expect(stepsPerBar({ timeSignature: FOUR_FOUR })).toBe(16);
    expect(isWholeBarPatternFor(FOUR_FOUR, pattern.stepCount)).toBe(true);
  });

  it("in 6/8 the imported length is a whole number of 6/8 bars", () => {
    const { pattern } = importInto(SIX_EIGHT);
    // A 6/8 bar is twelve sixteenth steps; the material needs 20 → two whole
    // bars (24 steps) instead of 4/4's 32 (2.67 bars).
    expect(stepsPerBar({ timeSignature: SIX_EIGHT })).toBe(12);
    expect(pattern.stepCount).toBe(24);
    expect(isWholeBarPatternFor(SIX_EIGHT, pattern.stepCount)).toBe(true);
  });

  it("the length is never shorter than the material — nothing is cut to fit a bar", () => {
    for (const sig of [FOUR_FOUR, SIX_EIGHT]) {
      const { pattern } = importInto(sig);
      const longestHit = hitSteps(pattern).at(-1) ?? 0;
      // The pattern must cover every hit it holds, and the material's own end
      // (step 20) must be inside it.
      expect(pattern.stepCount).toBeGreaterThanOrEqual(20);
      expect(pattern.stepCount).toBeGreaterThan(longestHit);
    }
  });

  it("the MATERIAL does not move: the same file hits the same steps in 4/4 and in 6/8", () => {
    const four = importInto(FOUR_FOUR);
    const six = importInto(SIX_EIGHT);
    // Same hits, same absolute steps. Only the loop's length differs.
    expect(hitSteps(six.pattern)).toEqual(hitSteps(four.pattern));
    expect(hitSteps(six.pattern)).toEqual([0, 19]);
    // The bass note keeps its absolute start and duration (ticks). The comparison is on the
    // MUSICAL fields only — the note's own id is a fresh UUID per import, so comparing it
    // would compare two runs of the generator, not the two metres.
    const musical = (note: { pitch: number; start: number; duration: number; velocity: number }) => ({
      pitch: note.pitch,
      start: note.start,
      duration: note.duration,
      velocity: note.velocity,
    });
    expect(six.notes.map(musical)).toEqual(four.notes.map(musical));
    expect(six.notes[0]).toMatchObject({ start: 0, duration: 2400 });
    // …and the two lengths differ, which is the whole point.
    expect(six.pattern.stepCount).not.toBe(four.pattern.stepCount);
  });

  it("the grid's rounding rounds UP, never down, and always lands on a bar", () => {
    const doc44 = { timeSignature: FOUR_FOUR };
    const doc68 = { timeSignature: SIX_EIGHT };
    for (const needed of [0, 1, 11, 12, 13, 20, 24, 25, 100]) {
      for (const doc of [doc44, doc68]) {
        const steps = stepsForWholeBars(doc, needed);
        expect(steps).toBeGreaterThanOrEqual(needed);
        expect(steps % stepsPerBar(doc)).toBe(0);
        expect(isWholeBarPatternFor(doc.timeSignature, steps)).toBe(true);
      }
    }
    // 4/4 is the legacy arithmetic, exactly.
    expect(stepsForWholeBars(doc44, 20)).toBe(32);
    expect(stepsForWholeBars(doc68, 20)).toBe(24);
    // A sixteenth note is still a sixteenth note — the unit did not change.
    expect(STEP_TICKS).toBe(120);
  });
});
