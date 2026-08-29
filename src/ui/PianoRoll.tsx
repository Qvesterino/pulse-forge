import { useEffect, useRef, useState } from "react";
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
  nudgeNotes,
  quantizeNotes,
  setNotesVelocities,
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
  | {
      mode: "move";
      noteId: string;
      grabStep: number;
      basePitch: number;
      baseStart: number;
      dSteps: number;
      dPitch: number;
      altDuplicate?: boolean;
      duplicatedIds?: string[];
    }
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
  // Ghost notes from other patterns (30% opacity, non-interactive)
  const ghostNotes: NoteEvent[] = (() => {
    const out: NoteEvent[] = [];
    for (const other of doc.patterns) {
      if (other.id === pattern.id) continue;
      const list = other.notes?.[track.id];
      if (!list || list.length === 0) continue;
      for (const n of list) out.push({ ...n, id: `ghost-${other.id}-${n.id}` });
    }
    return out;
  })();
  const [velDrag, setVelDrag] = useState<{
    anchorId: string;
    startY: number;
    startVels: Record<string, number>;
  } | null>(null);
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
    // Alt+drag duplicates selection (or this note if not in selection) before dragging — like FL
    const isAlt = event.altKey;
    let dragNoteId = note.id;
    let altDuplicatedIds: string[] | undefined;
    if (isAlt) {
      const sel = selectedNote?.trackId === track.id ? selectedNote.noteIds : [];
      const idsToDup = sel.includes(note.id) && sel.length > 0 ? sel : [note.id];
      const dups: NoteEvent[] = [];
      for (const nid of idsToDup) {
        const src = notes.find((n) => n.id === nid);
        if (!src) continue;
        dups.push({ ...src, id: uid("note") });
      }
      if (dups.length > 0) {
        const prev = [...notes];
        const next = [...notes, ...dups].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
        const newIds = dups.map((n) => n.id);
        altDuplicatedIds = newIds;
        // Dispatch duplicate as one undo step, then drag the first duplicate
        services.store.execute({
          type: "altDragDuplicate",
          label: `Duplicate ${dups.length} notes`,
          execute: (d: any) => ({
            ...d,
            patterns: d.patterns.map((p: any) =>
              p.id === pattern.id ? { ...p, notes: { ...(p.notes ?? {}), [track.id]: next } } : p,
            ),
          }),
          undo: (d: any) => ({
            ...d,
            patterns: d.patterns.map((p: any) =>
              p.id === pattern.id ? { ...p, notes: { ...(p.notes ?? {}), [track.id]: prev } } : p,
            ),
          }),
        } as any);
        // Switch selection to duplicates so the drag moves the copies
        onSelectNote({ trackId: track.id, noteIds: newIds });
        dragNoteId = newIds[0] ?? note.id;
        // Update note reference to the duplicate's cloned data (same pitch/start as original)
      }
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // no active pointer (synthetic dispatch) — drag continues without capture
    }
    const { stepF } = posFromEvent(event);
    const refNote = notes.find((n) => n.id === note.id) ?? note;
    const noteStartSteps = refNote.start / STEP_TICKS;
    const noteDurSteps = refNote.duration / STEP_TICKS;
    const isEdge = stepF - noteStartSteps > Math.max(noteDurSteps - 0.35, 0.65);
    if (!isAlt) onSelectNote({ trackId: track.id, noteIds: [dragNoteId] });
    if (isEdge) {
      const state: DragState = {
        mode: "resize",
        noteId: dragNoteId,
        baseStart: refNote.start,
        baseDurSteps: noteDurSteps,
        durSteps: noteDurSteps,
      };
      dragRef.current = state;
      setDrag(state);
    } else {
      const state: DragState = {
        mode: "move",
        noteId: dragNoteId,
        grabStep: stepF - noteStartSteps,
        basePitch: refNote.pitch,
        baseStart: refNote.start,
        dSteps: 0,
        dPitch: 0,
        altDuplicate: isAlt,
        duplicatedIds: altDuplicatedIds,
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

  const [marquee, setMarquee] = useState<{
    startStep: number;
    startPitch: number;
    endStep: number;
    endPitch: number;
  } | null>(null);
  const marqueeRef = useRef<{ startStep: number; startPitch: number } | null>(null);

  const onGridPointerDown = (event: React.PointerEvent) => {
    if (event.button === 2) {
      const { stepF, pitch } = posFromEvent(event);
      marqueeRef.current = { startStep: stepF, startPitch: pitch };
      setMarquee({ startStep: stepF, startPitch: pitch, endStep: stepF, endPitch: pitch });
      try {
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      } catch {
        /* no capture */
      }
      event.preventDefault();
      return;
    }
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
    const selected = notes.filter(
      (n) => n.start >= minTick && n.start < maxTick && n.pitch >= minPitch && n.pitch <= maxPitch,
    );
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
    const isInSel = selectedNote?.trackId === track.id && selectedNote.noteIds.includes(note.id);
    if (isInSel && selectedNote!.noteIds.length > 1) {
      const map: Record<string, number> = {};
      for (const nid of selectedNote!.noteIds) {
        const n = notes.find((x) => x.id === nid);
        if (n) map[nid] = n.velocity;
      }
      setVelDrag({ anchorId: note.id, startY: e.clientY, startVels: map });
    } else {
      setVelDrag({ anchorId: note.id, startY: e.clientY, startVels: { [note.id]: note.velocity } });
      onSelectNote({ trackId: track.id, noteIds: [note.id] });
    }
  };
  const onVelPointerMove = (e: React.PointerEvent) => {
    if (!velDrag) return;
    const delta = velDrag.startY - e.clientY;
    for (const [nid, startVel] of Object.entries(velDrag.startVels)) {
      const v = clamp(startVel + delta / 120, 0.05, 1);
      const el = document.querySelector(`[data-vel="${nid}"]`) as HTMLElement | null;
      if (el) el.style.height = `${v * 100}%`;
    }
  };
  const onVelPointerUp = (e: React.PointerEvent) => {
    if (!velDrag) return;
    const delta = velDrag.startY - e.clientY;
    const velocities: Record<string, number> = {};
    for (const [nid, startVel] of Object.entries(velDrag.startVels)) {
      velocities[nid] = clamp(startVel + delta / 120, 0.05, 1);
    }
    const ids = Object.keys(velocities);
    if (ids.length === 1) services.store.execute(setNotesVelocity(doc, track.id, ids, velocities[ids[0]]));
    else services.store.execute(setNotesVelocities(doc, track.id, velocities));
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
        patterns: d.patterns.map((p: any) =>
          p.id === pattern.id ? { ...p, notes: { ...(p.notes ?? {}), [track.id]: next } } : p,
        ),
      }),
      undo: (d: any) => ({
        ...d,
        patterns: d.patterns.map((p: any) =>
          p.id === pattern.id ? { ...p, notes: { ...(p.notes ?? {}), [track.id]: prev } } : p,
        ),
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

  // Keyboard nudge for selected notes (arrow keys when not typing)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "SELECT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (typing) return;
      if (!hasSelection) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
        // Only handle when piano roll is in viewport and user isn't holding ctrl/meta for other shortcuts
        if (e.ctrlKey || e.metaKey) return;
        e.preventDefault();
        let dt = 0;
        let dp = 0;
        if (e.key === "ArrowLeft") dt = e.shiftKey ? -STEP_TICKS * 4 : -STEP_TICKS;
        if (e.key === "ArrowRight") dt = e.shiftKey ? STEP_TICKS * 4 : STEP_TICKS;
        if (e.key === "ArrowUp") dp = e.shiftKey ? 12 : 1;
        if (e.key === "ArrowDown") dp = e.shiftKey ? -12 : -1;
        services.store.execute(nudgeNotes(doc, track.id, selectedNote!.noteIds, dt, dp));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [hasSelection, selectedNote, doc, track.id, services.store]);

  // P2.1 shortcuts: S strum, Alt+S slide, L legato, Ctrl/Cmd+B duplicate
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "SELECT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (typing) return;
      if (!hasSelection) return;
      const lower = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && lower === "b") {
        e.preventDefault();
        try {
          services.store.execute(duplicateNotes(doc, track.id, selectedNote!.noteIds));
        } catch {
          /* empty */
        }
        return;
      }
      if (lower === "s" && !ctrl) {
        if (e.altKey) {
          // Alt+S slide — overlapping legato with 20% overlap for glide
          e.preventDefault();
          const sel = notes.filter((n) => selectedNote!.noteIds.includes(n.id)).sort((a, b) => a.start - b.start);
          if (sel.length < 2) return;
          const prev = [...notes];
          const map = new Map(sel.map((n) => [n.id, { ...n }]));
          for (let i = 0; i < sel.length - 1; i++) {
            const cur = map.get(sel[i].id)!;
            const nxt = sel[i + 1];
            const gap = nxt.start - cur.start;
            cur.duration = Math.max(STEP_TICKS, gap + Math.round(STEP_TICKS * 0.2));
          }
          const last = map.get(sel[sel.length - 1].id);
          if (last) last.duration = sel[sel.length - 1].duration;
          const next = notes.map((n) => map.get(n.id) ?? n);
          services.store.execute({
            type: "slideNotes",
            label: `Slide ${sel.length} notes`,
            execute: (d: any) => ({
              ...d,
              patterns: d.patterns.map((p: any) =>
                p.id === pattern.id ? { ...p, notes: { ...(p.notes ?? {}), [track.id]: next } } : p,
              ),
            }),
            undo: (d: any) => ({
              ...d,
              patterns: d.patterns.map((p: any) =>
                p.id === pattern.id ? { ...p, notes: { ...(p.notes ?? {}), [track.id]: prev } } : p,
              ),
            }),
          } as any);
          return;
        }
        // S strum — 20 ticks spread, uses FL strum semantics
        e.preventDefault();
        services.store.execute(
          applyMidiCreativeTool(doc, {
            trackId: track.id,
            noteIds: selectedNote!.noteIds,
            operation: {
              kind: "strum",
              options: { spreadTicks: 20, direction: "up" },
              scaleLock: scaleSnap,
              key: doc.key,
            },
          }),
        );
        return;
      }
      if (lower === "l" && !ctrl && !e.altKey) {
        e.preventDefault();
        // L legato — extend each selected note to next selected note's start
        const sel = notes.filter((n) => selectedNote!.noteIds.includes(n.id)).sort((a, b) => a.start - b.start);
        if (sel.length === 0) return;
        const prev = [...notes];
        const map = new Map(sel.map((n) => [n.id, { ...n }]));
        for (let i = 0; i < sel.length; i++) {
          const cur = map.get(sel[i].id)!;
          const nextStart =
            i + 1 < sel.length ? sel[i + 1].start : Math.min(patternTicks, cur.start + cur.duration + STEP_TICKS * 2);
          cur.duration = Math.max(STEP_TICKS, nextStart - cur.start);
          if (cur.start + cur.duration > patternTicks) cur.duration = patternTicks - cur.start;
        }
        const next = notes.map((n) => map.get(n.id) ?? n);
        services.store.execute({
          type: "legatoNotes",
          label: `Legato ${sel.length} notes`,
          execute: (d: any) => ({
            ...d,
            patterns: d.patterns.map((p: any) =>
              p.id === pattern.id ? { ...p, notes: { ...(p.notes ?? {}), [track.id]: next } } : p,
            ),
          }),
          undo: (d: any) => ({
            ...d,
            patterns: d.patterns.map((p: any) =>
              p.id === pattern.id ? { ...p, notes: { ...(p.notes ?? {}), [track.id]: prev } } : p,
            ),
          }),
        } as any);
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [hasSelection, selectedNote, doc, track.id, pattern.id, patternTicks, notes, scaleSnap, services.store]);

  return (
    <div className="pianoroll-wrap">
      <div className="pianoroll-toolbar" role="toolbar" aria-label="Piano roll tools">
        <span className="pr-toolbar-count">{selLabel}</span>
        <div className="pr-toolbar-group">
          <button
            type="button"
            className="btn btn-small"
            title="Quantize to 1/16"
            onClick={() => runOnSelection((ids) => services.store.execute(quantizeNotes(doc, track.id, ids)))}
          >
            QUANT
          </button>
          <button
            type="button"
            className="btn btn-small"
            title="Duplicate"
            onClick={() => runOnSelection((ids) => services.store.execute(duplicateNotes(doc, track.id, ids)))}
          >
            DUP
          </button>
          <button
            type="button"
            className="btn btn-small"
            title="Split notes in half"
            disabled={!hasSelection}
            onClick={() => runOnSelection((ids) => services.store.execute(splitNotes(doc, track.id, ids)))}
          >
            SPLIT
          </button>
          <button
            type="button"
            className="btn btn-small"
            title="Glue notes of same pitch"
            disabled={!hasSelection || (selectedNote?.noteIds.length ?? 0) < 2}
            onClick={() => runOnSelection((ids) => services.store.execute(glueNotes(doc, track.id, ids)))}
          >
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
            onClick={() =>
              runOnSelection((ids) =>
                services.store.execute(
                  applyMidiCreativeTool(doc, {
                    trackId: track.id,
                    noteIds: ids,
                    operation: { kind: "reverse", scaleLock: scaleSnap, key: doc.key },
                  }),
                ),
              )
            }
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
                    operation: {
                      kind: "humanize",
                      options: { timingTicks: 12, velocityAmount: 0.1, seed: `hum-${Date.now()}` },
                      scaleLock: scaleSnap,
                      key: doc.key,
                    },
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
                    operation: {
                      kind: "strum",
                      options: { spreadTicks: 20, direction: "up" },
                      scaleLock: scaleSnap,
                      key: doc.key,
                    },
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
              const vel = Math.max(
                0.05,
                (notes.find((n) => selectedNote!.noteIds.includes(n.id))?.velocity ?? 0.8) - 0.1,
              );
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
          <button
            type="button"
            className="btn btn-small"
            title="Nudge left 1/16"
            disabled={!hasSelection}
            onClick={() =>
              hasSelection && services.store.execute(nudgeNotes(doc, track.id, selectedNote!.noteIds, -STEP_TICKS, 0))
            }
          >
            ◀
          </button>
          <button
            type="button"
            className="btn btn-small"
            title="Nudge right 1/16"
            disabled={!hasSelection}
            onClick={() =>
              hasSelection && services.store.execute(nudgeNotes(doc, track.id, selectedNote!.noteIds, STEP_TICKS, 0))
            }
          >
            ▶
          </button>
          <button
            type="button"
            className="btn btn-small"
            title="Nudge up 1 semitone"
            disabled={!hasSelection}
            onClick={() =>
              hasSelection && services.store.execute(nudgeNotes(doc, track.id, selectedNote!.noteIds, 0, 1))
            }
          >
            ▲
          </button>
          <button
            type="button"
            className="btn btn-small"
            title="Nudge down 1 semitone"
            disabled={!hasSelection}
            onClick={() =>
              hasSelection && services.store.execute(nudgeNotes(doc, track.id, selectedNote!.noteIds, 0, -1))
            }
          >
            ▼
          </button>
          <button
            type="button"
            className="btn btn-small"
            title="Arpeggiate Up 1/16"
            onClick={() =>
              runOnSelection((ids) =>
                services.store.execute(
                  applyMidiCreativeTool(doc, {
                    trackId: track.id,
                    noteIds: ids,
                    operation: {
                      kind: "arpeggiate",
                      options: {
                        mode: "up",
                        rateTicks: STEP_TICKS,
                        octaveRange: 1,
                        gate: 0.9,
                        seed: `arp-${Date.now()}`,
                      },
                      scaleLock: scaleSnap,
                      key: doc.key,
                    },
                  }),
                ),
              )
            }
          >
            ARP
          </button>
          <button
            type="button"
            className="btn btn-small"
            title="Note repeat x4 1/32"
            onClick={() =>
              runOnSelection((ids) =>
                services.store.execute(
                  applyMidiCreativeTool(doc, {
                    trackId: track.id,
                    noteIds: ids,
                    operation: {
                      kind: "note-repeat",
                      options: { rateTicks: STEP_TICKS / 2, count: 4, velocityFalloff: 0.15 },
                      scaleLock: scaleSnap,
                      key: doc.key,
                    },
                  }),
                ),
              )
            }
          >
            RPT
          </button>
        </div>
        <div className="pr-toolbar-group">
          <button
            type="button"
            className="btn btn-small"
            title="Copy selected notes"
            disabled={!hasSelection}
            onClick={copySelectedNotes}
          >
            COPY
          </button>
          <button
            type="button"
            className="btn btn-small"
            title="Paste copied notes"
            disabled={!noteClipboard || noteClipboard.length === 0}
            onClick={pasteNotesClipboard}
          >
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
                {isScaleActive && inScale && (
                  <span className="pr-scale-deg">{scaleDegreeLabel(pitch, projectKey!)}</span>
                )}
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
              i % 4 === 0 ? <div key={i} className="pr-beatline" style={{ left: `${stepPct(i)}%` }} /> : null,
            )}
            {playheadStep >= 0 && playheadStep < pattern.stepCount && (
              <div
                className="pr-playhead"
                style={{ left: `${stepPct(playheadStep)}%`, width: `${100 / pattern.stepCount}%` }}
              />
            )}
            {/* Ghost notes from other patterns — 30% opaque, non-interactive */}
            {ghostNotes.map((note) => {
              const startSteps = note.start / STEP_TICKS;
              const durSteps = note.duration / STEP_TICKS;
              const top = (PITCH_MAX - note.pitch) * ROW_HEIGHT;
              return (
                <div
                  key={note.id}
                  className="pr-note ghost"
                  style={{
                    left: `${(startSteps / pattern.stepCount) * 100}%`,
                    width: `${(durSteps / pattern.stepCount) * 100}%`,
                    top: `${clamp(top, 0, (PITCH_COUNT - 1) * ROW_HEIGHT)}px`,
                    opacity: 0.3,
                  }}
                  title={`Ghost ${pitchName(note.pitch)} — from another pattern`}
                />
              );
            })}
            {notes.map((note) => {
              let startSteps = note.start / STEP_TICKS;
              let durSteps = note.duration / STEP_TICKS;
              if (drag && drag.noteId === note.id) {
                if (drag.mode === "move") {
                  startSteps = clamp(startSteps + drag.dSteps, 0, pattern.stepCount - durSteps);
                } else {
                  durSteps = Math.max(1, drag.durSteps);
                }
              }
              const selected = selectedNote?.trackId === track.id && selectedNote.noteIds.includes(note.id);
              const top =
                (PITCH_MAX - note.pitch - (drag && drag.noteId === note.id && drag.mode === "move" ? drag.dPitch : 0)) *
                ROW_HEIGHT;
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
                  title={`${pitchName(note.pitch)} — drag to move, Alt+drag duplicate, drag right edge to resize, right-click to delete — S strum, Alt+S slide, L legato, Ctrl+B duplicate`}
                  onPointerDown={(event) => beginNoteDrag(event, note)}
                  onPointerMove={onNotePointerMove}
                  onPointerUp={onNotePointerUp}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    services.store.execute(deleteNote(services.store.doc, track.id, note.id));
                    if (selectedNote?.trackId === track.id && selectedNote.noteIds.includes(note.id))
                      onSelectNote(null);
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
