import type { NoteEvent } from "./types";
import { BAR_TICKS, STEP_TICKS } from "./types";

const noteEndCache = new WeakMap<readonly NoteEvent[], number>();

/**
 * MIDI note phrases may outlive the fixed step grid. Each instrument track
 * repeats at the later of its step-grid length and the next bar after its last
 * note end; drum rows keep using the bounded step-grid period.
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
  return Math.max(gridTicks, Math.ceil(noteEnd / BAR_TICKS) * BAR_TICKS);
}
