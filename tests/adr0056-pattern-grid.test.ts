/**
 * ADR 0056 — a pattern that is not a whole number of BARS drifts against the ruler.
 *
 * Stage 2 moved the whole arrangement onto the document's meter: the ruler, clip
 * placement, loop regions, the metronome and the bar readouts all measure the
 * metrical bar now. The PATTERN grid stayed where it was — a pattern is 16
 * sixteenth steps (`PATTERN_TICKS` = four quarter notes) whatever the meter
 * declares.
 *
 * That is not a cosmetic difference. In 6/8 a bar is 1440 ticks and a 16-step
 * pattern is 1920, so the pattern's phrase is 1.33 bars long: its downbeat
 * reaches the bar line only every fourth bar and is a quarter note late in
 * between. A groove whose "one" drifts against the ruler is a real defect, so
 * it is measured here rather than assumed.
 *
 * ADR 0057 moved the GRID onto the meter (one bar is `ticksPerBar(doc) /
 * STEP_TICKS` steps, and the grid draws that bar line), so the defect has
 * MOVED: it is no longer the grid's fault, it is the PATTERN'S LENGTH. A
 * 12-step pattern in 6/8 is one bar and does not drift — the measurement below
 * is now about the length, and the whole-bar contrast is the negative control.
 *
 * The 4/4 case is the negative control and it is not optional: the pattern grid
 * is correct in 4/4-like meters, and a guard that fired there would be wrong.
 */
import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject, ticksPerBar } from "../src/project-model/schema";
import { isWholeBarPatternFor, stepsPerBar } from "../src/project-model/grid";
import { patternPhaseOffsetAtTick } from "../src/project-model/events";
import { PATTERN_TICKS, STEPS_PER_PATTERN } from "../src/project-model/types";
import type { ProjectDocument, TimeSignature } from "../src/project-model/types";

const FOUR_FOUR: TimeSignature = { numerator: 4, denominator: 4 };
const SIX_EIGHT: TimeSignature = { numerator: 6, denominator: 8 };
const TWO_FOUR: TimeSignature = { numerator: 2, denominator: 4 };

function docWithMeter(sig: TimeSignature): ProjectDocument {
  return normalizeProject({
    ...createProjectFromTemplate("house"),
    timeSignature: sig,
    bpm: 120,
    arrangement: { clips: [] },
  });
}

/** The pattern's phase (ticks into its cycle) at each musical bar line. */
function patternPhasesAtBarLines(doc: ProjectDocument, bars: number, stepCount?: number): number[] {
  const bar = ticksPerBar(doc);
  const pattern = doc.patterns[0]!;
  const measured = stepCount === undefined ? pattern : { ...pattern, stepCount };
  const clip = { startBar: 0, phaseOffsetTicks: 0 };
  const phases: number[] = [];
  for (let b = 0; b < bars; b++) {
    phases.push(patternPhaseOffsetAtTick(clip, measured, b * bar, bar));
  }
  return phases;
}

describe("ADR 0056/0057 — a pattern that is not a whole number of bars drifts", () => {
  it("NEGATIVE CONTROL: in 4/4 the pattern's downbeat lands on every bar line", () => {
    const doc = docWithMeter(FOUR_FOUR);
    expect(ticksPerBar(doc)).toBe(PATTERN_TICKS);
    expect(isWholeBarPatternFor(FOUR_FOUR, STEPS_PER_PATTERN)).toBe(true);
    // Phase 0 at every bar line: the pattern repeats exactly on the bar.
    expect(patternPhasesAtBarLines(doc, 8)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("in 6/8 a 16-step pattern drifts and only reaches the bar every 4th bar", () => {
    const doc = docWithMeter(SIX_EIGHT);
    expect(ticksPerBar(doc)).toBe(1440);
    expect(isWholeBarPatternFor(SIX_EIGHT, STEPS_PER_PATTERN)).toBe(false);
    // The measured drift: 1920 - 1440 = 480 ticks (a quarter note) per bar, so
    // the phase advances 1440, then 960, then 480, and returns to 0 on the
    // fourth bar. This is the number the disclosure quotes.
    expect(patternPhasesAtBarLines(doc, 8)).toEqual([0, 1440, 960, 480, 0, 1440, 960, 480]);
  });

  it("NEGATIVE CONTROL: a WHOLE-BAR pattern in 6/8 never drifts (ADR 0057)", () => {
    const doc = docWithMeter(SIX_EIGHT);
    // One 6/8 bar is 12 sixteenth steps. A 12-step pattern is exactly one bar.
    expect(stepsPerBar(doc)).toBe(12);
    expect(patternPhasesAtBarLines(doc, 8, 12)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("knows which meters make a 16-step pattern a whole number of bars", () => {
    for (const sig of [
      { numerator: 4, denominator: 4 },
      { numerator: 2, denominator: 2 },
      { numerator: 8, denominator: 8 },
      // 2/4 used to be on the OTHER side of this line. The old predicate asked
      // "is the bar four quarter notes", which is a different question; this one
      // asks "does a 16-step pattern land on the bar line", and in 2/4 the bar
      // is eight steps, so a 16-step pattern is exactly TWO whole bars. It does
      // not drift — and a disclosure that said it did would be lying.
      { numerator: 2, denominator: 4 },
    ]) {
      expect(isWholeBarPatternFor(sig, STEPS_PER_PATTERN)).toBe(true);
    }
    for (const sig of [
      { numerator: 3, denominator: 4 },
      { numerator: 6, denominator: 8 },
      { numerator: 4, denominator: 2 },
      { numerator: 12, denominator: 8 },
    ]) {
      expect(isWholeBarPatternFor(sig, STEPS_PER_PATTERN)).toBe(false);
    }
  });

  it("a 2/4 pattern is a two-bar phrase, not a drift", () => {
    const doc = docWithMeter(TWO_FOUR);
    expect(ticksPerBar(doc)).toBe(960);
    // The phase is 960 on the odd bars because the pattern SPANS two bars — it
    // starts on a bar line and repeats every two bars. That is a whole number
    // of bars, so the groove does not drift against the ruler.
    expect(patternPhasesAtBarLines(doc, 8)).toEqual([0, 960, 0, 960, 0, 960, 0, 960]);
  });
});
