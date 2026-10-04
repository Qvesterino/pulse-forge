import type { Command } from "./types";
import type {
  ArrangementClip,
  ArrangementTransition,
  ArrangementTransitionType,
  AudioClip,
  DrumPad,
  DrumTrack,
  GrooveSettings,
  Marker,
  NoteEvent,
  PatternAssist,
  ProjectDocument,
  Scene,
  SceneRole,
  StepMeta,
} from "../project-model/types";
import { BAR_TICKS, PPQ, STEP_TICKS } from "../project-model/types";
import { arrangementSecondsBetweenTicks, tempoAtTick } from "../project-model/scene-time";
import { buildStemProject } from "../rendering/stems";
import { withPad } from "../project-model/transform";
import { warpBufferTimeAtTick } from "../project-model/audio-clip-warp";
import { patternPhaseOffsetAtTick, sceneOffsetAtTick } from "../project-model/events";
import {
  createGroupTrackModel,
  createPatternForDoc,
  MAX_ARRANGEMENT_CLIP_BARS,
  MAX_BPM,
  MIN_BPM,
  normalizeProject,
  sceneRoleOf,
  clampArrangementTransitionType,
  sanitizeArrangementTransitions,
} from "../project-model/schema";
import { sanitizeGateSteps, sanitizeManglerSteps } from "../project-model/modulators";
import type { Pattern } from "../project-model/types";
import { clampEffectParam, defaultParamsOf, EFFECT_META, normalizePluginParams } from "../effects/definitions";
import { type EffectPreset } from "../effects/presets";
import { clampFxOutputTrimDb, factoryFxPresetGainDb } from "../effects/presetLoudness";
import { uid } from "../shared/ids";
import type { SharedPackSceneSketch, SharedPackSketch } from "../export/packCode";
import { resolveGrooveForGeneration } from "../ai/generator";
import { generateLocalResultFromOptions } from "../intent/pipeline";
import type { GenerationResult } from "../intent/types";
import type { GenerateOptions } from "../ai/types";
import { buildAssistPatch, normalizeAssistRequest } from "../assist/pipeline";
import { ASSIST_ENGINE_ID, ASSIST_ENGINE_VERSION, type AssistInput } from "../assist/types";
import { canonicalizePattern, contentHash } from "../ai/evaluation";

// The command engine lives in this folder, split by domain. `core` holds
// snapshot() and the dev-freeze guard; every domain module sits above it.
// This file stays the single public entry point, so the ~199 modules that
// import it keep working against an unchanged surface.
import { snapshot } from "./core";
// The effect/intent layers below still drive the master bus; the command itself lives in ./master.
// The intent/production layer below still drives project-level settings and pads from their own
// module now; the commands themselves live in ./project.
import { type PadSlice, sliceToPads } from "./project";
// The intent layer below still applies groove settings; the command itself lives in ./groove.
// docOps is plumbing shared by several domains and is NOT re-exported wholesale; only the one
// name that was already public goes back out, so the barrel's surface is unchanged.
import { cloneStepMeta, trackEffectsOf, unlinkMarkersOfClips, withTrackEffects } from "./docOps";
export { __resetSnapshotVerificationFallbacks, __snapshotVerificationFallbacks, snapshot } from "./core";
export { trackEffectsOf } from "./docOps";

export * from "./freeze";
export * from "./instrument";
export * from "./automation";
export * from "./master";
export * from "./notes";
export * from "./quantize";
export * from "./plugins";
export * from "./project";
export * from "./groove";
export * from "./patterns";
export * from "./arrangement";
export * from "./markers";
export * from "./metadata";
// The clip layers below read the project key when they rebuild a stem set, so this one needs a
// local binding — a re-export would not give the barrel body the name.
export * from "./clipPlayback";
export * from "./sceneAutomation";
export * from "./effectInstances";
// NOT `export *`: foldProductionIntent is exported from ./intentRouting for the barrel body and for
// effectParams, and a star re-export would publish it — the surface would be 234 names, not 233.
export {
  applyExactIntentCommand,
  applyProductionIntentCommand,
  applyProductionIntentToTrackCommand,
  exactReadback,
  foldFxIntoDoc,
  resolveExactTargetTracks,
} from "./intentRouting";
// The clip layers below fold production FX chains onto a ghost document, so this one needs a local
// binding — and it is imported, not re-exported, because it was internal before the split.
import { foldProductionIntent } from "./intentRouting";
export * from "./effectParams";
// The clip layers below read the transition list between neighbours, so this one needs a local
// binding — a re-export would not give the barrel body the name.
// NOT `export *`: makeSceneVariation is exported from ./scenes for the arrangement layer, and a
// star re-export would publish it — the surface would be 234 names instead of 233.
export {
  createScene,
  deleteScene,
  duplicateSceneAsVariation,
  renameScene,
  reorderScenes,
  setScenePattern,
  setSceneRole,
} from "./scenes";
// The arrangement layer below builds a scene variation and places it on the timeline, so it needs
// a local binding — a re-export would not give the barrel body the name either way.
// The arrangement/clip layers below resize patterns directly, so this one needs a local binding —
// a bare re-export would not give the barrel body the name.
export {
  addEffect,
  addEffectToTracks,
  addToGroup,
  clearAllMutes,
  clearAllSolos,
  countReferenceCleanups,
  createDrumTrack,
  createGenerativeTrack,
  createGroupTrack,
  createInstrumentTrack,
  createReturnTrack,
  deleteTrack,
  duplicateTrack,
  removeEffectFromTracks,
  removeFromGroup,
  setEffectBypassOnTracks,
  setGenerativeTrackConfig,
  setGroupCollapsed,
  setGroupMute,
  setGroupSolo,
  setPadColor,
  setPadLoop,
  setTrackColor,
} from "./tracks";
// Type-only re-export: isolatedModules forbids smiešanie typov do hodnotového zozname vyššie.
export type { GenerativeTrackConfigPatch } from "./tracks";

/* ---------------- audioClips ---------------- */

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
    startBar: Math.max(0, Math.round(finiteOr(startBar, 0) * 100) / 100),
    lengthBars: Math.max(0.25, Math.round(finiteOr(lengthBars, 4) * 100) / 100),
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
  // Markers linked to the deleted clip are unlinked in-command (same contract
  // as deleteArrangementClip) so no stale linkedClipId survives in saves.
  const unlinked = unlinkMarkersOfClips(doc.markers, new Set([clipId]));
  const next: ProjectDocument = {
    ...doc,
    ...(unlinked !== undefined ? { markers: unlinked } : {}),
    arrangement: {
      ...doc.arrangement,
      audioClips: (doc.arrangement.audioClips ?? []).filter((c) => c.id !== clipId),
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
  if (!Number.isFinite(startBar)) return snapshot("moveAudioClip", "Move audio clip (no-op)", doc, doc);
  const bar = Math.max(0, Math.round(startBar * 100) / 100);
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
  if (!Number.isFinite(lengthBars)) return snapshot("stretchAudioClip", "Stretch audio clip (no-op)", doc, doc);
  const bars = Math.max(0.25, Math.round(lengthBars * 100) / 100);
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
  if (!Number.isFinite(lengthBars)) return snapshot("resizeAudioClip", "Resize audio clip (no-op)", doc, doc);
  const bars = Math.max(0.25, Math.round(lengthBars * 100) / 100);
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
  const bars = Number.isFinite(patch.lengthBars)
    ? Math.max(0.25, Math.round(patch.lengthBars * 100) / 100)
    : clip.lengthBars;
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

/**
 * "Steal the groove": bake an extracted loop-groove map into a pattern.
 * Every ACTIVE step gets the loop's microtiming shift; with `applyVelocity`
 * the step velocity is also scaled by the loop's accent (steps the loop was
 * silent on keep their original velocity). Locks, probability and ratchets
 * are preserved — only timing/velocity fields are touched.
 */
export function stealGrooveIntoPattern(
  doc: ProjectDocument,
  patternId: string,
  map: { timing: number[]; accent: number[] },
  options: { applyVelocity?: boolean } = {},
): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  if (!map.timing.length || !map.accent.length || map.timing.length !== map.accent.length) {
    throw new Error("Invalid groove map");
  }
  const steps = pattern.stepCount;
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const timingAt = (step: number) => map.timing[((step % map.timing.length) + map.timing.length) % map.timing.length];
  const accentAt = (step: number) => map.accent[((step % map.accent.length) + map.accent.length) % map.accent.length];

  const rows: Pattern["rows"] = {};
  const stepMeta: Pattern["stepMeta"] = {};
  let touched = 0;
  for (const pad of doc.tracks.filter((t): t is DrumTrack => t.kind === "drum").flatMap((t) => t.pads)) {
    const row = pattern.rows[pad.id];
    if (!row) continue;
    const nextRow = [...row];
    const padMeta = pattern.stepMeta?.[pad.id];
    let padTouched = false;
    for (let step = 0; step < steps; step++) {
      if ((row[step] ?? 0) <= 0) continue;
      const timing = Math.max(-1, Math.min(1, timingAt(step)));
      const accent = accentAt(step);
      const meta = padMeta?.[step] ?? {};
      stepMeta[pad.id] = { ...(stepMeta[pad.id] ?? {}), [step]: { ...meta, microtiming: timing } };
      if (options.applyVelocity && accent > 0) {
        nextRow[step] = clamp01((row[step] ?? 0) * (0.4 + 0.6 * accent));
      }
      padTouched = true;
      touched += 1;
    }
    if (padTouched) rows[pad.id] = nextRow;
  }
  if (touched === 0) throw new Error("Pattern has no active steps to groove");

  const next: ProjectDocument = {
    ...doc,
    patterns: doc.patterns.map((p) =>
      p.id === patternId ? { ...p, rows: { ...p.rows, ...rows }, stepMeta: { ...p.stepMeta, ...stepMeta } } : p,
    ),
  };
  return snapshot("stealGrooveIntoPattern", `Steal groove → ${touched} steps`, doc, next);
}

// ── User kits — pad mappings as first-class, shareable objects ─────────────

export interface KitPadCapture {
  idx: number;
  assetId: string | null;
  synth?: DrumTrack["pads"][number]["synth"] | null;
  gain?: number;
  pan?: number;
  chokeGroup?: number | null;
  pitch?: number;
}

/** Read a drum track's pad mapping into a portable kit object. */
export function captureKitFromTrack(doc: ProjectDocument, trackId: string): KitPadCapture[] {
  const track = doc.tracks.find((t): t is DrumTrack => t.kind === "drum" && t.id === trackId);
  if (!track) throw new Error(`Drum track ${trackId} not found`);
  return track.pads.map((pad, idx) => ({
    idx,
    assetId: pad.assetId ?? null,
    synth: pad.synth ?? null,
    gain: pad.gain,
    pan: pad.pan,
    chokeGroup: pad.chokeGroup ?? null,
    pitch: pad.pitch ?? 0,
  }));
}

/**
 * Apply a kit's pad mapping onto a drum track (one undo entry). Pads with
 * `assetId: null` in the kit keep their current sample; everything else
 * (sample, synth, gain, pan, choke, pitch) is replaced.
 */
export function applyKitToDrumTrack(
  doc: ProjectDocument,
  trackId: string,
  kitName: string,
  pads: KitPadCapture[],
): Command {
  const track = doc.tracks.find((t): t is DrumTrack => t.kind === "drum" && t.id === trackId);
  if (!track) throw new Error(`Drum track ${trackId} not found`);
  const byIdx = new Map(pads.map((p) => [p.idx, p]));
  const next: ProjectDocument = {
    ...doc,
    tracks: doc.tracks.map((t) => {
      if (t.id !== trackId || t.kind !== "drum") return t;
      const drum = t as DrumTrack;
      return {
        ...drum,
        pads: drum.pads.map((pad, idx) => {
          const k = byIdx.get(idx);
          if (!k || k.assetId === null) return pad;
          return {
            ...pad,
            assetId: k.assetId,
            synth: k.synth ?? null,
            gain: k.gain ?? pad.gain,
            pan: k.pan ?? pad.pan,
            chokeGroup: k.chokeGroup ?? pad.chokeGroup,
            pitch: k.pitch ?? pad.pitch ?? 0,
          };
        }),
      };
    }),
  };
  return snapshot("applyKitToDrumTrack", `Apply kit "${kitName}"`, doc, next);
}

// ── Pack sketch — the arrangement half of a PFPACK bundle ──────────────────

const SKETCH_SCENE_LIMIT = 16;
const SKETCH_CLIP_LIMIT = 64;
const SKETCH_VELOCITY_STEPS = 15;

function hexRowOf(row: number[] | undefined, steps: number): string | null {
  if (!row) return null;
  let out = "";
  for (let i = 0; i < steps; i++) {
    const v = Math.round(Math.min(1, Math.max(0, row[i] ?? 0)) * SKETCH_VELOCITY_STEPS);
    out += v.toString(16);
  }
  return /[^0]/.test(out) ? out : null;
}

/**
 * Capture the arrangement side of the current project as a portable sketch:
 * scenes become drum rows keyed by the kit track's PAD INDEX (so the sketch
 * replays through any installed kit), plus the timeline clip layout and bpm.
 */
export function captureSketchFromDoc(doc: ProjectDocument, trackId: string): SharedPackSketch | undefined {
  const track = doc.tracks.find((t): t is DrumTrack => t.kind === "drum" && t.id === trackId);
  if (!track) throw new Error(`Drum track ${trackId} not found`);
  const scenes = doc.scenes.slice(0, SKETCH_SCENE_LIMIT);
  if (scenes.length === 0) return undefined;
  const padIds = track.pads.map((p) => p.id);
  const sketchScenes: SharedPackSceneSketch[] = [];
  const sceneIndexByScene = new Map<string, number>();
  scenes.forEach((scene) => {
    const pattern = doc.patterns.find((p) => p.id === scene.patternId);
    if (!pattern) return;
    const rows: string[] = [];
    padIds.forEach((padId) => {
      const hex = hexRowOf(pattern.rows[padId], pattern.stepCount);
      if (hex) rows.push(hex);
    });
    if (rows.length === 0) return;
    sceneIndexByScene.set(scene.id, sketchScenes.length);
    sketchScenes.push({
      name: scene.name.slice(0, 40),
      role: scene.role,
      intensity: scene.intensity,
      steps: Math.min(64, Math.max(1, pattern.stepCount)),
      rows,
    });
  });
  if (sketchScenes.length === 0) return undefined;
  const clips: SharedPackSketch["clips"] = [];
  for (const clip of doc.arrangement.clips) {
    const scene = sceneIndexByScene.get(clip.sceneId);
    if (scene === undefined) continue;
    clips.push({ scene, startBar: clip.startBar, lengthBars: clip.lengthBars });
    if (clips.length >= SKETCH_CLIP_LIMIT) break;
  }
  return { bpm: doc.bpm, scenes: sketchScenes, clips };
}

const SKETCH_ROLE_SET = new Set<string>(["intro", "build", "drop", "break", "outro", "fill", "custom"]);

/**
 * Install a pack sketch against a drum track: creates one pattern per scene
 * (rows mapped pad-index → this track's pads), matching scenes and the
 * arrangement clips — all in ONE command so undo removes the whole import.
 */
export function installPackSketch(doc: ProjectDocument, trackId: string, sketch: SharedPackSketch): Command | null {
  const track = doc.tracks.find((t): t is DrumTrack => t.kind === "drum" && t.id === trackId);
  if (!track) return null;
  if (!sketch.scenes.length) return null;
  const drumPadIds = doc.tracks
    .filter((t): t is DrumTrack => t.kind === "drum")
    .flatMap((t) => t.pads.map((p) => p.id));
  const emptyRow = (steps: number) => new Array<number>(steps).fill(0);

  const patterns: Pattern[] = [];
  const scenes: Scene[] = [];
  const sceneIdByIndex: string[] = [];
  const stamp = Date.now().toString(36);
  sketch.scenes.forEach((sc, index) => {
    const steps = Math.min(64, Math.max(1, Math.round(sc.steps)));
    const patternId = uid(`psk-${stamp}`);
    const rows: Pattern["rows"] = {};
    for (const padId of drumPadIds) rows[padId] = emptyRow(steps);
    sc.rows.forEach((hex, padIdx) => {
      const pad = track.pads[padIdx];
      if (!pad) return;
      const row = rows[pad.id];
      for (let step = 0; step < Math.min(steps, hex.length); step++) {
        const v = parseInt(hex[step], 16);
        if (v > 0) row[step] = Math.min(1, v / SKETCH_VELOCITY_STEPS);
      }
    });
    patterns.push({
      id: patternId,
      name: sc.name || `Sketch ${index + 1}`,
      stepCount: steps,
      rows,
      notes: {},
    });
    const sceneId = uid(`ssk-${stamp}`);
    sceneIdByIndex.push(sceneId);
    scenes.push({
      id: sceneId,
      name: sc.name || `Sketch ${index + 1}`,
      patternId,
      intensity: typeof sc.intensity === "number" ? Math.min(1, Math.max(0, sc.intensity)) : 0.7,
      role: sc.role && SKETCH_ROLE_SET.has(sc.role) ? (sc.role as SceneRole) : undefined,
    });
  });
  if (patterns.length === 0) return null;

  const endBar = doc.arrangement.clips.reduce((max, c) => Math.max(max, c.startBar + c.lengthBars), 0);
  const clips: ArrangementClip[] = [];
  for (const c of sketch.clips) {
    const sceneId = sceneIdByIndex[c.scene];
    if (!sceneId) continue;
    clips.push({
      id: uid(`csk-${stamp}`),
      sceneId,
      startBar: endBar + c.startBar,
      lengthBars: c.lengthBars,
    });
  }

  const next: ProjectDocument = {
    ...doc,
    bpm: typeof sketch.bpm === "number" ? Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(sketch.bpm))) : doc.bpm,
    patterns: [...doc.patterns, ...patterns],
    scenes: [...doc.scenes, ...scenes],
    arrangement: clips.length ? { ...doc.arrangement, clips: [...doc.arrangement.clips, ...clips] } : doc.arrangement,
  };
  return snapshot("installPackSketch", `Install sketch (${patterns.length} scenes)`, doc, next);
}

