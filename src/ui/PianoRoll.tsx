import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useDoc, useServices } from "./context";
import type { InstrumentTrack, NoteEvent, Pattern, ProjectDocument } from "../project-model/types";
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
import { usePublishCursor, useRemoteCursors } from "./remoteCursors";
import { MELODIC_OFFSETS, melodicKeys } from "./melodicKeys";
import { humanizeVelocities, randomizeVelocities } from "../shared/velocityFx";

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
  | { mode: "resize"; noteId: string; baseStart: number; baseDurSteps: number; durSteps: number }
  | { mode: "noteVelocity"; noteId: string; startY: number; startVels: Record<string, number> };

/** Per-note visual state derived from an active drag (null = not dragging this note). */
interface NoteDragPreview {
  mode: "move" | "resize";
  dSteps: number;
  dPitch: number;
  durSteps: number;
}

/** Note event handlers live behind a stable object (latest-ref) — see PianoRollNote. */
interface PianoRollNoteHandlers {
  beginDrag: (event: React.PointerEvent, note: NoteEvent) => void;
  pointerHover: (event: React.PointerEvent) => void;
  pointerUp: (event?: React.PointerEvent) => void;
  pointerCancel: () => void;
  deleteAt: (event: React.MouseEvent, note: NoteEvent) => void;
  /** Touch long-press — opens the note action menu (delete/duplicate/slide). */
  openMenu: (note: NoteEvent, x: number, y: number) => void;
}

/**
 * One piano-roll note. Memoized because a drag re-renders the whole track on
 * every pointermove and only the dragged note's props change — without the
 * memo the per-frame diff is O(notes) and ~300-note patterns blow the 60 Hz
 * frame budget (measured 7-10 ms/frame in the jsdom probe). Handlers arrive
 * through a stable object whose fields the parent refreshes each render, so
 * skipped notes never hold stale closures.
 */
const PianoRollNote = memo(
  function PianoRollNote({
    note,
    stepCount,
    selected,
    outOfScale,
    dragPreview,
    handlers,
  }: {
    note: NoteEvent;
    stepCount: number;
    selected: boolean;
    outOfScale: boolean;
    dragPreview: NoteDragPreview | null;
    handlers: PianoRollNoteHandlers;
  }) {
    let startSteps = note.start / STEP_TICKS;
    let durSteps = note.duration / STEP_TICKS;
    let top = (PITCH_MAX - note.pitch) * ROW_HEIGHT;
    if (dragPreview?.mode === "move") {
      startSteps = clamp(startSteps + dragPreview.dSteps, 0, stepCount - durSteps);
      top = (PITCH_MAX - note.pitch - dragPreview.dPitch) * ROW_HEIGHT;
    } else if (dragPreview?.mode === "resize") {
      durSteps = Math.max(1, dragPreview.durSteps);
    }
    return (
      <div
        data-note-id={note.id}
        className={`pr-note${selected ? " selected" : ""}${outOfScale ? " out-of-scale" : ""}${note.slide ? " slide" : ""}`}
        style={{
          left: `${(startSteps / stepCount) * 100}%`,
          width: `${(durSteps / stepCount) * 100}%`,
          top: `${clamp(top, 0, (PITCH_COUNT - 1) * ROW_HEIGHT)}px`,
          opacity: 0.35 + note.velocity * 0.65,
        }}
        title={`${pitchName(note.pitch)}${note.slide ? " (slide)" : ""} — top third = move, right edge = resize, middle+Alt = duplicate, middle+Ctrl = velocity — S strum, Alt+S slide, L legato, Ctrl+B duplicate — hold on touch for the note menu`}
        onPointerDown={(event) => handlers.beginDrag(event, note)}
        onPointerMove={handlers.pointerHover}
        onPointerUp={handlers.pointerUp}
        onPointerCancel={handlers.pointerCancel}
        onContextMenu={(event) => handlers.deleteAt(event, note)}
      />
    );
  },
  (a, b) =>
    a.note === b.note &&
    a.stepCount === b.stepCount &&
    a.selected === b.selected &&
    a.outOfScale === b.outOfScale &&
    a.dragPreview?.mode === b.dragPreview?.mode &&
    a.dragPreview?.dSteps === b.dragPreview?.dSteps &&
    a.dragPreview?.dPitch === b.dragPreview?.dPitch &&
    a.dragPreview?.durSteps === b.dragPreview?.durSteps,
);

/** Velocity-lane handlers behind a stable object — see VelocityBar. */
interface PianoRollVelHandlers {
  beginDrag: (event: React.PointerEvent, note: NoteEvent) => void;
  pointerMove: (event: React.PointerEvent) => void;
  pointerUp: (event: React.PointerEvent) => void;
  pointerCancel: () => void;
}

/**
 * One velocity-lane bar. Memoized for the same reason as PianoRollNote: the
 * lane re-renders on every drag pointermove with only one bar changed.
 */
