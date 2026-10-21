import { isBackbeatAnchor, isDownbeat, stepInBar, type AiMeter } from "../meter";

/**
 * THE BAR POSITION REACHING THE PINNED MODELS (ADR 0057 Stage 2d).
 *
 * The pinned ONNX priors and the melodic model were trained on SIXTEEN-step
 * bars. Their feature rows carry a note's position inside the bar as five
 * numbers — the position itself plus a first and second harmonic — and the
 * drum row carries two flags that name 4/4's downbeat and 4/4's backbeat.
 *
 * Two facts have to be kept apart, and the old code had them fused:
 *
 * - The FRAME is the MODEL's contract. The feature COUNT (five position
 *   values) and the pinned manifests do not change, so the shipped models
 *   stay valid, and in 4/4 every value is byte-identical to what it was.
 * - The POSITION is the DOCUMENT's. A 6/8 bar is twelve steps, so a note on
 *   its last eighth sits at 10/12 of the bar — and the old encoding called
 *   that "10/16", a position that does not exist in that bar. The old row
 *   also folded the bar at sixteen, so a 6/8 bar looked like the first three
 *   quarters of a 4/4 one, and its flags named 4/4's backbeat (a beat 4 that
 *   a 3/4 bar does not have).
 *
 * ## Why the position is encoded on the BAR'S OWN period
 *
 * The five values are a phase encoding of "where in the bar is this note":
 * `phase`, `sin 2π·phase`, `cos 2π·phase`, `sin 4π·phase`, `cos 4π·phase`,
 * with `phase` the note's position in the bar DIVIDED BY THE BAR'S LENGTH.
 *
 * In 4/4 the bar is sixteen steps, so the phase is `s16/16` — exactly the
 * legacy value, and every one of the five is byte-identical.
 *
 * The reason to divide by the bar's own length rather than to rescale onto a
 * fixed sixteen-step scale is the LANDMARKS. A phase encoding puts the
 * downbeat at phase 0 and the half-bar at phase 0.5 in EVERY metre, so the
 * model reads "the downbeat" and "the half-bar" as the numbers it learned in
 * 4/4 — in 6/8 the third eighth (the half of a dotted-quarter bar) arrives
 * with the same values the model saw for 4/4's half-bar. A fixed-scale
 * rescaling would have to round, and rounding collides neighbouring steps in
 * a long bar (in 4/2, steps 1 and 2 would both land on 1).
 *
 * ## What this is NOT
 *
 * The models themselves are still 4/4-trained, and the training corpus is
 * 4/4 sheet music — so this is a truthful encoding, not a re-trained model.
 * The corpus's own rows pass the 4/4 frame explicitly and are therefore
 * byte-identical to the rows the shipped models were trained on.
 */
export const CANONICAL_FRAME_STEPS = 16;

/**
 * The note's position inside the bar, as a phase in [0, 1).
 *
 * 4/4 is the identity on the legacy scale: `phase === s16 / 16`.
 */
export function barPhase(meter: AiMeter, step: number): number {
  const period = Math.max(1, meter.stepsPerBar);
  return stepInBar(meter, step) / period;
}

/**
 * The five "step-in-bar" feature values, in the pinned models' order.
 *
 * 4/4 is byte-identical to the legacy encoding — the same five numbers, in
 * the same order, from the same input.
 */
export function stepInBarFeatures(meter: AiMeter, step: number): number[] {
  const phase = barPhase(meter, step);
  return [
    phase,
    Math.sin(2 * Math.PI * phase),
    Math.cos(2 * Math.PI * phase),
    Math.sin(4 * Math.PI * phase),
    Math.cos(4 * Math.PI * phase),
  ];
}

/**
 * The two role flags the drum row carries: "this step is the bar's downbeat"
 * and "this step is the metre's backbeat".
 *
 * In 4/4 these are the legacy `s16 === 0` and `s16 === 4 || s16 === 12`. In
 * a compound metre the backbeat is the second unit inside each group of
 * three (the shuffle's "2 & 5"); in an irregular bar there is no second
 * pulse, so there is no backbeat to name.
 */
export function roleFlags(meter: AiMeter, step: number): { downbeat: number; backbeat: number } {
  return {
    downbeat: isDownbeat(meter, step) ? 1 : 0,
    backbeat: isBackbeatAnchor(meter, step) ? 1 : 0,
  };
}
