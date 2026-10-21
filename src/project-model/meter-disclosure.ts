import { ticksPerBarFor } from "./schema";
import { barsPerPattern, isWholeBarPattern, stepsPerBarFor } from "./grid";
import type { ProjectDocument, TimeSignature } from "./types";

/**
 * WHAT A CHOSEN METER MEANS — the one owner of the words (ADR 0056, ADR 0057).
 *
 * Three surfaces can put the project into a meter the user did not ask for
 * explicitly — the transfer dialog (a meter for an import), the intent engine
 * ("make it 6/8") and the MCP surface (`kyx_music`). Before this module each
 * of them said something DIFFERENT, and the truth about the metre lived in
 * the export layer where no other surface could reach it. A disclosure that
 * three surfaces word differently is three disclosures, and two of them are
 * wrong by accident.
 *
 * The facts are measured, not asserted:
 *
 * - the metrical bar's length in ticks and in sixteenth steps
 *   (`ticksPerBarFor`, `stepsPerBarFor`);
 * - what happens to the user's own patterns: their LENGTH does not change,
 *   so a pattern that is not a whole number of the new bars drifts against
 *   the ruler (`barsPerPattern`, `isWholeBarPattern`).
 *
 * Nothing here says the project was damaged. A 6/8 project is a correct
 * project; what the user has to be told is what the metre measures, and what
 * happens to material that was authored in another one.
 */

/** The metrical facts, measured. */
export interface MeterFacts {
  /** The metre as "6/8". */
  label: string;
  /** The metrical bar in ticks — the ruler, the clip placement, the loop region. */
  ticks: number;
  /** The metrical bar in sixteenth steps — the step grid's bar. */
  steps: number;
}

/** The metrical facts of a signature. */
export function meterFacts(sig: TimeSignature): MeterFacts {
  return {
    label: `${sig.numerator}/${sig.denominator}`,
    ticks: ticksPerBarFor(sig),
    steps: stepsPerBarFor(sig),
  };
}

/**
 * The shared sentence: what the metre MEASURES.
 *
 * The transfer dialog and every meter-change disclosure quote this, so the
 * three surfaces cannot drift apart in their words.
 */
export function meterMeaning(sig: TimeSignature): string {
  const facts = meterFacts(sig);
  return (
    `every ruler bar, clip placement and loop region is ${facts.ticks} ticks, ` +
    `and the step grid's bar is ${facts.steps} sixteenth steps`
  );
}

/**
 * True when the two signatures measure the SAME bar — the change is then
 * invisible: 4/4, 2/2 and 8/8 are all sixteen-step bars, and saying anything
 * about them would be noise. A disclosure that fires on every no-op is a
 * disclosure nobody reads.
 */
export function meterIsBarEquivalent(a: TimeSignature, b: TimeSignature): boolean {
  return ticksPerBarFor(a) === ticksPerBarFor(b);
}

/** What the user's own material does in the new metre. */
function patternClause(doc: ProjectDocument, sig: TimeSignature): string {
  const steps = doc.patterns.find((pattern) => pattern.id === doc.activePatternId)?.stepCount;
  if (steps == null || steps <= 0) {
    return "Your pattern keeps its own length.";
  }
  const perBar = stepsPerBarFor(sig);
  const bars = barsPerPattern({ timeSignature: sig }, steps);
  if (isWholeBarPattern({ timeSignature: sig }, steps)) {
    return `Your ${steps}-step pattern is exactly ${bars} ${bars === 1 ? "bar" : "bars"} — it lands on the downbeat.`;
  }
  return (
    `Your ${steps}-step pattern is ${bars.toFixed(2)} bars and drifts against the ruler — ` +
    `snap it to a whole bar (${perBar} steps) to land on the downbeat.`
  );
}

/**
 * The DISCLOSURE for a meter that changes the bar: what the metre measures,
 * and what happens to the material that was authored in another one.
 *
 * `null` when the bar does not change (see `meterIsBarEquivalent`).
 */
export function meterChangeDisclosure(before: ProjectDocument, after: TimeSignature): string | null {
  if (meterIsBarEquivalent(before.timeSignature, after)) return null;
  return `${meterFacts(after).label}: ${meterMeaning(after)}. ${patternClause(before, after)}`;
}

/**
 * The COMPACT clause for a read-back line — the same facts, shortened.
 *
 * It is a shortening of the same measured facts, not a second truth: the bar
 * in steps, and what the active pattern does in it.
 */
export function meterChangeClause(before: ProjectDocument, after: TimeSignature): string | null {
  if (meterIsBarEquivalent(before.timeSignature, after)) return null;
  const facts = meterFacts(after);
  const steps = before.patterns.find((pattern) => pattern.id === before.activePatternId)?.stepCount;
  const perBar = facts.steps;
  if (steps == null || steps <= 0) return `bar = ${perBar} steps`;
  const bars = barsPerPattern({ timeSignature: after }, steps);
  if (isWholeBarPattern({ timeSignature: after }, steps)) {
    return `bar = ${perBar} steps; your ${steps}-step pattern is ${bars} ${bars === 1 ? "bar" : "bars"} and lands on the downbeat`;
  }
  return (
    `bar = ${perBar} steps; your ${steps}-step pattern is ${bars.toFixed(2)} bars and drifts ` +
    `(snap it to a whole bar to land on the downbeat)`
  );
}
