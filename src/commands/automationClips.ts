import type {
  ArrangementAutomationClip,
  AutomationPoint,
  AutomationTarget,
  ProjectDocument,
} from "../project-model/types";
import { STEP_TICKS } from "../project-model/types";
import { insertPointSorted } from "../project-model/automation";
import { clampTargetValue, isAutomationTargetValid, targetParamDef } from "../project-model/targets";
import { MAX_ARRANGEMENT_CLIP_TICKS } from "../project-model/schema";
import { uid } from "../shared/ids";
import { clipGroupsWithoutIds } from "./clipGroups";
import { unlinkMarkersOfClips } from "./docOps";
import { snapshot } from "./core";
import type { Command } from "./types";

function clipOf(doc: ProjectDocument, clipId: string): ArrangementAutomationClip {
  const clip = doc.arrangement.automationClips?.find((candidate) => candidate.id === clipId);
  if (!clip) throw new Error(`Automation clip ${clipId} not found`);
  return clip;
}

function editable(clip: ArrangementAutomationClip): void {
  if (clip.locked) throw new Error("Automation clip is locked");
}

function safeGeometry(startTick: number, lengthTicks: number): { startTick: number; lengthTicks: number } {
  if (!Number.isFinite(startTick) || !Number.isFinite(lengthTicks)) {
    throw new Error("Automation clip position and length must be finite ticks");
  }
  const length = Math.min(MAX_ARRANGEMENT_CLIP_TICKS, Math.max(1, Math.round(lengthTicks)));
  const start = Math.min(MAX_ARRANGEMENT_CLIP_TICKS - length, Math.max(0, Math.round(startTick)));
  return { startTick: start, lengthTicks: length };
}

function withClip(doc: ProjectDocument, nextClip: ArrangementAutomationClip): ProjectDocument {
  const automationClips = (doc.arrangement.automationClips ?? [])
    .map((clip) => (clip.id === nextClip.id ? nextClip : clip))
    .sort((a, b) => a.startTick - b.startTick);
  return { ...doc, arrangement: { ...doc.arrangement, automationClips } };
}

export function addAutomationClip(
  doc: ProjectDocument,
  target: AutomationTarget,
  startTick: number,
  lengthTicks: number,
  points: AutomationPoint[],
): Command {
  if (!isAutomationTargetValid(doc, target)) throw new Error("Invalid automation clip target");
  const geometry = safeGeometry(startTick, lengthTicks);
  const curve = points
    .filter((point) => Number.isFinite(point.tick) && Number.isFinite(point.value))
    .map((point) => ({
      tick: Math.min(MAX_ARRANGEMENT_CLIP_TICKS, Math.max(0, Math.round(point.tick))),
      value: clampTargetValue(doc, target, point.value),
    }))
    .sort((a, b) => a.tick - b.tick)
    .slice(0, 16384);
  if (curve.length === 0) {
    const value = targetParamDef(doc, target)?.default ?? 0;
    curve.push({ tick: 0, value }, { tick: geometry.lengthTicks, value });
  }
  const clip: ArrangementAutomationClip = {
    id: uid("autoclip"),
    target: { ...target },
    ...geometry,
    points: curve,
  };
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      automationClips: [...(doc.arrangement.automationClips ?? []), clip].sort((a, b) => a.startTick - b.startTick),
    },
  };
  return snapshot("addAutomationClip", "Add arrangement automation clip", doc, next);
}

/** Copy a MOD lane to the song timeline at the active pattern's phrase length. */
export function addAutomationClipFromLane(doc: ProjectDocument, laneId: string, startTick: number): Command {
  const lane = doc.automation.find((candidate) => candidate.id === laneId);
  if (!lane) throw new Error(`Automation lane ${laneId} not found`);
  const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId) ?? doc.patterns[0];
  if (!pattern) throw new Error("Automation clips need a source pattern length");
  const lengthTicks = Math.max(STEP_TICKS, pattern.stepCount * STEP_TICKS);
  const points = lane.points.length > 0 ? lane.points.map((point) => ({ ...point })) : [];
  return addAutomationClip(doc, lane.target, startTick, lengthTicks, points);
}