const VelocityBar = memo(
  function VelocityBar({
    note,
    patternTicks,
    selected,
    handlers,
  }: {
    note: NoteEvent;
    patternTicks: number;
    selected: boolean;
    handlers: PianoRollVelHandlers;
  }) {
    const left = (note.start / patternTicks) * 100;
    const hue = Math.round(200 - Math.max(0, Math.min(1, (note.velocity - 0.05) / 0.95)) * 180);
    return (
      <div
        data-vel={note.id}
        className={`pr-vel-bar${selected ? " selected" : ""}`}
        style={{ left: `${left}%`, height: `${note.velocity * 100}%`, background: `hsl(${hue} 85% 55%)` }}
        title={`${pitchName(note.pitch)} vel ${Math.round(note.velocity * 100)}% — drag vertically`}
        onPointerDown={(e) => handlers.beginDrag(e, note)}
        onPointerMove={handlers.pointerMove}
        onPointerUp={handlers.pointerUp}
        onPointerCancel={handlers.pointerCancel}
      />
    );
  },
  (a, b) => a.note === b.note && a.patternTicks === b.patternTicks && a.selected === b.selected,
);

/** Keyboard-column handlers behind a stable object — see PianoKey. */
interface PianoKeyHandlers {
  preview: (pitch: number) => void;
}

/**
 * One piano keyboard key. Memoized: the column is 61 static buttons that
 * otherwise re-diff on every drag pointermove even though only the scale
 * highlighting (rare) can change them. Scale labels arrive precomputed —
 * the key has no access to the project key.
 */
const PianoKey = memo(
  function PianoKey({
    pitch,
    scaleActive,
    inScale,
    isRoot,
    degLabel,
    handlers,
  }: {
    pitch: number;
    scaleActive: boolean;
    inScale: boolean;
    isRoot: boolean;
    degLabel: string;
    handlers: PianoKeyHandlers;
  }) {
    return (
      <button
        type="button"
        className={`pr-key${BLACK_KEYS.has(pitch % 12) ? " black" : ""}${pitch % 12 === 0 ? " c-key" : ""}${scaleActive && !inScale ? " out-scale" : ""}${isRoot ? " root" : ""}`}
        style={{ height: ROW_HEIGHT }}
        title={`Preview ${pitchName(pitch)}${scaleActive && inScale ? " (in scale)" : ""}`}
        onPointerDown={() => handlers.preview(pitch)}
      >
        {pitch % 12 === 0 ? pitchName(pitch) : ""}
        {scaleActive && inScale && degLabel && <span className="pr-scale-deg">{degLabel}</span>}
      </button>
    );
  },
  (a, b) =>
    a.pitch === b.pitch &&
    a.scaleActive === b.scaleActive &&
    a.inScale === b.inScale &&
    a.isRoot === b.isRoot &&
    a.degLabel === b.degLabel,
);

/** A non-interactive ghost note shown behind the editable grid. */
const GhostNote = memo(
  function GhostNote({
    note,
    stepCount,
    variant,
  }: {
    note: NoteEvent;
    stepCount: number;
    variant: "ghost" | "ghost-track";
  }) {
    const startSteps = note.start / STEP_TICKS;
    const durSteps = note.duration / STEP_TICKS;
    const top = (PITCH_MAX - note.pitch) * ROW_HEIGHT;
    return (
      <div
        className={`pr-note ${variant}`}
        style={{
          left: `${(startSteps / stepCount) * 100}%`,
          width: `${(durSteps / stepCount) * 100}%`,
          top: `${clamp(top, 0, (PITCH_COUNT - 1) * ROW_HEIGHT)}px`,
          opacity: variant === "ghost" ? 0.3 : 0.2,
        }}
        title={`Ghost ${pitchName(note.pitch)} — ${variant === "ghost" ? "from another pattern" : "from another track in same pattern"}`}
      />
    );
  },
  (a, b) => a.note === b.note && a.stepCount === b.stepCount && a.variant === b.variant,
);