export function updateAudioClip(
  doc: ProjectDocument,
  clipId: string,
  patch: Partial<
    Pick<
      AudioClip,
      | "offsetSec"
      | "trimStart"
      | "trimEnd"
      | "gain"
      | "fadeIn"
      | "fadeOut"
      | "stretchRate"
      | "stretchMode"
      | "reverse"
      | "loop"
      | "bufferId"
      | "warpMarkers"
    >
  > & { sourceChannel?: number | null },
): Command {
  const clip = (doc.arrangement.audioClips ?? []).find((c) => c.id === clipId);
  if (!clip) throw new Error(`AudioClip ${clipId} not found`);
  // sanitizeAudioClips drops non-finite numbers on load; match that here so a
  // NaN patch (parse bug in a caller) can never poison the in-memory doc —
  // a NaN stretchRate would throw inside the scheduler's audio window.
  const num = (value: number | undefined, min: number, max: number): number | undefined =>
    value === undefined || !Number.isFinite(value) ? undefined : Math.min(max, Math.max(min, value));
  const nextPatch: Partial<AudioClip> = {};
  if (patch.bufferId !== undefined) nextPatch.bufferId = patch.bufferId;
  if (patch.sourceChannel === null) nextPatch.sourceChannel = undefined;
  else if (Number.isSafeInteger(patch.sourceChannel) && patch.sourceChannel! >= 0 && patch.sourceChannel! < 32) {
    nextPatch.sourceChannel = patch.sourceChannel!;
  }
  const offsetSec = num(patch.offsetSec, 0, Infinity);
  if (offsetSec !== undefined) nextPatch.offsetSec = offsetSec;
  const trimStart = num(patch.trimStart, 0, Infinity);
  if (trimStart !== undefined) nextPatch.trimStart = trimStart;
  const trimEnd = num(patch.trimEnd, 0, Infinity);
  if (trimEnd !== undefined) nextPatch.trimEnd = trimEnd;
  const gain = num(patch.gain, 0, 2);
  if (gain !== undefined) nextPatch.gain = gain;
  const clipDurSec = audioClipDurationSec(doc, clip.lengthBars, clip.startBar);
  const fadeIn = num(patch.fadeIn, 0, clipDurSec);
  if (fadeIn !== undefined) nextPatch.fadeIn = fadeIn;
  const fadeOut = num(patch.fadeOut, 0, clipDurSec);
  if (fadeOut !== undefined) nextPatch.fadeOut = fadeOut;
  const stretchRate = num(patch.stretchRate, 0.25, 4);
  if (stretchRate !== undefined) nextPatch.stretchRate = stretchRate;
  if (patch.stretchMode !== undefined) nextPatch.stretchMode = patch.stretchMode;
  if (patch.warpMarkers !== undefined) {
    // Clone, never store the caller's array: addAudioClip/duplicateAudioClip
    // deep-copy warp pins, and a shared reference here would let a later
    // in-place edit of the caller's array silently rewrite stored history.
    nextPatch.warpMarkers = patch.warpMarkers.map((m) => ({ timeSec: m.timeSec, tick: m.tick }));
  }
  if (patch.reverse !== undefined) nextPatch.reverse = patch.reverse === true;
  if (patch.loop !== undefined) {
    nextPatch.loop = patch.loop === true;
    if (patch.loop !== true) nextPatch.loopPhaseOffsetSec = undefined;
  }
  if (patch.reverse === true) nextPatch.loopPhaseOffsetSec = undefined;
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      audioClips: (doc.arrangement.audioClips ?? []).map((c) => (c.id === clipId ? { ...c, ...nextPatch } : c)),
    },
  };
  return snapshot("updateAudioClip", "Edit audio clip", doc, next);
}

/**
 * Fit a loop clip to the project tempo: pitch-preserving time-stretch with
 * rate = detected loop BPM / project BPM, so the loop locks to the grid
 * while keeping its pitch. Warp markers are left untouched — they describe
 * the source material, not the playback rate.
 */
export interface FittedLoopPlacement {
  /** Whole bars the loop spans at its detected tempo. */
  lengthBars: number;
  /** Pitch-preserving rate locking detected → project tempo (0.25–4 gate). */
  rate: number;
}

/**
 * "Fit to N bars" math for freshly imported loops: whole-bar length from the
 * loop's own duration + detected tempo, plus the fitAudioClipTempo rate.
 * Null when there is nothing musical to fit (no detection, bad numbers).
 * Pure — shared by the DropZone offer and any future place-fitted flow.
 */
export function fittedLoopPlacement(
  durationSec: number,
  detectedBpm: number | undefined,
  projectBpm: number,
  beatsPerBar = 4,
): FittedLoopPlacement | null {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  if (detectedBpm === undefined || !Number.isFinite(detectedBpm) || detectedBpm < 40 || detectedBpm > 240) return null;
  if (!Number.isFinite(projectBpm) || projectBpm <= 0) return null;
  if (!Number.isFinite(beatsPerBar) || beatsPerBar < 1) return null;
  const lengthBars = Math.max(1, Math.round((durationSec * detectedBpm) / 60 / beatsPerBar));
  const rate = Math.round(Math.min(4, Math.max(0.25, detectedBpm / projectBpm)) * 100) / 100;
  return { lengthBars, rate };
}

export function fitAudioClipTempo(doc: ProjectDocument, clipId: string, detectedBpm: number): Command {
  const clip = (doc.arrangement.audioClips ?? []).find((c) => c.id === clipId);
  if (!clip) throw new Error(`AudioClip ${clipId} not found`);
  if (!Number.isFinite(detectedBpm) || detectedBpm < 40 || detectedBpm > 240) {
    throw new Error(`Detected tempo ${detectedBpm} out of range — refusing to fit`);
  }
  // Fit against the tempo the transport ACTUALLY runs at the clip — its
  // covering scene's BPM pin — not flat doc.bpm. Fitting to the project tempo
  // under a pinned scene left the loop locked to a clock nothing plays at.
  const targetBpm = tempoAtTick(doc.arrangement.clips, doc.scenes, clip.startBar * BAR_TICKS, doc.bpm);
  const rate = Math.round(Math.min(4, Math.max(0.25, detectedBpm / targetBpm)) * 100) / 100;
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      audioClips: (doc.arrangement.audioClips ?? []).map((c) =>
        c.id === clipId ? { ...c, stretchMode: "stretch", stretchRate: rate } : c,
      ),
    },
  };
  return snapshot("fitAudioClipTempo", `Fit loop ${Math.round(detectedBpm)}→${targetBpm} BPM (×${rate})`, doc, next);
}

/**
 * Slice an audio clip into multiple clips at given time positions.
 * `sliceTimesSec` are WALL seconds measured from the clip's first audible
 * moment (0 = clip start). Each segment becomes a separate AudioClip in the
 * arrangement, positioned sequentially after the original.
 * SlicerX/PT-style: transient → clip row.
 */