export function moveAutomationClip(doc: ProjectDocument, clipId: string, startTick: number): Command {
  const clip = clipOf(doc, clipId);
  editable(clip);
  const geometry = safeGeometry(startTick, clip.lengthTicks);
  return snapshot("moveAutomationClip", "Move automation clip", doc, withClip(doc, { ...clip, ...geometry }));
}

export function resizeAutomationClip(doc: ProjectDocument, clipId: string, lengthTicks: number): Command {
  const clip = clipOf(doc, clipId);
  editable(clip);
  const geometry = safeGeometry(
    clip.startTick,
    Math.min(lengthTicks, MAX_ARRANGEMENT_CLIP_TICKS - (clip.phaseOffsetTicks ?? 0)),
  );
  return snapshot("resizeAutomationClip", "Resize automation clip", doc, withClip(doc, { ...clip, ...geometry }));
}

export function trimAutomationClipStart(doc: ProjectDocument, clipId: string, startTick: number): Command {
  const clip = clipOf(doc, clipId);
  editable(clip);
  if (!Number.isFinite(startTick)) throw new Error("Automation clip trim position must be finite ticks");
  const endTick = clip.startTick + clip.lengthTicks;
  const nextStart = Math.max(0, Math.min(endTick - 1, Math.round(startTick)));
  const phase = (clip.phaseOffsetTicks ?? 0) + nextStart - clip.startTick;
  const nextClip: ArrangementAutomationClip = { ...clip, startTick: nextStart, lengthTicks: endTick - nextStart };
  if (phase > 0) nextClip.phaseOffsetTicks = phase;
  else delete nextClip.phaseOffsetTicks;
  return snapshot("trimAutomationClipStart", "Trim automation clip start", doc, withClip(doc, nextClip));
}

export function splitAutomationClipAtTick(doc: ProjectDocument, clipId: string, splitTick: number): Command {
  const clip = clipOf(doc, clipId);
  editable(clip);
  if (!Number.isFinite(splitTick)) throw new Error("Automation clip split position must be finite ticks");
  const split = Math.round(splitTick);
  const end = clip.startTick + clip.lengthTicks;
  if (split <= clip.startTick || split >= end) throw new Error("Split must leave two non-empty automation clips");
  const phase = (clip.phaseOffsetTicks ?? 0) + split - clip.startTick;
  const right: ArrangementAutomationClip = {
    ...clip,
    id: uid("autoclip"),
    startTick: split,
    lengthTicks: end - split,
    ...(phase > 0 ? { phaseOffsetTicks: phase } : {}),
  };
  const left = { ...clip, lengthTicks: split - clip.startTick };
  const automationClips = (doc.arrangement.automationClips ?? [])
    .flatMap((candidate) => (candidate.id === clipId ? [left, right] : [candidate]))
    .sort((a, b) => a.startTick - b.startTick);
  return snapshot("splitAutomationClipAtTick", "Split automation clip", doc, {
    ...doc,
    arrangement: { ...doc.arrangement, automationClips },
  });
}

export function duplicateAutomationClip(doc: ProjectDocument, clipId: string, startTick?: number): Command {
  const source = clipOf(doc, clipId);
  const geometry = safeGeometry(startTick ?? source.startTick + source.lengthTicks, source.lengthTicks);
  const copy: ArrangementAutomationClip = {
    ...source,
    id: uid("autoclip"),
    ...geometry,
    points: source.points.map((p) => ({ ...p })),
  };
  return snapshot("duplicateAutomationClip", "Duplicate automation clip", doc, {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      automationClips: [...(doc.arrangement.automationClips ?? []), copy].sort((a, b) => a.startTick - b.startTick),
    },
  });
}

