import { useEffect, useRef, useState } from "react";
import type { Command } from "../../commands/types";
import {
  addAutomationClip,
  addAutomationClipFromLane,
  addAutomationClipPoint,
  deleteAutomationClip,
  duplicateAutomationClip,
  linkAutomationClipTarget,
  moveAutomationClipPoint,
  moveAutomationClip,
  removeAutomationClipPoint,
  resizeAutomationClip,
  setAutomationClipLocked,
  setAutomationClipMuted,
  trimAutomationClipStart,
  unlinkAutomationClipTarget,
} from "../../commands/automationClips";
import { arrangementAutomationSegmentsInWindow } from "../../project-model/events";
import { nudgeClips } from "../../commands/clipEditing";
import { valueAt } from "../../project-model/automation";
import type { ArrangementAutomationClip, AutomationTarget, ProjectDocument } from "../../project-model/types";
import { BAR_TICKS, STEP_TICKS } from "../../project-model/types";
import {
  automationClipForTarget,
  automationTargetKey,
  automationTargetsOfClip,
  mapAutomationValueBetweenTargets,
  targetParamDef,
} from "../../project-model/targets";
import { snapBarsFor, snapTick, type SnapGridId } from "../snap";
import {
  clearTimelineGroupDragPreview,
  publishTimelineGroupDragPreview,
  useTimelineGroupDragPreview,
} from "./groupDragPreview";

interface AutomationClipLanesProps {
  doc: ProjectDocument;
  automationClips: ArrangementAutomationClip[];
  selectedClipId: string | null;
  totalBars: number;
  barWidth: number;
  snapGrid: SnapGridId;
  playheadTick: number;
  onExecute: (command: Command) => boolean;
  onSelect: (clipId: string) => void;
}

interface DragState {
  clipId: string;
  pointerId: number;
  mode: "move" | "resize" | "trim";
  clientX: number;
  startTick: number;
  lengthTicks: number;
  nextStartTick: number;
  nextLengthTicks: number;
  barWidthAt: number;
  groupId?: string;
  groupClipIds?: string[];
  groupHasScene?: boolean;
}

interface PointDragState {
  clipId: string;
  target: AutomationTarget;
  pointIndex: number;
  pointerId: number;
  visibleTick: number;
  value: number;
}

function snapped(tick: number, grid: SnapGridId, free: boolean): number {
  const bars = free ? null : snapBarsFor(grid);
  return Math.max(0, Math.round(bars === null ? tick : snapTick(tick, bars)));
}

function snappedDelta(tick: number, grid: SnapGridId, free: boolean): number {
  const bars = free ? null : snapBarsFor(grid);
  return Math.round(bars === null ? tick : snapTick(tick, bars));
}

function targetName(doc: ProjectDocument, target: AutomationTarget): string {
  const track = doc.tracks.find((candidate) => candidate.id === target.trackId);
  const ret = doc.returns.find((candidate) => candidate.id === target.trackId);
  const owner = track?.name ?? ret?.name ?? "Unknown target";
  if (target.kind === "trackGain") return `${owner} · Volume`;
  if (target.kind === "trackPan") return `${owner} · Pan`;
  return `${owner} · ${target.paramId ?? target.kind}`;
}

function valueRange(
  doc: ProjectDocument,
  target: AutomationTarget,
  clip: ArrangementAutomationClip,
): { min: number; max: number } {
  const def = targetParamDef(doc, target);
  if (def && (target.kind === "trackGain" || target.kind === "trackPan")) return { min: def.min, max: def.max };
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const point of clip.points) {
    if (!Number.isFinite(point.value)) continue;
    min = Math.min(min, point.value);
    max = Math.max(max, point.value);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  const padding = max > min ? (max - min) * 0.08 : Math.max(1, Math.abs(min) * 0.25);
  return {
    min: Math.max(def?.min ?? Number.NEGATIVE_INFINITY, min - padding),
    max: Math.min(def?.max ?? Number.POSITIVE_INFINITY, max + padding),
  };
}

