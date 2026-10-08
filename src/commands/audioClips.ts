/**
 * Audio clips on the arrangement: place one, add and switch takes, comp a range, move,
 * stretch, resize, trim the head, or delete.
 *
 * Length and fade helpers live here too rather than in the renderer, because the command
 * layer is what decides what a clip's duration and fade bounds are; the engine only reads
 * the result. Keeping both sides out of one place is what stops the UI and the offline
 * render from disagreeing about how long a clip is.
 */
import type { Command } from "./types";
import type { AudioClip, ProjectDocument } from "../project-model/types";
import { BAR_TICKS, PPQ } from "../project-model/types";
import { tempoAtTick } from "../project-model/scene-time";
import { normalizeProject } from "../project-model/schema";
import { uid } from "../shared/ids";
import { snapshot } from "./core";
import { assertClipEditable, clipGroupsWithoutIds } from "./clipGroups";
import { unlinkMarkersOfClips } from "./docOps";

/* ---------------- audioClips ---------------- */

/**
 * Storage precision for audio-clip bar geometry: TICK-ALIGNED. The musical
 * grid lives on ticks (1/16 bar = 120 ticks), so every snapped position
 * survives the round-trip exactly. The previous 0.01-bar round collapsed 1/8
 * and 1/16 positions (0.125 → 0.13, 0.0625 → 0.06) — finer than the old
 * precision on purpose, and legacy 0.01-quantized data shifts by at most half
 * a tick on its next edit (inaudible at any tempo).
 */
export function quantizeAudioBar(bar: number): number {
  return Number.isFinite(bar) ? Math.round(bar * BAR_TICKS) / BAR_TICKS : bar;
}

export function addAudioClip(
  doc: ProjectDocument,
  trackId: string,
  bufferId: string,
  startBar: number,
  lengthBars = 4,
  patch: Partial<Omit<AudioClip, "id" | "trackId" | "bufferId" | "startBar" | "lengthBars">> = {},
): Command {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`Track ${trackId} not found`);
  if (!bufferId) throw new Error("bufferId required");
  // Audit hardening: a non-finite position/duration from a caller parse bug
  // must never poison the document (Math.max/min pass NaN through).
  const finiteOr = (value: number, fallback: number): number => (Number.isFinite(value) ? value : fallback);
  const clip: AudioClip = {
    id: uid("audioClip"),
    trackId,
    bufferId,
    startBar: Math.max(0, quantizeAudioBar(finiteOr(startBar, 0))),
    lengthBars: Math.max(0.25, quantizeAudioBar(finiteOr(lengthBars, 4))),
    offsetSec: Math.max(0, finiteOr(patch.offsetSec ?? 0, 0)),
    trimStart: Math.max(0, finiteOr(patch.trimStart ?? 0, 0)),
    trimEnd: Math.max(0, finiteOr(patch.trimEnd ?? 0, 0)),
    gain: Math.min(2, Math.max(0, finiteOr(patch.gain ?? 1, 1))),
    fadeIn: Math.max(0, finiteOr(patch.fadeIn ?? 0, 0)),
    fadeOut: Math.max(0, finiteOr(patch.fadeOut ?? 0, 0)),
    stretchRate: Math.min(4, Math.max(0.25, finiteOr(patch.stretchRate ?? 1, 1))),
    reverse: patch.reverse === true,
    ...(Number.isSafeInteger(patch.sourceChannel) &&
    (patch.sourceChannel ?? -1) >= 0 &&
    (patch.sourceChannel ?? 32) < 32
      ? { sourceChannel: patch.sourceChannel }
      : {}),
    ...(patch.stretchMode ? { stretchMode: patch.stretchMode } : {}),
    ...(patch.loop === true ? { loop: true as const } : {}),
    ...(patch.muted === true ? { muted: true as const } : {}),
    ...(patch.fadeCurve === "equal" ? { fadeCurve: "equal" as const } : {}),
    ...(patch.loop === true && Number.isFinite(patch.loopPhaseOffsetSec)
      ? { loopPhaseOffsetSec: Math.max(0, patch.loopPhaseOffsetSec!) }
      : {}),
    ...(patch.warpMarkers ? { warpMarkers: patch.warpMarkers.map((m) => ({ ...m })) } : {}),
  };
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      audioClips: [...(doc.arrangement.audioClips ?? []), clip].sort((a, b) => a.startBar - b.startBar),
    },
  };
  return snapshot("addAudioClip", `Add audio clip`, doc, next);
}

