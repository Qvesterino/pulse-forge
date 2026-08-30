import type { NoteEvent, Pattern, ProjectDocument } from "./types";
import { STEP_TICKS } from "./types";
import { drumHitsInWindow, type DrumHit } from "./groove";

export interface ScheduledNote {
  trackId: string;
  note: NoteEvent;
  /** Absolute project tick, matching the drum event plan's coordinate system. */
  tick: number;
  /**
   * For `note.slide` notes: the previous non-slide note's (pitch, absolute
   * when-tick) so the instrument runtime can glide instead of re-attacking.
   */
  slideFrom?: { pitch: number; tick: number };
}

export interface PatternEventPlan {
  drums: DrumHit[];
  notes: ScheduledNote[];
}

/**
 * Expand pattern-relative melodic notes into an absolute scheduling window.
 * Realtime and offline rendering both use this helper so loop boundaries and
 * note timing cannot drift between playback and export.
 *
 * Slide notes (FL portamento): a `slide:true` note carries `slideFrom` with
 * the previous non-slide note's pitch + absolute tick (sorted by start), so
 * the runtime glides between the two. Live and offline produce identical glides.
 */
export function noteEventsInWindow(pattern: Pattern, base: number, fromTick: number, toTick: number): ScheduledNote[] {
  const patternTicks = pattern.stepCount * STEP_TICKS;
  if (patternTicks <= 0 || toTick <= fromTick) return [];
  const events: ScheduledNote[] = [];
  for (const [trackId, notes] of Object.entries(pattern.notes ?? {})) {
    // Sorted by start within the track so "previous note" is deterministic
    const sorted = [...notes].sort((a, b) => a.start - b.start);
    // lastNonSlide holds (pitch, absoluteTick) of the most recent non-slide note,
    // crossing pattern loops (previous cycle wraps as the slide source).
    let lastNonSlide: { pitch: number; tick: number } | null = null;
    for (let cycle = Math.floor(Math.max(0, fromTick - base) / patternTicks) - 1; ; cycle++) {
      if (cycle < 0) cycle = 0;
      let anyInWindow = false;
      for (const note of sorted) {
        const tick = base + note.start + cycle * patternTicks;
        if (tick >= toTick + patternTicks) break;
        if (tick >= toTick) continue;
        if (tick + note.duration > fromTick - patternTicks && tick < toTick) {
          if (tick >= fromTick) {
            events.push({
              trackId,
              note,
              tick,
              ...(note.slide && lastNonSlide
                ? { slideFrom: { pitch: lastNonSlide.pitch, tick: lastNonSlide.tick } }
                : note.slide
                  ? {}
                  : {}),
            });
            anyInWindow = true;
          }
          if (tick < fromTick || tick >= fromTick) {
            // Track the last non-slide note (its end is the glide origin)
            if (!note.slide) lastNonSlide = { pitch: note.pitch, tick: tick + note.duration };
          }
        }
      }
      if (anyInWindow && base + (cycle + 1) * patternTicks + (sorted[0]?.start ?? 0) >= toTick) break;
      if (cycle > 0 && base + cycle * patternTicks > toTick) break;
      if (!anyInWindow && base + cycle * patternTicks > toTick) break;
      if (cycle > 10000) break;
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