export function sliceAudioClipToArrangement(doc: ProjectDocument, clipId: string, sliceTimesSec: number[]): Command {
  const clip = (doc.arrangement.audioClips ?? []).find((c) => c.id === clipId);
  if (!clip) throw new Error(`AudioClip ${clipId} not found`);
  if (sliceTimesSec.length === 0) throw new Error("No slice points provided");
  if (clip.reverse === true) throw new Error("Slice is not supported on reversed clips");
  if (clip.loop === true) throw new Error("Slice is not supported on looping clips");
  const startTick = clip.startBar * BAR_TICKS;
  const endTick = startTick + clip.lengthBars * BAR_TICKS;
  // Same discipline as splitAudioClipAtTick: wall math at the scene-pinned
  // tempo (not doc.bpm), source advance per wall second = rate (resample) or
  // 1/rate (pitch-preserving stretch), and the window base is
  // offsetSec + trimStart — dropping trimStart made every slice play the
  // wrong region of a start-trimmed clip.
  const wallDurSec = arrangementSecondsBetweenTicks(doc.arrangement.clips, doc.scenes, startTick, endTick, doc.bpm);
  const spt = 60 / (tempoAtTick(doc.arrangement.clips, doc.scenes, startTick, doc.bpm) * PPQ);
  const rate = Math.min(4, Math.max(0.25, clip.stretchRate ?? 1));
  const preservingStretch = clip.stretchMode === "stretch" && Math.abs(rate - 1) >= 0.01;
  const sourcePerWall = preservingStretch ? 1 / rate : rate;
  const sourceStart = (clip.offsetSec ?? 0) + (clip.trimStart ?? 0);
  // Build segments in wall seconds: [0, t1), [t1, t2), ..., [last, end)
  const sorted = [...sliceTimesSec].filter((t) => Number.isFinite(t) && t > 0 && t < wallDurSec).sort((a, b) => a - b);
  const ends = [...sorted, wallDurSec];
  const starts = [0, ...sorted];
  const segments: Array<{ startSec: number; endSec: number }> = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const e = ends[i];
    if (e - s > 0.03) segments.push({ startSec: s, endSec: e });
  }
  if (segments.length < 2) throw new Error("Slices too short or too few");
  // Position segments sequentially after original clip's end. Advance by the
  // STORED (rounded) length so repeated slices never drift onto each other.
  const originalEndBar = clip.startBar + clip.lengthBars;
  const newClips: AudioClip[] = [];
  let currentBar = Math.round((originalEndBar + 0.5) * 100) / 100;
  for (const seg of segments) {
    const segWallSec = seg.endSec - seg.startSec;
    const segBars = Math.max(0.25, segWallSec / (spt * BAR_TICKS));
    const storedBars = Math.round(segBars * 100) / 100;
    // A slice is typically far shorter than the clip it came from, so the
    // parent's fades are re-bounded by the slice's own STORED length, at the
    // tempo where the slice actually sits.
    const { fadeIn, fadeOut } = clampClipFades(doc, clip, storedBars, currentBar);
    newClips.push({
      ...clip,
      id: uid("audioClip"),
      startBar: currentBar,
      lengthBars: storedBars,
      offsetSec: Math.max(0, sourceStart + seg.startSec * sourcePerWall),
      trimStart: 0,
      trimEnd: 0,
      fadeIn,
      fadeOut,
      warpMarkers: undefined,
    });
    currentBar = Math.round((currentBar + storedBars + 0.25) * 100) / 100;
  }
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      audioClips: [...(doc.arrangement.audioClips ?? []), ...newClips].sort((a, b) => a.startBar - b.startBar),
    },
  };
  return snapshot("sliceAudioClipToArrangement", `Slice clip → ${newClips.length} segments`, doc, next);
}

export function duplicateAudioClip(doc: ProjectDocument, clipId: string): Command {
  const clip = (doc.arrangement.audioClips ?? []).find((c) => c.id === clipId);
  if (!clip) throw new Error(`AudioClip ${clipId} not found`);
  // OVERLAP CONTRACT (audit §13): the two clip systems intentionally differ.
  // AudioClips LAYER — the engine sums every clip into its track input, and
  // add/move/resize allow free placement — so the copy lands EXACTLY after
  // its source and may overlap neighbouring clips like any moved clip would.
  // (The old forward-bump here was copied from the arrangement-clip system,
  // which IS no-overlap: moveArrangementClip/duplicateArrangementClip
  // enforce it. Bumping silently teleported audio duplicates across busy
  // tracks — unpredictable placement.) Arrangement clips keep no-overlap.
  const startBar = clip.startBar + clip.lengthBars;
  const copy: AudioClip = {
    ...clip,
    id: uid("audioClip"),
    startBar,
    ...(clip.warpMarkers ? { warpMarkers: clip.warpMarkers.map((m) => ({ ...m })) } : {}),
  };
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      audioClips: [...(doc.arrangement.audioClips ?? []), copy].sort((a, b) => a.startBar - b.startBar),
    },
  };
  return snapshot("duplicateAudioClip", "Duplicate audio clip", doc, next);
}

export function bounceStemsToAudioClip(
  doc: ProjectDocument,
  trackIds: string[],
  startBar: number,
  lengthBars: number,
  bufferId: string,
): Command {
  // Guardrail: use buildStemProject so grouped FX are preserved in the future freeze render
  const stemDoc = buildStemProject(doc, (t) => trackIds.includes(t.id));
  void stemDoc;
  if (trackIds.length === 0) throw new Error("Select at least one track to bounce");
  if (!bufferId) throw new Error("bufferId required for bounced clip");
  // Use first track as destination (or first selected)
  const trackId = trackIds[0];
  return addAudioClip(doc, trackId, bufferId, startBar, lengthBars, { gain: 1, stretchRate: 1 });
}

export function splitAudioClipAtTick(
  doc: ProjectDocument,
  clipId: string,
  splitTick: number,
  /** Decoded source duration enables exact split-window preservation for warped clips. */
  sourceDurationSec?: number,
): Command {
  return splitAudioClipAtTickWithMinimumFragment(doc, clipId, splitTick, sourceDurationSec, 0.05);
}

function splitAudioClipAtTickWithMinimumFragment(
  doc: ProjectDocument,
  clipId: string,
  splitTick: number,
  sourceDurationSec: number | undefined,
  minimumFragmentBars: number,
): Command {
  const clip = (doc.arrangement.audioClips ?? []).find((c) => c.id === clipId);
  if (!clip) throw new Error(`AudioClip ${clipId} not found`);
  if (!Number.isFinite(splitTick)) throw new Error("Split point must be a finite arrangement tick");
  if (!Number.isFinite(minimumFragmentBars) || minimumFragmentBars < 0) {
    throw new Error("Minimum split fragment must be a finite non-negative bar length");
  }
  const startTick = clip.startBar * BAR_TICKS;
  const endTick = startTick + clip.lengthBars * BAR_TICKS;
  if (splitTick <= startTick || splitTick >= endTick) throw new Error("Split point outside clip");
  const leftBars = (splitTick - startTick) / BAR_TICKS;
  const rightBars = clip.lengthBars - leftBars;
  if (leftBars < minimumFragmentBars || rightBars < minimumFragmentBars) throw new Error("Split too close to edge");
  // Piecewise bars→seconds at the scenes' effective tempos: the scheduler runs
  // each arrangement span at its scene's BPM pin (gaps at the project tempo),
  // so a split under a pinned scene must consume source at THAT tempo. Plain
  // doc.bpm math wrote the right half's offsetSec against a wall clock the
  // transport never ran at — the split point skipped or repeated source.
  // secondsPerTick stays for the warp branch, whose mapping the engine derives
  // from the clip's start tempo (triggerEngine's clipDurSec/clipTicks).
  const leftSec = arrangementSecondsBetweenTicks(doc.arrangement.clips, doc.scenes, startTick, splitTick, doc.bpm);
  const rightSec = arrangementSecondsBetweenTicks(doc.arrangement.clips, doc.scenes, splitTick, endTick, doc.bpm);
  const secondsPerTick = 60 / (tempoAtTick(doc.arrangement.clips, doc.scenes, startTick, doc.bpm) * PPQ);
  const rate = Math.min(4, Math.max(0.25, clip.stretchRate ?? 1));
  const preservingStretch = clip.stretchMode === "stretch" && Math.abs(rate - 1) >= 0.01;
  const sourceSecondsPerWallSecond = preservingStretch ? 1 / rate : rate;
  const leftSourceSec = leftSec * sourceSecondsPerWallSecond;
  const rightSourceSec = rightSec * sourceSecondsPerWallSecond;
  const rightOffset = (clip.offsetSec ?? 0) + (clip.trimStart ?? 0) + leftSourceSec;
  const reverseLeftOffset = (clip.offsetSec ?? 0) + rightSourceSec;
  const sourceStartSec = (clip.offsetSec ?? 0) + (clip.trimStart ?? 0);
  const sourceEndSec =
    Number.isFinite(sourceDurationSec) && sourceDurationSec! > 0 ? sourceDurationSec! - (clip.trimEnd ?? 0) : NaN;
  const hasInRangeWarpMarker =
    clip.reverse !== true &&
    clip.loop !== true &&
    (clip.warpMarkers ?? []).some(
      (marker) =>
        Number.isFinite(marker.timeSec) &&
        Number.isFinite(marker.tick) &&
        marker.tick >= startTick &&
        marker.tick <= endTick,
    );
  const warpSplitTimeSec =
    hasInRangeWarpMarker &&
    Number.isFinite(sourceStartSec) &&
    Number.isFinite(sourceEndSec) &&
    sourceEndSec > sourceStartSec
      ? warpBufferTimeAtTick({
          markers: clip.warpMarkers ?? [],
          clipStartTick: startTick,
          clipTicks: endTick - startTick,
          tick: splitTick,
          spt: secondsPerTick,
          contentStartSec: sourceStartSec,
          contentDurSec: sourceEndSec - sourceStartSec,
          stretchRate: clip.stretchRate,
          stretchMode: clip.stretchMode,
        })
      : null;
  const preserveWarpAcrossSplit =
    warpSplitTimeSec !== null &&
    Number.isFinite(warpSplitTimeSec) &&
    warpSplitTimeSec >= sourceStartSec &&
    warpSplitTimeSec <= sourceEndSec;
  const leftId = uid("audioClip");
  const rightId = uid("audioClip");
  // Preserve the split's fractional-tick position. Rounding bars to 0.01
  // moved the timeline edge and accumulated source-offset drift on repeated
  // edits. Tiny fades suppress a discontinuity without changing the source
  // window or the exact adjacent timeline boundary.
  const rightStartBar = splitTick / BAR_TICKS;
  const leftLength = rightStartBar - clip.startBar;
  const rightLength = clip.startBar + clip.lengthBars - rightStartBar;
  const splitDeclickFadeSec = 0.003;
  const copyWarps = () => (clip.warpMarkers ? { warpMarkers: clip.warpMarkers.map((m) => ({ ...m })) } : {});
  const splitWarpMarkers = (fromTick: number, toTick: number): AudioClip["warpMarkers"] => {
    if (!preserveWarpAcrossSplit || warpSplitTimeSec === null) return undefined;
    return [
      ...(clip.warpMarkers ?? [])
        .filter((marker) => Number.isFinite(marker.timeSec) && Number.isFinite(marker.tick))
        .filter((marker) => marker.tick >= fromTick && marker.tick <= toTick && marker.tick !== splitTick)
        .map((marker) => ({ ...marker })),
      { timeSec: warpSplitTimeSec, tick: splitTick },
    ].sort((a, b) => a.tick - b.tick);
  };
  const leftWarpMarkers = splitWarpMarkers(startTick, splitTick);
  const rightWarpMarkers = splitWarpMarkers(splitTick, endTick);
  // Each fragment is bounded by its OWN length, not the parent's: the left
  // fragment keeps the parent's fadeIn and the right keeps the parent's
  // fadeOut, and either fragment can be arbitrarily shorter than the clip it
  // came from. Without this a 4s fadeIn survives on a 0.1s left fragment.
  const leftFades = clampClipFades(doc, clip, leftLength, clip.startBar);
  const rightFades = clampClipFades(doc, clip, rightLength, rightStartBar);
  const leftClip: import("../project-model/types").AudioClip = {
    ...clip,
    ...(leftWarpMarkers ? { warpMarkers: leftWarpMarkers } : copyWarps()),
    id: leftId,
    lengthBars: leftLength,
    ...(clip.reverse && !preserveWarpAcrossSplit ? { offsetSec: reverseLeftOffset } : {}),
    ...(clip.loop === true && !clip.reverse ? { loopPhaseOffsetSec: clip.loopPhaseOffsetSec ?? 0 } : {}),
    ...(preserveWarpAcrossSplit && sourceDurationSec !== undefined && warpSplitTimeSec !== null
      ? { trimEnd: sourceDurationSec - warpSplitTimeSec }
      : {}),
    // Declick fade is applied last so the split seam is still suppressed, but
    // bounded by the fragment's own duration like any other fade.
    fadeIn: leftFades.fadeIn,
    fadeOut: Math.min(splitDeclickFadeSec, audioClipDurationSec(doc, leftLength, clip.startBar)),
  };
  const rightClip: import("../project-model/types").AudioClip = {
    ...clip,
    ...(rightWarpMarkers ? { warpMarkers: rightWarpMarkers } : copyWarps()),
    id: rightId,
    startBar: rightStartBar,
    lengthBars: rightLength,
    offsetSec: preserveWarpAcrossSplit
      ? warpSplitTimeSec!
      : clip.reverse || clip.loop === true
        ? clip.offsetSec
        : Math.max(0, rightOffset - (clip.trimStart ?? 0)),
    ...(clip.loop === true && !clip.reverse
      ? { loopPhaseOffsetSec: (clip.loopPhaseOffsetSec ?? 0) + leftSourceSec }
      : {}),
    ...(preserveWarpAcrossSplit ? { trimStart: 0 } : {}),
    fadeIn: Math.min(splitDeclickFadeSec, audioClipDurationSec(doc, rightLength, rightStartBar)),
    fadeOut: rightFades.fadeOut,
  };
  const nextClips = (doc.arrangement.audioClips ?? [])
    .filter((c) => c.id !== clipId)
    .concat([leftClip, rightClip])
    .sort((a, b) => a.startBar - b.startBar);
  const next: ProjectDocument = { ...doc, arrangement: { ...doc.arrangement, audioClips: nextClips } };
  return snapshot("splitAudioClip", `Split audio clip at bar ${(splitTick / BAR_TICKS + 1).toFixed(2)}`, doc, next);
}

