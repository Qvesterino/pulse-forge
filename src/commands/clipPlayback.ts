/**
 * Playback shaping for scenes and the clips that reference them: per-scene bpm, intensity curve
 * and loop, plus the ripple variants of the arrangement-clip operations.
 *
 * The ripple commands differ from their non-ripple twins in ./arrangement in one way only —
 * everything after the edit point shifts, so a delete closes the gap instead of leaving a hole.
 * Keeping both in view is the point: reading the ripple and the plain version side by side is how
 * you see exactly which lines make the difference.
 */
import type { Command } from "./types";
import type { AudioClip, IntensityPoint, ProjectDocument } from "../project-model/types";
import { MAX_ARRANGEMENT_CLIP_BARS } from "../project-model/schema";
import { snapshot } from "./core";
import { markerClampPatch, unlinkMarkersOfClips } from "./docOps";
import { assertClipEditable } from "./clipGroups";
import { transitionsForClips } from "./arrangement";

/* ---------------- scenes (intensity / loop) ---------------- */ export function setSceneIntensity(
  doc: ProjectDocument,
  sceneId: string,
  intensity: number,
): Command {
  const target = doc.scenes.find((s) => s.id === sceneId);
  if (!target) throw new Error(`Scene ${sceneId} not found`);
  const clamped = Math.min(1, Math.max(0, Number.isFinite(intensity) ? intensity : 0.7));
  const next = { ...doc, scenes: doc.scenes.map((s) => (s.id === sceneId ? { ...s, intensity: clamped } : s)) };
  return snapshot("setSceneIntensity", `Scene intensity to ${clamped.toFixed(2)}`, doc, next);
}

/**
 * Scene tempo: a number pins the scene's playback BPM (applied while its
 * clips play); `null` clears it and the scene follows the project tempo.
 */
export function setSceneBpm(doc: ProjectDocument, sceneId: string, bpm: number | null): Command {
  const target = doc.scenes.find((s) => s.id === sceneId);
  if (!target) throw new Error(`Scene ${sceneId} not found`);
  if (bpm !== null && (!Number.isFinite(bpm) || bpm < 40 || bpm > 240)) {
    throw new Error(`Scene tempo ${bpm} out of range (40–240)`);
  }
  const value = bpm === null ? undefined : Math.round(bpm);
  const next = { ...doc, scenes: doc.scenes.map((s) => (s.id === sceneId ? { ...s, bpm: value } : s)) };
  return snapshot(
    "setSceneBpm",
    value === undefined ? "Scene follows project tempo" : `Scene tempo to ${value} BPM`,
    doc,
    next,
  );
}
export function setSceneIntensityCurve(doc: ProjectDocument, sceneId: string, curve: IntensityPoint[]): Command {
  const target = doc.scenes.find((s) => s.id === sceneId);
  if (!target) throw new Error(`Scene ${sceneId} not found`);
  const cleaned = curve
    .map((p) => ({
      // Math.floor(NaN) is NaN — sanitize would silently pin it to 0 on the
      // next execute; clamp here so the stored curve is already finite.
      offset: Number.isFinite(p.offset) ? Math.max(0, Math.floor(p.offset)) : 0,
      value: Math.min(1, Math.max(0, Number.isFinite(p.value) ? p.value : 0)),
    }))
    .sort((a, b) => a.offset - b.offset);
  const next = {
    ...doc,
    scenes: doc.scenes.map((s) =>
      s.id === sceneId ? { ...s, intensityCurve: cleaned.length > 0 ? cleaned : undefined } : s,
    ),
  };
  return snapshot("setSceneIntensityCurve", "Scene intensity curve", doc, next);
}
export function setSceneLoop(doc: ProjectDocument, sceneId: string, loop: boolean): Command {
  const target = doc.scenes.find((s) => s.id === sceneId);
  if (!target) throw new Error(`Scene ${sceneId} not found`);
  const next = { ...doc, scenes: doc.scenes.map((s) => (s.id === sceneId ? { ...s, loop } : s)) };
  return snapshot("setSceneLoop", loop ? "Loop scene" : "Unloop scene", doc, next);
}
export function setArrangementClipLoop(doc: ProjectDocument, clipId: string, loop: boolean): Command {
  const target = doc.arrangement.clips.find((c) => c.id === clipId);
  if (!target) throw new Error(`Clip ${clipId} not found`);
  const next = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      clips: doc.arrangement.clips.map((c) => (c.id === clipId ? { ...c, loop } : c)),
    },
  };
  return snapshot("setArrangementClipLoop", loop ? "Loop clip" : "Unloop clip", doc, next);
}

