import { DEFAULT_TIME_SIGNATURE, stepsPerBarFor, stepsPerBeatFor } from "../project-model/grid";
import type { TimeSignature } from "../project-model/types";

/**
 * THE AI LAYER'S METRICAL TRUTH (ADR 0057 Stage 2b).
 *
 * The generator used to believe that one bar is always SIXTEEN sixteenth-note
 * steps: `bars = Math.ceil(stepCount / 16)`, the phrase cut at `bar * 16`, the
 * kick on `step % 4 === 0`, the snare on `step % 8 === 4`, the groove reference
 * folded at `step % 16`. Those are not neutral defaults — they are 4/4 CONTENT
 * wearing the clothes of arithmetic. In a 3/4 document they put the fill
 * mid-bar, count four bars where there are three, and truncate the groove's
 * beat-4 backbeat away; in 6/8 they put the kick on the eighths where the
 * meter pulses on dotted quarters.
 *
 * This module is the ONE owner of the AI layer's metrical facts. It does not
 * re-implement the bar-length formula: `stepsPerBarFor` / `stepsPerBeatFor`
 * come from `src/project-model/grid.ts`, which is the grid's own truth table,
 * so the pattern grid and the AI layer cannot drift apart.
 *
 * ## The pulse rule
 *
 * A meter has ONE recurring pulse, and the AI layer anchors on it:
 *
 * | meter | pulse            | kick       | backbeat         |
 * | ----- | ---------------- | ---------- | ---------------- |
 * | 4/4   | quarter (4)      | 0,4,8,12   | 4, 12            |
 * | 3/4   | quarter (4)      | 0,4,8      | 4                |
 * | 2/4   | quarter (4)      | 0,4        | 4                |
 * | 5/4   | quarter (4)      | 0,4,8,12,16| 4, 12            |
 * | 2/2   | half (8)         | 0,8        | 8                |
 * | 6/8   | dotted quarter(6)| 0,6        | 2, 8 (the "2 & 5")|
 * | 12/8  | dotted quarter(6)| 0,6,12,18  | 2, 8, 14, 20     |
 * | 7/8   | the whole bar    | 0          | — (grouping is content) |
 *
 * Three regimes:
 *
 * 1. SIMPLE — the denominator's unit is at least a quarter note (x/1, x/2,
 *    x/4). The pulse IS that unit; the kick rides every pulse and the
 *    backbeat every SECOND pulse (beats 2 and 4). In 4/4 this is exactly the
 *    legacy rule, which is why 4/4 stays byte-identical.
 * 2. COMPOUND — x/8 (or finer) with a numerator that is a multiple of three:
 *    the units group in threes (the dotted quarter). The kick rides the GROUP
 *    (the dotted-quarter pulse), and the backbeat is the SECOND unit inside
 *    each group — the shuffle's "2 & 5". A compound meter does NOT get
 *    "every second pulse": that would put a snare on the second dotted
 *    quarter and turn a shuffle into a tresillo.
 * 3. IRREGULAR — a bar that does not divide into equal pulses of at least a
 *    quarter note (7/8, 5/8, 3/16). The whole bar is one pulse: only the
 *    downbeat is anchored, and the grouping (2+2+3) is GROOVE CONTENT, not
 *    arithmetic. Declared, not guessed.
 *
 * The 4/4 row above is the load-bearing one: it is the promise the product's
 * overwhelming majority depends on, and it is measured, not assumed.
 */
export interface AiMeter {
  /** The meter's own signature — what the generation recipe records. */
  signature: TimeSignature;
  /** Steps (sixteenths) in one metrical bar. */
  stepsPerBar: number;
  /** Steps (sixteenths) in the denominator's unit — the meter's own beat. */
  stepsPerBeat: number;
  /** Steps between two pulses — the strongest recurring accent in the bar. */
  pulseSteps: number;
  /** Denominator units in one bar (the numerator). */
  unitsPerBar: number;
  /** Denominator units in one pulse. */
  pulseUnits: number;
  /** Compound meter: the units group in threes (6/8, 9/8, 12/8). */
  compound: boolean;
}

/** A signature the grid can actually measure. */
function isUsableSignature(signature: TimeSignature | undefined | null): signature is TimeSignature {
  return (
    !!signature &&
    Number.isFinite(signature.numerator) &&
    Number.isFinite(signature.denominator) &&
    signature.numerator >= 1 &&
    signature.denominator >= 1
  );
}

/**
 * How many denominator units make one pulse.
 *
 * A unit that is already at least a quarter note IS the pulse. A finer unit
 * is grouped until the pulse reaches a quarter note and still divides the bar
 * evenly; a bar that cannot (7/8, 5/8) becomes a single pulse.
 */
function pulseUnitsFor(unitsPerBar: number, stepsPerBeat: number): number {
  if (stepsPerBeat >= 4) return 1;
  const minUnits = Math.max(1, Math.ceil(4 / stepsPerBeat));
  for (let units = minUnits; units <= unitsPerBar; units++) {
    if (unitsPerBar % units === 0) return units;
  }
  return unitsPerBar;
}

