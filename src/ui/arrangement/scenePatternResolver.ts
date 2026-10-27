/**
 * THE SCENE PATTERN'S MARKS — what the region SHOWS, resolved from the same
 * resolvers the region PLAYS.
 *
 * The scene lane was blind: a scene region in the arrangement was a labelled
 * box. It played a whole scene — drums, melody, an intensity curve — and it
 * showed none of it. The user could not see what the region would play, could
 * not see where the beats fell, and could not see the melody move when the
 * region was trimmed.
 *
 * THESE MARKS ARE THE SAME EVENTS THE AUDIO PLAYS. The scene's audible
 * content is `patternBaseTickForClip` + `noteEventsInWindow` (and
 * `drumHitsInWindow` for the drums), and the live scheduler and the offline
 * renderer both use exactly those:
 *
 *   src/scheduler/Scheduler.ts    patternBaseTickForClip -> schedulePatternWindow
 *   src/rendering/renderer.ts     patternBaseTickForClip -> noteEventsInWindow
 *
 * So this module resolves the window with the SAME calls, and the picture
 * cannot drift from the sound — there is no second implementation of "which
 * notes does this region play" to fall out of step.
 */
import { noteEventsInWindow, patternBaseTickForClip } from "../../project-model/events";
import { drumHitsInWindow } from "../../project-model/groove";
import { ticksPerBar } from "../../project-model/schema";
import type { ArrangementClip, ProjectDocument } from "../../project-model/types";

/** A melodic note inside the region. */
export interface SceneNoteMark {
  /** Stable across renders — the mark's identity in the DOM. */
  key: string;
  /** The note's offset from the region's start, in ticks. */
  offsetTicks: number;
  /** The note's sounding length, in ticks. */
  durationTicks: number;
  pitch: number;
  velocity: number;
}

/** A drum hit inside the region. */
export interface SceneDrumMark {
  key: string;
  /** The hit's offset from the region's start, in ticks. */
  offsetTicks: number;
  /** The drum's name, for the mark's title. */
  label: string;
  velocity: number;
}

export interface ScenePatternMarks {
  notes: SceneNoteMark[];
  drums: SceneDrumMark[];
}

const EMPTY: ScenePatternMarks = { notes: [], drums: [] };

/**
 * The marks a scene region shows: the melody's notes and the drums' hits,
 * both positioned from the region's own start.
 *
 * The window is the region's own span in ticks (bars → ticks through the
 * document's bar length, so a 6/8 project is measured in the same unit the
 * music is), and the origin is the pattern's base for THIS clip — which is
 * where the region's phase puts the pattern, the very same origin the
 * scheduler resolves.
 */
export function scenePatternMarks(doc: ProjectDocument, clip: ArrangementClip): ScenePatternMarks {
  const scene = doc.scenes.find((candidate) => candidate.id === clip.sceneId);
  const pattern = scene ? doc.patterns.find((candidate) => candidate.id === scene.patternId) : undefined;
  if (!pattern) return EMPTY;
  const barUnit = ticksPerBar(doc);
  const from = clip.startBar * barUnit;
  const to = from + clip.lengthBars * barUnit;
  const base = patternBaseTickForClip(clip, barUnit);

  const notes = noteEventsInWindow(pattern, base, from, to).map((event) => ({
    key: `n:${event.trackId}:${event.note.id}:${event.tick}`,
    offsetTicks: event.tick - from,
    durationTicks: Math.max(1, event.note.duration),
    pitch: event.note.pitch,
    velocity: event.note.velocity,
  }));
  const drums = drumHitsInWindow(doc, pattern, base, from, to).map((hit) => ({
    // The ratchet index is part of the identity: one pad can retrigger
    // several times on the same tick, and two marks with one key would be
    // one mark in the DOM.
    key: `d:${hit.trackId}:${hit.pad.id}:${hit.tick}:${hit.ratchetIndex}`,
    offsetTicks: hit.tick - from,
    label: hit.pad.name,
    velocity: hit.velocity,
  }));
  return { notes, drums };
}

/** The region's length in ticks — the width the marks are measured against. */
export function sceneClipLengthTicks(doc: ProjectDocument, clip: ArrangementClip): number {
  return clip.lengthBars * ticksPerBar(doc);
}