export function addAutomationClipPoint(
  doc: ProjectDocument,
  clipId: string,
  visibleTick: number,
  value: number,
): Command {
  const clip = clipOf(doc, clipId);
  editable(clip);
  if (!Number.isFinite(visibleTick) || !Number.isFinite(value)) throw new Error("Automation point must be finite");
  const tick = (clip.phaseOffsetTicks ?? 0) + Math.max(0, Math.min(clip.lengthTicks, Math.round(visibleTick)));
  const point = { tick, value: clampTargetValue(doc, clip.target, value) };
  const points = clip.points.filter((candidate) => candidate.tick !== tick);
  return snapshot(
    "addAutomationClipPoint",
    "Add automation clip point",
    doc,
    withClip(doc, {
      ...clip,
      points: insertPointSorted(points, point),
    }),
  );
}

export function removeAutomationClipPoint(doc: ProjectDocument, clipId: string, pointIndex: number): Command {
  const clip = clipOf(doc, clipId);
  editable(clip);
  if (!Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex >= clip.points.length)
    return snapshot("removeAutomationClipPoint", "Remove automation point", doc, doc);
  return snapshot(
    "removeAutomationClipPoint",
    "Remove automation clip point",
    doc,
    withClip(doc, {
      ...clip,
      points: clip.points.filter((_point, index) => index !== pointIndex),
    }),
  );
}

export function moveAutomationClipPoint(
  doc: ProjectDocument,
  clipId: string,
  pointIndex: number,
  visibleTick: number,
  value: number,
): Command {
  const clip = clipOf(doc, clipId);
  editable(clip);
  if (
    !Number.isInteger(pointIndex) ||
    pointIndex < 0 ||
    pointIndex >= clip.points.length ||
    !Number.isFinite(visibleTick) ||
    !Number.isFinite(value)
  ) {
    throw new Error("Automation point position and value must be valid");
  }
  const tick = (clip.phaseOffsetTicks ?? 0) + Math.max(0, Math.min(clip.lengthTicks, Math.round(visibleTick)));
  const point = { tick, value: clampTargetValue(doc, clip.target, value) };
  const points = clip.points.filter((_candidate, index) => index !== pointIndex && _candidate.tick !== tick);
  return snapshot(
    "moveAutomationClipPoint",
    "Move automation clip point",
    doc,
    withClip(doc, { ...clip, points: insertPointSorted(points, point) }),
  );
}

export function setAutomationClipMuted(doc: ProjectDocument, clipId: string, muted: boolean): Command {
  const clip = clipOf(doc, clipId);
  const next = { ...clip };
  if (muted) next.muted = true;
  else delete next.muted;
  return snapshot("setAutomationClipMuted", `${muted ? "Mute" : "Unmute"} automation clip`, doc, withClip(doc, next));
}

export function setAutomationClipLocked(doc: ProjectDocument, clipId: string, locked: boolean): Command {
  const clip = clipOf(doc, clipId);
  const next = { ...clip };
  if (locked) next.locked = true;
  else delete next.locked;
  return snapshot("setAutomationClipLocked", `${locked ? "Lock" : "Unlock"} automation clip`, doc, withClip(doc, next));
}

export function deleteAutomationClip(doc: ProjectDocument, clipId: string): Command {
  const clip = clipOf(doc, clipId);
  editable(clip);
  const removed = new Set([clipId]);
  const automationClips = (doc.arrangement.automationClips ?? []).filter((candidate) => candidate.id !== clipId);
  const markers = unlinkMarkersOfClips(doc.markers, removed);
  const clipGroups = clipGroupsWithoutIds(doc.arrangement.clipGroups, [clipId]);
  return snapshot("deleteAutomationClip", "Delete automation clip", doc, {
    ...doc,
    ...(markers ? { markers } : {}),
    arrangement: {
      ...doc.arrangement,
      automationClips,
      ...(clipGroups ? { clipGroups } : {}),
      ...(doc.arrangement.clipGroups && clipGroups?.length === 0 ? { clipGroups: undefined } : {}),
    },
  });
}
