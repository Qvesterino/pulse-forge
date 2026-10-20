import type { NoteEvent } from "./types";
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