/**
 * Replace one audio clip with a fragment per non-silent segment (PT-style
 * Strip Silence). `segments` are seconds in the ORIGINAL sample — the live
 * caller analyzes the whole decoded buffer, so this command intersects them
 * with the clip's audible window `[offsetSec+trimStart, sourceDur-trimEnd]`
 * (fragments outside the window are material this clip never played) and
 * places each fragment at its wall-clock position inside the clip.
 *
 * Geometry follows splitAudioClipAtTick's discipline: seconds-per-tick at the
 * clip's SCENE-pinned tempo (not doc.bpm — under a tempo-pinned scene the
 * transport runs a different wall clock), and source advance per wall second
 * = `rate` for resample mode / `1/rate` for pitch-preserving stretch.
 * Reversed and looping clips invert or wrap the window — fail closed rather
 * than emit fragments at wrong positions.
 */
export function stripSilenceAudioClip(
  doc: ProjectDocument,
  clipId: string,
  segments: Array<{ startSec: number; endSec: number }>,
  /** Decoded source duration — bounds the clip's audible window (same contract as splitAudioClipAtTick). */
  sourceDurationSec?: number,
): Command {
  const clip = (doc.arrangement.audioClips ?? []).find((c) => c.id === clipId);
  if (!clip) throw new Error(`AudioClip ${clipId} not found`);
  if (segments.length === 0) throw new Error("No non-silent segments");
  if (clip.reverse === true) throw new Error("Strip silence is not supported on reversed clips");
  if (clip.loop === true) throw new Error("Strip silence is not supported on looping clips");
  const startTick = clip.startBar * BAR_TICKS;
  const endTick = startTick + clip.lengthBars * BAR_TICKS;
  // Scene-pinned seconds-per-tick at the clip's start: the scheduler runs this
  // span at its effective tempo, so plain doc.bpm places fragments against a
  // wall clock the transport never runs at (same bug class the split fix
  // documented).
  const spt = 60 / (tempoAtTick(doc.arrangement.clips, doc.scenes, startTick, doc.bpm) * PPQ);
  const rate = Math.min(4, Math.max(0.25, clip.stretchRate ?? 1));
  const preservingStretch = clip.stretchMode === "stretch" && Math.abs(rate - 1) >= 0.01;
  const sourcePerWall = preservingStretch ? 1 / rate : rate;
  const windowStart = (clip.offsetSec ?? 0) + (clip.trimStart ?? 0);
  const windowEnd =
    Number.isFinite(sourceDurationSec) && sourceDurationSec! > windowStart
      ? Math.max(windowStart, sourceDurationSec! - (clip.trimEnd ?? 0))
      : Number.POSITIVE_INFINITY;
  const fragments = segments
    .filter((seg) => Number.isFinite(seg.startSec) && Number.isFinite(seg.endSec) && seg.endSec > seg.startSec)
    .map((seg) => ({ start: Math.max(windowStart, seg.startSec), end: Math.min(windowEnd, seg.endSec) }))
    .filter((seg) => seg.end - seg.start > 0.01);
  if (fragments.length === 0) throw new Error("No audible content inside this clip's window");
  // The clip currently plays the source span [windowStart, playedEnd]; if the
  // fragments cover exactly that, stripping would be a no-op.
  const playedEnd = Math.min(
    windowEnd,
    windowStart +
      arrangementSecondsBetweenTicks(doc.arrangement.clips, doc.scenes, startTick, endTick, doc.bpm) * sourcePerWall,
  );
  if (
    fragments.length === 1 &&
    Math.abs(fragments[0].start - windowStart) < 0.001 &&
    Math.abs(fragments[0].end - playedEnd) < 0.1
  ) {
    throw new Error("No silence to strip");
  }
  const newClips: import("../project-model/types").AudioClip[] = fragments.map((seg) => {
    // Source span → wall span via the stretch conversion, then wall → bars at
    // the scene-pinned tempo.
    const wallDurSec = (seg.end - seg.start) / sourcePerWall;
    const segBars = wallDurSec / (spt * BAR_TICKS);
    const segStartTick = startTick + (seg.start - windowStart) / sourcePerWall / spt;
    const storedBars = Math.max(0.05, Math.round(segBars * 100) / 100);
    // Stripped segments are by definition much shorter than the source clip —
    // a 4s fadeIn cannot survive on a 0.1s blip. Bounded at the fragment's own
    // timeline position (scene-pinned tempo may differ from the parent's).
    const { fadeIn, fadeOut } = clampClipFades(doc, clip, storedBars, segStartTick / BAR_TICKS);
    return {
      ...clip,
      id: uid("audioClip"),
      startBar: segStartTick / BAR_TICKS,
      lengthBars: storedBars,
      offsetSec: seg.start,
      trimStart: 0,
      trimEnd: 0,
      fadeIn,
      fadeOut,
      // Fragments have their own source windows — the parent's tick-anchored
      // warp pins describe a span that no longer exists (sliceAudioClipToArrangement
      // clears them for the same reason). Also prevents all fragments from
      // sharing ONE array reference via the `...clip` spread.
      warpMarkers: undefined,
    } as import("../project-model/types").AudioClip;
  });
  // Keep original clip's track/color but replace single with many
  const nextClips = (doc.arrangement.audioClips ?? [])
    .filter((c) => c.id !== clipId)
    .concat(newClips)
    .sort((a, b) => a.startBar - b.startBar);
  const next: ProjectDocument = { ...doc, arrangement: { ...doc.arrangement, audioClips: nextClips } };
  return snapshot("stripSilence", `Strip silence → ${newClips.length} clips`, doc, next);
}

export function consolidateAudioClips(doc: ProjectDocument, clipIds: string[], bufferId: string): Command {
  const ids = new Set(clipIds);
  const clips = (doc.arrangement.audioClips ?? []).filter((clip) => ids.has(clip.id));
  if (ids.size < 2 || clips.length !== ids.size)
    throw new Error("Select at least 2 existing audio clips to consolidate");
  if (!bufferId) throw new Error("Rendered audio buffer ID is required");
  const first = clips[0];
  if (!first) throw new Error("No audio clips selected");
  if (clips.some((clip) => clip.trackId !== first.trackId)) {
    throw new Error("Consolidate requires clips on the same track");
  }
  if (clips.some((clip) => clip.takeGroupId !== first.takeGroupId || clip.takeId !== first.takeId)) {
    throw new Error("Consolidate clips from one take lane at a time");
  }
  if (Boolean(first.takeGroupId) !== Boolean(first.takeId)) {
    throw new Error("Selected audio clips have invalid take-lane metadata");
  }
  if (first.takeGroupId) {
    const group = doc.arrangement.takeGroups?.find((candidate) => candidate.id === first.takeGroupId);
    if (!group || group.trackId !== first.trackId)
      throw new Error("Selected audio clips have invalid take-lane metadata");
  }

  const startBar = Math.min(...clips.map((clip) => clip.startBar));
  const endBar = Math.max(...clips.map((clip) => clip.startBar + clip.lengthBars));
  const lengthBars = endBar - startBar;
  if (!Number.isFinite(startBar) || !Number.isFinite(lengthBars) || lengthBars < 0.25) {
    throw new Error("Consolidation range must be at least 1/4 bar");
  }

  const sameSourceTake =
    Boolean(first.compSourceTakeId) && clips.every((clip) => clip.compSourceTakeId === first.compSourceTakeId);
  const consolidated: AudioClip = {
    id: uid("audioClip"),
    trackId: first.trackId,
    bufferId,
    startBar,
    lengthBars,
    offsetSec: 0,
    trimStart: 0,
    trimEnd: 0,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    stretchRate: 1,
    reverse: false,
    ...(first.takeGroupId && first.takeId ? { takeGroupId: first.takeGroupId, takeId: first.takeId } : {}),
    ...(sameSourceTake ? { compSourceTakeId: first.compSourceTakeId } : {}),
  };
  const nextAudioClips = [...(doc.arrangement.audioClips ?? []).filter((clip) => !ids.has(clip.id)), consolidated].sort(
    (a, b) => a.startBar - b.startBar,
  );
  const next: ProjectDocument = {
    ...doc,
    arrangement: { ...doc.arrangement, audioClips: nextAudioClips },
  };
  return snapshot("consolidateAudioClips", `Consolidate ${clips.length} clips`, doc, next);
}

/**
 * Duplicate all musical material inside a timeRange [fromTick, toTick) and
 * insert the copy immediately after the range, shifting later clips forward.
 * Operates on arrangement clips (wholly inside), notes and steps (active
 * patterns). One undo via snapshot(). Guardrails: buildStemProject is
 * exercised for the zone's stem so consolidate stays in sync with bounce
 * routing (group FX preserved).
 */
