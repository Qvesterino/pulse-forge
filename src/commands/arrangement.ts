/**
 * Arrangement clips: place a scene on the timeline, then move, resize, duplicate
 * and delete it, plus the transition lookup the clip layers read.
 */
import type { Command } from "./types";
import type {
  ArrangementClip,
  ArrangementTransition,
  Pattern,
  ProjectDocument,
  SceneRole,
} from "../project-model/types";
import { sanitizeArrangementTransitions, ticksPerBar } from "../project-model/schema";
import { clampBarPosition, clampWholeBarLength } from "./geometry";
import { scenePatternPeriodTicks } from "../project-model/midiTime";
import { uid } from "../shared/ids";
import { snapshot } from "./core";
import { makeSceneVariation } from "./scenes";
import { markerClampPatch, unlinkMarkersOfClips } from "./docOps";
import { assertClipEditable, clipGroupsWithoutIds } from "./clipGroups";

/**
 * The scene clip's phase after `elapsedTicks` — the music's position inside
 * the scene's loop.
 *
 * A scene clip carries TWO position fields, and they advance TOGETHER:
 * `phaseOffsetTicks` (where the PATTERN's loop sits under the region) and
 * `sceneOffsetTicks` (where the INTENSITY curve sits under the region). Both
 * grow by the elapsed time; only the phase wraps, and it wraps against the
 * scene's TRUE period (`scenePatternPeriodTicks`: the least common multiple of
 * the step grid and every melodic track's phrase) — NOT against the step grid
 * alone, which is what finding D4 was about.
 *
 * The two fields advance in step rather than one being derived from the other,
 * and that is a CONTRACT, not an accident: a document that predates the repair
 * can carry a phase that does not match its offset, and the audible promise —
 * "the right half of a split plays exactly what the original played at the
 * seam" — is about the MUSIC. Deriving the phase from the offset would silently
 * re-seat such a document's music at the next edit.
 */
function scenePhaseAfter(pattern: Pattern | undefined, phase: number, elapsedTicks: number): number {
  const from = Math.max(0, Math.round(phase));
  const advanced = from + Math.max(0, Math.round(elapsedTicks));
  if (!pattern) return advanced;
  const period = scenePatternPeriodTicks(pattern);
  if (period <= 0) return advanced;
  return ((advanced % period) + period) % period;
}

/** The pattern of the scene a clip plays. */
function patternOfScene(doc: ProjectDocument, clip: ArrangementClip): Pattern | undefined {
  const scene = doc.scenes.find((s) => s.id === clip.sceneId);
  return scene ? doc.patterns.find((p) => p.id === scene.patternId) : undefined;
}

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
  const bar = clampBarPosition(startBar);
  // MAX on add as well as resize: normalize FILTERS (drops) an over-length clip
  // outright, so an unclamped add from a scripted caller would "succeed" while
  // the clip never lands. Clamp here so the stored clip is one normalize keeps.
  const bars = clampWholeBarLength(lengthBars);
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
  const bar = clampBarPosition(startBar);
  const bars = clampWholeBarLength(lengthBars);
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
  assertClipEditable(clip, "move");
  // NaN passes Math.max/round through — clamp to 0 like addArrangementClip.
  const bar = clampBarPosition(startBar);
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
  assertClipEditable(clip, "resize");
  // NaN passes Math.max/round through — clamp to 1 (minimum clip length).
  // The upper bound is a rendering invariant, not a musical one: the
  // arrangement view allocates one bar-grid node PER BAR, so an unbounded
  // length (a typed SECS value, a scripted command, an imported document)
  // could ask for millions of DOM nodes and freeze the tab.
  const bars = clampWholeBarLength(lengthBars);
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
  const deleted = doc.arrangement.clips.find((c) => c.id === clipId);
  assertClipEditable(deleted ?? { locked: false }, "delete");
  // Markers linked to the deleted clip must be unlinked in-command: the
  // stale id would survive every save (schema keeps any string) and undo
  // could not restore the link if it were left to a post-apply normalize.
  const unlinked = unlinkMarkersOfClips(doc.markers, new Set([clipId]));
  const clamp = markerClampPatch(
    unlinked ?? doc.markers,
    doc.scenes,
    doc.patterns,
    {
      ...doc.arrangement,
      clips: remainingClips,
    },
    ticksPerBar(doc),
  );
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
      // Group membership dies with the clip; an emptied group dies with it.
      ...(() => {
        const groups = clipGroupsWithoutIds(doc.arrangement.clipGroups, [clipId]);
        return groups !== doc.arrangement.clipGroups ? { clipGroups: groups } : {};
      })(),
    },
  };
  return snapshot("deleteArrangementClip", "Delete clip", doc, next);
}

