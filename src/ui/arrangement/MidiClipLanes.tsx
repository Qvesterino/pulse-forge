import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Command } from "../../commands/types";
import {
  addMidiClip,
  deleteMidiClip,
  duplicateMidiClip,
  editMidiClipNotes,
  makeMidiClipUnique,
  moveMidiClip,
  resizeMidiClip,
  setMidiClipMuted,
  trimMidiClipStart,
} from "../../commands/midiClips";
import { nudgeClips } from "../../commands/clipEditing";
import type { MidiClip, NoteEvent, ProjectDocument, Track } from "../../project-model/types";
import type { MidiObjectNoteEdit } from "../../commands/midiClips";
import { BAR_TICKS, STEP_TICKS } from "../../project-model/types";
import { midiPhraseLengthTicks } from "../../project-model/midiTime";
import { snapBarsFor, snapTick, type SnapGridId } from "../snap";
import {
  clearTimelineGroupDragPreview,
  publishTimelineGroupDragPreview,
  useTimelineGroupDragPreview,
} from "./groupDragPreview";
import { MidiMultiObjectEditor } from "./MidiMultiObjectEditor";

interface MidiClipLanesProps {
  doc: ProjectDocument;
  tracks: Track[];
  midiClips: MidiClip[];
  selectedClipIds: readonly string[];
  totalBars: number;
  barWidth: number;
  snapGrid: SnapGridId;
  playheadTick: number;
  onExecute: (command: Command) => boolean;
  onSelect: (clipId: string, mode?: "replace" | "toggle" | "range") => void;
  onEditSource: (clip: MidiClip) => void;
  onMakeUniqueAndEdit: (clipId: string) => void;
}

interface ClipDrag {
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
  multiClipIds?: string[];
}

const EMPTY_NOTES: readonly NoteEvent[] = [];

const MidiClipNoteMarks = memo(function MidiClipNoteMarks({
  notes,
  patternTicks,
  phase,
  lengthTicks,
}: {
  notes: readonly NoteEvent[];
  patternTicks: number;
  phase: number;
  lengthTicks: number;
}) {
  if (patternTicks <= 0 || lengthTicks <= 0) return null;
  const marks = [];
  for (const note of notes) {
    if (marks.length >= 256) break;
    const firstOffset = (((note.start - phase) % patternTicks) + patternTicks) % patternTicks;
    for (let offset = firstOffset; offset < lengthTicks && marks.length < 256; offset += patternTicks) {
      marks.push(
        <i
          className="arr-midi-note-mark"
          key={`${note.id}:${offset}`}
          style={{
            left: `${(offset / lengthTicks) * 100}%`,
            width: `${Math.max(0.5, (Math.min(note.duration, lengthTicks - offset) / lengthTicks) * 100)}%`,
          }}
        />,
      );
    }
  }
  return <>{marks}</>;
});

function snapToGrid(tick: number, grid: SnapGridId, suspended: boolean): number {
  const bars = suspended ? null : snapBarsFor(grid);
  return Math.round(bars === null ? tick : snapTick(tick, bars));
}