export function duplicateTimeRange(doc: ProjectDocument, fromTick: number, toTick: number): Command {
  const rawFrom = Math.min(fromTick, toTick);
  const rawTo = Math.max(fromTick, toTick);
  if (rawFrom === rawTo) throw new Error("Cannot duplicate empty time range");
  // Scene clips live on an integer-bar grid (every move/resize command rounds
  // to whole bars) but the marquee only quantizes to ticks — a 2.4-bar drag
  // would shift later sections to fractional startBars, which the next move
  // command silently snaps back to an integer (position jump) and whose
  // startBar*BAR_TICKS is not even tick-exact in floating point. Widen the
  // zone to whole bars, never shrink it; bar-aligned ranges are unaffected.
  const from = Math.floor(rawFrom / BAR_TICKS) * BAR_TICKS;
  const to = Math.ceil(rawTo / BAR_TICKS) * BAR_TICKS;
  const delta = to - from;
  const deltaBars = delta / BAR_TICKS;
  // Scene clips are a no-overlap lane: a clip crossing either zone boundary
  // neither duplicates (not wholly inside) nor shifts (not trailing), so an
  // inside clip's copy would land on top of it — the audio lane below refuses
  // straddling clips for exactly this reason. Fail closed, not with an
  // overlapping arrangement.
  if (
    doc.arrangement.clips.some((c) => {
      const cFrom = c.startBar * BAR_TICKS;
      const cTo = (c.startBar + c.lengthBars) * BAR_TICKS;
      return (cFrom < from && cTo > from) || (cFrom < to && cTo > to);
    })
  ) {
    throw new Error("Cannot duplicate a time range when a clip crosses its boundary; adjust the range first.");
  }
  const fromStep = Math.floor(from / STEP_TICKS);
  const toStepEx = Math.ceil(to / STEP_TICKS);
  const deltaSteps = toStepEx - fromStep;
  // Verify stem routing for tracks that contribute to the zone (guardrail)
  const zoneTrackIds = new Set<string>();
  for (const clip of doc.arrangement.clips) {
    const cFrom = clip.startBar * BAR_TICKS;
    const cTo = (clip.startBar + clip.lengthBars) * BAR_TICKS;
    if (cFrom >= from && cTo <= to) {
      const scene = doc.scenes.find((s) => s.id === clip.sceneId);
      if (scene) {
        const pat = doc.patterns.find((p) => p.id === scene.patternId);
        if (pat) {
          for (const t of doc.tracks) if (pat.rows[t.id] || pat.notes?.[t.id]) zoneTrackIds.add(t.id);
        }
      }
    }
  }
  for (const pattern of doc.patterns) {
    for (const [trackId, notes] of Object.entries(pattern.notes ?? {})) {
      if (notes.some((n) => n.start >= from && n.start < to)) zoneTrackIds.add(trackId);
    }
    for (const [padId, row] of Object.entries(pattern.rows)) {
      for (let s = fromStep; s < toStepEx && s < row.length; s++) if (row[s] > 0) zoneTrackIds.add(padId);
    }
  }
  // Exercise buildStemProject so consolidation and duplicate stay consistent
  void buildStemProject(doc, (t) => zoneTrackIds.has(t.id));

  let nextDoc: ProjectDocument = { ...doc };

  // 1) Arrangement clips: wholly-inside are duplicated; trailing clips are shifted forward by deltaBars
  const whollyInside = doc.arrangement.clips.filter((c) => {
    const cFrom = c.startBar * BAR_TICKS;
    const cTo = (c.startBar + c.lengthBars) * BAR_TICKS;
    return cFrom >= from && cTo <= to;
  });
  const trailingIds = new Set(doc.arrangement.clips.filter((c) => c.startBar * BAR_TICKS >= to).map((c) => c.id));
  const baseClips: ArrangementClip[] = doc.arrangement.clips.map((c) =>
    trailingIds.has(c.id) ? { ...c, startBar: c.startBar + deltaBars } : c,
  );
  const duplicatedClips: ArrangementClip[] = whollyInside.map((c) => ({
    id: uid("clip"),
    sceneId: c.sceneId,
    startBar: c.startBar + deltaBars,
    lengthBars: c.lengthBars,
    // Carry the per-clip loop/phase flags — duplicateArrangementClip does; a
    // fresh literal silently reset them, so the zone copy of a phase-shifted
    // clip played the pattern from the wrong phase.
    ...(c.phaseOffsetTicks !== undefined ? { phaseOffsetTicks: c.phaseOffsetTicks } : {}),
    ...(c.sceneOffsetTicks !== undefined ? { sceneOffsetTicks: c.sceneOffsetTicks } : {}),
    ...(c.loop ? { loop: c.loop } : {}),
  }));
  const nextClips = [...baseClips, ...duplicatedClips].sort((a, b) => a.startBar - b.startBar);
  // Preserve transitions where possible (sanitize prunes dangling ones)
  const nextTransitions = sanitizeArrangementTransitions(doc.arrangement.transitions, nextClips);
  nextDoc = {
    ...nextDoc,
    arrangement: {
      ...nextDoc.arrangement,
      clips: nextClips,
      ...(nextTransitions ? { transitions: nextTransitions } : { transitions: undefined }),
    },
  };

  // Audio clips use a free-overlap lane, so only clips wholly contained in
  // the selected range can be copied safely. A clip crossing either range
  // edge would need a destructive split; fail closed rather than leave it
  // straddling the inserted section. Clips at/after the insertion point move
  // with the timeline, including their absolute warp-pin ticks.
  const fromBar = from / BAR_TICKS;
  const toBar = to / BAR_TICKS;
  const audioClips = doc.arrangement.audioClips ?? [];
  const overlapsRange = (clip: AudioClip) => clip.startBar < toBar && clip.startBar + clip.lengthBars > fromBar;
  const isWhollyInsideRange = (clip: AudioClip) => clip.startBar >= fromBar && clip.startBar + clip.lengthBars <= toBar;
  if (audioClips.some((clip) => overlapsRange(clip) && !isWhollyInsideRange(clip))) {
    throw new Error("Cannot duplicate a time range when an audio clip crosses its boundary; adjust the range first.");
  }
  const shiftWarpPins = (clip: AudioClip): AudioClip["warpMarkers"] =>
    clip.warpMarkers?.map((marker) => ({ ...marker, tick: marker.tick + delta }));
  const nextAudioClips = audioClips
    .flatMap((clip) => {
      if (isWhollyInsideRange(clip)) {
        return [
          {
            ...clip,
            id: uid("audioClip"),
            startBar: clip.startBar + deltaBars,
            ...(clip.warpMarkers ? { warpMarkers: shiftWarpPins(clip) } : {}),
          },
          clip,
        ];
      }
      if (clip.startBar >= toBar) {
        return [
          {
            ...clip,
            startBar: clip.startBar + deltaBars,
            ...(clip.warpMarkers ? { warpMarkers: shiftWarpPins(clip) } : {}),
          },
        ];
      }
      return [clip];
    })
    .sort((a, b) => a.startBar - b.startBar);
  if (doc.arrangement.audioClips !== undefined) {
    nextDoc = {
      ...nextDoc,
      arrangement: { ...nextDoc.arrangement, audioClips: nextAudioClips },
    };
  }

  // Markers inside zone are duplicated; trailing markers are shifted
  const nextMarkers = doc.markers.flatMap((m) => {
    if (m.tick >= from && m.tick < to) {
      return [m, { ...m, id: uid("marker"), tick: m.tick + delta }];
    }
    if (m.tick >= to) return [{ ...m, tick: m.tick + delta }];
    return [m];
  });

  nextDoc = { ...nextDoc, markers: nextMarkers };

  // 2) Patterns: duplicate notes and steps; extend pattern if needed
  const nextPatterns: Pattern[] = nextDoc.patterns.map((pattern) => {
    const patternTicks = pattern.stepCount * STEP_TICKS;
    // Notes
    const notesEntries = Object.entries(pattern.notes ?? {});
    let maxEnd = patternTicks;
    const nextNotes: Record<string, NoteEvent[]> = {};
    let notesChanged = false;
    for (const [trackId, notes] of notesEntries) {
      const inside = notes.filter((n) => n.start >= from && n.start < to);
      if (inside.length === 0) {
        nextNotes[trackId] = notes;
        continue;
      }
      const copies = inside.map((n) => ({ ...n, id: uid("note"), start: n.start + delta }));
      for (const c of copies) maxEnd = Math.max(maxEnd, c.start + c.duration);
      nextNotes[trackId] = [...notes, ...copies].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
      notesChanged = true;
    }
    // Include empty trackId entries that only had step duplicates? Keep as is.
    for (const [tid, nlist] of Object.entries(pattern.notes ?? {})) if (!nextNotes[tid]) nextNotes[tid] = nlist;

    // Rows + stepMeta
    const nextRows: Record<string, number[]> = {};
    let rowsChanged = false;
    let nextStepMeta = pattern.stepMeta ? cloneStepMeta(pattern.stepMeta) : undefined;
    let neededSteps = pattern.stepCount;
    // Determine needed steps from note copies
    if (maxEnd > patternTicks) neededSteps = Math.max(neededSteps, Math.ceil(maxEnd / STEP_TICKS));
    for (const [padId, row] of Object.entries(pattern.rows)) {
      let newRow = [...row];
      // Ensure row can hold duplicated steps
      const requiredLen = toStepEx + deltaSteps;
      if (requiredLen > newRow.length) {
        newRow = [...newRow, ...new Array(requiredLen - newRow.length).fill(0)];
        neededSteps = Math.max(neededSteps, newRow.length);
      }
      let changed = false;
      for (let s = fromStep; s < toStepEx && s < row.length; s++) {
        const vel = row[s];
        if (vel > 0) {
          const dst = s + deltaSteps;
          if (dst < newRow.length) {
            newRow[dst] = vel;
            changed = true;
            const meta = pattern.stepMeta?.[padId]?.[s];
            if (meta) {
              if (!nextStepMeta) nextStepMeta = {};
              if (!nextStepMeta[padId]) nextStepMeta[padId] = {};
              nextStepMeta[padId][dst] = { ...meta, ...(meta.locks ? { locks: { ...meta.locks } } : {}) };
            }
          }
        }
      }
      nextRows[padId] = newRow;
      if (changed) rowsChanged = true;
    }
    // Ensure all rows same length = neededSteps
    for (const padId of Object.keys(nextRows)) {
      const r = nextRows[padId];
      if (r.length < neededSteps) nextRows[padId] = [...r, ...new Array(neededSteps - r.length).fill(0)];
      else if (r.length > neededSteps) neededSteps = r.length;
    }
    // Final harmonize length if needed
    if (neededSteps !== pattern.stepCount) {
      for (const padId of Object.keys(nextRows)) {
        const r = nextRows[padId];
        if (r.length < neededSteps) nextRows[padId] = [...r, ...new Array(neededSteps - r.length).fill(0)];
        if (r.length > neededSteps) nextRows[padId] = r.slice(0, neededSteps);
      }
    }
    if (!notesChanged && !rowsChanged && neededSteps === pattern.stepCount) return pattern;
    return {
      ...pattern,
      stepCount: neededSteps,
      rows: Object.keys(nextRows).length > 0 ? nextRows : pattern.rows,
      notes: Object.keys(nextNotes).length > 0 ? nextNotes : pattern.notes,
      stepMeta: nextStepMeta && Object.keys(nextStepMeta).length > 0 ? nextStepMeta : undefined,
    };
  });
  nextDoc = { ...nextDoc, patterns: nextPatterns };

  return snapshot("duplicateTimeRange", `Duplicate zone ${Math.round(deltaBars * 10) / 10} bars`, doc, nextDoc);
}

/**
 * Legacy synchronous, musical-only range consolidation. Producer-facing
 * selected-range actions use `consolidateTimeRangeToAudio` after rendering;
 * this command remains for callers that explicitly want pattern material.
 */
export function consolidateTimeRange(doc: ProjectDocument, fromTick: number, toTick: number): Command {
  const from = Math.min(fromTick, toTick);
  const to = Math.max(fromTick, toTick);
  if (from === to) throw new Error("Cannot consolidate empty time range");
  const delta = to - from;
  const deltaBars = delta / BAR_TICKS;
  const fromBar = from / BAR_TICKS;
  const fromStep = Math.floor(from / STEP_TICKS);
  const toStepEx = Math.ceil(to / STEP_TICKS);
  const zoneSteps = toStepEx - fromStep;
  if (zoneSteps <= 0) throw new Error("Zone too small to consolidate");

  // Collect zone track affinity for stem filtering
  const zoneTrackIds = new Set<string>();
  for (const clip of doc.arrangement.clips) {
    const cFrom = clip.startBar * BAR_TICKS;
    const cTo = (clip.startBar + clip.lengthBars) * BAR_TICKS;
    if (cFrom < to && cTo > from) {
      const scene = doc.scenes.find((s) => s.id === clip.sceneId);
      if (scene) {
        const pat = doc.patterns.find((p) => p.id === scene.patternId);
        if (pat)
          for (const t of doc.tracks) if (pat.rows[t.id] !== undefined || pat.notes?.[t.id]) zoneTrackIds.add(t.id);
      }
    }
  }
  for (const pattern of doc.patterns) {
    for (const [trackId, notes] of Object.entries(pattern.notes ?? {}))
      if (notes.some((n) => n.start >= from && n.start < to)) zoneTrackIds.add(trackId);
    for (const [padId, row] of Object.entries(pattern.rows))
      for (let s = fromStep; s < toStepEx && s < row.length; s++) if (row[s] > 0) zoneTrackIds.add(padId);
  }
  // Guardrail: build the stem project so group parents are pulled in
  const stemProject = buildStemProject(doc, (t) => zoneTrackIds.has(t.id));
  void stemProject;

  // Gather zone's musical content shifted to 0
  const consolidatedNotes: Record<string, NoteEvent[]> = {};
  const consolidatedRows: Record<string, number[]> = {};
  const consolidatedMeta: NonNullable<Pattern["stepMeta"]> = {};
  // Use first drum pad list as row template
  const drumPadIds = doc.tracks
    .filter((t): t is DrumTrack => t.kind === "drum")
    .flatMap((t) => t.pads.map((p) => p.id));
  for (const padId of drumPadIds) consolidatedRows[padId] = new Array<number>(zoneSteps).fill(0);

  for (const pattern of doc.patterns) {
    for (const [trackId, notes] of Object.entries(pattern.notes ?? {})) {
      for (const n of notes)
        if (n.start >= from && n.start < to) {
          const shifted = { ...n, id: uid("note"), start: n.start - from };
          if (!consolidatedNotes[trackId]) consolidatedNotes[trackId] = [];
          consolidatedNotes[trackId].push(shifted);
        }
    }
    for (const [padId, row] of Object.entries(pattern.rows)) {
      if (!consolidatedRows[padId]) consolidatedRows[padId] = new Array<number>(zoneSteps).fill(0);
      for (let s = fromStep; s < toStepEx && s < row.length; s++)
        if (row[s] > 0) {
          const dst = s - fromStep;
          consolidatedRows[padId][dst] = row[s];
          const meta = pattern.stepMeta?.[padId]?.[s];
          if (meta) {
            if (!consolidatedMeta[padId]) consolidatedMeta[padId] = {};
            consolidatedMeta[padId][dst] = { ...meta, ...(meta.locks ? { locks: { ...meta.locks } } : {}) };
          }
        }
    }
  }
  // Prune empty rows / notes
  for (const padId of Object.keys(consolidatedRows))
    if (consolidatedRows[padId].every((v) => v === 0)) delete consolidatedRows[padId];
  for (const tid of Object.keys(consolidatedNotes))
    consolidatedNotes[tid].sort((a, b) => a.start - b.start || a.pitch - b.pitch);

  const hasContent = Object.keys(consolidatedRows).length > 0 || Object.keys(consolidatedNotes).length > 0;
  if (!hasContent) throw new Error("Nothing to consolidate in this zone");

  const newPattern: Pattern = {
    id: uid("pattern"),
    name: `Zone ${Math.round(fromBar + 1)}–${Math.round(fromBar + deltaBars + 1)} consolidated`,
    stepCount: zoneSteps,
    rows: consolidatedRows,
    notes: consolidatedNotes,
    stepMeta: Object.keys(consolidatedMeta).length > 0 ? consolidatedMeta : undefined,
  };
  const newScene: Scene = {
    id: uid("scene"),
    name: newPattern.name,
    patternId: newPattern.id,
    intensity: 0.7,
  };
  const newClip: ArrangementClip = {
    id: uid("clip"),
    sceneId: newScene.id,
    startBar: fromBar,
    lengthBars: deltaBars,
  };

  // Remove wholly-inside clips and source notes/rows inside zone
  const whollyInsideIds = new Set(
    doc.arrangement.clips
      .filter((c) => {
        const cFrom = c.startBar * BAR_TICKS;
        const cTo = (c.startBar + c.lengthBars) * BAR_TICKS;
        return cFrom >= from && cTo <= to;
      })
      .map((c) => c.id),
  );
  let nextPatterns: Pattern[] = doc.patterns.map((pattern) => {
    let changed = false;
    const nextNotes: Record<string, NoteEvent[]> = {};
    for (const [tid, notes] of Object.entries(pattern.notes ?? {})) {
      const filtered = notes.filter((n) => !(n.start >= from && n.start < to));
      nextNotes[tid] = filtered;
      if (filtered.length !== notes.length) changed = true;
    }
    const nextRows: Record<string, number[]> = { ...pattern.rows };
    let nextMeta = pattern.stepMeta ? cloneStepMeta(pattern.stepMeta) : undefined;
    for (const [padId, row] of Object.entries(pattern.rows)) {
      let rowChanged = false;
      const newRow = [...row];
      for (let s = fromStep; s < toStepEx && s < newRow.length; s++)
        if (newRow[s] !== 0) {
          newRow[s] = 0;
          rowChanged = true;
        }
      if (rowChanged) {
        nextRows[padId] = newRow;
        changed = true;
        if (nextMeta?.[padId]) {
          for (let s = fromStep; s < toStepEx; s++) delete nextMeta[padId][s];
          if (Object.keys(nextMeta[padId]).length === 0) delete nextMeta[padId];
        }
      }
    }
    if (nextMeta && Object.keys(nextMeta).length === 0) nextMeta = undefined;
    if (!changed) return pattern;
    return { ...pattern, notes: nextNotes, rows: nextRows, stepMeta: nextMeta };
  });

  nextPatterns = [...nextPatterns, newPattern];
  const nextScenes = [...doc.scenes, newScene];
  const remainingClips = doc.arrangement.clips.filter((c) => !whollyInsideIds.has(c.id));
  const nextClips = [...remainingClips, newClip].sort((a, b) => a.startBar - b.startBar);
  const nextTransitions = sanitizeArrangementTransitions(doc.arrangement.transitions, nextClips);

  const nextDoc: ProjectDocument = {
    ...doc,
    patterns: nextPatterns,
    scenes: nextScenes,
    arrangement: {
      // Spread the existing arrangement: rebuilding it from scratch DROPPED
      // `audioClips` — consolidating a zone silently deleted every audio
      // clip in the project (undoable once, permanent after a save).
      ...doc.arrangement,
      clips: nextClips,
      ...(nextTransitions ? { transitions: nextTransitions } : { transitions: undefined }),
    },
  };
  return snapshot("consolidateTimeRange", `Consolidate zone ${Math.round(deltaBars * 10) / 10} bars`, doc, nextDoc);
}

