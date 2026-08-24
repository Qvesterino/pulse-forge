import { useRef, useState } from "react";
import { useDoc, useServices } from "./context";
import type { InstrumentTrack, NoteEvent, Pattern } from "../project-model/types";
import { STEP_TICKS, pitchName } from "../project-model/types";
import { addNote, deleteNote, moveNote, resizeNote } from "../commands/commands";
import { clamp } from "../shared/ids";
import { getScalePitchesInRange, isInScale, snapToScale, scaleDegreeLabel } from "../project-model/scales";

const PITCH_MIN = 24;
const PITCH_MAX = 84;
const PITCH_COUNT = PITCH_MAX - PITCH_MIN + 1;
const ROW_HEIGHT = 14;
const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

export interface SelectedNotes {
  trackId: string;
  noteIds: string[];
}

/** Backwards-compatible alias for callers that still use the singular name. */
export type SelectedNote = SelectedNotes;

type DragState =
  | { mode: "move"; noteId: string; grabStep: number; basePitch: number; baseStart: number; dSteps: number; dPitch: number }
  | { mode: "resize"; noteId: string; baseStart: number; baseDurSteps: number; durSteps: number };

export function PianoRollTrack({
  track,
  pattern,
  playheadStep,
  selectedNote,
  onSelectNote,
  scaleSnap,
}: {
  track: InstrumentTrack;
  pattern: Pattern;
  playheadStep: number;
  selectedNote: SelectedNote | null;
  onSelectNote: (selection: SelectedNote | null) => void;
  scaleSnap: boolean;
}) {
  const services = useServices();
  const doc = useDoc();
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const notes = pattern.notes?.[track.id] ?? [];
  const patternTicks = STEP_TICKS * pattern.stepCount;

  // Scale awareness
  const projectKey = doc.key;
  const scalePitches = projectKey ? getScalePitchesInRange(projectKey, PITCH_MIN, PITCH_MAX) : null;

  const posFromEvent = (event: React.PointerEvent): { stepF: number; pitch: number } => {
    const grid = gridRef.current;
    if (!grid) return { stepF: 0, pitch: PITCH_MIN };
    const rect = grid.getBoundingClientRect();
    const x = clamp(event.clientX - rect.left, 0, rect.width);
    const y = clamp(event.clientY - rect.top, 0, rect.height);
    let pitch = PITCH_MAX - Math.floor(y / ROW_HEIGHT);
    if (scaleSnap && projectKey) {
      pitch = snapToScale(pitch, projectKey);
    }
    return {
      stepF: (x / rect.width) * pattern.stepCount,
      pitch,
    };
  };

  const beginNoteDrag = (event: React.PointerEvent, note: NoteEvent) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (event.shiftKey) {
      const currentIds = selectedNote?.trackId === track.id ? selectedNote.noteIds : [];
      const nextIds = currentIds.includes(note.id)
        ? currentIds.filter((id) => id !== note.id)
        : [...currentIds, note.id];
      onSelectNote(nextIds.length > 0 ? { trackId: track.id, noteIds: nextIds } : null);
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // no active pointer (synthetic dispatch) — drag continues without capture
    }
    const { stepF } = posFromEvent(event);
    const noteStartSteps = note.start / STEP_TICKS;
    const noteDurSteps = note.duration / STEP_TICKS;
    const isEdge = stepF - noteStartSteps > Math.max(noteDurSteps - 0.35, 0.65);
    onSelectNote({ trackId: track.id, noteIds: [note.id] });
    if (isEdge) {
      const state: DragState = {
        mode: "resize",
        noteId: note.id,
        baseStart: note.start,
        baseDurSteps: noteDurSteps,
        durSteps: noteDurSteps,
      };
      dragRef.current = state;
      setDrag(state);
    } else {
      const state: DragState = {
        mode: "move",
        noteId: note.id,
        grabStep: stepF - noteStartSteps,
        basePitch: note.pitch,
        baseStart: note.start,
        dSteps: 0,
        dPitch: 0,
      };
      dragRef.current = state;
      setDrag(state);
    }
  };

  const onNotePointerMove = (event: React.PointerEvent) => {
    const current = dragRef.current;
    if (!current) return;
    const { stepF, pitch } = posFromEvent(event);
    if (current.mode === "move") {
      const next: DragState = {
        ...current,
        dSteps: Math.round(stepF - current.grabStep - current.baseStart / STEP_TICKS),
        dPitch: pitch - current.basePitch,
      };
      dragRef.current = next;
      setDrag(next);
    } else {
      const next: DragState = {
        ...current,
        durSteps: Math.max(1, Math.round(stepF - current.baseStart / STEP_TICKS)),
      };
      dragRef.current = next;
      setDrag(next);
    }
  };

  const onNotePointerUp = () => {
    const current = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!current) return;
    if (current.mode === "move" && (current.dSteps !== 0 || current.dPitch !== 0)) {
      const newStart = clamp(current.baseStart + current.dSteps * STEP_TICKS, 0, patternTicks - STEP_TICKS);
      let newPitch = clamp(current.basePitch + current.dPitch, PITCH_MIN, PITCH_MAX);
      if (scaleSnap && projectKey) {
        newPitch = snapToScale(newPitch, projectKey);
      }
      services.store.execute(
        moveNote(services.store.doc, track.id, current.noteId, { start: newStart, pitch: newPitch }),
      );
    }
    if (current.mode === "resize" && current.durSteps !== current.baseDurSteps) {
      const maxDur = Math.round((patternTicks - current.baseStart) / STEP_TICKS);
      services.store.execute(
        resizeNote(services.store.doc, track.id, current.noteId, clamp(current.durSteps, 1, maxDur) * STEP_TICKS),
      );
    }
  };

  const onGridPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    if (event.target !== gridRef.current) return;
    const { stepF, pitch } = posFromEvent(event);
    const start = clamp(Math.floor(stepF), 0, pattern.stepCount - 1) * STEP_TICKS;
    services.store.execute(
      addNote(services.store.doc, track.id, { pitch, start, duration: STEP_TICKS, velocity: 0.9 }),
    );
    onSelectNote(null);
  };

  const previewKey = (pitch: number) => services.engine.previewNote(track.id, pitch);

  const stepPct = (step: number) => (step / pattern.stepCount) * 100;

  // Compute in-scale pitch set for visual highlighting
  const isScaleActive = scalePitches !== null && scalePitches.size > 0;

  return (
    <div className="pianoroll">
      <div className="pianoroll-keys">
        {Array.from({ length: PITCH_COUNT }, (_, i) => {
          const pitch = PITCH_MAX - i;
          const inScale = isScaleActive && scalePitches!.has(pitch);
          const isRoot = inScale && projectKey && scaleDegreeLabel(pitch, projectKey) === "1";
          return (
            <button
              key={pitch}
              type="button"
              className={`pr-key${BLACK_KEYS.has(pitch % 12) ? " black" : ""}${pitch % 12 === 0 ? " c-key" : ""}${isScaleActive && !inScale ? " out-scale" : ""}${isRoot ? " root" : ""}`}
              style={{ height: ROW_HEIGHT }}
              title={`Preview ${pitchName(pitch)}${inScale ? " (in scale)" : ""}`}
              onPointerDown={() => previewKey(pitch)}
            >
              {pitch % 12 === 0 ? pitchName(pitch) : ""}
              {isScaleActive && inScale && <span className="pr-scale-deg">{scaleDegreeLabel(pitch, projectKey!)}</span>}
            </button>
          );
        })}
      </div>
      <div
        className="pianoroll-scroll"
        ref={scrollRef}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) onSelectNote(null);
        }}
      >
        <div
          className="pianoroll-grid"
          ref={gridRef}
          style={{ height: PITCH_COUNT * ROW_HEIGHT }}
          onPointerDown={onGridPointerDown}
        >
          {/* Scale row highlights (background tint on in-scale rows) */}
          {isScaleActive &&
            Array.from({ length: PITCH_COUNT }, (_, i) => {
              const pitch = PITCH_MAX - i;
              const inScale = scalePitches!.has(pitch);
              if (!inScale) return null;
              const isRoot = scaleDegreeLabel(pitch, projectKey!) === "1";
              return (
                <div
                  key={`scale-${pitch}`}
                  className={`pr-scale-row${isRoot ? " root" : ""}`}
                  style={{ top: i * ROW_HEIGHT, height: ROW_HEIGHT }}
                />
              );
            })}
          {Array.from({ length: pattern.stepCount }, (_, i) =>
            i % 4 === 0 ? (
              <div key={i} className="pr-beatline" style={{ left: `${stepPct(i)}%` }} />
            ) : null,
          )}
          {playheadStep >= 0 && playheadStep < pattern.stepCount && (
            <div className="pr-playhead" style={{ left: `${stepPct(playheadStep)}%`, width: `${100 / pattern.stepCount}%` }} />
          )}
          {notes.map((note) => {
            let startSteps = note.start / STEP_TICKS;
            let durSteps = note.duration / STEP_TICKS;
            if (drag && drag.noteId === note.id) {
              if (drag.mode === "move") {
                startSteps = clamp(
                  startSteps + drag.dSteps,
                  0,
                  pattern.stepCount - durSteps,
                );
              } else {
                durSteps = Math.max(1, drag.durSteps);
              }
            }
            const selected = selectedNote?.trackId === track.id && selectedNote.noteIds.includes(note.id);
            const top = (PITCH_MAX - note.pitch - (drag && drag.noteId === note.id && drag.mode === "move" ? drag.dPitch : 0)) * ROW_HEIGHT;
            return (
              <div
                key={note.id}
                className={`pr-note${selected ? " selected" : ""}${isScaleActive && !isInScale(note.pitch, projectKey!) ? " out-of-scale" : ""}`}
                style={{
                  left: `${(startSteps / pattern.stepCount) * 100}%`,
                  width: `${(durSteps / pattern.stepCount) * 100}%`,
                  top: `${clamp(top, 0, (PITCH_COUNT - 1) * ROW_HEIGHT)}px`,
                  opacity: 0.35 + note.velocity * 0.65,
                }}
                title={`${pitchName(note.pitch)} — drag to move, drag right edge to resize, right-click to delete`}
                onPointerDown={(event) => beginNoteDrag(event, note)}
                onPointerMove={onNotePointerMove}
                onPointerUp={onNotePointerUp}
                onContextMenu={(event) => {
                  event.preventDefault();
                  services.store.execute(deleteNote(services.store.doc, track.id, note.id));
                  if (selectedNote?.trackId === track.id && selectedNote.noteIds.includes(note.id)) onSelectNote(null);
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