/**
 * VARIANT SWAP (arrangement-as-a-tool wave): point an existing clip at a
 * different scene — same position, same length, same transitions. This is
 * the cheap "try Pattern B in the second chorus" move: nothing on the
 * timeline changes but the musical content under the clip.
 */
export function setArrangementClipScene(doc: ProjectDocument, clipId: string, sceneId: string): Command {
  const clip = doc.arrangement.clips.find((c) => c.id === clipId);
  if (!clip) throw new Error(`Clip ${clipId} not found`);
  const scene = doc.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`Scene ${sceneId} not found`);
  if (clip.sceneId === sceneId) return snapshot("setArrangementClipScene", "Swap variant (no-op)", doc, doc);
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      clips: doc.arrangement.clips.map((c) => (c.id === clipId ? { ...c, sceneId } : c)),
    },
  };
  return snapshot("setArrangementClipScene", `Swap variant → ${scene.name}`, doc, next);
}

/**
 * ADR 0025: ripple is timeline-wide. Audio clips at/after the edit point
 * shift by the same whole-bar delta (tick-aligned — integer bars cannot
 * destroy sub-bar positions). A clip STRADDLING the boundary stays put: the
 * layering contract allows it to keep sounding across the moved seam, and
 * yanking it would teleport audible content the user did not grab.
 */
function rippleShiftAudioClips(
  audioClips: AudioClip[] | undefined,
  threshold: number,
  deltaBars: number,
): AudioClip[] | undefined {
  if (!audioClips || audioClips.length === 0) return audioClips;
  return audioClips.map((c) => (c.startBar >= threshold ? { ...c, startBar: Math.max(0, c.startBar + deltaBars) } : c));
}

/**
 * RIPPLE EDIT (arrangement-as-a-tool wave): moving a clip shifts every
 * later clip by the same delta, preserving all gaps — the arrangement
 * behaves like one continuous strip instead of clips floating on rails.
 * Transitions are re-derived from the resulting layout.
 */
export function moveArrangementClipRipple(doc: ProjectDocument, clipId: string, startBar: number): Command {
  const clip = doc.arrangement.clips.find((c) => c.id === clipId);
  if (!clip) throw new Error(`Clip ${clipId} not found`);
  // Lock guard covers the RIPPLE TARGET; tail clips flowing past a locked
  // clip are a documented v1 boundary.
  assertClipEditable(clip, "move");
  if (!Number.isFinite(startBar)) return snapshot("moveArrangementClipRipple", "Ripple move (no-op)", doc, doc);
  // RIPPLE LEFT FLOOR: the moved clip stops at the end of whatever sits
  // before it (0 when the lane is clear to the origin). An unclamped
  // leftward ripple dropped the clip ON its predecessor, and the per-clip
  // Math.max(0, …) below then piled every later clip onto bar 0 — N
  // overlapping clips at the timeline origin from one drag. Clamping the
  // TARGET (not the per-clip results) is what keeps every gap: later clips
  // shift by the same delta, so once the target is legal the whole tail is.
  const predecessorEnd = doc.arrangement.clips
    .filter((c) => c.id !== clipId && c.startBar + c.lengthBars <= clip.startBar)
    .reduce((max, c) => Math.max(max, c.startBar + c.lengthBars), 0);
  const target = Math.max(predecessorEnd, Math.round(startBar));
  const delta = target - clip.startBar;
  const clips = doc.arrangement.clips
    .map((c) =>
      c.id === clipId || c.startBar >= clip.startBar + clip.lengthBars
        ? { ...c, startBar: Math.max(0, c.startBar + delta) }
        : c,
    )
    .sort((a, b) => a.startBar - b.startBar);
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      clips,
      audioClips: rippleShiftAudioClips(doc.arrangement.audioClips, clip.startBar + clip.lengthBars, delta),
      transitions: transitionsForClips(doc, clips),
    },
  };
  return snapshot("moveArrangementClipRipple", `Ripple move to bar ${target + 1}`, doc, next);
}