/**
 * Replace a complete arrangement range with one rendered audio clip. Empty
 * scene clips retain the source scene tempos for the printed clip; their IDs
 * stay stable so timeline markers and transitions remain attached. Source
 * patterns themselves are never destructively edited. Audio clips crossing a
 * range edge are split at the exact boundary, leaving their outside segments
 * intact while replacing only the rendered middle.
 */
interface SplitAudioRangeResult {
  project: ProjectDocument;
  removedClipIds: Set<string>;
}

function splitAudioClipsForConsolidationRange(
  doc: ProjectDocument,
  clips: AudioClip[],
  fromTick: number,
  toTick: number,
  sourceDurationsByBufferId: ReadonlyMap<string, number>,
): SplitAudioRangeResult {
  let project = doc;
  const removedClipIds = new Set<string>();

  for (const sourceClip of clips) {
    const sourceDuration = sourceDurationsByBufferId.get(sourceClip.bufferId);
    const crossesRangeBoundary =
      sourceClip.startBar * BAR_TICKS < fromTick || (sourceClip.startBar + sourceClip.lengthBars) * BAR_TICKS > toTick;
    if (
      crossesRangeBoundary &&
      sourceClip.warpMarkers?.length &&
      (!Number.isFinite(sourceDuration) || sourceDuration! <= 0)
    ) {
      throw new Error(`Load the source audio for warped clip ${sourceClip.id} before consolidating its range.`);
    }

    let rangeClipId = sourceClip.id;
    const currentClip = () => project.arrangement.audioClips?.find((clip) => clip.id === rangeClipId);
    const initial = currentClip();
    if (!initial) throw new Error(`AudioClip ${sourceClip.id} disappeared during range consolidation.`);

    const splitAt = (clipId: string, tick: number): AudioClip[] => {
      const priorIds = new Set((project.arrangement.audioClips ?? []).map((clip) => clip.id));
      project = splitAudioClipAtTickWithMinimumFragment(project, clipId, tick, sourceDuration, 0).execute(project);
      const pieces = (project.arrangement.audioClips ?? []).filter(
        (clip) =>
          !priorIds.has(clip.id) && clip.bufferId === sourceClip.bufferId && clip.trackId === sourceClip.trackId,
      );
      if (pieces.length !== 2)
        throw new Error(`Could not preserve the source segments for audio clip ${sourceClip.id}.`);
      return pieces;
    };

    if (initial.startBar * BAR_TICKS < fromTick) {
      const rangeFragment = splitAt(rangeClipId, fromTick).find(
        (clip) => Math.abs(clip.startBar * BAR_TICKS - fromTick) < 1e-6,
      );
      if (!rangeFragment) throw new Error(`Could not preserve the left audio fragment for clip ${sourceClip.id}.`);
      rangeClipId = rangeFragment.id;
    }

    const middle = currentClip();
    if (!middle) throw new Error(`AudioClip ${sourceClip.id} disappeared during range consolidation.`);
    if ((middle.startBar + middle.lengthBars) * BAR_TICKS > toTick) {
      const rangeFragment = splitAt(rangeClipId, toTick).find(
        (clip) =>
          clip.startBar * BAR_TICKS >= fromTick - 1e-6 &&
          (clip.startBar + clip.lengthBars) * BAR_TICKS <= toTick + 1e-6 &&
          (clip.startBar + clip.lengthBars) * BAR_TICKS > fromTick,
      );
      if (!rangeFragment) throw new Error(`Could not isolate the selected audio range for clip ${sourceClip.id}.`);
      rangeClipId = rangeFragment.id;
    }
    removedClipIds.add(rangeClipId);
  }

  return { project, removedClipIds };
}

export function consolidateTimeRangeToAudio(
  doc: ProjectDocument,
  fromTick: number,
  toTick: number,
  bufferId: string,
  sourceDurationsByBufferId: ReadonlyMap<string, number> = new Map(),
  printLengthBars?: number,
): Command {
  const from = Math.min(fromTick, toTick);
  const to = Math.max(fromTick, toTick);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from) {
    throw new Error("Select a valid, non-empty time range.");
  }
  if (from % BAR_TICKS !== 0 || to % BAR_TICKS !== 0) {
    throw new Error("Consolidation requires a selection aligned to complete bars.");
  }
  if (!bufferId) throw new Error("A rendered audio asset is required for consolidation.");
  if (doc.tracks.some((track) => track.solo)) {
    throw new Error("Turn off Solo before consolidating so the print does not change the rest of the mix.");
  }

  const fromBar = from / BAR_TICKS;
  const toBar = to / BAR_TICKS;
  const lengthBars = toBar - fromBar;
  const renderedLengthBars = printLengthBars ?? lengthBars;
  if (
    !Number.isFinite(renderedLengthBars) ||
    renderedLengthBars < lengthBars ||
    renderedLengthBars > MAX_ARRANGEMENT_CLIP_BARS
  ) {
    throw new Error("The rendered print duration must cover the selected range and stay within the clip limit.");
  }
  const overlaps = (startBar: number, bars: number) => startBar < toBar && startBar + bars > fromBar;
  const sourceClips = doc.arrangement.clips.filter((clip) => overlaps(clip.startBar, clip.lengthBars));
  const sourceAudio = (doc.arrangement.audioClips ?? []).filter((clip) => overlaps(clip.startBar, clip.lengthBars));

  const splitAudio = splitAudioClipsForConsolidationRange(doc, sourceAudio, from, to, sourceDurationsByBufferId);

  const groupCount = splitAudio.project.tracks.filter((track) => track.kind === "group").length;
  const printTrack = {
    ...createGroupTrackModel(`Consolidated ${groupCount + 1}`),
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
    sends: {},
  };
  const withPrintTrack: ProjectDocument = {
    ...splitAudio.project,
    tracks: [...splitAudio.project.tracks, printTrack],
  };
  const withPrintClip = addAudioClip(withPrintTrack, printTrack.id, bufferId, fromBar, renderedLengthBars, {
    gain: 1,
    stretchRate: 1,
    fadeIn: 0.003,
    fadeOut: 0.003,
  }).execute(withPrintTrack);
  const printClip = withPrintClip.arrangement.audioClips?.find(
    (clip) => clip.trackId === printTrack.id && clip.bufferId === bufferId,
  );
  if (!printClip) throw new Error("The rendered audio clip could not be added to the print track.");

  const tempoPatterns: Pattern[] = [];
  const tempoScenes: Scene[] = [];
  const tempoSceneByClipId = new Map<string, Scene>();
  for (const clip of sourceClips) {
    const scene = doc.scenes.find((candidate) => candidate.id === clip.sceneId);
    const pattern = scene && doc.patterns.find((candidate) => candidate.id === scene.patternId);
    if (!scene || !pattern) throw new Error(`Cannot preserve tempo for arrangement clip ${clip.id}.`);
    const tempoPattern: Pattern = {
      ...pattern,
      id: uid("pattern"),
      name: `${pattern.name} · print tempo`,
      rows: {},
      notes: {},
      stepMeta: undefined,
    };
    const tempoScene: Scene = {
      ...scene,
      id: uid("scene"),
      name: `Print tempo · ${scene.name}`,
      patternId: tempoPattern.id,
    };
    tempoPatterns.push(tempoPattern);
    tempoScenes.push(tempoScene);
    tempoSceneByClipId.set(clip.id, tempoScene);
  }

  const sourceClipIds = new Set(sourceClips.map((clip) => clip.id));
  const nextClips: ArrangementClip[] = [];
  for (const clip of doc.arrangement.clips) {
    if (!sourceClipIds.has(clip.id)) {
      nextClips.push(clip);
      continue;
    }
    const tempoScene = tempoSceneByClipId.get(clip.id);
    const scene = doc.scenes.find((candidate) => candidate.id === clip.sceneId);
    const pattern = scene && doc.patterns.find((candidate) => candidate.id === scene.patternId);
    if (!tempoScene || !pattern) throw new Error(`Cannot preserve tempo for arrangement clip ${clip.id}.`);

    const clipEndBar = clip.startBar + clip.lengthBars;
    const overlapStartBar = Math.max(clip.startBar, fromBar);
    const overlapEndBar = Math.min(clipEndBar, toBar);
    const hasLeftRemainder = clip.startBar < overlapStartBar;
    const hasRightRemainder = overlapEndBar < clipEndBar;
    const isPartial = hasLeftRemainder || hasRightRemainder;

    if (hasLeftRemainder) {
      nextClips.push({ ...clip, lengthBars: overlapStartBar - clip.startBar });
    }

    if (hasRightRemainder) {
      const rightStartTick = overlapEndBar * BAR_TICKS;
      nextClips.push({
        ...clip,
        id: hasLeftRemainder ? uid("clip") : clip.id,
        startBar: overlapEndBar,
        lengthBars: clipEndBar - overlapEndBar,
        phaseOffsetTicks: patternPhaseOffsetAtTick(clip, pattern, rightStartTick),
        sceneOffsetTicks: sceneOffsetAtTick(clip, rightStartTick),
      });
    }

    const placeholder: ArrangementClip = {
      ...clip,
      id: isPartial ? uid("clip") : clip.id,
      sceneId: tempoScene.id,
      startBar: overlapStartBar,
      lengthBars: overlapEndBar - overlapStartBar,
    };
    delete placeholder.phaseOffsetTicks;
    delete placeholder.sceneOffsetTicks;
    nextClips.push(placeholder);
  }
  nextClips.sort((a, b) => a.startBar - b.startBar);
  const nextAudioClips = (withPrintClip.arrangement.audioClips ?? [])
    .filter((clip) => !splitAudio.removedClipIds.has(clip.id))
    .sort((a, b) => a.startBar - b.startBar);
  const liveTakeGroupIds = new Set(nextAudioClips.flatMap((clip) => (clip.takeGroupId ? [clip.takeGroupId] : [])));
  const takeGroups = doc.arrangement.takeGroups?.filter((group) => liveTakeGroupIds.has(group.id));
  const transitions = sanitizeArrangementTransitions(doc.arrangement.transitions, nextClips);

  const nextDoc = normalizeProject({
    ...withPrintClip,
    patterns: [...doc.patterns, ...tempoPatterns],
    scenes: [...doc.scenes, ...tempoScenes],
    arrangement: {
      ...withPrintClip.arrangement,
      clips: nextClips,
      audioClips: nextAudioClips,
      ...(takeGroups ? { takeGroups } : {}),
      ...(transitions ? { transitions } : { transitions: undefined }),
    },
  });
  return snapshot(
    "consolidateTimeRangeToAudio",
    `Consolidate ${Math.round(lengthBars * 10) / 10} bars to audio`,
    doc,
    nextDoc,
  );
}

function transitionBetween(doc: ProjectDocument, fromClipId: string, toClipId: string): void {
  const from = doc.arrangement.clips.find((clip) => clip.id === fromClipId);
  const to = doc.arrangement.clips.find((clip) => clip.id === toClipId);
  if (!from || !to) throw new Error("Transition clips not found");
  if (fromClipId === toClipId || from.startBar >= to.startBar || from.startBar + from.lengthBars > to.startBar) {
    throw new Error("Transition clips must be ordered and non-overlapping");
  }
}

export function addArrangementTransition(
  doc: ProjectDocument,
  fromClipId: string,
  toClipId: string,
  type: ArrangementTransitionType = "custom",
  lengthBars = 1,
  cueAssetId?: string,
): Command {
  transitionBetween(doc, fromClipId, toClipId);
  if (
    doc.arrangement.transitions?.some(
      (transition) => transition.fromClipId === fromClipId && transition.toClipId === toClipId,
    )
  ) {
    throw new Error("A transition already exists between these clips");
  }
  const transition: ArrangementTransition = {
    id: uid("transition"),
    fromClipId,
    toClipId,
    type,
    lengthBars: Math.min(4, Math.max(1, Math.round(lengthBars))),
    cueAssetId: cueAssetId?.trim() || undefined,
  };
  const next: ProjectDocument = {
    ...doc,
    arrangement: { ...doc.arrangement, transitions: [...(doc.arrangement.transitions ?? []), transition] },
  };
  return snapshot("addArrangementTransition", "Add arrangement transition", doc, next);
}