/**
 * SPLIT a scene clip at an arrangement tick (ADR 0025: split-at-playhead is
 * timeline-wide). The LEFT fragment keeps the original id, so transitions
 * attached to the clip stay attached to the continuation of its start; the
 * RIGHT fragment is a fresh clip whose content state continues the seam:
 *
 *  - the scene's performance offset: sceneOffset + leftTicks — the intensity
 *    curve does NOT loop, it keeps elapsed time;
 *  - the pattern phase: phase + leftTicks, wrapped against the scene's TRUE
 *    loop period (the least common multiple of the step grid and every melodic
 *    track's phrase) — so the right half plays exactly what the original
 *    played at the seam, and the halves tile the original's attacks;
 *  - the per-clip loop flag carries (duplicateArrangementClip contract).
 *
 * The LEFT fragment keeps the original's phase and offset untouched: it is the
 * original, truncated, so the music under it does not move.
 *
 * The scene-clip system is integer-bar by contract (every move/resize rounds,
 * no-overlap compares integer starts), so the split lands on the LAST bar
 * line at or before the playhead, and both fragments must keep a whole bar
 * (the arrangement-clip minimum). Splitting mid-bar asks for the nearest
 * earlier bar line — never a fractional startBar, which the next move would
 * silently snap anyway.
 */
export function splitArrangementClipAtTick(doc: ProjectDocument, clipId: string, splitTick: number): Command {
  const clip = doc.arrangement.clips.find((c) => c.id === clipId);
  if (!clip) throw new Error(`Clip ${clipId} not found`);
  if (!Number.isFinite(splitTick)) throw new Error("Split point must be a finite arrangement tick");
  assertClipEditable(clip, "split");
  const startTick = clip.startBar * ticksPerBar(doc);
  const endTick = startTick + clip.lengthBars * ticksPerBar(doc);
  if (splitTick <= startTick || splitTick >= endTick) throw new Error("Split point outside clip");
  const splitBar = Math.floor(splitTick / ticksPerBar(doc));
  const leftBars = splitBar - clip.startBar;
  const rightBars = clip.lengthBars - leftBars;
  if (leftBars < 1 || rightBars < 1) {
    throw new Error("Scene clips split at bar lines — playhead must leave a whole bar on each side");
  }
  const leftTicks = leftBars * ticksPerBar(doc);
  const pattern = patternOfScene(doc, clip);
  // The right half CONTINUES both positions by the left half's elapsed time:
  // the offset keeps the intensity curve's elapsed time, and the phase is the
  // music's position in the scene's loop — wrapped against the scene's TRUE
  // period (the least common multiple of the step grid and every melodic
  // track's phrase), not against the grid alone (finding D4). The two
  // fragments therefore tile the original's attacks: before the repair the
  // phase was wrapped against the step GRID, so a scene whose melody outlived
  // the grid played a DIFFERENT note at the seam.
  const rightOffset = (clip.sceneOffsetTicks ?? 0) + leftTicks;
  const rightPhase = scenePhaseAfter(pattern, clip.phaseOffsetTicks ?? 0, leftTicks);
  const right: ArrangementClip = {
    id: uid("clip"),
    sceneId: clip.sceneId,
    startBar: splitBar,
    lengthBars: rightBars,
    ...(rightPhase > 0 ? { phaseOffsetTicks: rightPhase } : {}),
    ...(rightOffset > 0 ? { sceneOffsetTicks: rightOffset } : {}),
    ...(clip.loop ? { loop: clip.loop } : {}),
  };
  // The left half IS the original, truncated: it keeps the original's phase
  // and offset untouched, so the music under it does not move.
  const left: ArrangementClip = { ...clip, lengthBars: leftBars };
  const nextClips = doc.arrangement.clips
    .flatMap((c) => (c.id === clipId ? [left, right] : [c]))
    .sort((a, b) => a.startBar - b.startBar);
  // Split of a GROUPED clip: both fragments inherit the membership (the left
  // fragment keeps the original id, the right joins by id replacement).
  const clipGroups = doc.arrangement.clipGroups?.map((group) =>
    group.clipIds.includes(clipId)
      ? { ...group, clipIds: group.clipIds.flatMap((id) => (id === clipId ? [left.id, right.id] : [id])) }
      : group,
  );
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      clips: nextClips,
      // The original id survives as the left fragment, so every transition
      // touching it is still ordered against the shrunken left edge — re-run
      // the same sanitize move/resize run rather than trusting that.
      transitions: sanitizeArrangementTransitions(doc.arrangement.transitions, nextClips),
      ...(clipGroups !== doc.arrangement.clipGroups ? { clipGroups } : {}),
    },
  };
  return snapshot("splitArrangementClip", `Split clip at bar ${splitBar + 1}`, doc, next);
}

