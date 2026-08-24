import type { NoteEvent, Pattern, ProjectDocument } from "./types";
import { STEP_TICKS } from "./types";
import { drumHitsInWindow, type DrumHit } from "./groove";

export interface ScheduledNote {
  trackId: string;
  note: NoteEvent;
  /** Absolute project tick, matching the drum event plan's coordinate system. */
  tick: number;
}

export interface PatternEventPlan {
  drums: DrumHit[];
  notes: ScheduledNote[];
}

/**
 * Expand pattern-relative melodic notes into an absolute scheduling window.
 * Realtime and offline rendering both use this helper so loop boundaries and
 * note timing cannot drift between playback and export.
 */
export function noteEventsInWindow(
  pattern: Pattern,
  base: number,
  fromTick: number,
  toTick: number,
): ScheduledNote[] {
  const patternTicks = pattern.stepCount * STEP_TICKS;
  if (patternTicks <= 0 || toTick <= fromTick) return [];
  const events: ScheduledNote[] = [];
  for (const [trackId, notes] of Object.entries(pattern.notes ?? {})) {
    for (const note of notes) {
      const firstCycle = Math.ceil((fromTick - (base + note.start)) / patternTicks);
      for (let cycle = Math.max(0, firstCycle); ; cycle++) {
        const tick = base + note.start + cycle * patternTicks;
        if (tick >= toTick) break;
        if (tick >= fromTick) events.push({ trackId, note, tick });
      }
    }
  }
  return events.sort((a, b) => a.tick - b.tick || a.trackId.localeCompare(b.trackId) || a.note.pitch - b.note.pitch);
}

/** Shared absolute event plan consumed by realtime and offline paths. */
export function patternEventsInWindow(
  doc: ProjectDocument,
  pattern: Pattern,
  base: number,
  fromTick: number,
  toTick: number,
): PatternEventPlan {
  return {
    drums: drumHitsInWindow(doc, pattern, base, fromTick, toTick),
    notes: noteEventsInWindow(pattern, base, fromTick, toTick),
  };
}
