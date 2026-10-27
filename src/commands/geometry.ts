/**
 * CLIP GEOMETRY — THE ONE HOME OF THE CLAMP RULE.
 *
 * Every clip-mutating verb in the command layer has to answer the same
 * question: a gesture asked for a geometry the document cannot hold — a
 * length past the ceiling, a position before the timeline, a NaN out of a
 * typed field. Something has to give, and WHICH something gives is the
 * product's promise.
 *
 * THE RULE: **the clamp falls on the field the verb does NOT own.**
 *
 *   - a PLACEMENT verb (add, move, paste, ripple) owns the length the user
 *     asked for, so the POSITION gives way — the clip is pulled back inside
 *     the timeline;
 *   - a RESIZE verb (resize, stretch) owns the length it was asked for, so
 *     the POSITION stays where the user put it and the LENGTH gives way.
 *
 * The second half is the one that was wrong for a long time, and the property
 * sweep found it: a resize that asked for a length past the ceiling wrote
 * the clamped START, so the clip TELEPORTED to the timeline's beginning; and a
 * MIDI resize that kept the old start let the clip's END reach past the
 * ceiling — where the normalizer DROPS the clip, so the user's clip vanished
 * mid-edit, with an undo step that could not bring it back.
 *
 * WHAT LIVES HERE, AND WHAT DOES NOT:
 *
 *   - HERE: the ceilings (`MAX_ARRANGEMENT_CLIP_BARS`, `MAX_ARRANGEMENT_CLIP_TICKS`),
 *     the floors, and the rule that decides which field yields.
 *   - NOT HERE: a lane's own ROUNDING policy — scene clips are whole bars,
 *     audio clips snap to a 1/16 bar, a trim lands on the metrical bar. That
 *     is a musical decision, and it stays with the verb that owns it.
 *
 * The two lanes address the timeline differently (bars vs ticks), so the
 * module carries one function per unit. Every clip verb in
 * `src/commands/` goes through these; if you find a clamp written inline,
 * that is a bug in the making.
 */
import { MAX_ARRANGEMENT_CLIP_BARS, MAX_ARRANGEMENT_CLIP_TICKS } from "../project-model/schema";

/** A value clamped into a range. */
export function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * A bar-addressed clip's LENGTH: at the ceiling, at least the floor.
 *
 * The floor is the caller's (a lane's own minimum — an audio clip that is
 * already shorter than the creation floor keeps its own length), and the
 * ceiling is the same for every bar-addressed lane: `normalizeProject` DROPS
 * an over-length clip outright, so an unclamped value does not store an
 * oversized clip, it silently DELETES the user's clip with no error and no
 * undo entry.
 */
export function clampBarLength(bars: number, minBars = 1): number {
  return Math.min(MAX_ARRANGEMENT_CLIP_BARS, Math.max(minBars, bars));
}

/**
 * A WHOLE-BAR clip's length — the scene lane.
 *
 * Scene clips are integer-bar by contract (a split lands on a bar line, a
 * move rounds to a bar), and a bar-addressed clip is at least one bar long.
 * Garbage in (NaN, Infinity) becomes one bar, never a clip the normalizer
 * drops.
 */
export function clampWholeBarLength(bars: number): number {
  return Number.isFinite(bars) ? clampBarLength(Math.round(bars), 1) : 1;
}

/** A bar-addressed clip's POSITION: never before the timeline. */
export function clampBarPosition(bar: number): number {
  return Number.isFinite(bar) ? Math.max(0, Math.round(bar)) : 0;
}

/**
 * A tick-addressed clip's LENGTH: at the ceiling, at least one tick.
 *
 * The non-refusing sibling of `clampResizeLength` — for the paths that carry
 * a STORED geometry (a paste out of the clipboard) and must not throw on
 * whatever the clipboard happens to hold.
 */
export function clampTickLength(lengthTicks: number): number {
  return Math.min(MAX_ARRANGEMENT_CLIP_TICKS, Math.max(1, Math.round(lengthTicks)));
}

/**
 * A tick-addressed clip's PLACEMENT (add, move, paste): the POSITION gives
 * way, because the length is what the user asked for.
 *
 * `lane` names the lane in the refusal ("MIDI clip position and length must
 * be finite ticks") — the message is the lane's, not the helper's.
 */
export function clampTickSpan(
  startTick: number,
  lengthTicks: number,
  lane: string,
): { startTick: number; lengthTicks: number } {
  if (!Number.isFinite(startTick) || !Number.isFinite(lengthTicks)) {
    throw new Error(`${lane} clip position and length must be finite ticks`);
  }
  const length = clampTickLength(lengthTicks);
  const start = Math.min(MAX_ARRANGEMENT_CLIP_TICKS - length, Math.max(0, Math.round(startTick)));
  return { startTick: start, lengthTicks: length };
}

/**
 * A tick-addressed clip's MOVE with a fixed length (the ripple shift): the
 * POSITION gives way — the clip is pulled back inside the timeline, and the
 * length is not the verb's to change.
 */
export function clampTickPosition(startTick: number, lengthTicks: number): number {
  return Math.max(0, Math.min(MAX_ARRANGEMENT_CLIP_TICKS - lengthTicks, Math.round(startTick)));
}

/**
 * A tick-addressed clip's RESIZE: the START stays where the user put it and
 * the LENGTH gives way.
 *
 * `ceiling` is an extra bound the lane owns — the automation lane's phase
 * limits how far into its source curve the clip may reach, so the length may
 * not push the clip's end past it.
 */
export function clampResizeLength(startTick: number, lengthTicks: number, lane: string, ceiling?: number): number {
  if (!Number.isFinite(lengthTicks)) throw new Error(`${lane} clip length must be finite ticks`);
  const start = Math.max(0, Math.round(startTick));
  const room = Math.max(1, Math.min(MAX_ARRANGEMENT_CLIP_TICKS - start, ceiling ?? Number.POSITIVE_INFINITY));
  return Math.min(room, Math.max(1, Math.round(lengthTicks)));
}

/** A curve POINT's tick: inside the timeline, and it never eats the length. */
export function clampPointTick(tick: number): number {
  return Math.min(MAX_ARRANGEMENT_CLIP_TICKS, Math.max(0, Math.round(tick)));
}