export function MidiClipLanes({
  doc,
  tracks,
  midiClips,
  selectedClipIds,
  totalBars,
  barWidth,
  snapGrid,
  playheadTick,
  onExecute,
  onSelect,
  onEditSource,
  onMakeUniqueAndEdit,
}: MidiClipLanesProps) {
  const instruments = tracks.filter((track) => track.kind === "instrument");
  const dragRef = useRef<ClipDrag | null>(null);
  const [preview, setPreview] = useState<ClipDrag | null>(null);
  const groupDragPreview = useTimelineGroupDragPreview();
  const [menu, setMenu] = useState<{ clipId: string; x: number; y: number } | null>(null);
  const [editingClipIds, setEditingClipIds] = useState<string[] | null>(null);
  const laneWidth = totalBars * barWidth;
  const menuClip = menu ? midiClips.find((clip) => clip.id === menu.clipId) : undefined;
  const selectedMidiClips = (doc.arrangement.midiClips ?? []).filter((clip) => selectedClipIds.includes(clip.id));
  const editingClips = editingClipIds
    ? (doc.arrangement.midiClips ?? []).filter((clip) => editingClipIds.includes(clip.id))
    : [];
  const patternPlacementCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const addPatternPlacement = (patternId: string | undefined) => {
      if (!patternId) return;
      counts.set(patternId, (counts.get(patternId) ?? 0) + 1);
    };
    const patternIdBySceneId = new Map(doc.scenes.map((scene) => [scene.id, scene.patternId]));
    for (const clip of doc.arrangement.clips) addPatternPlacement(patternIdBySceneId.get(clip.sceneId));
    // `midiClips` is viewport-filtered by ArrangementPanel; count the full
    // document so the shared-source warning stays stable while scrolling.
    for (const clip of doc.arrangement.midiClips ?? []) addPatternPlacement(clip.patternId);
    return counts;
  }, [doc.arrangement.clips, doc.arrangement.midiClips, doc.scenes]);
  const clipsByTrack = new Map<string, MidiClip[]>();
  for (const clip of midiClips) {
    const clips = clipsByTrack.get(clip.trackId) ?? [];
    clips.push(clip);
    clipsByTrack.set(clip.trackId, clips);
  }

  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      if (!(event.target as HTMLElement | null)?.closest(".arr-midi-clip-menu")) setMenu(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  const beginDrag = (event: React.PointerEvent<HTMLButtonElement>, clip: MidiClip) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey) {
      onSelect(clip.id, "toggle");
      return;
    }
    if (event.shiftKey) {
      onSelect(clip.id, "range");
      return;
    }
    if (!selectedClipIds.includes(clip.id)) onSelect(clip.id, "replace");
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
    const multiClipIds =
      mode === "move" && selectedClipIds.length > 1 && selectedClipIds.includes(clip.id)
        ? selectedMidiClips.filter((candidate) => candidate.locked !== true).map((candidate) => candidate.id)
        : [];
    const drag: ClipDrag = {
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
      ...(multiClipIds.length > 1 && !groupId ? { multiClipIds } : {}),
    };
    dragRef.current = drag;
    setPreview(drag);
    if (groupId) publishTimelineGroupDragPreview(doc, groupId, groupClipIds);
    else if (multiClipIds.length > 1) publishTimelineGroupDragPreview(doc, "midi-selection", multiClipIds);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updateDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const delta = ((event.clientX - current.clientX) / Math.max(1, current.barWidthAt)) * BAR_TICKS;
    if (current.multiClipIds) {
      const stillLive = current.multiClipIds.every((id) =>
        (doc.arrangement.midiClips ?? []).some((candidate) => candidate.id === id),
      );
      if (!stillLive) {
        cancelDrag();
        return;
      }
      const deltaTicks = snapToGrid(delta, snapGrid, event.shiftKey);
      const planned = nudgeClips(doc, current.multiClipIds, deltaTicks / BAR_TICKS).execute(doc);
      const nextStartTick =
        planned.arrangement.midiClips?.find((candidate) => candidate.id === current.clipId)?.startTick ??
        current.startTick;
      const next = { ...current, nextStartTick, nextLengthTicks: current.lengthTicks };
      dragRef.current = next;
      setPreview(next);
      publishTimelineGroupDragPreview(planned, "midi-selection", current.multiClipIds);
      return;
    }
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
        : snapToGrid(delta, snapGrid, event.shiftKey);
      const planned = nudgeClips(doc, [current.clipId], deltaTicks / BAR_TICKS).execute(doc);
      const nextStartTick =
        planned.arrangement.midiClips?.find((candidate) => candidate.id === current.clipId)?.startTick ??
        current.startTick;
      const next = { ...current, nextStartTick, nextLengthTicks: current.lengthTicks };
      dragRef.current = next;
      setPreview(next);
      publishTimelineGroupDragPreview(planned, current.groupId, current.groupClipIds);
      return;
    }
    const snappedDelta = snapToGrid(delta, snapGrid, event.shiftKey);
    let nextStartTick = current.startTick;
    let nextLengthTicks = current.lengthTicks;
    if (current.mode === "move") {
      nextStartTick = Math.max(0, current.startTick + snappedDelta);
    } else if (current.mode === "resize") {
      const snappedEnd = snapToGrid(current.startTick + current.lengthTicks + delta, snapGrid, event.shiftKey);
      nextLengthTicks = Math.max(STEP_TICKS, snappedEnd - current.startTick);
    } else {
      const endTick = current.startTick + current.lengthTicks;
      nextStartTick = Math.max(
        0,
        Math.min(endTick - STEP_TICKS, snapToGrid(current.startTick + delta, snapGrid, event.shiftKey)),
      );
      nextLengthTicks = endTick - nextStartTick;
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
      /* Pointer capture can be released by the browser before pointerup. */
    }
    if (current.multiClipIds) {
      const deltaTicks = current.nextStartTick - current.startTick;
      clearTimelineGroupDragPreview();
      if (deltaTicks !== 0) onExecute(nudgeClips(doc, current.multiClipIds, deltaTicks / BAR_TICKS));
      return;
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
      onExecute(moveMidiClip(doc, current.clipId, current.nextStartTick));
    } else if (current.mode === "resize" && current.nextLengthTicks !== current.lengthTicks) {
      onExecute(resizeMidiClip(doc, current.clipId, current.nextLengthTicks));
    } else if (current.mode === "trim" && current.nextStartTick !== current.startTick) {
      onExecute(trimMidiClipStart(doc, current.clipId, current.nextStartTick));
    }
  };

  const cancelDrag = () => {
    dragRef.current = null;
    setPreview(null);
    clearTimelineGroupDragPreview();
  };

  return (
    <section className="arr-midi-lanes" aria-label="Instrument MIDI arrangement lanes">
      <div className="arr-midi-lanes-heading">
        <span>MIDI TRACKS</span>
        <span>Drag clips to move · drag edges to trim/extend · Shift = free snap</span>
      </div>
      {instruments.map((track) => {
        const clips = clipsByTrack.get(track.id) ?? [];
        const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId) ?? doc.patterns[0];
        const patternNotes = pattern?.notes?.[track.id] ?? EMPTY_NOTES;
        const defaultClipLength = pattern ? midiPhraseLengthTicks(pattern.stepCount, patternNotes) : STEP_TICKS * 64;
        return (
          <div className="arr-midi-lane-row" key={track.id} aria-label={`${track.name} MIDI lane`}>
            <div className="arr-midi-lane-label">
              <span title={track.name}>{track.name}</span>
              <button
                type="button"
                aria-label={`Add MIDI clip to ${track.name}`}
                title="Place the active pattern at the playhead on this instrument lane"
                disabled={!pattern}
                onClick={() => {
                  if (!pattern) return;
                  onExecute(
                    addMidiClip(
                      doc,
                      track.id,
                      pattern.id,
                      Math.max(0, snapToGrid(playheadTick, snapGrid, false)),
                      defaultClipLength,
                    ),
                  );
                }}
              >
                +
              </button>
            </div>
            <div
              className="arr-midi-lane-track"
              style={{ width: laneWidth, backgroundSize: `${barWidth}px 100%` }}
              onDoubleClick={(event) => {
                if (event.target !== event.currentTarget || !pattern) return;
                const rect = event.currentTarget.getBoundingClientRect();
                const tick = snapToGrid(
                  ((event.clientX - rect.left) / Math.max(1, barWidth)) * BAR_TICKS,
                  snapGrid,
                  event.shiftKey,
                );
                onExecute(addMidiClip(doc, track.id, pattern.id, Math.max(0, tick), defaultClipLength));
              }}
            >
              {clips.map((clip) => {
                const activeDrag = preview?.clipId === clip.id ? preview : null;
                const groupStartTick =
                  groupDragPreview?.projectId === doc.id && groupDragPreview.clipIds.includes(clip.id)
                    ? groupDragPreview.startTicks[clip.id]
                    : undefined;
                const startTick = groupStartTick ?? activeDrag?.nextStartTick ?? clip.startTick;
                const lengthTicks = activeDrag?.nextLengthTicks ?? clip.lengthTicks;
                const source = doc.patterns.find((candidate) => candidate.id === clip.patternId);
                const sourcePlacementCount = patternPlacementCounts.get(clip.patternId) ?? 0;
                const sharedSource = sourcePlacementCount > 1;
                const sourceNotes = source?.notes?.[track.id] ?? EMPTY_NOTES;
                const patternTicks = source ? midiPhraseLengthTicks(source.stepCount, sourceNotes) : 0;
                const phase = clip.phaseOffsetTicks ?? 0;
                const sharedHint = sharedSource
                  ? `Shared source pattern: editing it changes all ${sourcePlacementCount} arrangement placements. Use Make unique & edit for an independent variation.`
                  : "Source pattern: edits apply to this pattern. Right-click for clip actions.";
                return (
                  <button
                    type="button"
                    key={clip.id}
                    className={`arr-midi-clip${selectedClipIds.includes(clip.id) ? " selected" : ""}${clip.muted ? " muted" : ""}${clip.locked ? " locked" : ""}${sharedSource ? " shared-source" : ""}${doc.arrangement.clipGroups?.some((group) => group.clipIds.includes(clip.id)) ? " grouped" : ""}`}
                    aria-label={`${source?.name ?? "Pattern"} MIDI clip on ${track.name}, bar ${Math.floor(startTick / BAR_TICKS) + 1}${sharedSource ? `, shared source pattern used by ${sourcePlacementCount} placements` : ""}`}
                    title={`${source?.name ?? "Pattern"} · ${track.name} · ${lengthTicks} ticks · ${sharedHint} Double-click to edit source pattern.`}
                    style={{
                      left: (startTick / BAR_TICKS) * barWidth,
                      width: Math.max(10, (lengthTicks / BAR_TICKS) * barWidth - 3),
                    }}
                    onPointerDown={(event) => beginDrag(event, clip)}
                    onPointerMove={updateDrag}
                    onPointerUp={finishDrag}
                    onPointerCancel={cancelDrag}
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onEditSource(clip);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (!selectedClipIds.includes(clip.id)) onSelect(clip.id, "replace");
                      setMenu({ clipId: clip.id, x: event.clientX, y: event.clientY });
                    }}
                  >
                    <span className="arr-midi-clip-name">{source?.name ?? "MIDI"}</span>
                    {sharedSource && (
                      <span className="arr-midi-clip-shared-mark" aria-hidden="true">
                        <svg viewBox="0 0 16 16" focusable="false">
                          <path d="M6.2 9.8 4.8 11.2a2.1 2.1 0 0 1-3-3l3-3a2.1 2.1 0 0 1 3 0M9.8 6.2l1.4-1.4a2.1 2.1 0 0 1 3 3l-3 3a2.1 2.1 0 0 1-3 0M5.7 10.3l4.6-4.6" />
                        </svg>
                      </span>
                    )}
                    <MidiClipNoteMarks
                      notes={sourceNotes}
                      patternTicks={patternTicks}
                      phase={phase}
                      lengthTicks={lengthTicks}
                    />
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      {menu && menuClip && (
        <div className="arr-midi-clip-menu" style={{ left: menu.x, top: menu.y }} role="menu">
          {selectedMidiClips.length > 1 && (
            <button
              type="button"
              role="menuitem"
              disabled={selectedMidiClips.some((clip) => clip.locked === true)}
              title={
                selectedMidiClips.some((clip) => clip.locked === true)
                  ? "Unlock every selected MIDI object before editing notes."
                  : undefined
              }
              onClick={() => {
                setEditingClipIds(selectedMidiClips.map((clip) => clip.id));
                setMenu(null);
              }}
            >
              Edit note properties in {selectedMidiClips.length} objects…
            </button>
          )}
          {[
            ["Edit source pattern", () => onEditSource(menuClip)],
            ["Duplicate", () => onExecute(duplicateMidiClip(doc, menu.clipId))],
            ["Make unique & edit", () => onMakeUniqueAndEdit(menu.clipId)],
            ["Make unique", () => onExecute(makeMidiClipUnique(doc, menu.clipId))],
            [
              "Mute / unmute",
              () => {
                const clip = (doc.arrangement.midiClips ?? []).find((candidate) => candidate.id === menu.clipId);
                if (clip) onExecute(setMidiClipMuted(doc, clip.id, !clip.muted));
              },
            ],
            ["Delete", () => onExecute(deleteMidiClip(doc, menu.clipId))],
          ].map(([label, action]) => (
            <button
              type="button"
              role="menuitem"
              key={label as string}
              onClick={() => {
                (action as () => void)();
                setMenu(null);
              }}
            >
              {label as string}
            </button>
          ))}
        </div>
      )}
      {editingClips.length > 0 && (
        <MidiMultiObjectEditor
          doc={doc}
          clips={editingClips}
          onClose={() => setEditingClipIds(null)}
          onApply={(edit: MidiObjectNoteEdit) => {
            try {
              const committed = onExecute(
                editMidiClipNotes(
                  doc,
                  editingClips.map((clip) => clip.id),
                  edit,
                ),
              );
              if (!committed) return "The note edit could not be applied to the current project.";
              setEditingClipIds(null);
              return null;
            } catch (error) {
              return error instanceof Error ? error.message : String(error);
            }
          }}
        />
      )}
    </section>
  );
}
