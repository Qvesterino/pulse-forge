import { ticksPerBarFor, ticksPerBeatFor } from "./schema";
import { barsPerPattern, isWholeBarPattern, stepsPerBarFor, stepsPerBeatFor } from "./grid";
import type { ProjectDocument, TimeSignature } from "./types";

/**
 * WHAT A CHOSEN METER MEANS — the one owner of the words (ADR 0056, ADR 0057).
 *
 * Four surfaces can put a project into a meter the user did not spell out for
 * that surface — the transfer dialog (a meter for an import), the intent
 * engine ("make it 6/8"), the MCP surface (`kyx_music`) and the command itself
 * (`setTimeSignature`). Before this module each of them said something
 * DIFFERENT, and the truth about the metre lived in the export layer where no
 * other surface could reach it. A disclosure that four surfaces word
 * differently is four disclosures, and three of them are wrong by accident.
 *
 * The facts are measured, not asserted:
 *
 * - the metrical BAR's length in ticks and in sixteenth steps
 *   (`ticksPerBarFor`, `stepsPerBarFor`) — the ruler, the clip placement, the
 *   loop region;
 * - the metrical BEAT's length in ticks and in sixteenth steps, and how many
 *   beats the bar holds (`ticksPerBeatFor`, `stepsPerBeatFor`) — the click the
 *   metronome plays (`src/scheduler/Scheduler.ts`) and the count the ruler
 *   prints;
 * - what happens to the user's own patterns: their LENGTH does not change, so
 *   a pattern that is not a whole number of the new bars drifts against the
 *   ruler (`barsPerPattern`, `isWholeBarPattern`).
 *
 * Nothing here says the project was damaged. A 6/8 project is a correct
 * project; what the user has to be told is what the metre measures, and what
 * happens to material that was authored in another one.
 *
 * THE SILENCE RULE — a disclosure fires when the SIGNATURE changed, and not
 * one tick earlier:
 *
 * - 4/4 → 4/4 is not a change at all, so nothing is said (the negative
 *   control every spec pins).
 * - 4/4 → 2/2 DOES change something audible even though the bar keeps its
 *   1920 ticks: the beat becomes a half note, so the metronome clicks twice a
 *   bar instead of four times (`ticksPerBeatFor`). A disclosure keyed on the
 *   BAR alone would stay silent about a change the user can hear — and a
 *   disclosure that hides a real change is worse than no disclosure.
 */

/** The metrical facts, measured. */
export interface MeterFacts {
  /** The metre as "6/8". */
  label: string;
  /** The metrical bar in ticks — the ruler, the clip placement, the loop region. */
  ticks: number;
  /** The metrical bar in sixteenth steps — the step grid's bar. */
  steps: number;
  /** The metrical beat in ticks — what the metronome clicks. */
  beatTicks: number;
  /** The metrical beat in sixteenth steps. */
  beatSteps: number;
  /** How many beats the bar holds — the numerator. */
  beats: number;
}

/** The metrical facts of a signature. */
export function meterFacts(sig: TimeSignature): MeterFacts {
  return {
    label: `${sig.numerator}/${sig.denominator}`,
    ticks: ticksPerBarFor(sig),
    steps: stepsPerBarFor(sig),
    beatTicks: ticksPerBeatFor(sig),
    beatSteps: stepsPerBeatFor(sig),
    beats: sig.numerator,
  };
}

/**
 * The shared sentence: what the metre MEASURES.
 *
 * The transfer dialog quotes this, and so does the meter-change clause, so a
 * project that is READ in a meter and a project whose meter CHANGES cannot
 * describe the same metre in two different ways.
 */
export function meterMeaning(sig: TimeSignature): string {
  const facts = meterFacts(sig);
  return (
    `every ruler bar, clip placement and loop region is ${facts.ticks} ticks, ` +
    `and the step grid's bar is ${facts.steps} sixteenth steps`
  );
}

/**
 * True when the two signatures are the SAME metre — the change is then
 * invisible and nothing is disclosed.
 *
 * The test is the SIGNATURE, not the bar: 4/4 → 2/2 keeps the bar's 1920
 * ticks but moves the beat from a quarter note to a half note, so the click
 * changes and the change must be disclosed.
 */
export function meterSignatureChanged(a: TimeSignature, b: TimeSignature): boolean {
  return a.numerator !== b.numerator || a.denominator !== b.denominator;
}

/** What the user's own material does in the new metre. */
function patternClause(doc: ProjectDocument, sig: TimeSignature): string {
  const steps = doc.patterns.find((pattern) => pattern.id === doc.activePatternId)?.stepCount;
  if (steps == null || steps <= 0) return "";
  const perBar = stepsPerBarFor(sig);
  const bars = barsPerPattern({ timeSignature: sig }, steps);
  if (isWholeBarPattern({ timeSignature: sig }, steps)) {
    return `your ${steps}-step pattern is ${bars} ${bars === 1 ? "bar" : "bars"} and lands on the downbeat`;
  }
  return (
    `your ${steps}-step pattern is ${bars.toFixed(2)} bars and drifts against the ruler — ` +
    `snap it to a whole bar (${perBar} steps) to land on the downbeat`
  );
}

/**
 * The BAR clause: what the metre measures, in one phrase.
 *
 * This is the part of the disclosure that is true of the METRE alone — it
 * says nothing about the user's material, so it can be used where the
 * material is not what the old metre held (the AI generation path replaces
 * the pattern with one built in the new metre).
 */
export function meterBarClause(sig: TimeSignature): string {
  const facts = meterFacts(sig);
  return `bar = ${facts.ticks} ticks / ${facts.steps} steps (${facts.beats} beats of ${facts.beatTicks} ticks)`;
}

/**
 * The DISCLOSURE for a meter that changed: what the new metre MEASURES, and
 * what happens to the material that was authored in the old one.
 *
 * One sentence, used by every surface that announces a meter change — the
 * command's toast detail, the intent read-back and the MCP response — so the
 * three cannot drift apart in their wording.
 *
 * `null` when the signature did not change: nothing happened, so nothing is
 * said. A disclosure that fires on a no-op is a disclosure nobody reads.
 */
export function meterChangeClause(before: ProjectDocument, after: TimeSignature): string | null {
  if (!meterSignatureChanged(before.timeSignature, after)) return null;
  const bar = meterBarClause(after);
  const material = patternClause(before, after);
  return material ? `${bar}; ${material}` : bar;
}
