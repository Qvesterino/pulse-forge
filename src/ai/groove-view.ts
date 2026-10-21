import type { GrooveData } from "./types";
import { inferPadRole, type PadRole } from "./pad-roles";
import { isAnchorForRole, isDefaultMeter, type AiMeter } from "./meter";
import { getGroovePadModel } from "./markov";

/**
 * THE METRICAL VIEW OF THE GROOVE MATERIAL (ADR 0057 Stage 2c).
 *
 * The groove library is 4/4 material: every row is sixteen sixteenth steps,
 * written for a bar that has four beats. Stage 2b made the GENERATOR speak the
 * document's metre — the bar count, the phrase cut, the fill, the kick, the
 * snare — but the CONTENT it drew from was still a 4/4 groove read at the
 * metrical bar. In a 6/8 document that read cuts the bar in half: a UKG clap
 * that lives on the "and" of 3 and the "and" of 4 is simply gone, and a rock
 * backbeat on the "ands" of 1 and 3 lands on the wrong units.
 *
 * This module is the metrical VIEW of that material: a DERIVED PROJECTION, not
 * a second library. The library stays the source of truth and stays 4/4; the
 * projection answers "what does this groove say in THIS metre?".
 *
 * ## The projection
 *
 * 1. THE BASE — the source row folded into the target bar. A longer source is
 *    truncated (the bar is cut, never stretched); a shorter target tiles the
 *    source (the material repeats rather than running out).
 * 2. THE SKELETON — the roles the metre re-voices: the kick on the pulse, the
 *    snare and the clap on the backbeat. Every other role (hats, percussion,
 *    toms) keeps the folded positions — a hat on the eighths stays on the
 *    eighths, and the groove's own swing survives the fold.
 * 3. THE MATERIAL — the role's hits, collected from the WHOLE source row, in
 *    order. The whole row matters: a 4/4 groove's beat-4 backbeat lives past
 *    a 3/4 bar's end, and it is exactly the material a shorter metre needs.
 * 4. RE-VOICE — the base's hits give way to the metre's skeleton. The
 *    collected hits are re-emitted on the anchor positions in order; a metre
 *    with more anchors than the groove has hits repeats them (a shuffle wants
 *    a backbeat on both its "2" and its "5"), and a metre with fewer keeps the
 *    first ones (a 3/4 bar has no beat 4).
 *
 * ## What the projection refuses to do
 *
 * - A bar with ONE pulse (7/8, 5/8) has no skeleton to impose: the grouping
 *   is CONTENT, so the material keeps the shape the groove gave it.
 * - A role with no anchor in this metre (the snare in 7/8) keeps its material.
 * - A role with no material at all (a groove with no clap) is not invented.
 *
 * ## 4/4 is the identity
 *
 * In 4/4 the projection does not run: the metre IS the library's metre, so the
 * material is already in the right shape. That is what keeps 4/4
 * byte-identical — not a comparison, a short-circuit.
 */

/** The anchor a role rides in this metre — the roles the metre re-voices. */
function anchorKind(role: PadRole): "kick" | "snare" | null {
  if (role === "kick") return "kick";
  if (role === "snare" || role === "clap") return "snare";
  return null;
}

/**
 * The positions the metre puts this role's anchors on, inside one bar.
 *
 * The rule is the meter's own (`isAnchorForRole`) — this module asks, it does
 * not re-derive the skeleton.
 */
export function anchorPositions(meter: AiMeter, role: PadRole): number[] {
  const kind = anchorKind(role);
  if (!kind) return [];
  const positions: number[] = [];
  for (let step = 0; step < meter.stepsPerBar; step++) {
    if (isAnchorForRole(meter, kind, step)) positions.push(step);
  }
  return positions;
}

/**
 * Project ONE source row into the document's metre.
 *
 * Level-agnostic on purpose: the same projection maps the groove library's
 * velocities AND the Markov model's quantized levels, so the reference and the
 * generated content can never disagree about where the metre puts a hit.
 */
export function projectRowToMeter(row: readonly number[], role: PadRole, meter: AiMeter): number[] {
  // 4/4 is the identity — the library's own metre. Nothing moves, and the
  // row keeps its own length (one groove in the library carries a fifteen-step
  // row; the projection must not "fix" it in the metre that never asked).
  if (isDefaultMeter(meter.signature)) return Array.from(row);

  const target = Math.max(1, Math.floor(meter.stepsPerBar));
  const sourceLength = row.length;
  if (sourceLength === 0) return new Array<number>(target).fill(0);

  // 1. THE BASE — the source's material folded into the target bar.
  const base = new Array<number>(target);
  for (let step = 0; step < target; step++) {
    base[step] = row[step % sourceLength] ?? 0;
  }

  // 2. THE SKELETON — the anchors this metre gives the role.
  const anchors = anchorPositions(meter, role);
  if (anchors.length === 0) return base;
  // A bar with ONE pulse has no skeleton to impose: in 7/8 the grouping is
  // content, so the material keeps the shape the groove gave it.
  if (role === "kick" && meter.pulseSteps >= meter.stepsPerBar) return base;

  // 3. THE MATERIAL — the role's hits, from the WHOLE source row, in order.
  const hits: number[] = [];
  for (let step = 0; step < sourceLength; step++) {
    const value = row[step] ?? 0;
    if (value > 0) hits.push(value);
  }
  if (hits.length === 0) return base;

  // 4. RE-VOICE — the base's hits give way to the metre's skeleton. The lane
  // belongs to one role, so every hit in it belongs to that role.
  for (let step = 0; step < target; step++) base[step] = 0;
  for (let index = 0; index < anchors.length; index++) {
    base[anchors[index]] = hits[index % hits.length];
  }
  return base;
}

/** The role of a pad, from the caller's roles or the legacy index fallback. */
function roleAt(roles: readonly PadRole[], padIndex: number): PadRole {
  return roles[padIndex] ?? inferPadRole(undefined, padIndex);
}

/**
 * The metrical view of one pad's rows: the groove's patterns with that pad's
 * row projected into the document's metre.
 *
 * In 4/4 this is the groove's own rows, unchanged — the identity the whole
 * stage rests on.
 */
export function metricalGroovePadRows(
  groove: GrooveData,
  padIndex: number,
  role: PadRole,
  meter: AiMeter,
): readonly number[][] {
  if (isDefaultMeter(meter.signature)) {
    // The generator's own reference — the very same rows it has always read.
    return getGroovePadModel(groove, padIndex).patterns;
  }
  return groove.patterns.map((pattern) => projectRowToMeter(pattern[padIndex] ?? [], role, meter));
}

/**
 * The metrical view of a whole groove: every pattern, every pad row, projected
 * into the document's metre.
 *
 * This is what the quality metrics and the style gate compare against. A gate
 * that measures a 6/8 generation against a truncated 4/4 reference is grading
 * the wrong thing — the reference has to speak the same metre as the result.
 */
export function metricalGroovePatterns(
  groove: GrooveData,
  roles: readonly PadRole[],
  meter: AiMeter,
): { [padIndex: number]: number[] }[] {
  if (isDefaultMeter(meter.signature)) return groove.patterns;
  return groove.patterns.map((pattern) => {
    const projected: { [padIndex: number]: number[] } = {};
    for (const key of Object.keys(pattern)) {
      const padIndex = Number(key);
      projected[padIndex] = projectRowToMeter(pattern[padIndex] ?? [], roleAt(roles, padIndex), meter);
    }
    return projected;
  });
}