export function duplicateArrangementClip(doc: ProjectDocument, clipId: string): Command {
  const clip = doc.arrangement.clips.find((c) => c.id === clipId);
  if (!clip) throw new Error(`Clip ${clipId} not found`);
  let startBar = clip.startBar + clip.lengthBars;
  while (clipsOverlap(doc.arrangement.clips, null, startBar, clip.lengthBars)) startBar += clip.lengthBars;
  // Carry the per-clip `loop` flag — a fresh literal silently reset it. A
  // duplicate is a COPY, not a move: both position fields travel VERBATIM, so
  // the copy plays the same material as the clip it came from, shifted in time
  // by the distance between the two. (Re-deriving the phase here would
  // re-seat a document whose stored phase does not match its offset — the copy
  // would stop sounding like the original.)
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

/**
 * TRIM the START edge of an arrangement clip (move it right, end stays) —
 * the scene-clip twin of trimAudioClipStart.
 *
 * A trim CROPS: the region's music under the region does not change, and the
 * scene's intensity curve keeps its elapsed time. Both positions advance by
 * the elapsed time — the offset grows without bound (the curve does not loop),
 * the phase is the music's position in the scene's loop and is wrapped against
 * the scene's TRUE period (the least common multiple of the step grid and
 * every melodic track's phrase), NOT against the step grid alone (finding D4).
 * Because the region's start moves by exactly the elapsed time and the phase
 * advances by exactly the same amount, the music under the region does not
 * move — the trim crops, exactly like the audio, MIDI and automation lanes.
 * Before the repair the phase was wrapped against the GRID, so a scene whose
 * melody outlived the grid re-seated the pattern inside the region and the
 * region's music slid.
 *
 * Scene clips are integer-bar by contract: the new start is rounded and must
 * land strictly inside the clip, leaving at least one whole bar. The end edge
 * never moves, so the no-overlap contract cannot be violated and transitions
 * referencing the clip stay ordered.
 */
export function trimArrangementClipStart(doc: ProjectDocument, clipId: string, newStartBar: number): Command {
  const clip = doc.arrangement.clips.find((c) => c.id === clipId);
  if (!clip) throw new Error(`Clip ${clipId} not found`);
  assertClipEditable(clip, "trim");
  if (!Number.isFinite(newStartBar)) throw new Error("Trim start must be a finite bar position");
  const startBar = Math.round(newStartBar);
  const endBar = clip.startBar + clip.lengthBars;
  if (startBar <= clip.startBar) {
    throw new Error("Trim start must move the clip's start right (extend-left is a separate verb)");
  }
  if (startBar >= endBar) throw new Error("Trim start must leave at least one whole bar");
  const elapsedTicks = (startBar - clip.startBar) * ticksPerBar(doc);
  const pattern = patternOfScene(doc, clip);
  // Both positions advance by the elapsed time: the scene's performance offset
  // grows without bound, and the pattern's phase — the music's position in the
  // scene's loop — advances by the same amount, wrapped against the scene's
  // TRUE period (see scenePhaseAfter). The region's music under the region
  // therefore does not change — the trim crops, exactly like the audio, MIDI
  // and automation lanes.
  const sceneOffsetTicks = (clip.sceneOffsetTicks ?? 0) + elapsedTicks;
  const phaseOffsetTicks = scenePhaseAfter(pattern, clip.phaseOffsetTicks ?? 0, elapsedTicks);
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      clips: doc.arrangement.clips.map((c) => {
        if (c.id !== clipId) return c;
        const trimmed: ArrangementClip = { ...c, startBar, lengthBars: endBar - startBar };
        // A zero phase is the pattern's own start, and the house style omits it
        // — but the field must be REMOVED, not left as it was. Keeping the old
        // phase here would re-seat the region's music (this verb owns the
        // phase), and the trim's own arithmetic had just computed zero.
        if (phaseOffsetTicks > 0) trimmed.phaseOffsetTicks = phaseOffsetTicks;
        else delete trimmed.phaseOffsetTicks;
        if (sceneOffsetTicks > 0) trimmed.sceneOffsetTicks = sceneOffsetTicks;
        else delete trimmed.sceneOffsetTicks;
        return trimmed;
      }),
    },
  };
  return snapshot("trimArrangementClipStart", `Trim clip start to bar ${startBar + 1}`, doc, next);
}