/** Add one clip segment to a whole-take lane; repeated takeId segments form a comp source. */
export function addAudioTakeClip(
  doc: ProjectDocument,
  groupId: string,
  takeId: string,
  trackId: string,
  bufferId: string,
  startBar: number,
  lengthBars = 4,
  patch: Partial<Omit<AudioClip, "id" | "trackId" | "bufferId" | "startBar" | "lengthBars">> = {},
): Command {
  if (!groupId || !takeId) throw new Error("Audio take group and take IDs are required");
  const existingGroup = doc.arrangement.takeGroups?.find((group) => group.id === groupId);
  if (existingGroup && existingGroup.trackId !== trackId) throw new Error("Audio take group cannot span tracks");
  const added = addAudioClip(doc, trackId, bufferId, startBar, lengthBars, patch).execute(doc);
  const addedClip = added.arrangement.audioClips?.find(
    (clip) => !doc.arrangement.audioClips?.some((previous) => previous.id === clip.id),
  );
  if (!addedClip) throw new Error("Audio take clip was not added");
  const audioClips = added.arrangement.audioClips!.map((clip) =>
    clip.id === addedClip.id ? { ...clip, takeGroupId: groupId, takeId } : clip,
  );
  const takeGroups = existingGroup
    ? [...(doc.arrangement.takeGroups ?? [])]
    : [...(doc.arrangement.takeGroups ?? []), { id: groupId, trackId, activeTakeId: takeId }];
  const next = normalizeProject({
    ...added,
    arrangement: { ...added.arrangement, audioClips, takeGroups },
  });
  return snapshot("addAudioTakeClip", "Add audio take", doc, next);
}

/** Switch the audible pass without deleting or rewriting alternate recorded takes. */
export function setActiveAudioTake(doc: ProjectDocument, groupId: string, takeId: string): Command {
  const group = doc.arrangement.takeGroups?.find((item) => item.id === groupId);
  if (!group) throw new Error(`Audio take group ${groupId} not found`);
  if (
    !doc.arrangement.audioClips?.some(
      (clip) => clip.takeGroupId === groupId && clip.takeId === takeId && clip.trackId === group.trackId,
    )
  ) {
    throw new Error(`Audio take ${takeId} has no clips in group ${groupId}`);
  }
  const next = normalizeProject({
    ...doc,
    arrangement: {
      ...doc.arrangement,
      takeGroups: doc.arrangement.takeGroups!.map((item) =>
        item.id === groupId ? { ...item, activeTakeId: takeId } : item,
      ),
    },
  });
  return snapshot("setActiveAudioTake", `Select audio take ${takeId}`, doc, next);
}

/**
 * Replace an arrangement-tick range in a take comp with material from one
 * linear source pass. Optional crossfades are stored as overlapping comp
 * AudioClips with musical fade durations. Source passes remain immutable.
 */
