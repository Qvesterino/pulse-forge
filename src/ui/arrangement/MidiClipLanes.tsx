import { memo, useEffect, useRef, useState } from "react";
import type { Command } from "../../commands/types";
import {
  addMidiClip,
  deleteMidiClip,
  duplicateMidiClip,
  makeMidiClipUnique,
  moveMidiClip,
  resizeMidiClip,
  setMidiClipMuted,
  trimMidiClipStart,
} from "../../commands/midiClips";
import { nudgeClips } from "../../commands/clipEditing";
import type { MidiClip, NoteEvent, ProjectDocument, Track } from "../../project-model/types";
import { BAR_TICKS, STEP_TICKS } from "../../project-model/types";
import { midiPhraseLengthTicks } from "../../project-model/midiTime";
import { snapBarsFor, snapTick, type SnapGridId } from "../snap";
import {
  clearTimelineGroupDragPreview,
  publishTimelineGroupDragPreview,
  useTimelineGroupDragPreview,
} from "./groupDragPreview";

interface MidiClipLanesProps {
  doc: ProjectDocument;
  tracks: Track[];
  midiClips: MidiClip[];
  selectedClipId: string | null;
  totalBars: number;
  barWidth: number;
  snapGrid: SnapGridId;
  playheadTick: number;
  onExecute: (command: Command) => boolean;
  onSelect: (clipId: string) => void;
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
  selectedClipId,
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
  const laneWidth = totalBars * barWidth;
  const menuClip = menu ? midiClips.find((clip) => clip.id === menu.clipId) : undefined;
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
    };
    dragRef.current = drag;
    setPreview(drag);
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
                const sourceNotes = source?.notes?.[track.id] ?? EMPTY_NOTES;
                const patternTicks = source ? midiPhraseLengthTicks(source.stepCount, sourceNotes) : 0;
                const phase = clip.phaseOffsetTicks ?? 0;
                return (
                  <button
                    type="button"
                    key={clip.id}
                    className={`arr-midi-clip${selectedClipId === clip.id ? " selected" : ""}${clip.muted ? " muted" : ""}${clip.locked ? " locked" : ""}${doc.arrangement.clipGroups?.some((group) => group.clipIds.includes(clip.id)) ? " grouped" : ""}`}
                    aria-label={`${source?.name ?? "Pattern"} MIDI clip on ${track.name}, bar ${Math.floor(startTick / BAR_TICKS) + 1}`}
                    title={`${source?.name ?? "Pattern"} · ${track.name} · ${lengthTicks} ticks · double-click to edit source pattern · right-click for clip actions`}
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
                      onSelect(clip.id);
                      setMenu({ clipId: clip.id, x: event.clientX, y: event.clientY });
                    }}
                  >
                    <span className="arr-midi-clip-name">{source?.name ?? "MIDI"}</span>
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
    </section>
  );
}