function curvePath(clip: ArrangementAutomationClip, range: { min: number; max: number }, stepped = false): string {
  if (clip.points.length === 0) return "";
  const { min, max } = range;
  const span = max - min || 1;
  const phase = clip.phaseOffsetTicks ?? 0;
  const points = [...clip.points].sort((a, b) => a.tick - b.tick);
  const valueAtCurve = (tick: number) => {
    if (!stepped) return valueAt(points, tick, 0);
    let value = 0;
    for (const point of points) {
      if (point.tick > tick) break;
      value = point.value;
    }
    return Math.round(value);
  };
  const visible = [
    { tick: phase, value: valueAtCurve(phase) },
    ...points
      .filter((point) => point.tick > phase && point.tick < phase + clip.lengthTicks)
      .map((point) => ({ ...point, value: stepped ? Math.round(point.value) : point.value })),
    {
      tick: phase + clip.lengthTicks,
      value: valueAtCurve(phase + clip.lengthTicks),
    },
  ];
  const xy = (point: { tick: number; value: number }) => {
    const x = ((point.tick - phase) / clip.lengthTicks) * 100;
    const y = 23 - ((point.value - min) / span) * 21;
    return { x: x.toFixed(2), y: Math.max(1, Math.min(23, y)).toFixed(2) };
  };
  const first = xy(visible[0]!);
  let path = `M${first.x} ${first.y}`;
  for (let index = 1; index < visible.length; index++) {
    const previous = xy(visible[index - 1]!);
    const current = xy(visible[index]!);
    path += stepped ? ` L${current.x} ${previous.y} L${current.x} ${current.y}` : ` L${current.x} ${current.y}`;
  }
  return path;
}

