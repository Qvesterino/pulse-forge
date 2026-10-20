import type {
  ArrangementAutomationClip,
  ArrangementClip,
  AutomationPoint,
  AutomationTarget,
  MidiClip,
  NoteEvent,
  Pattern,
  ProjectDocument,
} from "./types";
import { STEP_TICKS } from "./types";
import { drumHitsInWindow, type DrumHit } from "./groove";
import { valueAt } from "./automation";
import { midiPhraseLengthTicks } from "./midiTime";
import { automationTargetKey, automationTargetsOfClip } from "./targets";

/**
 * A clip's absolute tick origin.
 *
 * `barUnitTicks` is the document's bar length in ticks (ADR 0056): a clip at
 * musical bar 2 of a 6/8 project starts at tick 2880, not 3840. The unit is a
 * required argument — a default would keep every pattern phase and scene
 * offset anchored to the 4/4 grid while the clip itself sits on the metrical
 * bar, so the pattern would play from the wrong point.
 */

/** Resolve the absolute tick origin shared by live and offline pattern events. */
export function patternBaseTickForClip(
  clip: Pick<ArrangementClip, "startBar" | "phaseOffsetTicks">,
  barUnitTicks: number,
): number {
  const phaseOffset = Number.isFinite(clip.phaseOffsetTicks) ? (clip.phaseOffsetTicks ?? 0) : 0;
  return clip.startBar * barUnitTicks - phaseOffset;
}

/** Resolve the absolute tick origin for scene-relative automation and intensity. */
export function sceneBaseTickForClip(
  clip: Pick<ArrangementClip, "startBar" | "sceneOffsetTicks">,
  barUnitTicks: number,
): number {
  const sceneOffset = Number.isFinite(clip.sceneOffsetTicks) ? (clip.sceneOffsetTicks ?? 0) : 0;
  return clip.startBar * barUnitTicks - sceneOffset;
}

/** Pattern phase at an absolute arrangement tick, wrapped to the source pattern's loop. */
export function patternPhaseOffsetAtTick(
  clip: Pick<ArrangementClip, "startBar" | "phaseOffsetTicks">,
  pattern: Pick<Pattern, "stepCount">,
  tick: number,
  barUnitTicks: number,
): number {
  const patternTicks = pattern.stepCount * STEP_TICKS;
  const phaseOffset = Number.isFinite(clip.phaseOffsetTicks) ? (clip.phaseOffsetTicks ?? 0) : 0;
  const elapsed = phaseOffset + tick - clip.startBar * barUnitTicks;
  if (patternTicks <= 0) return Math.max(0, elapsed);
  return ((elapsed % patternTicks) + patternTicks) % patternTicks;
}

/** Scene-relative time at an absolute tick; unlike pattern phase, it does not loop. */
export function sceneOffsetAtTick(
  clip: Pick<ArrangementClip, "startBar" | "sceneOffsetTicks">,
  tick: number,
  barUnitTicks: number,
): number {
  const sceneOffset = Number.isFinite(clip.sceneOffsetTicks) ? (clip.sceneOffsetTicks ?? 0) : 0;
  return Math.max(0, sceneOffset + tick - clip.startBar * barUnitTicks);
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
   * For legacy `note.slide` portamento: the previous attacked note's (pitch,
   * absolute when-tick), so the runtime can glide into this new attack.
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
 * Portamento notes carry `slideFrom` with the previous attacked note's pitch
 * and absolute tick. FL slide notes are separate pitch-only events and keep
 * their own articulation flag for the scheduler. Live and offline share both.
 */