/**
 * RIPPLE resize: growing a clip pushes every later clip right (shrinking
 * pulls them left) — the gaps after the edit stay exactly as before.
 */
export function resizeArrangementClipRipple(doc: ProjectDocument, clipId: string, lengthBars: number): Command {
  const clip = doc.arrangement.clips.find((c) => c.id === clipId);
  if (!clip) throw new Error(`Clip ${clipId} not found`);
  // Lock guard covers the RIPPLE TARGET; tail clips flowing past a locked
  // clip are a documented v1 boundary.
  assertClipEditable(clip, "resize");
  if (!Number.isFinite(lengthBars)) return snapshot("resizeArrangementClipRipple", "Ripple resize (no-op)", doc, doc);
  // Same rendering invariant as resizeArrangementClip — see the comment there.
  const bars = Math.min(MAX_ARRANGEMENT_CLIP_BARS, Math.max(1, Math.round(lengthBars)));
  const deltaBars = bars - clip.lengthBars;
  const oldEnd = clip.startBar + clip.lengthBars;
  const clips = doc.arrangement.clips
    .map((c) => {
      if (c.id === clipId) return { ...c, lengthBars: bars };
      if (c.startBar >= oldEnd) return { ...c, startBar: Math.max(0, c.startBar + deltaBars) };
      return c;
    })
    .sort((a, b) => a.startBar - b.startBar);
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      clips,
      audioClips: rippleShiftAudioClips(doc.arrangement.audioClips, oldEnd, deltaBars),
      transitions: transitionsForClips(doc, clips),
    },
  };
  return snapshot("resizeArrangementClipRipple", `Ripple resize to ${bars} bars`, doc, next);
}

/**
 * RIPPLE delete: removing a clip closes the gap — every later clip slides
 * left by the deleted length.
 */
export function deleteArrangementClipRipple(doc: ProjectDocument, clipId: string): Command {
  const clip = doc.arrangement.clips.find((c) => c.id === clipId);
  if (!clip) throw new Error(`Clip ${clipId} not found`);
  // Lock guard covers the RIPPLE TARGET; tail clips flowing past a locked
  // clip are a documented v1 boundary.
  assertClipEditable(clip, "delete");
  const oldEnd = clip.startBar + clip.lengthBars;
  const clips = doc.arrangement.clips
    .filter((c) => c.id !== clipId)
    .map((c) => (c.startBar >= oldEnd ? { ...c, startBar: Math.max(0, c.startBar - clip.lengthBars) } : c))
    .sort((a, b) => a.startBar - b.startBar);
  const unlinked = unlinkMarkersOfClips(doc.markers, new Set([clipId]));
  const clamp = markerClampPatch(unlinked ?? doc.markers, doc.scenes, doc.patterns, { ...doc.arrangement, clips });
  const markersPatch =
    clamp.markers !== undefined ? { markers: clamp.markers } : unlinked !== undefined ? { markers: unlinked } : {};
  const next: ProjectDocument = {
    ...doc,
    // Audit 08 D3: markers clamp to the shrunken project end in-command.
    ...markersPatch,
    arrangement: {
      ...doc.arrangement,
      clips,
      audioClips: rippleShiftAudioClips(doc.arrangement.audioClips, oldEnd, -clip.lengthBars),
      transitions: transitionsForClips(doc, clips),
    },
  };
  return snapshot("deleteArrangementClipRipple", `Ripple delete clip`, doc, next);
}