export function compAudioTakeRange(
  doc: ProjectDocument,
  groupId: string,
  sourceTakeId: string,
  startTick: number,
  endTick: number,
  crossfadeTicks = 0,
): Command {
  const group = doc.arrangement.takeGroups?.find((item) => item.id === groupId);
  if (!group) throw new Error(`Audio take group ${groupId} not found`);
  if (!Number.isFinite(startTick) || !Number.isFinite(endTick) || startTick < 0 || endTick <= startTick) {
    throw new Error("Comp range must have a positive, finite start and end");
  }
  if (!sourceTakeId || sourceTakeId === group.compTakeId) {
    throw new Error("Choose a source take, not the comp itself");
  }
  if (!Number.isSafeInteger(crossfadeTicks) || crossfadeTicks < 0 || crossfadeTicks > PPQ * 2) {
    throw new Error("Comp crossfade must be an integer between 0 and 960 ticks");
  }
  if (crossfadeTicks > endTick - startTick) {
    throw new Error("Comp crossfade cannot be longer than the selected range");
  }

  const audioClips = doc.arrangement.audioClips ?? [];
  const compTakeId = group.compTakeId ?? uid("takeComp");
  const epsilonTicks = 1e-6;
  const isLinear = (clip: AudioClip): boolean =>
    !clip.reverse && !clip.loop && clip.stretchMode !== "stretch" && (clip.warpMarkers?.length ?? 0) === 0;
  const clipsForTake = (takeId: string): AudioClip[] =>
    audioClips
      .filter((clip) => clip.takeGroupId === groupId && clip.takeId === takeId && clip.trackId === group.trackId)
      .sort((a, b) => a.startBar - b.startBar);
  const tempoSpans = doc.arrangement.clips.flatMap((arrangementClip) => {
    const scene = doc.scenes.find((item) => item.id === arrangementClip.sceneId);
    if (!scene) return [];
    return [
      {
        from: arrangementClip.startBar * BAR_TICKS,
        to: (arrangementClip.startBar + arrangementClip.lengthBars) * BAR_TICKS,
        bpm: scene.bpm ?? doc.bpm,
      },
    ];
  });
  const secondsBetweenTicks = (fromTick: number, toTick: number): number => {
    let cursor = fromTick;
    let seconds = 0;
    while (cursor < toTick - epsilonTicks) {
      const active = tempoSpans.find((span) => cursor >= span.from && cursor < span.to);
      const nextBoundary = active
        ? Math.min(toTick, active.to)
        : Math.min(toTick, ...tempoSpans.filter((span) => span.from > cursor).map((span) => span.from));
      seconds += (nextBoundary - cursor) * (60 / ((active?.bpm ?? doc.bpm) * PPQ));
      cursor = nextBoundary;
    }
    return seconds;
  };
  const declickFadeSec = 0.003;
  const sliceClip = (clip: AudioClip, fromTick: number, toTick: number, id: string): AudioClip | null => {
    const clipStartTick = clip.startBar * BAR_TICKS;
    const clipEndTick = clipStartTick + clip.lengthBars * BAR_TICKS;
    const sliceStart = Math.max(fromTick, clipStartTick);
    const sliceEnd = Math.min(toTick, clipEndTick);
    if (sliceEnd <= sliceStart + epsilonTicks) return null;
    const startsAtClipEdge = Math.abs(sliceStart - clipStartTick) <= epsilonTicks;
    const endsAtClipEdge = Math.abs(sliceEnd - clipEndTick) <= epsilonTicks;
    const elapsedSec = secondsBetweenTicks(clipStartTick, sliceStart);
    return {
      ...clip,
      id,
      startBar: sliceStart / BAR_TICKS,
      lengthBars: (sliceEnd - sliceStart) / BAR_TICKS,
      // offsetSec excludes trimStart; this matches splitAudioClipAtTick and
      // keeps the source window continuous for non-unit resample rates.
      offsetSec: Math.max(0, clip.offsetSec + elapsedSec * clip.stretchRate),
      fadeIn: startsAtClipEdge ? clip.fadeIn : declickFadeSec,
      fadeOut: endsAtClipEdge ? clip.fadeOut : declickFadeSec,
    };
  };
  const segmentsForTake = (
    takeId: string,
    fromTick: number,
    toTick: number,
  ): Array<{
    clip: AudioClip;
    startTick: number;
    endTick: number;
  }> => {
    const sourceClips = clipsForTake(takeId);
    if (sourceClips.length === 0) throw new Error(`Audio take ${takeId} has no clips in group ${groupId}`);
    const segments: Array<{ clip: AudioClip; startTick: number; endTick: number }> = [];
    let coveredUntil = fromTick;
    for (const clip of sourceClips) {
      const clipStartTick = clip.startBar * BAR_TICKS;
      const clipEndTick = clipStartTick + clip.lengthBars * BAR_TICKS;
      const segmentStart = Math.max(fromTick, clipStartTick);
      const segmentEnd = Math.min(toTick, clipEndTick);
      if (segmentEnd <= segmentStart + epsilonTicks) continue;
      if (segmentStart > coveredUntil + epsilonTicks) {
        throw new Error(`Audio take ${takeId} does not cover the entire comp range`);
      }
      if (segmentStart < coveredUntil - epsilonTicks) {
        throw new Error(`Audio take ${takeId} has overlapping clips in the comp range`);
      }
      if (!isLinear(clip)) {
        throw new Error("Comping currently requires linear, forward-playing source clips without warp or loop");
      }
      segments.push({ clip, startTick: segmentStart, endTick: segmentEnd });
      coveredUntil = segmentEnd;
      if (coveredUntil >= toTick - epsilonTicks) break;
    }
    if (coveredUntil < toTick - epsilonTicks) {
      throw new Error(`Audio take ${takeId} does not cover the entire comp range`);
    }
    return segments;
  };

  const compClips = clipsForTake(compTakeId);
  const leftCandidates = compClips
    .filter(
      (clip) =>
        clip.startBar * BAR_TICKS < startTick - epsilonTicks &&
        clip.startBar * BAR_TICKS + clip.lengthBars * BAR_TICKS >= startTick - epsilonTicks,
    )
    .sort((a, b) => b.startBar - a.startBar);
  const rightCandidates = compClips
    .filter(
      (clip) =>
        clip.startBar * BAR_TICKS <= endTick + epsilonTicks &&
        clip.startBar * BAR_TICKS + clip.lengthBars * BAR_TICKS > endTick + epsilonTicks,
    )
    .sort((a, b) => a.startBar + a.lengthBars - (b.startBar + b.lengthBars));
  const leftNeighbor = leftCandidates[0];
  const rightNeighbor = rightCandidates[0];
  const requestedHalfTicks = crossfadeTicks / 2;
  const leftHalfTicks =
    crossfadeTicks > 0 && leftNeighbor?.compSourceTakeId && leftNeighbor.compSourceTakeId !== sourceTakeId
      ? Math.min(requestedHalfTicks, startTick)
      : 0;
  const rightHalfTicks =
    crossfadeTicks > 0 && rightNeighbor?.compSourceTakeId && rightNeighbor.compSourceTakeId !== sourceTakeId
      ? requestedHalfTicks
      : 0;
  const sourceRangeStartTick = startTick - leftHalfTicks;
  const sourceRangeEndTick = endTick + rightHalfTicks;

  const ensureNoExistingCrossfadeInWindow = (fromTick: number, toTick: number): void => {
    const sources = new Set(
      compClips
        .filter((clip) => {
          const clipStart = clip.startBar * BAR_TICKS;
          const clipEnd = clipStart + clip.lengthBars * BAR_TICKS;
          return clipStart < toTick - epsilonTicks && clipEnd > fromTick + epsilonTicks;
        })
        .map((clip) => clip.compSourceTakeId ?? `unknown:${clip.id}`),
    );
    if (sources.size > 1) {
      throw new Error("This comp range touches an existing crossfade; include the full old seam in the selected range");
    }
  };
  if (leftHalfTicks > 0) ensureNoExistingCrossfadeInWindow(startTick - leftHalfTicks, startTick + leftHalfTicks);
  if (rightHalfTicks > 0) ensureNoExistingCrossfadeInWindow(endTick - rightHalfTicks, endTick + rightHalfTicks);

  const sourceSegments = segmentsForTake(sourceTakeId, sourceRangeStartTick, sourceRangeEndTick);
  const leftNeighborSegments =
    leftHalfTicks > 0
      ? segmentsForTake(leftNeighbor!.compSourceTakeId!, startTick - leftHalfTicks, startTick + leftHalfTicks)
      : [];
  const rightNeighborSegments =
    rightHalfTicks > 0
      ? segmentsForTake(rightNeighbor!.compSourceTakeId!, endTick - rightHalfTicks, endTick + rightHalfTicks)
      : [];
  const leftFadeSec = leftHalfTicks > 0 ? secondsBetweenTicks(startTick - leftHalfTicks, startTick + leftHalfTicks) : 0;
  const rightFadeSec = rightHalfTicks > 0 ? secondsBetweenTicks(endTick - rightHalfTicks, endTick + rightHalfTicks) : 0;

  const cutStartTick = sourceRangeStartTick;
  const cutEndTick = sourceRangeEndTick;
  const continuesLeftOfCrossfade =
    leftHalfTicks > 0 &&
    compClips.some(
      (clip) =>
        clip.compSourceTakeId === leftNeighbor?.compSourceTakeId &&
        clip.startBar * BAR_TICKS < cutStartTick - epsilonTicks &&
        clip.startBar * BAR_TICKS + clip.lengthBars * BAR_TICKS >= cutStartTick - epsilonTicks,
    );
  const continuesRightOfCrossfade =
    rightHalfTicks > 0 &&
    compClips.some(
      (clip) =>
        clip.compSourceTakeId === rightNeighbor?.compSourceTakeId &&
        clip.startBar * BAR_TICKS <= cutEndTick + epsilonTicks &&
        clip.startBar * BAR_TICKS + clip.lengthBars * BAR_TICKS > cutEndTick + epsilonTicks,
    );
  const retainedCompClips: AudioClip[] = [];
  for (const clip of audioClips) {
    if (clip.takeGroupId !== groupId || clip.takeId !== compTakeId || clip.trackId !== group.trackId) {
      retainedCompClips.push(clip);
      continue;
    }
    const clipStartTick = clip.startBar * BAR_TICKS;
    const clipEndTick = clipStartTick + clip.lengthBars * BAR_TICKS;
    if (clipEndTick <= cutStartTick + epsilonTicks || clipStartTick >= cutEndTick - epsilonTicks) {
      retainedCompClips.push(clip);
      continue;
    }
    const left = sliceClip(clip, clipStartTick, cutStartTick, uid("audioClip"));
    const right = sliceClip(clip, cutEndTick, clipEndTick, uid("audioClip"));
    if (left) {
      if (continuesLeftOfCrossfade && clip.compSourceTakeId === leftNeighbor?.compSourceTakeId) left.fadeOut = 0;
      retainedCompClips.push(left);
    }
    if (right) {
      if (continuesRightOfCrossfade && clip.compSourceTakeId === rightNeighbor?.compSourceTakeId) right.fadeIn = 0;
      retainedCompClips.push(right);
    }
  }

  const buildCompSegments = (
    segments: typeof sourceSegments,
    provenanceTakeId: string,
    fadeInSec = 0,
    fadeOutSec = 0,
  ): AudioClip[] =>
    segments.map(({ clip, startTick: segmentStart, endTick: segmentEnd }, index) => {
      const sliced = sliceClip(clip, segmentStart, segmentEnd, uid("audioClip"));
      if (!sliced) throw new Error("Unable to create a non-empty comp segment");
      return {
        ...sliced,
        ...(index === 0 && fadeInSec > 0 ? { fadeIn: fadeInSec } : {}),
        ...(index === segments.length - 1 && fadeOutSec > 0 ? { fadeOut: fadeOutSec } : {}),
        takeGroupId: groupId,
        takeId: compTakeId,
        compSourceTakeId: provenanceTakeId,
      };
    });
  const leftCrossfadeClips = buildCompSegments(
    leftNeighborSegments,
    leftNeighbor?.compSourceTakeId ?? "",
    0,
    leftFadeSec,
  );
  const selectedCompClips = buildCompSegments(sourceSegments, sourceTakeId, leftFadeSec, rightFadeSec);
  const rightCrossfadeClips = buildCompSegments(
    rightNeighborSegments,
    rightNeighbor?.compSourceTakeId ?? "",
    rightFadeSec,
    0,
  );
  if (continuesLeftOfCrossfade && leftCrossfadeClips[0]) leftCrossfadeClips[0].fadeIn = 0;
  if (continuesRightOfCrossfade && rightCrossfadeClips.length > 0) {
    rightCrossfadeClips[rightCrossfadeClips.length - 1]!.fadeOut = 0;
  }
  const next = normalizeProject({
    ...doc,
    arrangement: {
      ...doc.arrangement,
      audioClips: [...retainedCompClips, ...leftCrossfadeClips, ...selectedCompClips, ...rightCrossfadeClips].sort(
        (a, b) => a.startBar - b.startBar,
      ),
      takeGroups: doc.arrangement.takeGroups!.map((item) =>
        item.id === groupId ? { ...item, compTakeId, activeTakeId: compTakeId } : item,
      ),
    },
  });
  return snapshot(
    "compAudioTakeRange",
    `Comp ${sourceTakeId} over ticks ${startTick}–${endTick}${crossfadeTicks > 0 ? ` (${crossfadeTicks}-tick crossfade)` : ""}`,
    doc,
    next,
  );
}

