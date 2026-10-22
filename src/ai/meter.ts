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
 *    quarter note (7/8, 5/8, 11/8). The whole bar is one PULSE — but a pulse
 *    is not a structure. A DECLARED irregular metre (7/8, 5/8) carries its
 *    GROUPS (2+2+3, 3+2), and the groups are where the accents are: the kick
 *    rides the group downbeats, the backbeat sits on the accent group. An
 *    UNDECLARED one (11/8) keeps the whole bar as a single group: the
 *    grouping is unknown, so the product imposes nothing. Declared, not
 *    guessed.
 *
 * ## The GROUPS (ADR 0057 Stage 2i)
 *
 * Regime 3 above was written before the product had any irregular CONTENT.
 * It was right about the arithmetic and wrong about the consequence: with no
 * grouping, the metrical pulse of a 7/8 bar is the whole bar, so EVERY hit
 * off the downbeat counts as syncopation, the syncopation budget strips the
 * groove, and a 7/8 project gets a bare click on beat 1 instead of a groove.
 *
 * An irregular bar's structure is not a PULSE but a LIST OF GROUPS: 7/8 is
 * 2+2+3, 5/8 is 3+2. The groups are the bar's accents, and they are declared
 * (the signature does not say which grouping, and the groove library has no
 * irregular grooves to say it either). The metrical facts therefore carry the
 * grouping:
 *
 * - a SIMPLE meter's groups are its beats (4/4 -> 4,4,4,4);
 * - a COMPOUND meter's groups are its dotted quarters (6/8 -> 6,6);
 * - a DECLARED IRREGULAR meter's groups are its uneven parts (7/8 -> 4,4,6).
 *
 * For every regular metre the groups ARE the pulses, so the kick's anchors,
 * the backbeat and the syncopation grid are unchanged - that is the identity
 * this stage rests on. For an irregular metre the groups say where the
 * accents are: the kick rides the group downbeats and the backbeat sits on
 * the LAST group (the accent of 2+2+3 and of 3+2 both fall there).
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
  /**
   * The bar's GROUPS - the parts it divides into, in steps.
   *
   * A simple meter's groups are its beats, a compound meter's are its dotted
   * quarters, and a declared irregular meter's are its uneven parts (7/8 ->
   * 4,4,6 - the 2+2+3). The sum is always the bar's length.
   */
  groups: number[];
  /** The bar's groups are NOT all equal - the metre is irregular (7/8, 5/8). */
  irregular: boolean;
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

/**
 * The IRREGULAR GROUPINGS - declared, not guessed.
 *
 * 7/8 is not one metre but several (2+2+3, 2+3+2, 3+2+2, 2+2+2+1) and 5/8
 * likewise (3+2, 2+3). The SIGNATURE does not say which, and the groove
 * library has no irregular grooves to say it either - so the product DECLARES
 * the common ones and says so. The numbers are in the meter's own units
 * (eighths for an eighth-denominator), and they must sum to the bar.
 *
 * A metre that is NOT declared keeps the whole bar as one group: the
 * grouping is unknown, so the product imposes nothing - the honest fallback,
 * and the behaviour every irregular metre had before this stage.
 */
const IRREGULAR_GROUPINGS: Record<string, number[]> = {
  "7/8": [2, 2, 3],
  "5/8": [3, 2],
};

