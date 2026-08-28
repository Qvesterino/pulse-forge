import { useRef, useState } from "react";
import { useDoc, useServices } from "./context";
import type { InstrumentTrack, NoteEvent, Pattern } from "../project-model/types";
import { STEP_TICKS, pitchName } from "../project-model/types";
import {
  addNote,
  applyMidiCreativeTool,
  deleteNote,
  deleteNotes,
  duplicateNotes,
  glueNotes,
  quantizeNotes,
  setNotesVelocity,
  splitNotes,
  moveNote,
  resizeNote,
} from "../commands/commands";
import { clamp, uid } from "../shared/ids";
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
  const [velDrag, setVelDrag] = useState<{ noteId: string; startY: number; startVel: number } | null>(null);
  const [noteClipboard, setNoteClipboard] = useState<NoteEvent[] | null>(null);

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

  const [marquee, setMarquee] = useState<{ startStep: number; startPitch: number; endStep: number; endPitch: number } | null>(null);
  const marqueeRef = useRef<{ startStep: number; startPitch: number } | null>(null);

  const onGridPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    if (event.target !== gridRef.current) return;
    if (event.shiftKey) {
      const { stepF, pitch } = posFromEvent(event);
      marqueeRef.current = { startStep: stepF, startPitch: pitch };
      setMarquee({ startStep: stepF, startPitch: pitch, endStep: stepF, endPitch: pitch });
      try {
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      } catch {
        /* no capture */
      }
      return;
    }
    const { stepF, pitch } = posFromEvent(event);
    const start = clamp(Math.floor(stepF), 0, pattern.stepCount - 1) * STEP_TICKS;
    services.store.execute(
      addNote(services.store.doc, track.id, { pitch, start, duration: STEP_TICKS, velocity: 0.9 }),
    );
    onSelectNote(null);
  };
  const onGridPointerMove = (event: React.PointerEvent) => {
    if (!marqueeRef.current) return;
    const { stepF, pitch } = posFromEvent(event);
    const s = marqueeRef.current;
    setMarquee({ startStep: s.startStep, startPitch: s.startPitch, endStep: stepF, endPitch: pitch });
  };
  const onGridPointerUp = () => {
    if (!marqueeRef.current || !marquee) return;
    const { startStep, startPitch, endStep, endPitch } = marquee;
    const minStep = Math.min(startStep, endStep);
    const maxStep = Math.max(startStep, endStep);
    const minPitch = Math.min(startPitch, endPitch);
    const maxPitch = Math.max(startPitch, endPitch);
    const minTick = minStep * STEP_TICKS;
    const maxTick = maxStep * STEP_TICKS;
    const selected = notes.filter((n) => n.start >= minTick && n.start < maxTick && n.pitch >= minPitch && n.pitch <= maxPitch);
    if (selected.length > 0) onSelectNote({ trackId: track.id, noteIds: selected.map((n) => n.id) });
    else onSelectNote(null);
    marqueeRef.current = null;
    setMarquee(null);
  };

  const previewKey = (pitch: number) => services.engine.previewNote(track.id, pitch);

  const stepPct = (step: number) => (step / pattern.stepCount) * 100;

  const beginVelDrag = (e: React.PointerEvent, note: NoteEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* no capture */
    }
    setVelDrag({ noteId: note.id, startY: e.clientY, startVel: note.velocity });
    onSelectNote({ trackId: track.id, noteIds: [note.id] });
  };
  const onVelPointerMove = (e: React.PointerEvent) => {
    if (!velDrag) return;
    const delta = velDrag.startY - e.clientY;
    const v = clamp(velDrag.startVel + delta / 120, 0.05, 1);
    // live preview: update drag visual only, commit on up
    const el = document.querySelector(`[data-vel="${velDrag.noteId}"]`) as HTMLElement | null;
    if (el) el.style.height = `${v * 100}%`;
  };
  const onVelPointerUp = (e: React.PointerEvent) => {
    if (!velDrag) return;
    const delta = velDrag.startY - e.clientY;
    const v = clamp(velDrag.startVel + delta / 120, 0.05, 1);
    services.store.execute(setNotesVelocity(doc, track.id, [velDrag.noteId], v));
    setVelDrag(null);
  };

  // Note clipboard for copy/paste
  const copySelectedNotes = () => {
    if (!hasSelection) return;
    const toCopy = notes.filter((n) => selectedNote!.noteIds.includes(n.id));
    setNoteClipboard(toCopy.map((n) => ({ ...n })));
  };
  const pasteNotesClipboard = () => {
    if (!noteClipboard || noteClipboard.length === 0) return;
    const newNotes = noteClipboard.map((n) => ({ ...n, id: uid("note") }));
    const prev = [...notes];
    const next = [...notes, ...newNotes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    const newIds = newNotes.map((n) => n.id);
    services.store.execute({
      type: "pasteNotes",
      label: `Paste ${newNotes.length} notes`,
      execute: (d: any) => ({
        ...d,
        patterns: d.patterns.map((p: any) => (p.id === pattern.id ? { ...p, notes: { ...(p.notes ?? {}), [track.id]: next } } : p)),
      }),
      undo: (d: any) => ({
        ...d,
        patterns: d.patterns.map((p: any) => (p.id === pattern.id ? { ...p, notes: { ...(p.notes ?? {}), [track.id]: prev } } : p)),
      }),
    } as any);
    onSelectNote({ trackId: track.id, noteIds: newIds });
  };

  // Compute in-scale pitch set for visual highlighting
  const isScaleActive = scalePitches !== null && scalePitches.size > 0;
  const hasSelection = selectedNote?.trackId === track.id && selectedNote.noteIds.length > 0;
  const selCount = hasSelection ? selectedNote!.noteIds.length : notes.length;
  const selLabel = hasSelection ? `${selCount} SEL` : `${notes.length} NOTES`;

  const runOnSelection = (fn: (ids?: string[]) => void) => {
    try {
      const ids = hasSelection ? selectedNote!.noteIds : undefined;
      fn(ids);
      // keep selection after operation
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(e);
    }
  };

  return (
    <div className="pianoroll-wrap">
      <div className="pianoroll-toolbar" role="toolbar" aria-label="Piano roll tools">
        <span className="pr-toolbar-count">{selLabel}</span>
        <div className="pr-toolbar-group">
          <button type="button" className="btn btn-small" title="Quantize to 1/16" onClick={() => runOnSelection((ids) => services.store.execute(quantizeNotes(doc, track.id, ids)))}>
            QUANT
          </button>
          <button type="button" className="btn btn-small" title="Duplicate" onClick={() => runOnSelection((ids) => services.store.execute(duplicateNotes(doc, track.id, ids)))}>
            DUP
          </button>
          <button type="button" className="btn btn-small" title="Split notes in half" disabled={!hasSelection} onClick={() => runOnSelection((ids) => services.store.execute(splitNotes(doc, track.id, ids)))}>
            SPLIT
          </button>
          <button type="button" className="btn btn-small" title="Glue notes of same pitch" disabled={!hasSelection || (selectedNote?.noteIds.length ?? 0) < 2} onClick={() => runOnSelection((ids) => services.store.execute(glueNotes(doc, track.id, ids)))}>
            GLUE
          </button>
          <button
            type="button"
            className="btn btn-small btn-danger"
            title="Delete selected"
            disabled={!hasSelection}
            onClick={() => {
              if (hasSelection) {
                services.store.execute(deleteNotes(doc, track.id, selectedNote!.noteIds));
                onSelectNote(null);
              }
            }}
          >
            DEL
          </button>
        </div>
        <div className="pr-toolbar-group">
          <button
            type="button"
            className="btn btn-small"
            title="Reverse"
            onClick={() => runOnSelection((ids) => services.store.execute(applyMidiCreativeTool(doc, { trackId: track.id, noteIds: ids, operation: { kind: "reverse", scaleLock: scaleSnap, key: doc.key } })))}
          >
            REV
          </button>
          <button
            type="button"
            className="btn btn-small"
            title="Humanize ±12 ticks / ±0.1 vel (seeded)"
            onClick={() =>
              runOnSelection((ids) =>
                services.store.execute(
                  applyMidiCreativeTool(doc, {
                    trackId: track.id,
                    noteIds: ids,
                    operation: { kind: "humanize", options: { timingTicks: 12, velocityAmount: 0.1, seed: `hum-${Date.now()}` }, scaleLock: scaleSnap, key: doc.key },
                  }),
                ),
              )
            }
          >
            HUM
          </button>
          <button
            type="button"
            className="btn btn-small"
            title="Strum 20 ticks up"
            onClick={() =>
              runOnSelection((ids) =>
                services.store.execute(
                  applyMidiCreativeTool(doc, {
                    trackId: track.id,
                    noteIds: ids,
                    operation: { kind: "strum", options: { spreadTicks: 20, direction: "up" }, scaleLock: scaleSnap, key: doc.key },
                  }),
                ),
              )
            }
          >
            STRUM
          </button>
          <button
            type="button"
            className="btn btn-small"
            title="Velocity -10%"
            disabled={!hasSelection}
            onClick={() => {
              if (!hasSelection) return;
              const vel = Math.max(0.05, (notes.find((n) => selectedNote!.noteIds.includes(n.id))?.velocity ?? 0.8) - 0.1);
              services.store.execute(setNotesVelocity(doc, track.id, selectedNote!.noteIds, vel));
            }}
          >
            V-
          </button>
          <button
            type="button"
            className="btn btn-small"
            title="Velocity +10%"
            disabled={!hasSelection}
            onClick={() => {
              if (!hasSelection) return;
              const vel = Math.min(1, (notes.find((n) => selectedNote!.noteIds.includes(n.id))?.velocity ?? 0.8) + 0.1);
              services.store.execute(setNotesVelocity(doc, track.id, selectedNote!.noteIds, vel));
            }}
          >
            V+
          </button>
        </div>
        <div className="pr-toolbar-group">
          <button type="button" className="btn btn-small" title="Copy selected notes" disabled={!hasSelection} onClick={copySelectedNotes}>
            COPY
          </button>
          <button type="button" className="btn btn-small" title="Paste copied notes" disabled={!noteClipboard || noteClipboard.length === 0} onClick={pasteNotesClipboard}>
            PASTE
          </button>
        </div>
      </div>
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
          onPointerMove={onGridPointerMove}
          onPointerUp={onGridPointerUp}
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
          {marquee && (
            <div
              className="pr-marquee"
              style={{
                left: `${(Math.min(marquee.startStep, marquee.endStep) / pattern.stepCount) * 100}%`,
                width: `${(Math.abs(marquee.endStep - marquee.startStep) / pattern.stepCount) * 100}%`,
                top: `${(PITCH_MAX - Math.max(marquee.startPitch, marquee.endPitch)) * ROW_HEIGHT}px`,
                height: `${Math.abs(marquee.endPitch - marquee.startPitch) * ROW_HEIGHT + ROW_HEIGHT}px`,
              }}
            />
          )}
        </div>
      </div>
    </div>
      <div className="pr-velocity-lane" aria-label="Velocity lane">
        <div className="pr-velocity-bg" />
        {notes.map((note) => {
          const left = (note.start / patternTicks) * 100;
          const selected = selectedNote?.trackId === track.id && selectedNote.noteIds.includes(note.id);
          return (
            <div
              key={note.id}
              data-vel={note.id}
              className={`pr-vel-bar${selected ? " selected" : ""}`}
              style={{ left: `${left}%`, height: `${note.velocity * 100}%` }}
              title={`${pitchName(note.pitch)} vel ${Math.round(note.velocity * 100)}% — drag vertically`}
              onPointerDown={(e) => beginVelDrag(e, note)}
              onPointerMove={onVelPointerMove}
              onPointerUp={onVelPointerUp}
            />
          );
        })}
      </div>
    </div>
  );
}