export function deleteAudioClip(doc: ProjectDocument, clipId: string): Command {
  const clip = (doc.arrangement.audioClips ?? []).find((c) => c.id === clipId);
  assertClipEditable(clip ?? { locked: false }, "delete");
  // Markers linked to the deleted clip are unlinked in-command (same contract
  // as deleteArrangementClip) so no stale linkedClipId survives in saves.
  const unlinked = unlinkMarkersOfClips(doc.markers, new Set([clipId]));
  // Group membership dies with the clip; a group down to zero members dies
  // with it (same contract as deleteArrangementClip).
  const clipGroups = clipGroupsWithoutIds(doc.arrangement.clipGroups, [clipId]);
  const next: ProjectDocument = {
    ...doc,
    ...(unlinked !== undefined ? { markers: unlinked } : {}),
    arrangement: {
      ...doc.arrangement,
      audioClips: (doc.arrangement.audioClips ?? []).filter((c) => c.id !== clipId),
      ...(clipGroups !== doc.arrangement.clipGroups ? { clipGroups } : {}),
    },
  };
  return snapshot("deleteAudioClip", "Delete audio clip", doc, next);
}

/**
 * Timeline duration of a clip, in seconds.
 *
 * Single source of truth for "how long is this clip", so the fade clamp below
 * and every caller that needs the duration agree on one formula. Pass
 * `startBar` for the tempo the scheduler ACTUALLY runs the clip at — its
 * covering scene's BPM pin (Scene Mode) — rather than flat project tempo.
 */