/** Resolve the AI layer's metrical facts from a document's meter. */
export function aiMeterFor(signature?: TimeSignature | null): AiMeter {
  const sig = isUsableSignature(signature) ? signature : DEFAULT_TIME_SIGNATURE;
  const stepsPerBar = stepsPerBarFor(sig);
  const stepsPerBeat = stepsPerBeatFor(sig);
  const unitsPerBar = Math.max(1, Math.round(stepsPerBar / stepsPerBeat));
  const compound = sig.denominator >= 8 && sig.numerator % 3 === 0;
  const pulseUnits = compound ? 3 : pulseUnitsFor(unitsPerBar, stepsPerBeat);
  const pulseSteps = pulseUnits * stepsPerBeat;

  // The GROUPS. A regular meter's groups are its pulses (4/4 -> 4,4,4,4; 6/8
  // -> 6,6); a declared irregular meter's are its uneven parts (7/8 -> 4,4,6).
  const declared = IRREGULAR_GROUPINGS[`${sig.numerator}/${sig.denominator}`];
  const declaredGroups = declared?.map((units) => units * stepsPerBeat) ?? null;
  const usableDeclared =
    declaredGroups !== null &&
    declaredGroups.length > 1 &&
    declaredGroups.reduce((sum, group) => sum + group, 0) === stepsPerBar &&
    !declaredGroups.every((group) => group === declaredGroups[0]);
  const groups = usableDeclared
    ? declaredGroups
    : Array.from({ length: Math.max(1, Math.round(unitsPerBar / pulseUnits)) }, () => pulseSteps);

  return {
    signature: { numerator: sig.numerator, denominator: sig.denominator },
    stepsPerBar,
    stepsPerBeat,
    pulseSteps,
    unitsPerBar,
    pulseUnits,
    compound,
    groups,
    irregular: usableDeclared,
  };
}

/**
 * The group's starts inside one bar - the metrical accents.
 *
 * For a regular metre these ARE the pulse positions (4/4 -> 0,4,8,12), which
 * is the identity every layer rests on. For a declared irregular metre they
 * are the group's downbeats (7/8 -> 0,4,8).
 */
export function groupStarts(meter: AiMeter): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const group of meter.groups) {
    starts.push(at);
    at += group;
  }
  return starts;
}

/** True when the step starts a group - the bar's accents. */
export function isGroupStart(meter: AiMeter, step: number): boolean {
  const inBar = stepInBar(meter, step);
  let at = 0;
  for (const group of meter.groups) {
    if (at === inBar) return true;
    at += group;
  }
  return false;
}

/**
 * The ACCENT of an irregular bar: the LAST group's start.
 *
 * In 2+2+3 the accent is the long group's downbeat ("5"); in 3+2 it is the
 * downbeat of the two ("4"). Both are the last group, so both fall here.
 * A bar with ONE group has no accent of its own - its downbeat is already the
 * only accent - so it has no backbeat, exactly as before this stage.
 */
export function accentAnchor(meter: AiMeter): number | null {
  if (!meter.irregular || meter.groups.length < 2) return null;
  let at = 0;
  for (let index = 0; index < meter.groups.length - 1; index++) at += meter.groups[index];
  return at;
}

/**
 * The half-group: the grid inside a group that still counts as on-grid.
 *
 * For a regular metre this is the legacy `pulseSteps / 2` (4/4 -> 2, the
 * eighths; 6/8 -> 3). For an irregular metre it is the half of the SHORTEST
 * group (7/8 -> 2, the eighths) - the grid the eighths really live on.
 */
export function halfGroupSteps(meter: AiMeter): number {
  const shortest = Math.min(...meter.groups);
  return Math.max(1, Math.floor(shortest / 2));
}

/**
 * The offset of a step INSIDE its group.
 *
 * In 7/8 (2+2+3) step 10 is the third step of the third group, so its offset
 * is 2 — the eighth grid is counted from the group's own downbeat, not from
 * the bar's.
 */
export function offsetInGroup(meter: AiMeter, step: number): number {
  const inBar = stepInBar(meter, step);
  let at = 0;
  for (const group of meter.groups) {
    if (inBar < at + group) return inBar - at;
    at += group;
  }
  return 0;
}

/**
 * True when the step sits on the HALF of its group — the grid inside a group.
 *
 * For a regular metre this is the legacy `pulseSteps / 2` test (4/4 -> the
 * eighths, 6/8 -> the eighth inside the dotted quarter). For an irregular
 * metre it is the half of the shortest group, counted from each group's own
 * downbeat: in 7/8 (2+2+3) the eighths are 0, 2, 4, 6, 8, 10, 12 — the long
 * group's third eighth (12) is on the grid, because the grid follows the
 * group and not the bar.
 */