export function PianoRollTrack({
  track,
  pattern,
  playheadStep,
  selectedNote,
  onSelectNote,
  scaleSnap,
  fullscreen = false,
  onToggleFullscreen,
}: {
  track: InstrumentTrack;
  pattern: Pattern;
  playheadStep: number;
  selectedNote: SelectedNote | null;
  onSelectNote: (selection: SelectedNote | null) => void;
  scaleSnap: boolean;
  /** Fullscreen presentation for touch/narrow screens (mobile layout V2). */
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
}) {
  const services = useServices();
  const doc = useDoc();
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const notes = pattern.notes?.[track.id] ?? [];
  const patternTicks = STEP_TICKS * pattern.stepCount;
  // Ghost notes from other patterns (30% opacity, non-interactive) — memoized
  // so drag re-renders reuse the same note objects and skip the diff.
  const ghostNotes: NoteEvent[] = useMemo(() => {
    const out: NoteEvent[] = [];
    for (const other of doc.patterns) {
      if (other.id === pattern.id) continue;
      const list = other.notes?.[track.id];
      if (!list || list.length === 0) continue;
      for (const n of list) out.push({ ...n, id: `ghost-${other.id}-${n.id}` });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.patterns, pattern.id, track.id]);
  // Ghost notes per track (same pattern, other instrument tracks) — 20% opacity
  const ghostTrackNotes: NoteEvent[] = useMemo(() => {
    const out: NoteEvent[] = [];
    for (const [otherTrackId, list] of Object.entries(pattern.notes ?? {})) {
      if (otherTrackId === track.id) continue;
      const otherTrack = doc.tracks.find((t) => t.id === otherTrackId);
      if (!otherTrack || otherTrack.kind !== "instrument") continue;
      for (const n of list as NoteEvent[]) out.push({ ...n, id: `ghost-track-${otherTrackId}-${n.id}` });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pattern.notes, doc.tracks, track.id]);
  const [velDrag, setVelDrag] = useState<{
    anchorId: string;
    startY: number;
    startVels: Record<string, number>;
  } | null>(null);
  const [velZoom, setVelZoom] = useState(1);
  const [noteClipboard, setNoteClipboard] = useState<NoteEvent[] | null>(null);
  // Touch note menu — opened by a long-press; right-click keeps instant delete.
  const [noteMenu, setNoteMenu] = useState<{ noteId: string; x: number; y: number } | null>(null);
  const noteMenuTimer = useRef<number | null>(null);
  const noteMenuAnchor = useRef<{ x: number; y: number } | null>(null);
  const noteLongPressFired = useRef(false);
  // FL Chord Stamp menu (Shift+C) — shape picker anchored at cursor
  const [chordMenu, setChordMenu] = useState<{ x: number; y: number } | null>(null);
  // Step entry (FL-style): a grid cursor — QWERTY letter keys insert notes at
  // the cursor (cursor row = root, keys = semitone offsets) and the cursor
  // advances by the entry duration; arrows move it, Delete removes the note
  // under it. Live melodicKeys play yields to the editor while this is on.
  const [stepEntry, setStepEntry] = useState(false);
  const [entrySteps, setEntrySteps] = useState(2);
  const [cursor, setCursor] = useState({ pitch: 60, step: 0 });
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  useEffect(() => {
    melodicKeys.setSuppressed(stepEntry);
    return () => melodicKeys.setSuppressed(false);
  }, [stepEntry]);
  useEffect(() => {
    if (!stepEntry) return;
    const stepCount = pattern.stepCount;
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      const cur = cursorRef.current;
      const isArrow = event.code === "ArrowLeft" || event.code === "ArrowRight" || event.code === "ArrowUp" || event.code === "ArrowDown";
      if (event.repeat && !isArrow) return;
      if (event.code === "ArrowLeft") {
        event.preventDefault();
        setCursor((c) => ({ ...c, step: Math.max(0, c.step - entrySteps) }));
        return;
      }
      if (event.code === "ArrowRight") {
        event.preventDefault();
        setCursor((c) => ({ ...c, step: Math.min(Math.max(0, stepCount - entrySteps), c.step + entrySteps) }));
        return;
      }
      if (event.code === "ArrowUp" || event.code === "ArrowDown") {
        event.preventDefault();
        const delta = (event.code === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 12 : 1);
        setCursor((c) => ({ ...c, pitch: Math.max(PITCH_MIN, Math.min(PITCH_MAX, c.pitch + delta)) }));
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        const hit = (pattern.notes?.[track.id] ?? []).find(
          (n) => n.pitch === cur.pitch && n.start === cur.step * STEP_TICKS,
        );
        if (hit) services.store.execute(deleteNote(doc, track.id, hit.id));
        return;
      }
      const offset = MELODIC_OFFSETS[event.code];
      if (offset === undefined || event.ctrlKey || event.altKey || event.metaKey) return;
      event.preventDefault();
      // Cursor row is the entry root — keys stack semitones above it, so a
      // chord is just holding several keys before moving on.
      const pitch = Math.max(0, Math.min(127, cur.pitch + offset));
      services.store.execute(
        addNote(doc, track.id, {
          pitch,
          start: cur.step * STEP_TICKS,
          duration: entrySteps * STEP_TICKS,
          velocity: 0.8,
        }),
      );
      services.engine.noteOn?.(track.id, pitch, 0.8, services.engine.currentTime + 0.005, 0.2);
      setCursor((c) => ({ ...c, step: Math.min(Math.max(0, stepCount - entrySteps), c.step + entrySteps) }));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [stepEntry, entrySteps, pattern, track.id, doc, services]);
  useEffect(() => {
    if (!chordMenu) return;
    const onDown = (ev: MouseEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t?.closest(".chord-stamp-menu")) return;
      setChordMenu(null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setChordMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [chordMenu]);

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
    // Touch/pen: hold a note to open the action menu (delete / duplicate /
    // slide). Without this the only note deletion on touch is impossible —
    // mobile browsers never produce a right-click.
    if (event.pointerType !== "mouse") {
      if (noteMenuTimer.current !== null) window.clearTimeout(noteMenuTimer.current);
      const anchor = { x: event.clientX, y: event.clientY };
      noteMenuAnchor.current = anchor;
      noteMenuTimer.current = window.setTimeout(() => {
        noteMenuTimer.current = null;
        noteLongPressFired.current = true;
        onSelectNote({ trackId: track.id, noteIds: [note.id] });
        setNoteMenu({ noteId: note.id, x: anchor.x, y: anchor.y });
      }, 450);
      // Fall through: if the finger moves, the timer is cancelled and the
      // normal move gesture proceeds.
    }
    if (event.shiftKey) {
      const currentIds = selectedNote?.trackId === track.id ? selectedNote.noteIds : [];
      const nextIds = currentIds.includes(note.id)
        ? currentIds.filter((id) => id !== note.id)
        : [...currentIds, note.id];
      onSelectNote(nextIds.length > 0 ? { trackId: track.id, noteIds: nextIds } : null);
      return;
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const relX = event.clientX - rect.left;
    const relY = event.clientY - rect.top;
    const isRightEdge = relX > rect.width - 8;
    const isTopThird = relY < rect.height * 0.33;
    const isAlt = event.altKey;
    const isCtrl = event.ctrlKey || event.metaKey;
    // Smart Tool: right edge = resize (highest priority), Ctrl = velocity, Alt = duplicate+move, top third = move
    const smartMode: "resize" | "velocity" | "duplicate" | "move" = isRightEdge
      ? "resize"
      : isCtrl
        ? "velocity"
        : isAlt
          ? "duplicate"
          : isTopThird
            ? "move"
            : "move";
    if (smartMode === "velocity") {
      // Middle+Ctrl = velocity (vertical drag, no pitch/time move) — like FL/Cubase smart tool
      try {
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      } catch {}
      const selIds =
        selectedNote?.trackId === track.id && selectedNote.noteIds.includes(note.id) ? selectedNote.noteIds : [note.id];
      const map: Record<string, number> = {};
      for (const nid of selIds) {
        const n = notes.find((x) => x.id === nid);
        if (n) map[nid] = n.velocity;
      }
      if (!selectedNote || !selIds.every((id) => selectedNote.noteIds.includes(id)))
        onSelectNote({ trackId: track.id, noteIds: selIds });
      const state: DragState = { mode: "noteVelocity", noteId: note.id, startY: event.clientY, startVels: map };
      dragRef.current = state;
      setDrag(state as unknown as DragState);
      return;
    }
    // Alt+drag duplicates selection (or this note if not in selection) before dragging — like FL
    const isDuplicate = smartMode === "duplicate" || isAlt;
    let dragNoteId = note.id;
    let altDuplicatedIds: string[] | undefined;
    if (isDuplicate) {
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
        onSelectNote({ trackId: track.id, noteIds: newIds });
        dragNoteId = newIds[0] ?? note.id;
      }
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {}
    const { stepF } = posFromEvent(event);
    const refNote = notes.find((n) => n.id === dragNoteId) ?? notes.find((n) => n.id === note.id) ?? note;
    const noteStartSteps = refNote.start / STEP_TICKS;
    const noteDurSteps = refNote.duration / STEP_TICKS;
    const isEdge = isRightEdge || stepF - noteStartSteps > Math.max(noteDurSteps - 0.35, 0.65);
    if (!isDuplicate) onSelectNote({ trackId: track.id, noteIds: [dragNoteId] });
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
        altDuplicate: isDuplicate,
        duplicatedIds: altDuplicatedIds,
      };
      dragRef.current = state;
      setDrag(state);
    }
  };

  const onNotePointerMove = (event: React.PointerEvent) => {
    // Any real movement before the hold threshold means "drag", not "menu".
    if (noteMenuTimer.current !== null) {
      const start = noteMenuAnchor.current;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 7) {
        window.clearTimeout(noteMenuTimer.current);
        noteMenuTimer.current = null;
      }
    }
    const current = dragRef.current;
    if (!current) return;
    if (current.mode === "noteVelocity") {
      const delta = current.startY - event.clientY;
      for (const [nid, startVel] of Object.entries(current.startVels)) {
        const v = clamp(startVel + delta / 120, 0.05, 1);
        const el = document.querySelector(`[data-vel="${nid}"]`) as HTMLElement | null;
        if (el) el.style.height = `${v * 100}%`;
        const noteEl = document.querySelector(`[data-note-id="${nid}"]`) as HTMLElement | null;
        if (noteEl) noteEl.style.opacity = String(0.35 + v * 0.65);
      }
      return;
    }
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

  const onNotePointerUp = (event?: React.PointerEvent) => {
    // The hold already opened the note menu — releasing must not commit a move.
    if (noteMenuTimer.current !== null) {
      window.clearTimeout(noteMenuTimer.current);
      noteMenuTimer.current = null;
    }
    if (noteLongPressFired.current) {
      noteLongPressFired.current = false;
      dragRef.current = null;
      setDrag(null);
      return;
    }
    const current = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!current) return;
    if (current.mode === "noteVelocity") {
      const delta = current.startY - (event?.clientY ?? current.startY);
      const velocities: Record<string, number> = {};
      for (const [nid, startVel] of Object.entries(current.startVels))
        velocities[nid] = clamp(startVel + delta / 120, 0.05, 1);
      const ids = Object.keys(velocities);
      if (ids.length === 1) services.store.execute(setNotesVelocity(doc, track.id, ids, velocities[ids[0]]));
      else if (ids.length > 1) services.store.execute(setNotesVelocities(doc, track.id, velocities));
      // reset preview styles
      for (const nid of ids) {
        const el = document.querySelector(`[data-vel="${nid}"]`) as HTMLElement | null;
        if (el) {
          const n = notes.find((x) => x.id === nid);
          if (n) el.style.height = `${n.velocity * 100}%`;
        }
      }
      return;
    }
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

  // Interrupted drag (touch takeover, autoscroll, …) — abort without committing.
  const onNotePointerCancel = () => {
    if (noteMenuTimer.current !== null) {
      window.clearTimeout(noteMenuTimer.current);
      noteMenuTimer.current = null;
    }
    noteLongPressFired.current = false;
    const current = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (current?.mode === "noteVelocity") {
      // Restore the inline previews the drag mutated (no doc change will re-render them).
      for (const [nid, startVel] of Object.entries(current.startVels)) {
        const el = document.querySelector(`[data-vel="${nid}"]`) as HTMLElement | null;
        if (el) el.style.height = `${startVel * 100}%`;
        const noteEl = document.querySelector(`[data-note-id="${nid}"]`) as HTMLElement | null;
        if (noteEl) noteEl.style.opacity = String(0.35 + startVel * 0.65);
      }
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
  // Interrupted marquee — drop the selection rectangle without selecting.
  const onGridPointerCancel = () => {
    marqueeRef.current = null;
    setMarquee(null);
  };

  const previewKey = (pitch: number) => services.engine.previewNote(track.id, pitch);

  const stepPct = (step: number) => (step / pattern.stepCount) * 100;

  // ── Presence cursors ──────────────────────────────────────────────────
  const remoteCursors = useRemoteCursors();
  const publishCursor = usePublishCursor();
  const lastHoverRef = useRef<string | null>(null);
  /** Broadcast the hovered grid cell — only on cell change, mouse only. */
  const publishHover = (event: React.PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    const { stepF, pitch } = posFromEvent(event);
    const step = clamp(Math.floor(stepF), 0, pattern.stepCount - 1);
    const key = `${step}:${pitch}`;
    if (lastHoverRef.current === key) return;
    lastHoverRef.current = key;
    publishCursor({ view: "pianoroll", patternId: pattern.id, trackId: track.id, stepIndex: step, pitch });
  };
  const leaveGrid = () => {
    lastHoverRef.current = null;
    publishCursor(null);
  };
  // Everyone else hovering a cell of THIS track in THIS pattern.
  const remoteHere = remoteCursors.filter(
    ({ cursor }) =>
      cursor.view === "pianoroll" &&
      cursor.trackId === track.id &&
      (cursor.patternId ?? pattern.id) === pattern.id &&
      cursor.pitch !== undefined &&
      cursor.stepIndex !== undefined,
  );

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
  // Interrupted velocity drag — abort and restore the lane previews.
  const onVelPointerCancel = () => {
    if (!velDrag) return;
    for (const [nid, startVel] of Object.entries(velDrag.startVels)) {
      const el = document.querySelector(`[data-vel="${nid}"]`) as HTMLElement | null;
      if (el) el.style.height = `${startVel * 100}%`;
    }
    setVelDrag(null);
  };

  // Drag + hover cursor preview for one note (extracted from JSX so the
  // memoized note component can call it through the stable handlers ref).
  const onNotePointerHover = (event: React.PointerEvent) => {
    onNotePointerMove(event);
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const edge = x > rect.width - 8;
    const topThird = y < rect.height * 0.33;
    const el = event.currentTarget as HTMLElement;
    if (edge) el.style.cursor = "ew-resize";
    else if (event.ctrlKey || event.metaKey) el.style.cursor = "ns-resize";
    else if (event.altKey) el.style.cursor = "copy";
    else if (topThird) el.style.cursor = "move";
    else el.style.cursor = "grab";
  };

  const deleteNoteAt = (event: React.MouseEvent, note: NoteEvent) => {
    event.preventDefault();
    services.store.execute(deleteNote(services.store.doc, track.id, note.id));
    if (selectedNote?.trackId === track.id && selectedNote.noteIds.includes(note.id)) onSelectNote(null);
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

  // P2.1 shortcuts + P2.5: S strum, Alt+S slide, L legato, Ctrl/Cmd+B duplicate,
  // Shift+C chord stamp menu, Alt+Q quick quantize 50%
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
      const lower = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && lower === "b") {
        if (!hasSelection) return;
        e.preventDefault();
        try {
          services.store.execute(duplicateNotes(doc, track.id, selectedNote!.noteIds));
        } catch {
          /* empty */
        }
        return;
      }
      // Alt+Q quick quantize 50% (FL) — partial strength keeps groove feel, 2 keys vs 8
      if (e.altKey && lower === "q" && !ctrl) {
        e.preventDefault();
        try {
          services.store.execute(
            quantizeNotes(doc, track.id, hasSelection ? selectedNote!.noteIds : undefined, STEP_TICKS, 0.5),
          );
        } catch {
          /* nothing selected */
        }
        return;
      }
      // Shift+C chord stamp menu (anchored near the piano roll toolbar)
      if (e.shiftKey && lower === "c" && !ctrl) {
        e.preventDefault();
        setChordMenu({ x: window.innerWidth / 2 - 90, y: 140 });
        return;
      }
      if (!hasSelection) return;
      if (lower === "s" && !ctrl) {
        if (e.altKey) {
          // Alt+S slide — FL portamento: mark notes slide=true (glide from previous note)
          e.preventDefault();
          const sel = notes.filter((n) => selectedNote!.noteIds.includes(n.id)).sort((a, b) => a.start - b.start);
          if (sel.length === 0) return;
          const anySlid = sel.some((n) => n.slide === true);
          const prev = [...notes];
          const slideSet = new Set(sel.map((n) => n.id));
          const next = notes.map((n) => {
            if (!slideSet.has(n.id)) return n;
            // Toggle: first (earliest) selected note stays an attack; the rest slide
            if (anySlid) {
              const { slide: _drop, ...rest } = n;
              return rest as NoteEvent;
            }
            return { ...n, slide: n.start > sel[0].start };
          });
          services.store.execute({
            type: "slideNotes",
            label: anySlid ? `Unslide ${sel.length} notes` : `Slide ${sel.length} notes`,
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

  // Latest-ref handlers for the memoized notes: the ref object identity is
  // stable (memo comparisons never see it change), while its fields always
  // point at the freshest closures from this render.
  const noteHandlersRef = useRef<PianoRollNoteHandlers>({
    beginDrag: () => {},
    pointerHover: () => {},
    pointerUp: () => {},
    pointerCancel: () => {},
    deleteAt: () => {},
    openMenu: () => {},
  });
  noteHandlersRef.current = {
    beginDrag: beginNoteDrag,
    pointerHover: onNotePointerHover,
    pointerUp: onNotePointerUp,
    pointerCancel: onNotePointerCancel,
    deleteAt: deleteNoteAt,
    openMenu: (note, x, y) => setNoteMenu({ noteId: note.id, x, y }),
  };
  const velHandlersRef = useRef<PianoRollVelHandlers>({
    beginDrag: () => {},
    pointerMove: () => {},
    pointerUp: () => {},
    pointerCancel: () => {},
  });
  velHandlersRef.current = {
    beginDrag: beginVelDrag,
    pointerMove: onVelPointerMove,
    pointerUp: onVelPointerUp,
    pointerCancel: onVelPointerCancel,
  };
  const keyHandlersRef = useRef<PianoKeyHandlers>({ preview: () => {} });
  keyHandlersRef.current = { preview: previewKey };

  return (
    <div className={"pianoroll-wrap" + (fullscreen ? " pr-fullscreen" : "")}>
      <div className="pianoroll-toolbar" role="toolbar" aria-label="Piano roll tools">
        <span className="pr-toolbar-count">{selLabel}</span>
        {onToggleFullscreen && (
          <button
            type="button"
            className="btn btn-small pr-fullscreen-toggle"
            aria-pressed={fullscreen}
            aria-label={fullscreen ? "Exit fullscreen piano roll" : "Fullscreen piano roll"}
            title={fullscreen ? "Exit fullscreen" : "Fullscreen editor (touch screens)"}
            onClick={onToggleFullscreen}
          >
            {fullscreen ? "✕" : "⤢"}
          </button>
        )}
        <div className="pr-toolbar-group">
          <button
            type="button"
            className={`btn btn-small pr-step-toggle${stepEntry ? " active-solo" : ""}`}
            aria-pressed={stepEntry}
            title="Step entry — cursor mode: A–; keys insert notes at the cursor (cursor row = root), ←/→ move by the entry length, ↑/↓ pitch (Shift = octave), Delete removes the note under the cursor"
            onClick={() => setStepEntry((v) => !v)}
          >
            STEP
          </button>
          {stepEntry && (
            <select
              className="pr-step-dur"
              aria-label="Step entry duration"
              title="Entry duration — the cursor advances by this after each inserted note"
              value={entrySteps}
              onChange={(e) => setEntrySteps(Number(e.target.value))}
            >
              <option value={1}>1/16</option>
              <option value={2}>1/8</option>
              <option value={4}>1/4</option>
              <option value={8}>1/2</option>
            </select>
          )}
          <button
            type="button"
            className="btn btn-small"
            title="Quantize to 1/16"
            onClick={() => runOnSelection((ids) => services.store.execute(quantizeNotes(doc, track.id, ids ?? [])))}
          >
            QUANT
          </button>
          <button
            type="button"
            className="btn btn-small"
            disabled={!hasSelection}
            title="Randomize velocities of the selected notes (0.45–100%)"
            onClick={() =>
              runOnSelection((ids) => {
                const list = ids ?? [];
                const current = list.map((id) => notes.find((n) => n.id === id)?.velocity ?? 0);
                const next = randomizeVelocities(current);
                const velocities: Record<string, number> = {};
                list.forEach((id, i) => (velocities[id] = next[i]));
                services.store.execute(setNotesVelocities(doc, track.id, velocities));
              })
            }
          >
            RND
          </button>
          <button
            type="button"
            className="btn btn-small"
            disabled={!hasSelection}
            title="Humanize — nudge selected note velocities ±12% so the part breathes"
            onClick={() =>
              runOnSelection((ids) => {
                const list = ids ?? [];
                const current = list.map((id) => notes.find((n) => n.id === id)?.velocity ?? 0);
                const next = humanizeVelocities(current);
                const velocities: Record<string, number> = {};
                list.forEach((id, i) => (velocities[id] = next[i]));
                services.store.execute(setNotesVelocities(doc, track.id, velocities));
              })
            }
          >
            HUMAN
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
            title="Invert (vertical flip)"
            disabled={!hasSelection}
            onClick={() =>
              runOnSelection((ids) =>
                services.store.execute(
                  applyMidiCreativeTool(doc, {
                    trackId: track.id,
                    noteIds: ids,
                    operation: { kind: "invert", scaleLock: scaleSnap, key: doc.key },
                  }),
                ),
              )
            }
          >
            INV
          </button>
          <button
            type="button"
            className="btn btn-small"
            title="Mirror around C4 (60)"
            disabled={!hasSelection}
            onClick={() =>
              runOnSelection((ids) =>
                services.store.execute(
                  applyMidiCreativeTool(doc, {
                    trackId: track.id,
                    noteIds: ids,
                    operation: { kind: "mirror", centerPitch: 60, scaleLock: scaleSnap, key: doc.key },
                  }),
                ),
              )
            }
          >
            MIR
          </button>
          <button
            type="button"
            className="btn btn-small"
            title="Retrograde (reverse in time)"
            disabled={!hasSelection}
            onClick={() =>
              runOnSelection((ids) =>
                services.store.execute(
                  applyMidiCreativeTool(doc, {
                    trackId: track.id,
                    noteIds: ids,
                    operation: { kind: "retrograde", scaleLock: scaleSnap, key: doc.key },
                  }),
                ),
              )
            }
          >
            RETRO
          </button>
          <button
            type="button"
            className="btn btn-small"
            title="Cluster (within one octave)"
            disabled={!hasSelection}
            onClick={() =>
              runOnSelection((ids) =>
                services.store.execute(
                  applyMidiCreativeTool(doc, {
                    trackId: track.id,
                    noteIds: ids,
                    operation: { kind: "cluster", scaleLock: scaleSnap, key: doc.key },
                  }),
                ),
              )
            }
          >
            CLUS
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
        <div className="pr-toolbar-group">
          <span className="slider-label" title="Velocity lane zoom — per-velocity colors">
            V-ZOOM
          </span>
          <button
            type="button"
            className="btn btn-small"
            title="Zoom out velocity lane"
            onClick={() => setVelZoom((z) => Math.max(0.5, z - 0.25))}
          >
            −
          </button>
          <span style={{ fontSize: 11, minWidth: 32, textAlign: "center" }}>{Math.round(velZoom * 100)}%</span>
          <button
            type="button"
            className="btn btn-small"
            title="Zoom in velocity lane"
            onClick={() => setVelZoom((z) => Math.min(2.5, z + 0.25))}
          >
            +
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
              <PianoKey
                key={pitch}
                pitch={pitch}
                scaleActive={isScaleActive}
                inScale={inScale}
                isRoot={Boolean(isRoot)}
                degLabel={(inScale && projectKey ? scaleDegreeLabel(pitch, projectKey) : "") ?? ""}
                handlers={keyHandlersRef.current}
              />
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
            onPointerMove={(event) => {
              onGridPointerMove(event);
              publishHover(event);
            }}
            onPointerLeave={leaveGrid}
            onPointerUp={onGridPointerUp}
            onPointerCancel={onGridPointerCancel}
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
            {/* Bar lines + numbers for multi-bar patterns (FL orientation for long pads) */}
            {pattern.stepCount > 16 &&
              Array.from({ length: Math.floor(pattern.stepCount / 16) + 1 }, (_, b) => {
                const step = b * 16;
                if (step > pattern.stepCount) return null;
                return (
                  <div key={`bar-${b}`} className="pr-barline" style={{ left: `${stepPct(step)}%` }}>
                    {step < pattern.stepCount && <span className="pr-barnum">{b + 1}</span>}
                  </div>
                );
              })}
            {playheadStep >= 0 && playheadStep < pattern.stepCount && (
              <div
                className="pr-playhead"
                style={{ left: `${stepPct(playheadStep)}%`, width: `${100 / pattern.stepCount}%` }}
              />
            )}
            {/* Step-entry cursor — pitch row × entry-length column */}
            {stepEntry && (
              <div
                className="pr-step-cursor"
                data-pitch={cursor.pitch}
                data-step={cursor.step}
                style={{
                  top: (PITCH_MAX - cursor.pitch) * ROW_HEIGHT,
                  left: `${stepPct(cursor.step)}%`,
                  width: `${(entrySteps / pattern.stepCount) * 100}%`,
                  height: ROW_HEIGHT,
                }}
                aria-hidden="true"
              />
            )}
            {/* Remote presence cursors — one colored marker per collaborator */}
            {remoteHere.map(({ user, cursor }) => (
              <div
                key={`remote-${user.id}`}
                className="pr-remote-cursor"
                style={{
                  left: `${stepPct(Math.min(cursor.stepIndex!, pattern.stepCount - 1))}%`,
                  top: (PITCH_MAX - cursor.pitch!) * ROW_HEIGHT,
                  background: user.color,
                  borderColor: user.color,
                }}
                title={`${user.name} — ${pitchName(cursor.pitch!)}`}
                aria-label={`${user.name} is pointing at ${pitchName(cursor.pitch!)}`}
              />
            ))}
            {/* Ghost notes from other patterns — 30% opaque, non-interactive */}
            {ghostNotes.map((note) => (
              <GhostNote key={note.id} note={note} stepCount={pattern.stepCount} variant="ghost" />
            ))}
            {/* Ghost notes per track — same pattern, other instrument tracks (20% opacity) */}
            {ghostTrackNotes.map((note) => (
              <GhostNote key={note.id} note={note} stepCount={pattern.stepCount} variant="ghost-track" />
            ))}
            {notes.map((note) => {
              const noteDrag = drag && drag.noteId === note.id && drag.mode !== "noteVelocity" ? drag : null;
              const selected = selectedNote?.trackId === track.id && selectedNote.noteIds.includes(note.id);
              return (
                <PianoRollNote
                  key={note.id}
                  note={note}
                  stepCount={pattern.stepCount}
                  selected={selected}
                  outOfScale={isScaleActive && !isInScale(note.pitch, projectKey!)}
                  dragPreview={
                    noteDrag
                      ? {
                          mode: noteDrag.mode,
                          dSteps: noteDrag.mode === "move" ? noteDrag.dSteps : 0,
                          dPitch: noteDrag.mode === "move" ? noteDrag.dPitch : 0,
                          durSteps: noteDrag.mode === "resize" ? noteDrag.durSteps : 0,
                        }
                      : null
                  }
                  handlers={noteHandlersRef.current}
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
      <div className="pr-velocity-lane" aria-label="Velocity lane" style={{ height: `${48 * velZoom}px` }}>
        <div className="pr-velocity-bg" />
        {notes.map((note) => {
          const selected = selectedNote?.trackId === track.id && selectedNote.noteIds.includes(note.id);
          return (
            <VelocityBar
              key={note.id}
              note={note}
              patternTicks={patternTicks}
              selected={selected}
              handlers={velHandlersRef.current}
            />
          );
        })}
      </div>
      {chordMenu && (
        <div
          className="context-menu chord-stamp-menu"
          role="menu"
          aria-label="Chord stamp"
          style={{ left: chordMenu.x, top: chordMenu.y }}
          onMouseDown={(ev) => ev.stopPropagation()}
        >
          <div className="context-menu-header">CHORD STAMP (Shift+C)</div>
          {(
            [
              ["major", "Major"],
              ["minor", "Minor"],
              ["dominant7", "Dom 7"],
              ["major7", "Maj 7"],
              ["minor7", "Min 7"],
              ["sus2", "Sus 2"],
              ["sus4", "Sus 4"],
            ] as const
          ).map(([shape, label]) => (
            <button
              key={shape}
              type="button"
              role="menuitem"
              onClick={() => {
                setChordMenu(null);
                try {
                  services.store.execute(
                    applyMidiCreativeTool(doc, {
                      trackId: track.id,
                      noteIds: hasSelection ? selectedNote!.noteIds : undefined,
                      operation: { kind: "stamp-chord", shape },
                    }),
                  );
                } catch {
                  /* no notes */
                }
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {noteMenu && (
        <div
          className="context-menu pr-note-menu"
          role="menu"
          aria-label="Note actions"
          style={{
            left: Math.min(noteMenu.x, window.innerWidth - 180),
            top: Math.min(noteMenu.y, window.innerHeight - 160),
          }}
          onMouseDown={(ev) => ev.stopPropagation()}
          onPointerDown={(ev) => ev.stopPropagation()}
        >
          <div className="context-menu-header">{pitchName(notes.find((n) => n.id === noteMenu.noteId)?.pitch ?? 60)}</div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const target = noteMenu.noteId;
              setNoteMenu(null);
              services.store.execute(deleteNote(services.store.doc, track.id, target));
            }}
          >
            Delete
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const target = noteMenu.noteId;
              setNoteMenu(null);
              services.store.execute(duplicateNotes(services.store.doc, track.id, [target]));
            }}
          >
            Duplicate
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const target = noteMenu.noteId;
              setNoteMenu(null);
              const source = notes.find((n) => n.id === target);
              if (!source) return;
              const next = notes.map((n) => (n.id === target ? { ...n, slide: !n.slide } : n));
              const prev = [...notes];
              services.store.execute({
                type: "toggleSlide",
                label: `${source.slide ? "Unslide" : "Slide"} ${pitchName(source.pitch)}`,
                execute: (d: ProjectDocument) => ({
                  ...d,
                  patterns: d.patterns.map((p: Pattern) =>
                    p.id === pattern.id ? { ...p, notes: { ...(p.notes ?? {}), [track.id]: next } } : p,
                  ),
                }),
                undo: (d: ProjectDocument) => ({
                  ...d,
                  patterns: d.patterns.map((p: Pattern) =>
                    p.id === pattern.id ? { ...p, notes: { ...(p.notes ?? {}), [track.id]: prev } } : p,
                  ),
                }),
              } as never);
            }}
          >
            {notes.find((n) => n.id === noteMenu.noteId)?.slide ? "Unslide" : "Slide"}
          </button>
        </div>
      )}
    </div>
  );
}