export function audioClipDurationSec(doc: ProjectDocument, lengthBars: number, startBar?: number): number {
  const bars = Number.isFinite(lengthBars) ? lengthBars : 0;
  const bpm =
    startBar === undefined ? doc.bpm : tempoAtTick(doc.arrangement.clips, doc.scenes, startBar * BAR_TICKS, doc.bpm);
  return (bars * BAR_TICKS * 60) / (bpm * PPQ);
}

/**
 * INVARIANT: a clip's fade must never outlive the clip itself.
 *
 *   0 <= fadeIn  <= duration(clip)
 *   0 <= fadeOut <= duration(clip)
 *
 * This is not cosmetic. The engine clamps an out-of-bounds fade audibly, so a
 * fade that outlasts its clip makes the stored document disagree with both what
 * the user hears and where the fade handles are drawn — the visual/state
 * mismatch the editor audit calls out as P2.
 *
 * Every command that REWRITES a clip's length must run the inherited fades back
 * through here. The structural fragment builders (split, slice, strip-silence)
 * derive their fragments by spreading `...clip` and overwriting only the
 * geometry, so without this they hand a multi-second parent fade to a fragment
 * that can be orders of magnitude shorter — a 4s fadeIn on a 0.1s clip.
 *
 * Pass the clip's STORED length (post-rounding, post-clamp) as `lengthBars`: the
 * bound has to match the length that actually lands in the document.
 */
