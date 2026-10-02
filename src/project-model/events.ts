import type { ArrangementClip, NoteEvent, Pattern, ProjectDocument } from "./types";
import { BAR_TICKS, STEP_TICKS } from "./types";
import { drumHitsInWindow, type DrumHit } from "./groove";

/** Resolve the absolute tick origin shared by live and offline pattern events. */
export function patternBaseTickForClip(clip: Pick<ArrangementClip, "startBar" | "phaseOffsetTicks">): number {
  const phaseOffset = Number.isFinite(clip.phaseOffsetTicks) ? (clip.phaseOffsetTicks ?? 0) : 0;
  return clip.startBar * BAR_TICKS - phaseOffset;
}

/** Resolve the absolute tick origin for scene-relative automation and intensity. */
export function sceneBaseTickForClip(clip: Pick<ArrangementClip, "startBar" | "sceneOffsetTicks">): number {
  const sceneOffset = Number.isFinite(clip.sceneOffsetTicks) ? (clip.sceneOffsetTicks ?? 0) : 0;
  return clip.startBar * BAR_TICKS - sceneOffset;
}

/** Pattern phase at an absolute arrangement tick, wrapped to the source pattern's loop. */
export function patternPhaseOffsetAtTick(
  clip: Pick<ArrangementClip, "startBar" | "phaseOffsetTicks">,
  pattern: Pick<Pattern, "stepCount">,
  tick: number,
): number {
  const patternTicks = pattern.stepCount * STEP_TICKS;
  const phaseOffset = Number.isFinite(clip.phaseOffsetTicks) ? (clip.phaseOffsetTicks ?? 0) : 0;
  const elapsed = phaseOffset + tick - clip.startBar * BAR_TICKS;
  if (patternTicks <= 0) return Math.max(0, elapsed);
  return ((elapsed % patternTicks) + patternTicks) % patternTicks;
}

/** Scene-relative time at an absolute tick; unlike pattern phase, it does not loop. */
export function sceneOffsetAtTick(clip: Pick<ArrangementClip, "startBar" | "sceneOffsetTicks">, tick: number): number {
  const sceneOffset = Number.isFinite(clip.sceneOffsetTicks) ? (clip.sceneOffsetTicks ?? 0) : 0;
  return Math.max(0, sceneOffset + tick - clip.startBar * BAR_TICKS);
}

// GOAL 08/B6: notes arrays are immutable (untouched patterns keep the same
// reference across normalizes), so the per-track sort memoizes by reference
// instead of re-sorting every track's note list on every 25 ms window.
const sortedNotesCache = new WeakMap<NoteEvent[], NoteEvent[]>();

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
    let sorted = sortedNotesCache.get(notes);
    if (!sorted) {
      sorted = [...notes].sort((a, b) => a.start - b.start);
      sortedNotesCache.set(notes, sorted);
    }
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
  return events.sort(
    (a, b) =>
      a.tick - b.tick ||
      // Defect A.4 (performance / memory recon): `String.localeCompare`
      // is O(n) per comparison and walks ICU collation tables — the
      // DAW scheduler runs this comparator on the result of
      // `noteEventsInWindow` every 25 ms tick. A plain
      // string compare is O(n) too but with a much smaller constant,
      // and we only need total order across a small set of track
      // ids (≤ dozens per project). The same ordering semantics hold
      // for the codeset we actually use (track ids are app-generated
      // alphanumeric strings — no locale-aware comparison needed).
      (a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : 0) ||
      a.note.pitch - b.note.pitch,
  );
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
