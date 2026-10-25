import type { NoteEvent, Pattern } from "./types";
import { PATTERN_TICKS, STEP_TICKS } from "./types";

const noteEndCache = new WeakMap<readonly NoteEvent[], number>();

/**
 * MIDI note phrases may outlive the fixed step grid. Each instrument track
 * repeats at the later of its step-grid length and the next bar after its last
 * note end; drum rows keep using the bounded step-grid period.
 *
 * The "bar" here is the PATTERN grid (16 sixteenth steps = PATTERN_TICKS), not
 * the document's metrical bar (ADR 0056). Those are two different things: the
 * pattern grid is a property of the 16-step sequencer and defines the repeat
 * period, while the metrical bar is the arrangement's placement unit. In 6/8
 * the metrical bar is 1440 ticks and a 16-step pattern is 1920 — rounding the
 * phrase to the metrical bar would cut the pattern's own repeat cycle short.
 */
export function midiPhraseLengthTicks(stepCount: number, notes: readonly NoteEvent[]): number {
  const safeStepCount = Number.isFinite(stepCount) ? Math.max(1, Math.round(stepCount)) : 1;
  const gridTicks = safeStepCount * STEP_TICKS;
  let noteEnd = noteEndCache.get(notes);
  if (noteEnd === undefined) {
    noteEnd = 0;
    for (const note of notes) {
      if (!Number.isFinite(note.start) || !Number.isFinite(note.duration) || note.start < 0 || note.duration <= 0)
        continue;
      noteEnd = Math.max(noteEnd, note.start + note.duration);
    }
    noteEndCache.set(notes, noteEnd);
  }
  if (noteEnd <= gridTicks) return gridTicks;
  return Math.max(gridTicks, Math.ceil(noteEnd / PATTERN_TICKS) * PATTERN_TICKS);
}

/** The least common multiple of two tick counts (both treated as positive). */
export function lcmTicks(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const left = Math.max(1, Math.round(a));
  const right = Math.max(1, Math.round(b));
  const gcd = (x: number, y: number): number => (y === 0 ? x : gcd(y, x % y));
  return (left / gcd(left, right)) * right;
}

/**
 * The TRUE repeat period of a pattern: the least common multiple of the step
 * grid (the period the DRUMS repeat at) and every melodic track's phrase (the
 * period its NOTES repeat at).
 *
 * A pattern whose note outlives the grid has a phrase LONGER than the grid,
 * and its content only comes back around after both do — that is the period
 * any PHASE has to be wrapped against.
 *
 * The MIDI lane already wraps its phase against the phrase (the wave-1 F4
 * repair). The SCENE lane wrapped its phase against the grid alone, so a
 * scene whose melody outlived the grid re-seated the pattern inside the
 * region: the split's right half played a different note at the seam, and the
 * region's music slid by the partial grid. See
 * `docs/CLIP-EDIT-INTERACTION-AUDIT-2026-10-23.md` §14 (finding D4).
 */
export function scenePatternPeriodTicks(pattern: Pick<Pattern, "stepCount" | "notes">): number {
  const grid = pattern.stepCount * STEP_TICKS;
  let period = grid > 0 ? grid : 1;
  for (const notes of Object.values(pattern.notes ?? {})) {
    period = lcmTicks(period, midiPhraseLengthTicks(pattern.stepCount, notes));
  }
  return period;
}