export function clampClipFades(
  doc: ProjectDocument,
  clip: Pick<AudioClip, "fadeIn" | "fadeOut">,
  lengthBars: number,
  /** Clip start bar — bounds the fade at the scene-pinned tempo (see audioClipDurationSec). */
  startBar?: number,
): { fadeIn: number; fadeOut: number } {
  const durSec = audioClipDurationSec(doc, lengthBars, startBar);
  const bound = Number.isFinite(durSec) && durSec > 0 ? durSec : 0;
  const fadeIn = Number.isFinite(clip.fadeIn) ? (clip.fadeIn as number) : 0;
  const fadeOut = Number.isFinite(clip.fadeOut) ? (clip.fadeOut as number) : 0;
  return {
    fadeIn: Math.min(Math.max(0, fadeIn), bound),
    fadeOut: Math.min(Math.max(0, fadeOut), bound),
  };
}

export function moveAudioClip(doc: ProjectDocument, clipId: string, startBar: number): Command {
  const clip = (doc.arrangement.audioClips ?? []).find((c) => c.id === clipId);
  if (!clip) throw new Error(`AudioClip ${clipId} not found`);
  assertClipEditable(clip, "move");
  if (!Number.isFinite(startBar)) return snapshot("moveAudioClip", "Move audio clip (no-op)", doc, doc);
  const bar = Math.max(0, quantizeAudioBar(startBar));
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      audioClips: (doc.arrangement.audioClips ?? [])
        .map((c) => (c.id === clipId ? { ...c, startBar: bar } : c))
        .sort((a, b) => a.startBar - b.startBar),
    },
  };
  return snapshot("moveAudioClip", `Move audio clip to bar ${bar + 1}`, doc, next);
}

/**
 * SLIP the clip's content (Pro Tools / Reaper semantics): shift WHICH part of
 * the source plays without moving or resizing the clip on the timeline.
 * Only `offsetSec` changes — trim windows, fades, gain and geometry stay, so
 * the user's trims are not dragged along with the content shift.
 *
 * `offsetSec` is clamped to ≥ 0; the caller (the drag gesture) owns the upper
 * bound via the loaded buffer's duration — same parameter-injection pattern
 * as splitAudioClipAtTick's sourceDuration, because commands are pure over
 * the document and cannot reach the sample bank. Non-finite input keeps the
 * clip's current offset (no-op history entry, the moveAudioClip pattern).
 */
