import { STEP_TICKS } from "./types";
import { ticksPerBarFor, ticksPerBeatFor } from "./schema";
import type { ProjectDocument, TimeSignature } from "./types";

/**
 * THE GRID TRUTH — how the document's meter divides into the PATTERN grid.
 *
 * ADR 0056 Stage 2 put the ARRANGEMENT on the document's meter: the ruler,
 * the clip placement, the metronome and the readouts all measure the
 * metrical bar. The PATTERN grid was the one unit left behind — a pattern is
 * 16 sixteenth steps (`PATTERN_TICKS`, four quarter notes) whatever the meter
 * declares. Measured in 6/8: one pattern is 1.33 bars long and its downbeat
 * reaches the bar line only every fourth bar, so a groove drifts against the
 * ruler that sits right above it. ADR 0056 named the fix — "a metrical step
 * grid and its own ADR" — and this module is that fix's single owner.
 *
 * The step grid's unit is the SIXTEENTH NOTE (`STEP_TICKS = 120` ticks), not
 * the bar. That is what makes the grid metrical without changing a single
 * stored value: a pattern keeps its `stepCount` (a musical duration), and the
 * METER says how many of those steps make one bar.
 *
 * One formula, one truth table, one place. The bar-length formula itself is
 * NOT re-implemented here — it comes from `ticksPerBarFor` in `schema.ts`, so
 * the two units cannot drift apart again.
 *
 * | meter | bar (ticks) | steps/bar | steps/beat | beats/bar |
 * | ----- | ----------- | --------- | ---------- | --------- |
 * | 4/4   | 1920        | 16        | 4          | 4         |
 * | 2/2   | 1920        | 16        | 8          | 2         |
 * | 3/4   | 1440        | 12        | 4          | 3         |
 * | 6/8   | 1440        | 12        | 2          | 6         |
 * | 4/2   | 3840        | 32        | 8          | 4         |
 * | 5/4   | 2400        | 20        | 4          | 5         |
 * | 7/8   | 1680        | 14        | 2          | 7         |
 * | 12/8  | 2880        | 24        | 2          | 12        |
 *
 * 4/4 is unchanged by construction (16 steps, 4 per beat) — which is the
 * point: the grid becomes true in every meter WITHOUT touching the 4/4
 * projects that are the overwhelming majority.
 */

/** How many sixteenth-note steps one bar of `sig` holds. */
export function stepsPerBarFor(sig: TimeSignature | undefined): number {
  // A document that declares no (or a broken) meter falls back to 4/4 rather
  // than throwing: the grid must never be the thing that breaks a session.
  if (!sig || !Number.isFinite(sig.numerator) || !Number.isFinite(sig.denominator) || sig.denominator <= 0) {
    return DEFAULT_STEPS_PER_BAR;
  }
  return Math.max(1, Math.round(ticksPerBarFor(sig) / STEP_TICKS));
}

export function stepsPerBar(doc: Pick<ProjectDocument, "timeSignature">): number {
  return stepsPerBarFor(doc?.timeSignature);
}

/**
 * How many sixteenth-note steps one beat of `sig` holds. The beat is the
 * denominator's unit — a quarter in x/4, an eighth in x/8, a half in x/2 —
 * which is the same unit the metronome clicks (ADR 0056 Stage 2) and the
 * same unit `ticksPerBeatFor` measures.
 */
export function stepsPerBeatFor(sig: TimeSignature): number {
  return Math.max(1, Math.round(ticksPerBeatFor(sig) / STEP_TICKS));
}

export function stepsPerBeat(doc: Pick<ProjectDocument, "timeSignature">): number {
  return stepsPerBeatFor(doc.timeSignature);
}

/**
 * How many bars a pattern of `stepCount` steps spans. FRACTIONAL on purpose:
 * a pattern that is not a whole number of bars is exactly the situation the
 * UI has to state honestly instead of rounding away.
 */
export function barsPerPattern(doc: Pick<ProjectDocument, "timeSignature">, stepCount: number): number {
  const perBar = stepsPerBar(doc);
  return perBar > 0 ? stepCount / perBar : 0;
}

/** True when a pattern of `stepCount` steps is a whole number of bars. */
export function isWholeBarPattern(doc: Pick<ProjectDocument, "timeSignature">, stepCount: number): boolean {
  const perBar = stepsPerBar(doc);
  return perBar > 0 && stepCount % perBar === 0;
}

/** The bar counts the pattern-length control offers, with the steps they mean. */
export const PATTERN_LENGTH_BARS = [1, 2, 4, 8] as const;

export function patternLengthOptions(doc: Pick<ProjectDocument, "timeSignature">): { bars: number; steps: number }[] {
  const perBar = stepsPerBar(doc);
  return PATTERN_LENGTH_BARS.map((bars) => ({ bars, steps: bars * perBar }));
}

/**
 * The beat number a step carries inside the grid: 1-based, and it RESETS at
 * every metrical bar. In 4/4 that is "1, 2, 3, 4" per bar — unchanged. In 3/4
 * it is "1, 2, 3"; in 6/8 it is the eighth-note count "1…6" (the same unit
 * the click uses).
 */
export function beatNumberAtStep(doc: Pick<ProjectDocument, "timeSignature">, stepIndex: number): number | null {
  const perBeat = stepsPerBeat(doc);
  if (perBeat <= 0) return null;
  if (stepIndex % perBeat !== 0) return null;
  const perBar = stepsPerBar(doc);
  const beatsPerBar = Math.max(1, Math.round(perBar / perBeat));
  return (Math.floor(stepIndex / perBeat) % beatsPerBar) + 1;
}

/** The step index at which each metrical bar starts inside a pattern. */
export function barStartSteps(doc: Pick<ProjectDocument, "timeSignature">, stepCount: number): number[] {
  const perBar = stepsPerBar(doc);
  if (perBar <= 0) return [];
  const starts: number[] = [];
  for (let step = 0; step < stepCount; step += perBar) starts.push(step);
  return starts;
}

/**
 * How many steps `bars` bars of the document's meter hold. The one conversion
 * from bars to steps — the intent layer asks in bars, the pattern grid stores
 * steps, and this is where the two meet.
 */
export function stepsForBars(doc: Pick<ProjectDocument, "timeSignature">, bars: number): number {
  return Math.max(0, Math.round(bars)) * stepsPerBar(doc);
}

/**
 * The 4/4 bar length in steps — the fallback for contexts with no document
 * (an intent normalized without one, a provider payload that carries no
 * meter). It is the same quantity as `stepsPerBarFor` in 4/4, spelled out so
 * the fallback cannot drift away from the formula.
 */
export const DEFAULT_STEPS_PER_BAR = 16;

/** The meter a document falls back to when it declares none. */
export const DEFAULT_TIME_SIGNATURE: TimeSignature = { numerator: 4, denominator: 4 };

/** The longest pattern the engine generates, in steps. */
export const MAX_PATTERN_STEPS = 256;

/**
 * The largest bar count that fits in ANY supported meter — the shortest
 * supported bar is 3/4 (twelve steps), so twenty-one bars is the ceiling a
 * meter-blind request can honestly ask for. A meter-aware producer clamps
 * further to its own bar length.
 */
export const MAX_PATTERN_BARS = Math.floor(MAX_PATTERN_STEPS / 12);