export function AutomationClipLanes({
  doc,
  automationClips,
  selectedClipId,
  totalBars,
  barWidth,
  snapGrid,
  playheadTick,
  onExecute,
  onSelect,
}: AutomationClipLanesProps) {
  const dragRef = useRef<DragState | null>(null);
  const pointDragRef = useRef<PointDragState | null>(null);
  const [preview, setPreview] = useState<DragState | null>(null);
  const groupDragPreview = useTimelineGroupDragPreview();
  const [pointPreview, setPointPreview] = useState<PointDragState | null>(null);
  const [menu, setMenu] = useState<{ clipId: string; x: number; y: number } | null>(null);
  const laneWidth = totalBars * barWidth;
  const targets = new Map<string, AutomationTarget>();
  for (const lane of doc.automation) targets.set(automationTargetKey(lane.target), lane.target);
  for (const clip of doc.arrangement.automationClips ?? []) {
    for (const target of automationTargetsOfClip(clip)) targets.set(automationTargetKey(target), target);
  }
  const clipsByTarget = new Map<string, ArrangementAutomationClip[]>();
  for (const clip of automationClips) {
    for (const target of automationTargetsOfClip(clip)) {
      const key = automationTargetKey(target);
      const clips = clipsByTarget.get(key) ?? [];
      clips.push(clip);
      clipsByTarget.set(key, clips);
    }
  }
  const playheadWinners = arrangementAutomationSegmentsInWindow(automationClips, playheadTick, playheadTick + 1);
  const winnerClipByTarget = new Map(
    playheadWinners.map((segment) => [automationTargetKey(segment.target), segment.clip.id]),
  );
  const activeClipCountByTarget = new Map<string, number>();
  for (const clip of automationClips) {
    if (clip.muted || playheadTick < clip.startTick || playheadTick >= clip.startTick + clip.lengthTicks) continue;
    for (const target of automationTargetsOfClip(clip)) {
      const key = automationTargetKey(target);
      activeClipCountByTarget.set(key, (activeClipCountByTarget.get(key) ?? 0) + 1);
    }
  }

  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      if (!(event.target as HTMLElement | null)?.closest(".arr-auto-clip-menu")) setMenu(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  const addForTarget = (target: AutomationTarget, startTick: number) => {
    const lane = doc.automation.find(
      (candidate) => automationTargetKey(candidate.target) === automationTargetKey(target),
    );
    if (lane) {
      onExecute(addAutomationClipFromLane(doc, lane.id, startTick));
      return;
    }
    const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId) ?? doc.patterns[0];
    if (!pattern) return;
    const length = Math.max(STEP_TICKS, pattern.stepCount * STEP_TICKS);
    const existing = doc.arrangement.automationClips?.find((clip) =>
      automationTargetsOfClip(clip).some((candidate) => automationTargetKey(candidate) === automationTargetKey(target)),
    );
    const mappedExisting = existing ? automationClipForTarget(doc, existing, target) : undefined;
    const value = mappedExisting?.points[0]?.value ?? targetParamDef(doc, target)?.default ?? 0;
    onExecute(
      addAutomationClip(doc, target, startTick, length, [
        { tick: 0, value },
        { tick: length, value },
      ]),
    );
  };

  const beginDrag = (event: React.PointerEvent<HTMLButtonElement>, clip: ArrangementAutomationClip) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    onSelect(clip.id);
    if (clip.locked) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const mode = x <= 7 ? "trim" : x >= rect.width - 8 ? "resize" : "move";
    const group =
      mode === "move"
        ? doc.arrangement.clipGroups?.find((candidate) => candidate.clipIds.includes(clip.id))
        : undefined;
    const groupClipIds = group?.clipIds ?? [];
    const groupId = groupClipIds.length > 1 ? group?.id : undefined;
    const groupHasScene = groupId
      ? doc.arrangement.clips.some((candidate) => groupClipIds.includes(candidate.id))
      : false;
    const next = {
      clipId: clip.id,
      pointerId: event.pointerId,
      mode,
      clientX: event.clientX,
      startTick: clip.startTick,
      lengthTicks: clip.lengthTicks,
      nextStartTick: clip.startTick,
      nextLengthTicks: clip.lengthTicks,
      barWidthAt: barWidth,
      ...(groupId ? { groupId, groupClipIds, groupHasScene } : {}),
    } satisfies DragState;
    dragRef.current = next;
    setPreview(next);
    if (groupId) publishTimelineGroupDragPreview(doc, groupId, groupClipIds);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updateDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const delta = ((event.clientX - current.clientX) / Math.max(1, current.barWidthAt)) * BAR_TICKS;
    if (current.groupId && current.groupClipIds) {
      const currentGroup = doc.arrangement.clipGroups?.find((group) => group.id === current.groupId);
      const stillSameGroup =
        currentGroup?.clipIds.length === current.groupClipIds.length &&
        current.groupClipIds.every((id) => currentGroup.clipIds.includes(id));
      if (!stillSameGroup) {
        clearTimelineGroupDragPreview();
        dragRef.current = null;
        setPreview(null);
        return;
      }
      const deltaTicks = current.groupHasScene
        ? Math.round(delta / BAR_TICKS) * BAR_TICKS
        : snappedDelta(delta, snapGrid, event.shiftKey);
      const planned = nudgeClips(doc, [current.clipId], deltaTicks / BAR_TICKS).execute(doc);
      const nextStartTick =
        planned.arrangement.automationClips?.find((candidate) => candidate.id === current.clipId)?.startTick ??
        current.startTick;
      const next = { ...current, nextStartTick, nextLengthTicks: current.lengthTicks };
      dragRef.current = next;
      setPreview(next);
      publishTimelineGroupDragPreview(planned, current.groupId, current.groupClipIds);
      return;
    }
    let nextStartTick = current.startTick;
    let nextLengthTicks = current.lengthTicks;
    if (current.mode === "move") {
      nextStartTick = snapped(current.startTick + delta, snapGrid, event.shiftKey);
    } else if (current.mode === "resize") {
      nextLengthTicks = Math.max(
        STEP_TICKS,
        snapped(current.startTick + current.lengthTicks + delta, snapGrid, event.shiftKey) - current.startTick,
      );
    } else {
      const end = current.startTick + current.lengthTicks;
      nextStartTick = Math.max(
        0,
        Math.min(end - STEP_TICKS, snapped(current.startTick + delta, snapGrid, event.shiftKey)),
      );
      nextLengthTicks = end - nextStartTick;
    }
    const next = { ...current, nextStartTick, nextLengthTicks };
    dragRef.current = next;
    setPreview(next);
  };

  const finishDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setPreview(null);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* Pointer capture may already have ended. */
    }
    if (current.groupId && current.groupClipIds) {
      const currentGroup = doc.arrangement.clipGroups?.find((group) => group.id === current.groupId);
      const stillSameGroup =
        currentGroup?.clipIds.length === current.groupClipIds.length &&
        current.groupClipIds.every((id) => currentGroup.clipIds.includes(id));
      clearTimelineGroupDragPreview();
      if (!stillSameGroup) return;
      const deltaTicks = current.nextStartTick - current.startTick;
      if (deltaTicks !== 0) onExecute(nudgeClips(doc, [current.clipId], deltaTicks / BAR_TICKS));
      return;
    }
    if (current.mode === "move" && current.nextStartTick !== current.startTick) {
      onExecute(moveAutomationClip(doc, current.clipId, current.nextStartTick));
    } else if (current.mode === "resize" && current.nextLengthTicks !== current.lengthTicks) {
      onExecute(resizeAutomationClip(doc, current.clipId, current.nextLengthTicks));
    } else if (current.mode === "trim" && current.nextStartTick !== current.startTick) {
      onExecute(trimAutomationClipStart(doc, current.clipId, current.nextStartTick));
    }
  };

  const cancelDrag = () => {
    dragRef.current = null;
    setPreview(null);
    clearTimelineGroupDragPreview();
  };

  const pointValueAtEvent = (
    event: React.PointerEvent<SVGCircleElement>,
    clip: ArrangementAutomationClip,
    target: AutomationTarget,
  ): { visibleTick: number; value: number } => {
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!rect) return { visibleTick: 0, value: 0 };
    const rawTick = ((event.clientX - rect.left) / Math.max(1, rect.width)) * clip.lengthTicks;
    const absoluteTick = snapped(clip.startTick + rawTick, snapGrid, event.shiftKey);
    const visibleTick = Math.max(0, Math.min(clip.lengthTicks, absoluteTick - clip.startTick));
    const mapped = automationClipForTarget(doc, clip, target);
    const range = valueRange(doc, target, mapped);
    const targetValue = range.max - ((event.clientY - rect.top) / Math.max(1, rect.height)) * (range.max - range.min);
    return { visibleTick, value: mapAutomationValueBetweenTargets(doc, target, clip.target, targetValue) };
  };

  const beginPointDrag = (
    event: React.PointerEvent<SVGCircleElement>,
    clip: ArrangementAutomationClip,
    pointIndex: number,
    target: AutomationTarget,
  ) => {
    event.stopPropagation();
    onSelect(clip.id);
    if (clip.locked) return;
    const point = clip.points[pointIndex];
    if (!point) return;
    const visibleTick = point.tick - (clip.phaseOffsetTicks ?? 0);
    const next = { clipId: clip.id, target, pointIndex, pointerId: event.pointerId, visibleTick, value: point.value };
    pointDragRef.current = next;
    setPointPreview(next);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updatePointDrag = (event: React.PointerEvent<SVGCircleElement>) => {
    const current = pointDragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const clip = doc.arrangement.automationClips?.find((candidate) => candidate.id === current.clipId);
    if (!clip) return;
    const position = pointValueAtEvent(event, clip, current.target);
    const next = { ...current, ...position };
    pointDragRef.current = next;
    setPointPreview(next);
  };

  const finishPointDrag = (event: React.PointerEvent<SVGCircleElement>) => {
    const current = pointDragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const clip = doc.arrangement.automationClips?.find((candidate) => candidate.id === current.clipId);
    pointDragRef.current = null;
    setPointPreview(null);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* Pointer capture may already have ended. */
    }
    if (!clip) return;
    const position = pointValueAtEvent(event, clip, current.target);
    onExecute(moveAutomationClipPoint(doc, clip.id, current.pointIndex, position.visibleTick, position.value));
  };

  if (targets.size === 0) {
    return (
      <section className="arr-auto-lanes" aria-label="Automation arrangement lanes">
        <div className="arr-auto-lanes-heading">AUTOMATION · Create a target in MOD to place an automation clip.</div>
      </section>
    );
  }

  return (
    <section className="arr-auto-lanes" aria-label="Automation arrangement lanes">
      <div className="arr-auto-lanes-heading">
        <span>AUTOMATION CLIPS</span>
        <span>Double-click to add a point · drag points to edit · right-click a point to remove</span>
      </div>
      {[...targets.entries()].map(([key, target]) => {
        const clips = clipsByTarget.get(key) ?? [];
        const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId) ?? doc.patterns[0];
        return (
          <div className="arr-auto-lane-row" key={key} aria-label={`${targetName(doc, target)} automation lane`}>
            <div className="arr-auto-lane-label">
              <span title={targetName(doc, target)}>{targetName(doc, target)}</span>
              <button
                type="button"
                aria-label={`Add automation clip for ${targetName(doc, target)}`}
                disabled={!pattern}
                onClick={() => addForTarget(target, snapped(playheadTick, snapGrid, false))}
              >
                +
              </button>
            </div>
            <div
              className="arr-auto-lane-track"
              style={{ width: laneWidth, backgroundSize: `${barWidth}px 100%` }}
              onDoubleClick={(event) => {
                if (event.target !== event.currentTarget || !pattern) return;
                const rect = event.currentTarget.getBoundingClientRect();
                const tick = ((event.clientX - rect.left) / Math.max(1, barWidth)) * BAR_TICKS;
                addForTarget(target, snapped(tick, snapGrid, event.shiftKey));
              }}
            >
              {clips.map((clip) => {
                const active = preview?.clipId === clip.id ? preview : null;
                const groupStartTick =
                  groupDragPreview?.projectId === doc.id && groupDragPreview.clipIds.includes(clip.id)
                    ? groupDragPreview.startTicks[clip.id]
                    : undefined;
                const startTick = groupStartTick ?? active?.nextStartTick ?? clip.startTick;
                const lengthTicks = active?.nextLengthTicks ?? clip.lengthTicks;
                const selected = selectedClipId === clip.id;
                const muted = clip.muted === true;
                const primaryTarget = automationTargetKey(clip.target) === key;
                const visualClip = automationClipForTarget(doc, clip, target);
                const range = valueRange(doc, target, visualClip);
                const targetKind = targetParamDef(doc, target)?.kind;
                const stepped = targetKind === "toggle" || targetKind === "enum" || targetKind === "discrete";
                const phase = clip.phaseOffsetTicks ?? 0;
                const displayClip =
                  pointPreview?.clipId === clip.id
                    ? {
                        ...visualClip,
                        points: visualClip.points
                          .map((point, index) =>
                            index === pointPreview.pointIndex
                              ? {
                                  tick: phase + pointPreview.visibleTick,
                                  value: mapAutomationValueBetweenTargets(doc, clip.target, target, pointPreview.value),
                                }
                              : point,
                          )
                          .sort((a, b) => a.tick - b.tick),
                      }
                    : visualClip;
                const overlapping = (activeClipCountByTarget.get(key) ?? 0) > 1 && !muted;
                const isWinner = winnerClipByTarget.get(key) === clip.id;
                return (
                  <button
                    type="button"
                    key={clip.id}
                    className={`arr-auto-clip${selected ? " selected" : ""}${muted ? " muted" : ""}${clip.locked ? " locked" : ""}${doc.arrangement.clipGroups?.some((group) => group.clipIds.includes(clip.id)) ? " grouped" : ""}${overlapping ? (isWinner ? " overlap-winner" : " overlap-shadowed") : ""}`}
                    style={{
                      left: `${(startTick / BAR_TICKS) * barWidth}px`,
                      width: `${Math.max(8, (lengthTicks / BAR_TICKS) * barWidth)}px`,
                      zIndex: selected ? 3 : isWinner ? 2 : undefined,
                    }}
                    title={`${targetName(doc, target)} · ${lengthTicks} ticks${primaryTarget ? " · primary curve" : " · linked curve"}${overlapping ? (isWinner ? " · playback winner at playhead" : " · overlapped by another clip at playhead") : ""}${clip.locked ? " · locked" : ""}`}
                    onPointerDown={(event) => beginDrag(event, clip)}
                    onPointerMove={updateDrag}
                    onPointerUp={finishDrag}
                    onPointerCancel={cancelDrag}
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      const rect = event.currentTarget.getBoundingClientRect();
                      const localTick = ((event.clientX - rect.left) / Math.max(1, rect.width)) * lengthTicks;
                      const value =
                        range.max - ((event.clientY - rect.top) / Math.max(1, rect.height)) * (range.max - range.min);
                      onExecute(
                        addAutomationClipPoint(
                          doc,
                          clip.id,
                          localTick,
                          mapAutomationValueBetweenTargets(doc, target, clip.target, value),
                        ),
                      );
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onSelect(clip.id);
                      setMenu({ clipId: clip.id, x: event.clientX, y: event.clientY });
                    }}
                  >
                    <svg className="arr-auto-curve" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
                      <path d={curvePath(displayClip, range, stepped)} />
                      {clip.points.map((point, pointIndex) => {
                        const visibleTick =
                          pointPreview?.clipId === clip.id && pointPreview.pointIndex === pointIndex
                            ? pointPreview.visibleTick
                            : (displayClip.points[pointIndex]?.tick ?? point.tick) - phase;
                        if (visibleTick < 0 || visibleTick > clip.lengthTicks) return null;
                        const pointValue = displayClip.points[pointIndex]?.value ?? point.value;
                        const value = stepped ? Math.round(pointValue) : pointValue;
                        const y = 23 - ((value - range.min) / (range.max - range.min || 1)) * 21;
                        return (
                          <circle
                            key={`${point.tick}:${pointIndex}`}
                            className="arr-auto-point"
                            cx={`${(visibleTick / clip.lengthTicks) * 100}%`}
                            cy={Math.max(1, Math.min(23, y))}
                            r="2.5"
                            aria-label={`Automation point ${pointIndex + 1}`}
                            onPointerDown={(event) => beginPointDrag(event, clip, pointIndex, target)}
                            onPointerMove={updatePointDrag}
                            onPointerUp={finishPointDrag}
                            onPointerCancel={() => {
                              pointDragRef.current = null;
                              setPointPreview(null);
                            }}
                            onClick={(event) => event.stopPropagation()}
                            onDoubleClick={(event) => event.stopPropagation()}
                            onContextMenu={(event) => {
                              if (clip.locked) return;
                              event.preventDefault();
                              event.stopPropagation();
                              onExecute(removeAutomationClipPoint(doc, clip.id, pointIndex));
                            }}
                          />
                        );
                      })}
                    </svg>
                    <span>
                      {overlapping
                        ? isWinner
                          ? "WINNER"
                          : "OVERLAP"
                        : primaryTarget
                          ? clip.points.length > 2
                            ? "AUTO"
                            : "AUTO · flat"
                          : "LINKED"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      {menu &&
        (() => {
          const clip = (doc.arrangement.automationClips ?? []).find((candidate) => candidate.id === menu.clipId);
          if (!clip) return null;
          return (
            <div className="arr-auto-clip-menu" style={{ left: menu.x, top: menu.y }} role="menu">
              <label className="arr-auto-clip-link">
                Link target
                <select
                  aria-label="Link automation clip target"
                  defaultValue=""
                  disabled={clip.locked}
                  onChange={(event) => {
                    const target = targets.get(event.currentTarget.value);
                    if (target) onExecute(linkAutomationClipTarget(doc, clip.id, target));
                    event.currentTarget.value = "";
                  }}
                >
                  <option value="">Choose target…</option>
                  {[...targets.entries()]
                    .filter(
                      ([key]) => !automationTargetsOfClip(clip).some((target) => automationTargetKey(target) === key),
                    )
                    .map(([key, target]) => (
                      <option key={key} value={key}>
                        {targetName(doc, target)}
                      </option>
                    ))}
                </select>
              </label>
              {(clip.linkedTargets ?? []).map((target) => (
                <button
                  key={automationTargetKey(target)}
                  type="button"
                  role="menuitem"
                  disabled={clip.locked}
                  onClick={() => {
                    onExecute(unlinkAutomationClipTarget(doc, clip.id, target));
                    setMenu(null);
                  }}
                >
                  Unlink {targetName(doc, target)}
                </button>
              ))}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onExecute(duplicateAutomationClip(doc, clip.id));
                  setMenu(null);
                }}
              >
                Duplicate
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onExecute(setAutomationClipMuted(doc, clip.id, !clip.muted));
                  setMenu(null);
                }}
              >
                {clip.muted ? "Unmute" : "Mute"}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onExecute(setAutomationClipLocked(doc, clip.id, !clip.locked));
                  setMenu(null);
                }}
              >
                {clip.locked ? "Unlock" : "Lock"}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onExecute(deleteAutomationClip(doc, clip.id));
                  setMenu(null);
                }}
              >
                Delete
              </button>
            </div>
          );
        })()}
    </section>
  );
}