export function slipAudioClip(doc: ProjectDocument, clipId: string, offsetSec: number): Command {
  const clip = (doc.arrangement.audioClips ?? []).find((c) => c.id === clipId);
  if (!clip) throw new Error(`AudioClip ${clipId} not found`);
  assertClipEditable(clip, "slip");
  const nextOffset = Number.isFinite(offsetSec) ? Math.max(0, offsetSec) : (clip.offsetSec ?? 0);
  if (nextOffset === (clip.offsetSec ?? 0)) return snapshot("slipAudioClip", "Slip audio clip (no-op)", doc, doc);
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      audioClips: (doc.arrangement.audioClips ?? []).map((c) =>
        c.id === clipId ? { ...c, offsetSec: nextOffset } : c,
      ),
    },
  };
  return snapshot("slipAudioClip", `Slip audio clip to ${nextOffset.toFixed(3)}s`, doc, next);
}

/**
 * Mute/unmute a SET of audio clips as ONE undoable entry (a clip selection
 * can mix both clip systems — arrangement clips are routed out here, audio
 * clips muted). `muted` clips are skipped by `audioClipsForPlayback`, so the
 * scheduler, the offline render and the live-editing resume all agree; the
 * doc-change sync de-click-cancels a muted clip that is currently sounding
 * and resumes an unmuted one spanning the playhead (liveEditSync).
 */
export function setAudioClipsMute(doc: ProjectDocument, clipIds: readonly string[], muted: boolean): Command {
  const ids = new Set(clipIds);
  // Canonical comparison: an UNmuted clip stores no `muted` key (undefined),
  // so a raw `!==` would treat undefined vs false as a change and push a
  // dead history entry for "unmute what is already unmuted".
  const changed = (doc.arrangement.audioClips ?? []).some((c) => ids.has(c.id) && (c.muted === true) !== muted);
  if (!changed) return snapshot("setAudioClipsMute", muted ? "Mute clips (no-op)" : "Unmute clips (no-op)", doc, doc);
  const count = (doc.arrangement.audioClips ?? []).filter((c) => ids.has(c.id)).length;
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      audioClips: (doc.arrangement.audioClips ?? []).map((c) => (ids.has(c.id) ? { ...c, muted: muted === true } : c)),
    },
  };
  return snapshot(
    "setAudioClipsMute",
    `${muted ? "Mute" : "Unmute"} ${count === 1 ? "1 audio clip" : `${count} audio clips`}`,
    doc,
    next,
  );
}

/**
 * TOGGLE for a mixed clip selection (the M key AND the context-menu item —
 * one home for the toggle semantics): any unmuted audio clip in the selection
 * mutes ALL selected audio clips; an all-muted selection unmutes. Arrangement
 * clips in the selection are ignored (scene clips gate via track mute).
 * Returns null when the selection holds no audio clips — callers skip
 * silently instead of pushing a no-op history entry.
 */
export function toggleAudioClipsMute(doc: ProjectDocument, clipIds: readonly string[]): Command | null {
  const audioIds = clipIds.filter((id) => (doc.arrangement.audioClips ?? []).some((c) => c.id === id));
  if (audioIds.length === 0) return null;
  const anyUnmuted = (doc.arrangement.audioClips ?? []).some((c) => audioIds.includes(c.id) && c.muted !== true);
  return setAudioClipsMute(doc, audioIds, anyUnmuted);
}

/**
 * Preview rate for Alt+drag clip stretching: the content scales with the
 * clip, so the rate follows the length ratio (longer clip = slower playback
 * = lower rate). Relative to the CURRENT rate — trims need no absolute
 * buffer math. Pure, clamped to the engine 0.25–4 gate.
 */
export function previewStretchRate(origRate: number, origLengthBars: number, newLengthBars: number): number {
  const base = Number.isFinite(origRate) && origRate > 0 ? origRate : 1;
  const from = Number.isFinite(origLengthBars) && origLengthBars > 0 ? origLengthBars : 1;
  const to = Number.isFinite(newLengthBars) && newLengthBars > 0 ? newLengthBars : from;
  return Math.round(Math.min(4, Math.max(0.25, (base * from) / to)) * 100) / 100;
}

/**
 * Alt+drag clip stretch: length AND rate in ONE undo step (the content keeps
 * filling the clip). Same length/fade clamps as resizeAudioClip plus the
 * 0.25–4 rate gate from updateAudioClip.
 */