export function noteEventsInWindow(
  pattern: Pattern,
  base: number,
  fromTick: number,
  toTick: number,
  onlyTrackId?: string,
): ScheduledNote[] {
  if (toTick <= fromTick) return [];
  const events: ScheduledNote[] = [];
  for (const [trackId, notes] of Object.entries(pattern.notes ?? {})) {
    if (onlyTrackId !== undefined && trackId !== onlyTrackId) continue;
    const patternTicks = midiPhraseLengthTicks(pattern.stepCount, notes);
    // Sorted by start within the track so "previous note" is deterministic
    let sorted = sortedNotesCache.get(notes);
    if (!sorted) {
      sorted = [...notes].sort((a, b) => a.start - b.start);
      sortedNotesCache.set(notes, sorted);
    }
    // lastAttacked holds (pitch, absoluteTick) of the most recent attacked note,
    // crossing pattern loops (previous cycle wraps as the slide source).
    let lastAttacked: { pitch: number; tick: number } | null = null;
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
              ...(note.slide && lastAttacked
                ? { slideFrom: { pitch: lastAttacked.pitch, tick: lastAttacked.tick } }
                : note.slide
                  ? {}
                  : {}),
            });
            anyInWindow = true;
          }
          if (tick < fromTick || tick >= fromTick) {
            // Track the last non-slide note (its end is the glide origin)
            if (!note.slide && !note.slideNote)
              lastAttacked = {
                pitch: note.pitch + (note.expression?.pitchOffsetSemitones ?? 0),
                tick: tick + note.duration,
              };
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

/** Expand one instrument MIDI clip into its bounded, absolute note events. */
export function midiClipEventsInWindow(
  doc: ProjectDocument,
  clip: MidiClip,
  fromTick: number,
  toTick: number,
): ScheduledNote[] {
  if (clip.muted || toTick <= fromTick) return [];
  const pattern = doc.patterns.find((candidate) => candidate.id === clip.patternId);
  if (!pattern || !doc.tracks.some((track) => track.id === clip.trackId && track.kind === "instrument")) return [];
  const clipEnd = clip.startTick + clip.lengthTicks;
  const from = Math.max(fromTick, clip.startTick);
  const to = Math.min(toTick, clipEnd);
  if (to <= from) return [];
  const base = clip.startTick - (Number.isFinite(clip.phaseOffsetTicks) ? (clip.phaseOffsetTicks ?? 0) : 0);
  return noteEventsInWindow(pattern, base, from, to, clip.trackId).map((event) => {
    const duration = Math.min(event.note.duration, clipEnd - event.tick);
    return duration === event.note.duration ? event : { ...event, note: { ...event.note, duration } };
  });
}

/** Resolve a standalone automation clip into absolute boundary and point events. */
export function automationClipEventsInWindow(
  clip: ArrangementAutomationClip,
  fromTick: number,
  toTick: number,
  fallback = 0,
  stepped = false,
): AutomationPoint[] {
  if (clip.muted || clip.points.length === 0 || toTick <= fromTick) return [];
  const clipEnd = clip.startTick + clip.lengthTicks;
  const from = Math.max(fromTick, clip.startTick);
  const to = Math.min(toTick, clipEnd);
  if (to <= from) return [];
  const phase = Number.isFinite(clip.phaseOffsetTicks) ? (clip.phaseOffsetTicks ?? 0) : 0;
  const localAt = (tick: number) => phase + tick - clip.startTick;
  const points = [...clip.points].sort((a, b) => a.tick - b.tick);
  const valueAtClip = (tick: number) => {
    if (!stepped) return valueAt(points, localAt(tick), fallback);
    let value = fallback;
    for (const point of points) {
      if (point.tick > localAt(tick)) break;
      value = point.value;
    }
    return Math.round(value);
  };
  const events: AutomationPoint[] = [
    { tick: from, value: valueAtClip(from) },
    { tick: to, value: valueAtClip(to) },
  ];
  for (const point of points) {
    const absoluteTick = clip.startTick + point.tick - phase;
    if (absoluteTick > from && absoluteTick < to) {
      events.push({ tick: absoluteTick, value: stepped ? Math.round(point.value) : point.value });
    }
  }
  events.sort((a, b) => a.tick - b.tick);
  return events.filter((event, index) => index === 0 || event.tick !== events[index - 1].tick);
}

export interface ArrangementAutomationSegment {
  clip: ArrangementAutomationClip;
  target: AutomationTarget;
  fromTick: number;
  toTick: number;
}

/**
 * Resolve overlapping arrangement automation before either playback path
 * schedules it. For a target, the clip with the latest start tick owns the
 * overlap; clip id breaks ties so collaborators resolve same-tick clips alike.
 * Earlier clips resume after the winner ends.
 */
export function arrangementAutomationSegmentsInWindow(
  clips: readonly ArrangementAutomationClip[],
  fromTick: number,
  toTick: number,
): ArrangementAutomationSegment[] {
  if (!Number.isFinite(fromTick) || !Number.isFinite(toTick) || toTick <= fromTick) return [];
  const from = Math.max(0, fromTick);
  const to = Math.max(from, toTick);
  if (to <= from) return [];

  const byTarget = new Map<string, { target: AutomationTarget; clips: ArrangementAutomationClip[] }>();
  for (const clip of clips) {
    if (clip.muted || !Number.isFinite(clip.startTick) || !Number.isFinite(clip.lengthTicks) || clip.lengthTicks <= 0)
      continue;
    for (const target of automationTargetsOfClip(clip)) {
      const key = automationTargetKey(target);
      const group = byTarget.get(key);
      if (group) group.clips.push(clip);
      else byTarget.set(key, { target, clips: [clip] });
    }
  }

  const segments: ArrangementAutomationSegment[] = [];
  for (const { target, clips: group } of byTarget.values()) {
    const candidates = group.filter((clip) => clip.startTick < to && clip.startTick + clip.lengthTicks > from);
    if (candidates.length === 0) continue;
    const precedence = [...candidates].sort(
      (a, b) => b.startTick - a.startTick || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const boundaries = new Set<number>([from, to]);
    for (const clip of candidates) {
      const end = clip.startTick + clip.lengthTicks;
      if (clip.startTick > from && clip.startTick < to) boundaries.add(clip.startTick);
      if (end > from && end < to) boundaries.add(end);
    }
    const sorted = [...boundaries].sort((a, b) => a - b);
    for (let index = 0; index < sorted.length - 1; index++) {
      const start = sorted[index];
      const end = sorted[index + 1];
      if (end <= start) continue;
      const winner = precedence.find((clip) => clip.startTick <= start && clip.startTick + clip.lengthTicks >= end);
      if (!winner) continue;
      const previous = segments[segments.length - 1];
      if (
        previous?.clip.id === winner.id &&
        automationTargetKey(previous.target) === automationTargetKey(target) &&
        previous.toTick === start
      ) {
        previous.toTick = end;
      } else {
        segments.push({ clip: winner, target, fromTick: start, toTick: end });
      }
    }
  }
  return segments.sort(
    (a, b) =>
      a.fromTick - b.fromTick ||
      (automationTargetKey(a.target) < automationTargetKey(b.target)
        ? -1
        : automationTargetKey(a.target) > automationTargetKey(b.target)
          ? 1
          : 0) ||
      (a.clip.id < b.clip.id ? -1 : a.clip.id > b.clip.id ? 1 : 0),
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