export function isHalfGroupStart(meter: AiMeter, step: number): boolean {
  return offsetInGroup(meter, step) % halfGroupSteps(meter) === 0;
}

/**
 * True when the step is ON the metrical grid — the pulse or the half-grid.
 *
 * This is the question the syncopation weight asks: a hit on the grid is not
 * syncopation, whatever the metre calls its pulse.
 */
export function isOnGrid(meter: AiMeter, step: number): boolean {
  return isPulse(meter, step) || isHalfGroupStart(meter, step);
}

/**
 * The ACCENT group's length — the bar's last group.
 *
 * In a regular metre the last group IS the pulse (4/4 -> 4, 6/8 -> 6), so
 * this is the legacy `pulseSteps`. In an irregular metre it is the accent
 * group (7/8 -> 6, the long 2+2+3 group; 5/8 -> 4, the 3+2's second group),
 * which is where a fill belongs.
 */
export function accentGroupSteps(meter: AiMeter): number {
  return meter.groups[meter.groups.length - 1] ?? meter.pulseSteps;
}

/**
 * The metrical TIER of a step — how loud the bar's hierarchy says it is.
 *
 * - 0 — the DOWNBEAT (the strongest accent of the bar);
 * - 1 — the bar's SECONDARY accent (the legacy half-bar; in an irregular
 *   metre the accent group);
 * - 2 — the group downbeat (in a regular metre: the pulse);
 * - 3 — off the grid.
 *
 * In 4/4 this is exactly the legacy `s === 0 ? 1 : s === halfBar ? 0.4 :
 * s % pulseSteps === 0 ? 0.1 : -1`.
 */
export function metricalTier(meter: AiMeter, step: number): number {
  const inBar = stepInBar(meter, step);
  if (inBar === 0) return 0;
  const accent = meter.irregular ? accentAnchor(meter) : null;
  if (accent !== null) {
    if (inBar === accent) return 1;
    return isGroupStart(meter, step) ? 2 : 3;
  }
  if (inBar === meter.stepsPerBar / 2) return 1;
  return isPulse(meter, step) ? 2 : 3;
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
 * True when two signatures are the SAME metre.
 *
 * An absent signature IS 4/4 (the default the AI layer used to assume), so an
 * undeclared groove and a 4/4 document are the same metre — which is what lets
 * the irregular library (ADR 0057 Stage 2j) compare a groove's declared metre
 * with the document's without a second table of rules.
 */
export function sameSignature(a: TimeSignature | undefined | null, b: TimeSignature | undefined | null): boolean {
  const left = a ?? DEFAULT_TIME_SIGNATURE;
  const right = b ?? DEFAULT_TIME_SIGNATURE;
  return left.numerator === right.numerator && left.denominator === right.denominator;
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

/**
 * True when the step sits on the metrical pulse.
 *
 * In a regular metre that is the recurring pulse (4/4 -> 0,4,8,12). In a
 * declared irregular metre there is no repeating pulse, so the pulse IS the
 * group's downbeat (7/8 -> 0,4,8) - the accents the bar actually has.
 */
export function isPulse(meter: AiMeter, step: number): boolean {
  if (!meter.irregular) return stepInBar(meter, step) % meter.pulseSteps === 0;
  return isGroupStart(meter, step);
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
 * bars: the ACCENT group — the last group's downbeat (7/8's "5", 5/8's "4").
 *
 * An irregular bar has no second pulse to put a backbeat on, but it does have
 * exactly one accent besides the downbeat, and that is where a snare lives:
 * in the "1-2, 3-4, 5-6-7" of a 2+2+3 the backbeat is the "5", and in the
 * "1-2-3, 4-5" of a 3+2 it is the "4". A bar with NO declared grouping keeps
 * no backbeat at all — the product does not guess.
 */
export function isBackbeatAnchor(meter: AiMeter, step: number): boolean {
  const inBar = stepInBar(meter, step);
  if (meter.irregular) {
    const accent = accentAnchor(meter);
    return accent !== null && inBar === accent;
  }
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