export function stretchAudioClip(
  doc: ProjectDocument,
  clipId: string,
  lengthBars: number,
  stretchRate: number,
): Command {
  const clip = (doc.arrangement.audioClips ?? []).find((c) => c.id === clipId);
  if (!clip) throw new Error(`AudioClip ${clipId} not found`);
  assertClipEditable(clip, "stretch");
  if (!Number.isFinite(lengthBars)) return snapshot("stretchAudioClip", "Stretch audio clip (no-op)", doc, doc);
  const bars = Math.max(0.25, quantizeAudioBar(lengthBars));
  const rate = Number.isFinite(stretchRate) ? Math.round(Math.min(4, Math.max(0.25, stretchRate)) * 100) / 100 : 1;
  // Fades must stay inside the clip (clampClipFades) — same rule as resize.
  const { fadeIn, fadeOut } = clampClipFades(doc, clip, bars, clip.startBar);
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      audioClips: (doc.arrangement.audioClips ?? []).map((c) =>
        c.id === clipId ? { ...c, lengthBars: bars, stretchRate: rate, fadeIn, fadeOut } : c,
      ),
    },
  };
  return snapshot("stretchAudioClip", `Stretch audio clip to ${bars} bars (×${rate})`, doc, next);
}

export function resizeAudioClip(doc: ProjectDocument, clipId: string, lengthBars: number): Command {
  const clip = (doc.arrangement.audioClips ?? []).find((c) => c.id === clipId);
  if (!clip) throw new Error(`AudioClip ${clipId} not found`);
  assertClipEditable(clip, "resize");
  if (!Number.isFinite(lengthBars)) return snapshot("resizeAudioClip", "Resize audio clip (no-op)", doc, doc);
  const bars = Math.max(0.25, quantizeAudioBar(lengthBars));
  // Fades must stay inside the resized clip (audit §8): the engine clamps
  // audibly, but out-of-bounds state desyncs the fade handles from the
  // visual clip width.
  const { fadeIn, fadeOut } = clampClipFades(doc, clip, bars, clip.startBar);
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      audioClips: (doc.arrangement.audioClips ?? []).map((c) =>
        c.id === clipId ? { ...c, lengthBars: bars, fadeIn, fadeOut } : c,
      ),
    },
  };
  return snapshot("resizeAudioClip", `Resize audio clip to ${bars} bars`, doc, next);
}

/**
 * TRIM the start edge of an audio clip — ONE gesture, ONE undo entry.
 *
 * Trimming the left edge moves the source offset and shortens the clip at the
 * same time. Issuing `updateAudioClip` followed by `resizeAudioClip` produced
 * two history entries, so a single Ctrl+Z undid only the resize and left the
 * clip playing a different region of the sample at its original length.
 */
export function trimAudioClipStart(
  doc: ProjectDocument,
  clipId: string,
  patch: { lengthBars: number; trimStart: number; offsetSec: number },
): Command {
  const clip = (doc.arrangement.audioClips ?? []).find((c) => c.id === clipId);
  if (!clip) throw new Error(`AudioClip ${clipId} not found`);
  assertClipEditable(clip, "trim");
  const bars = Number.isFinite(patch.lengthBars) ? Math.max(0.25, quantizeAudioBar(patch.lengthBars)) : clip.lengthBars;
  const trimStart = Number.isFinite(patch.trimStart) ? Math.max(0, patch.trimStart) : clip.trimStart;
  const offsetSec = Number.isFinite(patch.offsetSec) ? Math.max(0, patch.offsetSec) : clip.offsetSec;
  // Fades must stay inside the trimmed clip (same rule as resizeAudioClip) or
  // the fade handles desync from the clip's visual width. Note `clip` is the
  // PARENT: the parent fadeIn rides along and has to be re-bounded by the
  // trimmed length.
  const { fadeIn, fadeOut } = clampClipFades(doc, clip, bars, clip.startBar);
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      audioClips: (doc.arrangement.audioClips ?? []).map((c) =>
        c.id === clipId
          ? {
              ...c,
              lengthBars: bars,
              trimStart,
              offsetSec,
              fadeIn,
              fadeOut,
            }
          : c,
      ),
    },
  };
  return snapshot("trimAudioClipStart", `Trim audio clip start to ${trimStart.toFixed(3)}s`, doc, next);
}