export function updateArrangementTransition(
  doc: ProjectDocument,
  transitionId: string,
  changes: Partial<Pick<ArrangementTransition, "type" | "lengthBars" | "cueAssetId">>,
): Command {
  const target = doc.arrangement.transitions?.find((transition) => transition.id === transitionId);
  if (!target) throw new Error(`Transition ${transitionId} not found`);
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      transitions: doc.arrangement.transitions!.map((transition) =>
        transition.id === transitionId
          ? {
              ...transition,
              ...(changes.type ? { type: clampArrangementTransitionType(changes.type) } : {}),
              ...(changes.lengthBars !== undefined
                ? { lengthBars: Math.min(4, Math.max(1, Math.round(changes.lengthBars))) }
                : {}),
              ...(changes.cueAssetId !== undefined ? { cueAssetId: changes.cueAssetId?.trim() || undefined } : {}),
            }
          : transition,
      ),
    },
  };
  return snapshot("updateArrangementTransition", "Edit arrangement transition", doc, next);
}

export function removeArrangementTransition(doc: ProjectDocument, transitionId: string): Command {
  if (!doc.arrangement.transitions?.some((transition) => transition.id === transitionId)) {
    throw new Error(`Transition ${transitionId} not found`);
  }
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      transitions: doc.arrangement.transitions!.filter((transition) => transition.id !== transitionId),
    },
  };
  return snapshot("removeArrangementTransition", "Remove arrangement transition", doc, next);
}

export interface ArrangementSkeletonStep {
  role: Exclude<SceneRole, "fill" | "custom">;
  sceneId: string;
  startBar: number;
  lengthBars: number;
}

const SKELETON_LAYOUT: ReadonlyArray<{ role: ArrangementSkeletonStep["role"]; lengthBars: number }> = [
  { role: "intro", lengthBars: 8 },
  { role: "build", lengthBars: 8 },
  { role: "drop", lengthBars: 16 },
  { role: "break", lengthBars: 8 },
  { role: "outro", lengthBars: 8 },
];

export function arrangementSkeletonPreview(doc: ProjectDocument): ArrangementSkeletonStep[] {
  const used = new Set<string>();
  let startBar = 0;
  const steps: ArrangementSkeletonStep[] = [];
  for (const item of SKELETON_LAYOUT) {
    const scene = doc.scenes.find((candidate) => !used.has(candidate.id) && sceneRoleOf(candidate) === item.role);
    if (!scene) continue;
    used.add(scene.id);
    steps.push({ role: item.role, sceneId: scene.id, startBar, lengthBars: item.lengthBars });
    startBar += item.lengthBars;
  }
  return steps;
}

/**
 * Auto-Arrange: lay ALL scenes into a classic electronic song template —
 * intro → build → drop → break → build → drop → outro — with riser/fill
 * transitions between the key boundaries and drop/buildup cue markers.
 *
 * Scenes are bucketed by role (`sceneRoleOf` infers from names); slots pick
 * from their bucket in order, cycling when a bucket has several scenes
 * (two drops → DROP A / DROP B). Missing roles fall back through a chain so
 * even a 3-scene jam gets a coherent song.
 */
export function autoArrangeSong(doc: ProjectDocument): Command {
  if (doc.scenes.length === 0) throw new Error("No scenes to arrange — create a few first");
  type Bucket = "intro" | "build" | "drop" | "break" | "outro" | "other";
  const buckets = new Map<Bucket, string[]>();
  for (const scene of doc.scenes) {
    const role = sceneRoleOf(scene) ?? "custom";
    // Songwriting roles (A2 v2) fold into their nearest electronic bucket:
    // chorus plays like a drop, verse like a build, bridge like a break.
    const folded = role === "chorus" ? "drop" : role === "verse" ? "build" : role === "bridge" ? "break" : role;
    const bucket: Bucket =
      folded === "intro" || folded === "build" || folded === "drop" || folded === "break" || folded === "outro"
        ? folded
        : "other";
    const list = buckets.get(bucket) ?? [];
    list.push(scene.id);
    buckets.set(bucket, list);
  }
  const cursor = new Map<Bucket, number>();
  const pick = (primary: Bucket, fallbacks: Bucket[]): string | null => {
    for (const bucket of [primary, ...fallbacks]) {
      const list = buckets.get(bucket) ?? [];
      if (list.length === 0) continue;
      const at = cursor.get(bucket) ?? 0;
      cursor.set(bucket, (at + 1) % list.length);
      return list[at];
    }
    return null;
  };

  const TEMPLATE: Array<{
    primary: Bucket;
    fallbacks: Bucket[];
    lengthBars: number;
    marker?: { type: Marker["type"]; name: string };
    transitionIn?: ArrangementTransitionType | null;
  }> = [
    { primary: "intro", fallbacks: ["break", "other", "drop"], lengthBars: 4 },
    {
      primary: "build",
      fallbacks: ["intro", "other", "drop"],
      lengthBars: 4,
      marker: { type: "buildup", name: "BUILD A" },
      transitionIn: null,
    },
    {
      primary: "drop",
      fallbacks: ["other", "build"],
      lengthBars: 8,
      marker: { type: "drop", name: "DROP A" },
      transitionIn: "riser",
    },
    {
      primary: "break",
      fallbacks: ["intro", "other"],
      lengthBars: 4,
      marker: { type: "cue", name: "BREAK" },
      transitionIn: "break",
    },
    {
      primary: "build",
      fallbacks: ["intro", "other", "drop"],
      lengthBars: 4,
      marker: { type: "buildup", name: "BUILD B" },
      transitionIn: "fill",
    },
    {
      primary: "drop",
      fallbacks: ["other", "build"],
      lengthBars: 8,
      marker: { type: "drop", name: "DROP B" },
      transitionIn: "riser",
    },
    { primary: "outro", fallbacks: ["break", "intro", "other"], lengthBars: 4, transitionIn: "break" },
  ];

  let bar = 0;
  const clips: ArrangementClip[] = [];
  const transitions: ArrangementTransition[] = [];
  const markers: Marker[] = [];
  let previousClipId: string | null = null;
  let usedSlots = 0;
  for (const slot of TEMPLATE) {
    const sceneId = pick(slot.primary, slot.fallbacks);
    if (!sceneId) continue;
    usedSlots += 1;
    const clip: ArrangementClip = { id: uid("clip"), sceneId, startBar: bar, lengthBars: slot.lengthBars };
    clips.push(clip);
    if (previousClipId && slot.transitionIn) {
      transitions.push({
        id: uid("transition"),
        fromClipId: previousClipId,
        toClipId: clip.id,
        type: slot.transitionIn,
        lengthBars: 1,
      });
    }
    if (slot.marker) {
      markers.push({
        id: uid("marker"),
        name: slot.marker.name,
        type: slot.marker.type,
        tick: bar * BAR_TICKS,
        linkedClipId: clip.id,
      });
    }
    previousClipId = clip.id;
    bar += slot.lengthBars;
  }
  if (usedSlots === 0) throw new Error("No scenes could be placed — create a few scenes first");

  const next: ProjectDocument = {
    ...doc,
    arrangement: { ...doc.arrangement, clips, transitions },
    markers: markers,
  };
  return snapshot("autoArrangeSong", `Auto-arrange song (intro→build→drop→break→drop→outro)`, doc, next);
}

export function createArrangementSkeleton(doc: ProjectDocument): Command {
  const steps = arrangementSkeletonPreview(doc);
  if (steps.length === 0) throw new Error("No INTRO, BUILD, DROP, BREAK or OUTRO scenes found");
  const clips = steps.map((step) => ({
    id: uid("clip"),
    sceneId: step.sceneId,
    startBar: step.startBar,
    lengthBars: step.lengthBars,
  }));
  const next: ProjectDocument = { ...doc, arrangement: { ...doc.arrangement, clips, transitions: undefined } };
  return snapshot("createArrangementSkeleton", "Build arrangement skeleton", doc, next);
}

export interface CapturedArrangementClip {
  sceneId: string;
  startBar: number;
  lengthBars: number;
}

export function appendCapturedArrangement(doc: ProjectDocument, captured: CapturedArrangementClip[]): Command {
  if (captured.length === 0) throw new Error("No captured scene launches");
  for (const entry of captured) {
    if (!doc.scenes.some((scene) => scene.id === entry.sceneId)) throw new Error(`Scene ${entry.sceneId} not found`);
  }
  const baseBar = doc.arrangement.clips.reduce((max, clip) => Math.max(max, clip.startBar + clip.lengthBars), 0);
  const clips = captured.map((entry) => ({
    id: uid("clip"),
    sceneId: entry.sceneId,
    startBar: baseBar + Math.max(0, Math.round(entry.startBar)),
    lengthBars: Math.max(1, Math.round(entry.lengthBars)),
  }));
  const allClips = [...doc.arrangement.clips, ...clips].sort((a, b) => a.startBar - b.startBar);
  if (
    allClips.some(
      (clip, index) => index > 0 && clip.startBar < allClips[index - 1].startBar + allClips[index - 1].lengthBars,
    )
  ) {
    throw new Error("Captured arrangement overlaps an existing clip");
  }
  return snapshot("appendCapturedArrangement", `Capture ${clips.length} scene${clips.length === 1 ? "" : "s"}`, doc, {
    ...doc,
    arrangement: { ...doc.arrangement, clips: allClips },
  });
}

/* ---------------- AI pattern generation ---------------- */

/**
 * Build the one-coherent-undo-step command that installs an ALREADY GENERATED,
 * already validated GenerationResult proposal into the project.
 *
 * Commands must never generate (async work / hidden nondeterminism inside
 * execute would break undo semantics), so product preview/apply flows
 * generate once through the Intent Engine and apply THAT result here. The
 * pattern is copied, never mutated — callers keep owning the previewed
 * object (React state, dice sessions).
 */
export function applyGenerationResultCommand(
  doc: ProjectDocument,
  result: GenerationResult,
  patternName?: string,
): Command {
  const proposal = result.proposal;
  if (!proposal) throw new Error(result.diagnostics.errors.join(", ") || "Intent generation was rejected");
  const options = result.plan.options;
  let pattern = proposal.pattern;
  const name = patternName ?? (pattern.name || `${options.genre} ${options.seed.slice(0, 4)}`.trim());
  if (name !== pattern.name) pattern = { ...pattern, name };

  // Apply groove settings from the resolved groove if requested
  let grooveUpdate: Partial<GrooveSettings> | undefined;
  if (options.applyGrooveSettings) {
    // Reuse the exact source-aware resolution path used by the generator.
    const groove = resolveGrooveForGeneration(doc, options);
    grooveUpdate = { swing: groove.swing };
  }
  const bpmUpdate = result.plan.resolvedBpm;
  const projectUpdates = {
    ...(grooveUpdate ? { groove: { ...doc.groove, ...grooveUpdate } } : {}),
    ...(bpmUpdate !== null && bpmUpdate !== undefined ? { bpm: bpmUpdate } : {}),
  };

  if (options.replaceMode === "replace") {
    const activeId = doc.activePatternId;
    const next: ProjectDocument = {
      ...doc,
      patterns: doc.patterns.map((p) =>
        p.id === activeId
          ? {
              ...p,
              rows: pattern.rows,
              notes: pattern.notes,
              stepMeta: pattern.stepMeta,
              stepCount: pattern.stepCount,
              name: pattern.name || p.name,
              generation: pattern.generation,
            }
          : p,
      ),
      ...projectUpdates,
    };
    return snapshot("generatePattern", `Replace with ${pattern.name}`, doc, next);
  }

  const scene: Scene = {
    id: uid("scene"),
    name: pattern.name,
    patternId: pattern.id,
    intensity: 0.7,
  };

  const next: ProjectDocument = {
    ...doc,
    patterns: [...doc.patterns, pattern],
    scenes: [...doc.scenes, scene],
    activePatternId: pattern.id,
    ...projectUpdates,
  };
  return snapshot("generatePattern", `Generate ${pattern.name}`, doc, next);
}

/**
 * Wave 1 — apply a generation result TOGETHER with the FX requests riding
 * its intent (`result.plan.intent.fx`, e.g. "wobbly drill"): pattern fold +
 * production fold in ONE undoable snapshot. Preview parity holds — the
 * candidate carries the same fx field the USE path applies.
 */
export function applyGenerationResultWithFxCommand(
  doc: ProjectDocument,
  result: GenerationResult,
  patternName?: string,
): Command {
  const patternCmd = applyGenerationResultCommand(doc, result, patternName);
  const fx = result.plan.intent.fx ?? null;
  if (!fx) return patternCmd;
  const next = foldProductionIntent(patternCmd.execute(doc), fx);
  return snapshot(
    "applyGenerationWithFx",
    `${patternCmd.label} + ${fx.goals.map((g) => g.concept).join(", ")}`,
    doc,
    next,
  );
}

/**
 * Generate (synchronously, heuristic ranking) and apply in one step.
 *
 * Direct generate-and-apply flows without a preview (e.g. AI Flip in the
 * arrangement panel) — there is no previewed result to protect, so the
 * generation is the single source. Preview/apply surfaces must NOT use this:
 * generate once via the Intent Engine and apply the previewed result with
 * {@link applyGenerationResultCommand} instead.
 */
