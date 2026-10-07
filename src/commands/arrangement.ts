/**
 * Arrangement clips: place a scene on the timeline, then move, resize, duplicate
 * and delete it, plus the transition lookup the clip layers read.
 */
import type { Command } from "./types";
import type { ArrangementClip, ArrangementTransition, ProjectDocument, SceneRole } from "../project-model/types";
import { MAX_ARRANGEMENT_CLIP_BARS, sanitizeArrangementTransitions } from "../project-model/schema";
import { uid } from "../shared/ids";
import { snapshot } from "./core";
import { makeSceneVariation } from "./scenes";
import { markerClampPatch, unlinkMarkersOfClips } from "./docOps";

/* ---------------- arrangement ---------------- */

/**
 * The arrangement lane's strict no-overlap predicate: touching (adjacent)
 * clips are legal. Shared with the clip clipboard's paste placement, which
 * must honor the exact same contract as add/move/resize/duplicate.
 */
export function clipsOverlap(
  clips: ArrangementClip[],
  ignoreId: string | null,
  startBar: number,
  lengthBars: number,
): boolean {
  const endBar = startBar + lengthBars;
  return clips.some((c) => {
    if (c.id === ignoreId) return false;
    return startBar < c.startBar + c.lengthBars && c.startBar < endBar;
  });
}

export function addArrangementClip(doc: ProjectDocument, sceneId: string, startBar: number, lengthBars = 4): Command {
  const scene = doc.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`Scene ${sceneId} not found`);
  // Math.max passes NaN through and NaN comparisons are all false — an
  // unguarded NaN/negative wrote a clip that normalize then silently
  // DELETED (as an "undoable move"). Clamp like the audio-clip path.
  const bar = Number.isFinite(startBar) ? Math.max(0, Math.round(startBar)) : 0;
  // MAX on add as well as resize: normalize FILTERS (drops) an over-length clip
  // outright, so an unclamped add from a scripted caller would "succeed" while
  // the clip never lands. Clamp here so the stored clip is one normalize keeps.
  const bars = Number.isFinite(lengthBars)
    ? Math.min(MAX_ARRANGEMENT_CLIP_BARS, Math.max(1, Math.round(lengthBars)))
    : 1;
  if (clipsOverlap(doc.arrangement.clips, null, bar, bars)) {
    throw new Error(`Clip overlaps an existing clip at bar ${bar + 1}`);
  }
  const clip: ArrangementClip = { id: uid("clip"), sceneId, startBar: bar, lengthBars: bars };
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      clips: [...doc.arrangement.clips, clip].sort((a, b) => a.startBar - b.startBar),
    },
  };
  return snapshot("addArrangementClip", `Place ${scene.name} at bar ${bar + 1}`, doc, next);
}

export function transitionsForClips(
  doc: ProjectDocument,
  clips: ArrangementClip[],
): ArrangementTransition[] | undefined {
  return sanitizeArrangementTransitions(doc.arrangement.transitions, clips);
}

export function createVariationAndPlaceClip(
  doc: ProjectDocument,
  sceneId: string,
  startBar: number,
  lengthBars = 4,
  roleOverride?: SceneRole,
): Command {
  const source = doc.scenes.find((scene) => scene.id === sceneId);
  if (!source) throw new Error(`Scene ${sceneId} not found`);
  // Same NaN/MAX discipline as addArrangementClip — with more at stake: this
  // command also mints a scene + pattern via makeSceneVariation BEFORE the
  // clip is placed, and normalize only filters the bad CLIP, so an unguarded
  // NaN startBar left the doc with an orphan scene+pattern and the command
  // reporting success with nothing on the timeline.
  const bar = Number.isFinite(startBar) ? Math.max(0, Math.round(startBar)) : 0;
  const bars = Number.isFinite(lengthBars)
    ? Math.min(MAX_ARRANGEMENT_CLIP_BARS, Math.max(1, Math.round(lengthBars)))
    : 1;
  if (clipsOverlap(doc.arrangement.clips, null, bar, bars)) {
    throw new Error(`Clip overlaps an existing clip at bar ${bar + 1}`);
  }
  const { scene, pattern } = makeSceneVariation(doc, source, roleOverride);
  const clip: ArrangementClip = { id: uid("clip"), sceneId: scene.id, startBar: bar, lengthBars: bars };
  const next: ProjectDocument = {
    ...doc,
    patterns: [...doc.patterns, pattern],
    scenes: [...doc.scenes, scene],
    arrangement: {
      ...doc.arrangement,
      clips: [...doc.arrangement.clips, clip].sort((a, b) => a.startBar - b.startBar),
    },
  };
  return snapshot("createVariationAndPlaceClip", `Place ${scene.name}`, doc, next);
}

