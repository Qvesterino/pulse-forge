/**
 * Scene automation lanes: the curve a scene can follow over time, and the points on it.
 *
 * Values go through the shared target clamp rather than their own bounds, so a lane cannot hold a
 * value the mixer would later reject.
 */
import type { Command } from "./types";
import type { AutomationTarget, ProjectDocument, SceneAutomation } from "../project-model/types";
import { clampTargetValue, isAutomationTargetValid, targetParamDef } from "../project-model/targets";
import { uid } from "../shared/ids";
import { snapshot } from "./core";

/* ---------------- scene automation ---------------- */ export function addSceneAutomation(
  doc: ProjectDocument,
  sceneId: string,
  target: AutomationTarget,
): Command {
  if (!doc.scenes.some((s) => s.id === sceneId)) throw new Error(`Scene ${sceneId} not found`);
  if (!isAutomationTargetValid(doc, target)) throw new Error("Invalid scene automation target");
  if (
    doc.sceneAutomation.some(
      (lane) =>
        lane.sceneId === sceneId &&
        lane.target.kind === target.kind &&
        lane.target.trackId === target.trackId &&
        lane.target.fxId === target.fxId &&
        lane.target.paramId === target.paramId,
    )
  ) {
    throw new Error("Scene automation lane for this target already exists");
  }
  const initial = clampTargetValue(doc, target, targetParamDef(doc, target)?.default ?? 0);
  // Copy the caller's target: the lane must not alias an object the caller
  // could later mutate in place (doc and undo snapshot would diverge).
  const lane: SceneAutomation = {
    id: uid("sceneAuto"),
    sceneId,
    target: { ...target },
    points: [{ tick: 0, value: initial }],
  };
  const next = { ...doc, sceneAutomation: [...doc.sceneAutomation, lane] };
  return snapshot("addSceneAutomation", "Add scene lane", doc, next);
}
export function removeSceneAutomation(doc: ProjectDocument, laneId: string): Command {
  const target = doc.sceneAutomation.find((l) => l.id === laneId);
  if (!target) throw new Error(`Scene lane ${laneId} not found`);
  const next = { ...doc, sceneAutomation: doc.sceneAutomation.filter((l) => l.id !== laneId) };
  return snapshot("removeSceneAutomation", "Remove scene lane", doc, next);
}
export function addSceneAutomationPoint(doc: ProjectDocument, laneId: string, tick: number, value: number): Command {
  const lane = doc.sceneAutomation.find((l) => l.id === laneId);
  if (!lane) throw new Error(`Scene lane ${laneId} not found`);
  const clampedValue = clampTargetValue(doc, lane.target, value);
  const next = {
    ...doc,
    sceneAutomation: doc.sceneAutomation.map((l) =>
      l.id === laneId
        ? {
            ...l,
            points: [...l.points, { tick: Math.max(0, Math.floor(tick)), value: clampedValue }].sort(
              (a, b) => a.tick - b.tick,
            ),
          }
        : l,
    ),
  };
  return snapshot("addSceneAutomationPoint", "Add scene point", doc, next);
}
export function moveSceneAutomationPoint(
  doc: ProjectDocument,
  laneId: string,
  index: number,
  delta: { tick?: number; value?: number },
): Command {
  const lane = doc.sceneAutomation.find((l) => l.id === laneId);
  if (!lane) throw new Error(`Scene lane ${laneId} not found`);
  if (index < 0 || index >= lane.points.length) throw new Error("Scene point out of range");
  const nextValue = delta.value === undefined ? undefined : clampTargetValue(doc, lane.target, delta.value);
  // Audit 06 D3: re-anchor by identity/(tick,value) like the project lanes.
  const original = lane.points[index]!;
  const next = {
    ...doc,
    sceneAutomation: doc.sceneAutomation.map((l) => {
      if (l.id !== laneId) return l;
      let at = l.points.findIndex((p) => p === original);
      if (at === -1) at = l.points.findIndex((p) => p.tick === original.tick && p.value === original.value);
      if (at === -1) return l;
      const points = [...l.points];
      points[at] = {
        tick:
          delta.tick !== undefined && Number.isFinite(delta.tick) ? Math.max(0, Math.floor(delta.tick)) : original.tick,
        value: nextValue ?? original.value,
      };
      points.sort((a, b) => a.tick - b.tick);
      return { ...l, points };
    }),
  };
  return snapshot("moveSceneAutomationPoint", "Move scene point", doc, next);
}
export function removeSceneAutomationPoint(doc: ProjectDocument, laneId: string, index: number): Command {
  const lane = doc.sceneAutomation.find((l) => l.id === laneId);
  if (!lane) throw new Error(`Scene lane ${laneId} not found`);
  if (index < 0 || index >= lane.points.length) throw new Error("Scene point out of range");
  const removed = lane.points[index];
  const next = {
    ...doc,
    sceneAutomation: doc.sceneAutomation.map((l) => {
      if (l.id !== laneId) return l;
      // Audit 06 D3: same re-anchor as the project-lane delete.
      let at = l.points.findIndex((p) => p === removed);
      if (at === -1) at = l.points.findIndex((p) => p.tick === removed.tick && p.value === removed.value);
      if (at === -1) return l;
      const points = [...l.points];
      points.splice(at, 1);
      return { ...l, points };
    }),
  };
  return snapshot("removeSceneAutomationPoint", "Remove scene point", doc, next);
}