export function generatePatternCommand(doc: ProjectDocument, options: GenerateOptions, patternName?: string): Command {
  const result = generateLocalResultFromOptions(doc, options, "apply");
  return applyGenerationResultCommand(doc, result, patternName);
}

/* ---------------- Pattern assist (iteration on your idea) ---------------- */

function drumPadsOf(doc: ProjectDocument): DrumPad[] {
  const track = doc.tracks.find((t): t is DrumTrack => t.kind === "drum");
  return track ? track.pads : [];
}

export function setEffectSidechainSource(
  doc: ProjectDocument,
  trackId: string,
  fxId: string,
  sourceTrackId: string | null,
): Command {
  const targetTrack = doc.tracks.find((track) => track.id === trackId);
  const target = trackEffectsOf(doc, trackId).find((fx) => fx.id === fxId);
  if (!targetTrack || !target) throw new Error(`Effect ${fxId} not found`);
  if (sourceTrackId !== null) {
    if (sourceTrackId === trackId) throw new Error("A track cannot sidechain itself");
    if (!doc.tracks.some((track) => track.id === sourceTrackId))
      throw new Error(`Sidechain source ${sourceTrackId} not found`);
  }
  const previous = target.sidechainTrackId ?? null;
  const apply = (d: ProjectDocument, source: string | null): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((fx) => (fx.id === fxId ? { ...fx, sidechainTrackId: source } : fx)),
    );
  return {
    type: "setEffectSidechainSource",
    label: sourceTrackId ? "Set sidechain source" : "Clear sidechain source",
    execute: (d) => apply(d, sourceTrackId),
    undo: (d) => apply(d, previous),
  };
}

export function applyEffectPreset(doc: ProjectDocument, trackId: string, fxId: string, preset: EffectPreset): Command {
  const target = trackEffectsOf(doc, trackId).find((fx) => fx.id === fxId);
  if (!target) throw new Error(`Effect ${fxId} not found`);
  if (target.type !== preset.type) throw new Error("Preset does not match effect type");
  const previous = { ...target.params };
  const previousSteps = target.steps ? [...target.steps] : undefined;
  const previousVolume = target.volumeSteps ? [...target.volumeSteps] : undefined;
  const previousPitch = target.pitchSteps ? [...target.pitchSteps] : undefined;
  const previousTrim = target.outputTrimDb ?? 0;
  const nextParams = { ...target.params };
  for (const [id, value] of Object.entries(preset.params)) nextParams[id] = clampEffectParam(target.type, id, value);
  const nextSteps = preset.steps ? sanitizeGateSteps(preset.steps) : target.steps;
  const nextVolume = preset.volumeSteps ? sanitizeManglerSteps(preset.volumeSteps, 0, 1, 1) : target.volumeSteps;
  const nextPitch = preset.pitchSteps ? sanitizeManglerSteps(preset.pitchSteps, -24, 24, 0) : target.pitchSteps;
  const nextTrim = clampFxOutputTrimDb(preset.outputTrimDb ?? factoryFxPresetGainDb(preset.id));
  const apply = (
    d: ProjectDocument,
    params: Record<string, number>,
    steps: number[] | undefined,
    volume: number[] | undefined,
    pitch: number[] | undefined,
    outputTrimDb: number,
  ): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((fx) => {
        if (fx.id !== fxId) return fx;
        const { outputTrimDb: _previousTrim, ...withoutTrim } = fx;
        return {
          ...withoutTrim,
          params: { ...params },
          steps,
          volumeSteps: volume,
          pitchSteps: pitch,
          ...(outputTrimDb !== 0 ? { outputTrimDb } : {}),
        };
      }),
    );
  return {
    type: "applyEffectPreset",
    label: `Apply ${preset.name} preset`,
    execute: (d) => apply(d, nextParams, nextSteps, nextVolume, nextPitch, nextTrim),
    undo: (d) => apply(d, previous, previousSteps, previousVolume, previousPitch, previousTrim),
  };
}

/** Reset an effect to its complete schema default in one undoable operation. */
export function resetEffect(doc: ProjectDocument, trackId: string, fxId: string): Command {
  const target = trackEffectsOf(doc, trackId).find((fx) => fx.id === fxId);
  if (!target) throw new Error(`Effect ${fxId} not found`);

  const previousParams = { ...target.params };
  const previousTrim = target.outputTrimDb ?? 0;
  // Flagship plugins expose deep, namespaced DSP parameters in addition to
  // the compact rack surface. normalizePluginParams({}) builds a complete,
  // schema-valid default map so reset cannot leave stale hidden parameters in
  // the worklet after a prior preset or A/B recall.
  const nextParams = normalizePluginParams(target.type, {}) ?? defaultParamsOf(target.type);
  const apply = (d: ProjectDocument, params: Record<string, number>, outputTrimDb: number): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((fx) => {
        if (fx.id !== fxId) return fx;
        const { outputTrimDb: _previousTrim, ...withoutTrim } = fx;
        return outputTrimDb === 0
          ? { ...withoutTrim, params: { ...params } }
          : { ...withoutTrim, params: { ...params }, outputTrimDb };
      }),
    );

  return {
    type: "resetEffect",
    label: `Reset ${EFFECT_META[target.type].name}`,
    execute: (d) => apply(d, nextParams, 0),
    undo: (d) => apply(d, previousParams, previousTrim),
  };
}

function applyRowsPatch(
  doc: ProjectDocument,
  patternId: string,
  patch: import("../assist/patternOps").RowsPatch,
): ProjectDocument {
  return {
    ...doc,
    patterns: doc.patterns.map((p) => {
      if (p.id !== patternId) return p;
      const stepCount = patch.stepCount ?? p.stepCount;
      const sourceRows = { ...p.rows, ...patch.rows };
      const rows = Object.fromEntries(
        Object.entries(sourceRows).map(([padId, row]) => [
          padId,
          new Array<number>(stepCount).fill(0).map((_, step) => row[step] ?? 0),
        ]),
      );
      const mergedMeta: NonNullable<Pattern["stepMeta"]> = Object.fromEntries(
        Object.entries(p.stepMeta ?? {}).map(([padId, padMeta]) => [padId, { ...padMeta }]),
      );
      if (patch.clearStepMeta) {
        const padIds = patch.clearStepMeta.padIds
          ? new Set(patch.clearStepMeta.padIds)
          : new Set(Object.keys(mergedMeta));
        for (const padId of padIds) {
          const padMeta = mergedMeta[padId];
          if (!padMeta) continue;
          for (const stepKey of Object.keys(padMeta)) {
            const step = Number(stepKey);
            if (step >= patch.clearStepMeta.from && step < patch.clearStepMeta.to) delete padMeta[step];
          }
        }
      }
      for (const [padId, padMeta] of Object.entries(patch.stepMeta ?? {})) {
        mergedMeta[padId] = { ...(mergedMeta[padId] ?? {}), ...padMeta };
      }
      const cleanedMeta: NonNullable<Pattern["stepMeta"]> = {};
      for (const [padId, padMeta] of Object.entries(mergedMeta)) {
        const row = rows[padId];
        if (!row) continue;
        const cleanSteps: Record<number, StepMeta> = {};
        for (const [stepKey, meta] of Object.entries(padMeta)) {
          const step = Number(stepKey);
          if (Number.isInteger(step) && step >= 0 && step < stepCount && row[step] > 0) {
            cleanSteps[step] = { ...meta };
          }
        }
        if (Object.keys(cleanSteps).length > 0) cleanedMeta[padId] = cleanSteps;
      }
      const notes = patch.notes
        ? Object.fromEntries(
            Object.entries(patch.notes).map(([trackId, noteList]) => [
              trackId,
              noteList
                .map((note) => ({ ...note }))
                .filter((note) => note.start >= 0 && note.start + note.duration <= stepCount * STEP_TICKS),
            ]),
          )
        : p.notes;
      return {
        ...p,
        rows,
        notes,
        stepCount,
        stepMeta: Object.keys(cleanedMeta).length > 0 ? cleanedMeta : undefined,
        phrasePlan: patch.phrasePlan ?? p.phrasePlan,
      };
    }),
  };
}

/** Remove the project-local slice edit from a pad while keeping its asset. */
export function resetPadSlice(doc: ProjectDocument, padId: string): Command {
  const pad = doc.tracks.flatMap((t) => (t.kind === "drum" ? t.pads : [])).find((p) => p.id === padId);
  if (!pad) throw new Error(`Pad ${padId} not found`);
  const next = withPad(doc, padId, (current) => {
    const clean = { ...current };
    delete clean.sliceStart;
    delete clean.sliceEnd;
    delete clean.sliceFadeIn;
    delete clean.sliceFadeOut;
    delete clean.sliceReverse;
    return clean;
  });
  return snapshot("resetPadSlice", `Reset slice on ${pad.name}`, doc, next);
}

export interface ChopSampleOptions {
  trackId: string;
  assetId: string;
  sourceName: string;
  slices: PadSlice[];
  createPattern: boolean;
}

/** Atomically map a source's first 16 slices and optionally create a pattern. */
export function chopSampleToPads(doc: ProjectDocument, options: ChopSampleOptions): Command {
  const track = doc.tracks.find((t): t is DrumTrack => t.id === options.trackId && t.kind === "drum");
  if (!track) throw new Error(`Drum track ${options.trackId} not found`);
  const fit = options.slices.slice(0, track.pads.length);
  let next = sliceToPads(doc, options.trackId, options.assetId, fit, options.sourceName).execute(doc);

  if (options.createPattern) {
    const pattern = createPatternForDoc(next, `${options.sourceName} Chop`, 16);
    const rows = { ...pattern.rows };
    fit.forEach((_, index) => {
      const pad = track.pads[index];
      if (!pad) return;
      const row = [...(rows[pad.id] ?? new Array<number>(16).fill(0))];
      row[index] = 0.9;
      rows[pad.id] = row;
    });
    const choppedPattern = { ...pattern, rows };
    next = {
      ...next,
      patterns: [...next.patterns, choppedPattern],
      activePatternId: choppedPattern.id,
    };
  }

  return snapshot(
    "chopSampleToPads",
    options.createPattern ? `Chop ${fit.length} slices + create pattern` : `Chop ${fit.length} slices to pads`,
    doc,
    next,
  );
}

function assistCommand(
  type: string,
  label: string,
  doc: ProjectDocument,
  patternId: string,
  input: AssistInput,
): Command {
  const sourcePattern = doc.patterns.find((pattern) => pattern.id === patternId);
  if (!sourcePattern) throw new Error(`Pattern ${patternId} not found`);
  const request = normalizeAssistRequest(input);
  const patch = buildAssistPatch(sourcePattern, drumPadsOf(doc), request);
  const patchedDoc = applyRowsPatch(doc, patternId, patch);
  const patchedPattern = patchedDoc.patterns.find((pattern) => pattern.id === patternId);
  if (!patchedPattern) throw new Error(`Pattern ${patternId} disappeared during Assist operation`);
  const sourceContentHash = contentHash(canonicalizePattern(doc, sourcePattern));
  const outputContentHash = contentHash(canonicalizePattern(patchedDoc, patchedPattern));
  const assist: PatternAssist = {
    engineId: ASSIST_ENGINE_ID,
    engineVersion: ASSIST_ENGINE_VERSION,
    operation: request.operation,
    seed: request.seed,
    sourceContentHash,
    outputContentHash,
    ...(request.operation === "vary" ? { amount: request.amount } : {}),
    ...(request.operation === "build" ? { bars: request.bars } : {}),
    ...(request.operation === "replace" ? { target: request.target, style: request.style } : {}),
  };
  const next: ProjectDocument = {
    ...patchedDoc,
    patterns: patchedDoc.patterns.map((pattern) => {
      if (pattern.id !== patternId) return pattern;
      if (!pattern.generation) return { ...pattern, assist };
      const generation = {
        ...pattern.generation,
        inputContentHash: sourceContentHash,
        outputContentHash,
      };
      delete generation.quality;
      return { ...pattern, assist, generation };
    }),
  };
  return snapshot(type, label, doc, next);
}

/** Vary the active pattern: velocity humanization + ghost notes + micro feel. */
export function assistVary(doc: ProjectDocument, patternId: string, seed: string, amount: number): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  return assistCommand("assistVary", `Vary ${pattern.name} (${seed})`, doc, patternId, {
    operation: "vary",
    seed,
    amount,
  });
}

/** Expand the pattern to `bars` with a progressive element + energy build. */
export function assistBuild(doc: ProjectDocument, patternId: string, bars: number, seed: string): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  return assistCommand("assistBuild", `Build ${pattern.name} to ${bars} bars`, doc, patternId, {
    operation: "build",
    bars,
    seed,
  });
}

/** Replace one pad family's groove with a style (hats → house, kicks → trap…). */
export function assistReplace(
  doc: ProjectDocument,
  patternId: string,
  target: import("../assist/patternOps").ReplaceTarget,
  style: string,
  seed: string,
): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  return assistCommand("assistReplace", `${target} → ${style}`, doc, patternId, {
    operation: "replace",
    target,
    style,
    seed,
  });
}

/** Crescendo snare fill over the pattern's last bar. */
export function assistFill(doc: ProjectDocument, patternId: string, seed: string): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  return assistCommand("assistFill", `Fill ${pattern.name} (${seed})`, doc, patternId, { operation: "fill", seed });
}