export function moveArrangementClip(doc: ProjectDocument, clipId: string, startBar: number): Command {
  const clip = doc.arrangement.clips.find((c) => c.id === clipId);
  if (!clip) throw new Error(`Clip ${clipId} not found`);
  // NaN passes Math.max/round through — clamp to 0 like addArrangementClip.
  const bar = Number.isFinite(startBar) ? Math.max(0, Math.round(startBar)) : 0;
  if (clipsOverlap(doc.arrangement.clips, clipId, bar, clip.lengthBars)) {
    throw new Error(`Clip overlaps an existing clip at bar ${bar + 1}`);
  }
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      clips: doc.arrangement.clips
        .map((c) => (c.id === clipId ? { ...c, startBar: bar } : c))
        .sort((a, b) => a.startBar - b.startBar),
      transitions: transitionsForClips(
        doc,
        doc.arrangement.clips
          .map((c) => (c.id === clipId ? { ...c, startBar: bar } : c))
          .sort((a, b) => a.startBar - b.startBar),
      ),
    },
  };
  return snapshot("moveArrangementClip", `Move clip to bar ${bar + 1}`, doc, next);
}

export function resizeArrangementClip(doc: ProjectDocument, clipId: string, lengthBars: number): Command {
  const clip = doc.arrangement.clips.find((c) => c.id === clipId);
  if (!clip) throw new Error(`Clip ${clipId} not found`);
  // NaN passes Math.max/round through — clamp to 1 (minimum clip length).
  // The upper bound is a rendering invariant, not a musical one: the
  // arrangement view allocates one bar-grid node PER BAR, so an unbounded
  // length (a typed SECS value, a scripted command, an imported document)
  // could ask for millions of DOM nodes and freeze the tab.
  const bars = Number.isFinite(lengthBars)
    ? Math.min(MAX_ARRANGEMENT_CLIP_BARS, Math.max(1, Math.round(lengthBars)))
    : 1;
  if (clipsOverlap(doc.arrangement.clips, clipId, clip.startBar, bars)) {
    throw new Error(`Clip would overlap the next clip`);
  }
  const nextClips = doc.arrangement.clips.map((c) => (c.id === clipId ? { ...c, lengthBars: bars } : c));
  const next: ProjectDocument = {
    ...doc,
    arrangement: { ...doc.arrangement, clips: nextClips, transitions: transitionsForClips(doc, nextClips) },
  };
  return snapshot("resizeArrangementClip", `Resize clip to ${bars} bars`, doc, next);
}

export function deleteArrangementClip(doc: ProjectDocument, clipId: string): Command {
  const remainingClips = doc.arrangement.clips.filter((c) => c.id !== clipId);
  // Markers linked to the deleted clip must be unlinked in-command: the
  // stale id would survive every save (schema keeps any string) and undo
  // could not restore the link if it were left to a post-apply normalize.
  const unlinked = unlinkMarkersOfClips(doc.markers, new Set([clipId]));
  const clamp = markerClampPatch(unlinked ?? doc.markers, doc.scenes, doc.patterns, {
    ...doc.arrangement,
    clips: remainingClips,
  });
  const markersPatch =
    clamp.markers !== undefined ? { markers: clamp.markers } : unlinked !== undefined ? { markers: unlinked } : {};
  const next: ProjectDocument = {
    ...doc,
    // Audit 08 D3: markers clamp to the shrunken project end in-command.
    ...markersPatch,
    arrangement: {
      ...doc.arrangement,
      clips: remainingClips,
      transitions: doc.arrangement.transitions?.filter(
        (transition) => transition.fromClipId !== clipId && transition.toClipId !== clipId,
      ),
    },
  };
  return snapshot("deleteArrangementClip", "Delete clip", doc, next);
}

export function duplicateArrangementClip(doc: ProjectDocument, clipId: string): Command {
  const clip = doc.arrangement.clips.find((c) => c.id === clipId);
  if (!clip) throw new Error(`Clip ${clipId} not found`);
  let startBar = clip.startBar + clip.lengthBars;
  while (clipsOverlap(doc.arrangement.clips, null, startBar, clip.lengthBars)) startBar += clip.lengthBars;
  // Carry the per-clip `loop` flag — a fresh literal silently reset it.
  const copy: ArrangementClip = {
    id: uid("clip"),
    sceneId: clip.sceneId,
    startBar,
    lengthBars: clip.lengthBars,
    ...(clip.phaseOffsetTicks !== undefined ? { phaseOffsetTicks: clip.phaseOffsetTicks } : {}),
    ...(clip.sceneOffsetTicks !== undefined ? { sceneOffsetTicks: clip.sceneOffsetTicks } : {}),
    ...(clip.loop ? { loop: clip.loop } : {}),
  };
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      clips: [...doc.arrangement.clips, copy].sort((a, b) => a.startBar - b.startBar),
    },
  };
  return snapshot("duplicateArrangementClip", "Duplicate clip", doc, next);
}
