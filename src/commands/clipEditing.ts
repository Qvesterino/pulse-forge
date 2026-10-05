/**
 * Clip surgery: tempo-fit to a bar grid, slice onto the arrangement, duplicate, bounce stems
 * back in as audio, split at a tick, strip silence, consolidate overlapping clips.
 *
 * splitAudioClipAtTick is the one to be careful with: a split that would leave a fragment
 * shorter than the fade region produces a click, so the real implementation lives in an
 * internal helper that enforces the minimum and the exported command delegates to it.
 */
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
  Pattern,
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
  clampArrangementTransitionType,
  createGroupTrackModel,
  createPatternForDoc,
  MAX_ARRANGEMENT_CLIP_BARS,
  MAX_BPM,
  MIN_BPM,
  normalizeProject,
  sanitizeArrangementTransitions,
  sceneRoleOf,
} from "../project-model/schema";
import { sanitizeGateSteps, sanitizeManglerSteps } from "../project-model/modulators";
import { clampEffectParam, defaultParamsOf, EFFECT_META, normalizePluginParams } from "../effects/definitions";
import type { EffectPreset } from "../effects/presets";
import { clampFxOutputTrimDb, factoryFxPresetGainDb } from "../effects/presetLoudness";
import { uid } from "../shared/ids";
import type { SharedPackSceneSketch, SharedPackSketch } from "../export/packCode";
import { resolveGrooveForGeneration } from "../ai/generator";
import { generateLocalResultFromOptions } from "../intent/pipeline";
import type { GenerationResult } from "../intent/types";
import type { GenerateOptions } from "../ai/types";
import { buildAssistPatch, normalizeAssistRequest } from "../assist/pipeline";
import type { AssistInput } from "../assist/types";
import { ASSIST_ENGINE_ID, ASSIST_ENGINE_VERSION } from "../assist/types";
import { canonicalizePattern, contentHash } from "../ai/evaluation";
import { snapshot } from "./core";
import { cloneStepMeta, unlinkMarkersOfClips } from "./docOps";
import { addAudioClip, audioClipDurationSec, clampClipFades } from "./audioClips";

/* ---------------- clip editing ---------------- */
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

export function splitAudioClipAtTickWithMinimumFragment(
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