/** Resolve the AI layer's metrical facts from a document's meter. */
export function aiMeterFor(signature?: TimeSignature | null): AiMeter {
  const sig = isUsableSignature(signature) ? signature : DEFAULT_TIME_SIGNATURE;
  const stepsPerBar = stepsPerBarFor(sig);
  const stepsPerBeat = stepsPerBeatFor(sig);
  const unitsPerBar = Math.max(1, Math.round(stepsPerBar / stepsPerBeat));
  const compound = sig.denominator >= 8 && sig.numerator % 3 === 0;
  const pulseUnits = compound ? 3 : pulseUnitsFor(unitsPerBar, stepsPerBeat);
  return {
    signature: { numerator: sig.numerator, denominator: sig.denominator },
    stepsPerBar,
    stepsPerBeat,
    pulseSteps: pulseUnits * stepsPerBeat,
    unitsPerBar,
    pulseUnits,
    compound,
  };
}

/**
 * The meter the AI layer assumed before ADR 0057 Stage 2b: 4/4.
 *
 * It is the DEFAULT of every metrical parameter in this layer, so a caller
 * that has no meter (an old recipe, a test fixture, a tool that only knows
 * steps) keeps the legacy behaviour exactly.
 */
export const DEFAULT_AI_METER: AiMeter = aiMeterFor(DEFAULT_TIME_SIGNATURE);

/** True when the signature is the 4/4 default the AI layer used to assume. */
export function isDefaultMeter(signature: TimeSignature | undefined | null): boolean {
  if (!isUsableSignature(signature)) return true;
  return (
    signature.numerator === DEFAULT_TIME_SIGNATURE.numerator &&
    signature.denominator === DEFAULT_TIME_SIGNATURE.denominator
  );
}

/**
 * The signature as it travels inside a CONTRACT (generation options, the
 * generation recipe): PRESENT only when it is not the 4/4 default.
 *
 * This is the "carry a new field only where the old form cannot express it"
 * rule from ADR 0057 Stage 2a, applied to the meter. In 4/4 the field is
 * absent, so the options object, the recipe and its hash are byte-identical
 * to what they were before the AI layer became metrical.
 */
export function meterCarrier(signature: TimeSignature | undefined | null): TimeSignature | undefined {
  if (!isUsableSignature(signature)) return undefined;
  if (isDefaultMeter(signature)) return undefined;
  return { numerator: signature.numerator, denominator: signature.denominator };
}

/** The step index inside the metrical bar. */
export function stepInBar(meter: AiMeter, step: number): number {
  return ((step % meter.stepsPerBar) + meter.stepsPerBar) % meter.stepsPerBar;
}

/** The bar a step belongs to, counted from the pattern's start. */
export function barOfStep(meter: AiMeter, step: number): number {
  return Math.floor(step / meter.stepsPerBar);
}

/** How many metrical bars a pattern of `stepCount` steps spans. */
export function barCount(meter: AiMeter, stepCount: number): number {
  if (!Number.isFinite(stepCount) || stepCount <= 0) return 0;
  return Math.ceil(stepCount / meter.stepsPerBar);
}

/** True when the step sits on the metrical bar's downbeat. */
export function isDownbeat(meter: AiMeter, step: number): boolean {
  return stepInBar(meter, step) === 0;
}

/** True when the step sits on the metrical pulse. */
export function isPulse(meter: AiMeter, step: number): boolean {
  return stepInBar(meter, step) % meter.pulseSteps === 0;
}

/** True when the step is a KICK anchor in this meter. */
export function isKickAnchor(meter: AiMeter, step: number): boolean {
  return isPulse(meter, step);
}

/**
 * True when the step is a SNARE / CLAP backbeat in this meter.
 *
 * Simple meters: every second pulse (beats 2 and 4). Compound meters: the
 * second unit inside each group of three (the shuffle's "2 & 5"). Irregular
 * bars: never — there is no second pulse to put it on.
 */
export function isBackbeatAnchor(meter: AiMeter, step: number): boolean {
  const inBar = stepInBar(meter, step);
  if (meter.compound) {
    if (inBar % meter.stepsPerBeat !== 0) return false;
    return Math.floor(inBar / meter.stepsPerBeat) % 3 === 1;
  }
  if (inBar % meter.pulseSteps !== 0) return false;
  return Math.floor(inBar / meter.pulseSteps) % 2 === 1;
}

/** True when the role's anchor lands on this step in this meter. */
export function isAnchorForRole(meter: AiMeter, role: "kick" | "snare" | "clap", step: number): boolean {
  if (role === "kick") return isKickAnchor(meter, step);
  return isBackbeatAnchor(meter, step);
}

/**
 * Where a groove REFERENCE row is read for a given step.
 *
 * The reference is the groove's own row; the metrical bar decides WHICH part
 * of it a bar of the pattern draws from. In 4/4 that is the legacy
 * `step % 16`; in 3/4 the second bar of a pattern draws the groove's FIRST
 * bar again instead of reaching past the end of the groove's 4/4 material.
 */
export function referencePhase(meter: AiMeter, step: number, referenceLength: number): number {
  const length =
    Number.isFinite(referenceLength) && referenceLength > 0 ? Math.floor(referenceLength) : meter.stepsPerBar;
  return stepInBar(meter, step) % length;
}
