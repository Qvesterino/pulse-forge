import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useArrangement, usePatterns, useScenes, useServices, useTracks } from "./context";
import type { InstrumentTrack, NoteEvent, Pattern, ProjectDocument } from "../project-model/types";
import { PATTERN_TICKS, STEP_TICKS, pitchName } from "../project-model/types";
import { midiPhraseLengthTicks } from "../project-model/midiTime";
import { MAX_ARRANGEMENT_CLIP_TICKS, ticksPerBar } from "../project-model/schema";
import {
  addNote,
  applyMidiCreativeTool,
  deleteNote,
  deleteNotes,
  duplicateNotes,
  glueNotes,
  nudgeNotes,
  quantizeNotes,
  setNotesExpression,
  setNotesSlideNote,
  setNotesVelocities,
  setNotesVelocity,
  splitNotes,
  moveNote,
  resizeNote,
} from "../commands/commands";
import type { NoteExpressionKey } from "../commands/notes";
import { clamp, uid } from "../shared/ids";
import { getScalePitchesInRange, isInScale, snapToScale, scaleDegreeLabel } from "../project-model/scales";
import { chordAtTick, nearestChordPitch } from "../project-model/chords";
import { usePublishCursor, useRemoteCursors } from "./remoteCursors";
import { usePointerDragGuard } from "./usePointerDragGuard";
import { MELODIC_OFFSETS, melodicKeys } from "./melodicKeys";
import { humanizeVelocities, randomizeVelocities } from "../shared/velocityFx";
import { HumToMelodyPanel } from "./HumToMelody";
import { executeUserEdit } from "../commands/types";
import {
  noteExpressionTargetsForInstrument,
  supportsHeldVoiceSlideNote,
} from "../instruments/noteExpressionCapabilities";

const PITCH_MIN = 24;
const PITCH_MAX = 84;
const PITCH_COUNT = PITCH_MAX - PITCH_MIN + 1;
const ROW_HEIGHT = 14;
const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);
const MAX_PIANO_ROLL_STEPS = Math.floor(MAX_ARRANGEMENT_CLIP_TICKS / STEP_TICKS);
const MIN_PIANO_ROLL_STEP_PX = 24;
/**
 * New-note length menu. The note lengths are PATTERN-grid ticks: a pattern is
 * 16 sixteenth steps (PATTERN_TICKS), so "1 BAR" here is the pattern's own bar
 * — which is one musical bar only in 4/4-like meters. In 6/8 the arrangement
 * bar is 1440 ticks while the pattern grid is 1920, and a note cannot be
 * measured against a unit its own grid does not use. Recorded in ADR 0056.
 */
const NOTE_LENGTH_OPTIONS = [
  { label: "1/16", ticks: STEP_TICKS },
  { label: "1/8", ticks: STEP_TICKS * 2 },
  { label: "1/4", ticks: STEP_TICKS * 4 },
  { label: "1/2", ticks: STEP_TICKS * 8 },
  { label: "1 BAR", ticks: PATTERN_TICKS },
  { label: "2 BARS", ticks: PATTERN_TICKS * 2 },
  { label: "4 BARS", ticks: PATTERN_TICKS * 4 },
  { label: "8 BARS", ticks: PATTERN_TICKS * 8 },
  { label: "12 BARS", ticks: PATTERN_TICKS * 12 },
  { label: "16 BARS", ticks: PATTERN_TICKS * 16 },
  { label: "32 BARS", ticks: PATTERN_TICKS * 32 },
  { label: "64 BARS", ticks: PATTERN_TICKS * 64 },
] as const;

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
      /** Alt-duplicate not yet committed — materialized on the first content-changing move. */
      pendingDupSrcIds?: string[];
    }
  | {
      mode: "resize";
      noteId: string;
      baseStart: number;
      baseDurSteps: number;
      durSteps: number;
      altDuplicate?: boolean;
      pendingDupSrcIds?: string[];
    }
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
    maxStepCount,
    selected,
    outOfScale,
    dragPreview,
    handlers,
  }: {
    note: NoteEvent;
    stepCount: number;
    maxStepCount: number;
    selected: boolean;
    outOfScale: boolean;
    dragPreview: NoteDragPreview | null;
    handlers: PianoRollNoteHandlers;
  }) {
    let startSteps = note.start / STEP_TICKS;
    let durSteps = note.duration / STEP_TICKS;
    let top = (PITCH_MAX - note.pitch) * ROW_HEIGHT;
    if (dragPreview?.mode === "move") {
      startSteps = clamp(startSteps + dragPreview.dSteps, 0, maxStepCount - durSteps);
      top = (PITCH_MAX - note.pitch - dragPreview.dPitch) * ROW_HEIGHT;
    } else if (dragPreview?.mode === "resize") {
      durSteps = Math.max(1, dragPreview.durSteps);
    }
    return (
      <div
        data-note-id={note.id}
        className={`pr-note${selected ? " selected" : ""}${outOfScale ? " out-of-scale" : ""}${note.slide ? " slide" : ""}${note.slideNote ? " slide-note" : ""}`}
        style={{
          left: `${(startSteps / stepCount) * 100}%`,
          width: `${(durSteps / stepCount) * 100}%`,
          top: `${clamp(top, 0, (PITCH_COUNT - 1) * ROW_HEIGHT)}px`,
          opacity: 0.35 + note.velocity * 0.65,
        }}
        title={`${pitchName(note.pitch)}${note.slide ? " (portamento)" : ""}${note.slideNote ? " (slide note)" : ""} — top third = move, right edge = resize, middle+Alt = duplicate, middle+Ctrl = velocity — S strum, Alt+S portamento, Alt+Shift+S slide note, L legato, Ctrl+B duplicate — hold on touch for the note menu`}
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
    a.maxStepCount === b.maxStepCount &&
    a.selected === b.selected &&
    a.outOfScale === b.outOfScale &&
    a.dragPreview?.mode === b.dragPreview?.mode &&
    a.dragPreview?.dSteps === b.dragPreview?.dSteps &&
    a.dragPreview?.dPitch === b.dragPreview?.dPitch &&
    a.dragPreview?.durSteps === b.dragPreview?.durSteps,
);

/** Velocity-lane handlers behind a stable object — see VelocityBar. */
interface PianoRollVelHandlers {
  beginDrag: (event: React.PointerEvent, note: NoteEvent, target?: NoteExpressionKey) => void;
  pointerMove: (event: React.PointerEvent) => void;
  pointerUp: (event: React.PointerEvent) => void;
  pointerCancel: () => void;
}

type PianoRollEventTarget = "velocity" | NoteExpressionKey;

const EVENT_EXPRESSION_DEFAULTS: Record<NoteExpressionKey, number> = {
  pan: 0,
  filterCutoffHz: 16000,
  filterResonance: 0.08,
  releaseVelocity: 0.5,
  modX: 0.5,
  modY: 0.5,
  pitchOffsetSemitones: 0,
};

function eventLaneDefaultValue(track: InstrumentTrack, target: NoteExpressionKey): number {
  if (target === "filterCutoffHz") {
    return Math.max(120, 150 * Math.pow(2, (track.params.tone ?? 0.35) * 5.5));
  }
  return EVENT_EXPRESSION_DEFAULTS[target];
}

function eventLaneStoredValue(note: NoteEvent, target: NoteExpressionKey, defaultValue: number): number {
  return note.expression?.[target] ?? defaultValue;
}

function eventLaneNormalizedValue(note: NoteEvent, target: PianoRollEventTarget, defaultValue: number): number {
  if (target === "velocity") return Math.max(0, Math.min(1, note.velocity));
  if (target === "pan") return ((note.expression?.pan ?? defaultValue) + 1) / 2;
  if (target === "filterCutoffHz") {
    const cutoff = Math.max(80, Math.min(16000, note.expression?.filterCutoffHz ?? defaultValue));
    return Math.log(cutoff / 80) / Math.log(16000 / 80);
  }
  if (target === "modX") return note.expression?.modX ?? defaultValue;
  if (target === "modY") return note.expression?.modY ?? defaultValue;
  if (target === "filterResonance") return note.expression?.filterResonance ?? defaultValue;
  if (target === "releaseVelocity") return note.expression?.releaseVelocity ?? defaultValue;
  return ((note.expression?.pitchOffsetSemitones ?? defaultValue) + 12) / 24;
}

function eventLaneValueFromNormalized(target: NoteExpressionKey, normalized: number): number {
  const value = Math.max(0, Math.min(1, normalized));
  if (target === "pan") return Math.round((value * 2 - 1) * 100) / 100;
  if (target === "filterCutoffHz") return Math.round(80 * Math.pow(16000 / 80, value));
  if (target === "pitchOffsetSemitones") return Math.round((value * 24 - 12) * 100) / 100;
  return Math.round(value * 100) / 100;
}

function eventLaneNormalizedFromValue(target: NoteExpressionKey, value: number): number {
  if (target === "pan") return (value + 1) / 2;
  if (target === "filterCutoffHz") return Math.log(Math.max(80, Math.min(16000, value)) / 80) / Math.log(16000 / 80);
  if (target === "pitchOffsetSemitones") return (value + 12) / 24;
  return value;
}

function eventBarVisual(target: NoteExpressionKey, value: number): { height: string; top?: string; bottom?: string } {
  if (target === "pitchOffsetSemitones" || target === "pan" || target === "modX" || target === "modY") {
    const signed =
      target === "pan"
        ? Math.max(-1, Math.min(1, value))
        : target === "modX" || target === "modY"
          ? (Math.max(0, Math.min(1, value)) - 0.5) * 2
          : Math.max(-12, Math.min(12, value)) / 12;
    return {
      height: `${Math.abs(signed) * 50}%`,
      top: signed >= 0 ? `${50 - Math.abs(signed) * 50}%` : "50%",
      bottom: "auto",
    };
  }
  return { height: `${Math.max(0, Math.min(1, eventLaneNormalizedFromValue(target, value)) * 100)}%`, bottom: "0%" };
}

function eventBarIsNegative(target: NoteExpressionKey, value: number): boolean {
  return (
    ((target === "pan" || target === "pitchOffsetSemitones") && value < 0) ||
    ((target === "modX" || target === "modY") && value < 0.5)
  );
}

function eventLaneTargetLabel(target: PianoRollEventTarget): string {
  switch (target) {
    case "velocity":
      return "Velocity";
    case "pan":
      return "Pan";
    case "filterCutoffHz":
      return "Filter cutoff";
    case "filterResonance":
      return "Filter resonance";
    case "releaseVelocity":
      return "Release velocity";
    case "modX":
      return "Mod X";
    case "modY":
      return "Mod Y";
    case "pitchOffsetSemitones":
      return "Fine pitch";
  }
}

function eventLaneValueLabel(note: NoteEvent, target: PianoRollEventTarget, defaultValue: number): string {
  const value = eventLaneNormalizedValue(note, target, defaultValue);
  if (target === "velocity") return `${Math.round(value * 100)}%`;
  if (target === "pan")
    return value < 0.49
      ? `L${Math.round((0.5 - value) * 200)}`
      : value > 0.51
        ? `R${Math.round((value - 0.5) * 200)}`
        : "C";
  if (target === "filterCutoffHz") return `${Math.round(note.expression?.filterCutoffHz ?? defaultValue)} Hz`;
  if (target === "filterResonance") return `${Math.round(value * 100)}%`;
  if (target === "releaseVelocity") return `${Math.round(value * 100)}%`;
  if (target === "modX" || target === "modY") return `${Math.round(value * 100)}%`;
  const semitones = note.expression?.pitchOffsetSemitones ?? 0;
  return `${semitones > 0 ? "+" : ""}${semitones.toFixed(2)} st`;
}

/**
 * One velocity-lane bar. Memoized for the same reason as PianoRollNote: the
 * lane re-renders on every drag pointermove with only one bar changed.
 */
const VelocityBar = memo(
  function VelocityBar({
    note,
    patternTicks,
    overlapOffset,
    selected,
    handlers,
  }: {
    note: NoteEvent;
    patternTicks: number;
    overlapOffset: number;
    selected: boolean;
    handlers: PianoRollVelHandlers;
  }) {
    const left = (note.start / patternTicks) * 100;
    const hue = Math.round(200 - Math.max(0, Math.min(1, (note.velocity - 0.05) / 0.95)) * 180);
    return (
      <div
        data-vel={note.id}
        className={`pr-vel-bar${selected ? " selected" : ""}`}
        style={{
          left: `calc(${left}% + ${overlapOffset}px)`,
          height: `${note.velocity * 100}%`,
          background: `hsl(${hue} 85% 55%)`,
        }}
        title={`${pitchName(note.pitch)} vel ${Math.round(note.velocity * 100)}% — drag vertically`}
        onPointerDown={note.slideNote ? undefined : (e) => handlers.beginDrag(e, note)}
        onPointerMove={(e) => handlers.pointerMove(e)}
        onPointerUp={(e) => handlers.pointerUp(e)}
        onPointerCancel={() => handlers.pointerCancel()}
      />
    );
  },
  (a, b) =>
    a.note === b.note &&
    a.patternTicks === b.patternTicks &&
    a.overlapOffset === b.overlapOffset &&
    a.selected === b.selected,
);

const ExpressionBar = memo(
  function ExpressionBar({
    note,
    patternTicks,
    overlapOffset,
    target,
    defaultValue,
    selected,
    handlers,
  }: {
    note: NoteEvent;
    patternTicks: number;
    overlapOffset: number;
    target: NoteExpressionKey;
    defaultValue: number;
    selected: boolean;
    handlers: PianoRollVelHandlers;
  }) {
    const left = (note.start / patternTicks) * 100;
    const value = eventLaneStoredValue(note, target, defaultValue);
    const hue =
      target === "pan"
        ? 165
        : target === "filterCutoffHz"
          ? 38
          : target === "filterResonance"
            ? 280
            : target === "pitchOffsetSemitones"
              ? 205
              : 320;
    const visual = eventBarVisual(target, value);
    return (
      <div
        id={`pr-expression-${note.id}`}
        data-expression={note.id}
        data-negative={eventBarIsNegative(target, value) ? "true" : "false"}
        className={`pr-vel-bar pr-expression-bar${selected ? " selected" : ""}`}
        style={{
          left: `calc(${left}% + ${overlapOffset}px)`,
          ...visual,
          background: `hsl(${hue} 75% 54%)`,
        }}
        title={`${pitchName(note.pitch)} ${eventLaneValueLabel(note, target, defaultValue)} — drag vertically`}
        onPointerDown={(event) => handlers.beginDrag(event, note, target)}
        onPointerMove={(event) => handlers.pointerMove(event)}
        onPointerUp={(event) => handlers.pointerUp(event)}
        onPointerCancel={() => handlers.pointerCancel()}
      />
    );
  },
  (a, b) =>
    a.note === b.note &&
    a.patternTicks === b.patternTicks &&
    a.overlapOffset === b.overlapOffset &&
    a.target === b.target &&
    a.selected === b.selected,
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

const SharedSourceBadge = memo(function SharedSourceBadge({ patternId }: { patternId: string }) {
  const scenes = useScenes();
  const arrangement = useArrangement();
  const placementCount = useMemo(() => {
    const sourceSceneIds = new Set(scenes.filter((scene) => scene.patternId === patternId).map((scene) => scene.id));
    const midiPlacements = (arrangement.midiClips ?? []).filter((clip) => clip.patternId === patternId).length;
    const scenePlacements = arrangement.clips.filter((clip) => sourceSceneIds.has(clip.sceneId)).length;
    return midiPlacements + scenePlacements;
  }, [arrangement, patternId, scenes]);

  if (placementCount <= 1) return null;
  return (
    <span
      className="pr-source-shared"
      title={`This source pattern is used by ${placementCount} arrangement clips. Choose “Make unique & edit” on a MIDI clip to edit it independently.`}
    >
      SHARED SOURCE · {placementCount} CLIPS
    </span>
  );
});

export function PianoRollTrack({
  track,
  pattern,
  playheadStep,
  selectedNote,
  onSelectNote,
  scaleSnap,
  fullscreen = false,
  onToggleFullscreen,
  focusTick = null,
  focusRevision = 0,
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
  /** Scroll to a clip's source phase when opened from the arrangement. */
  focusTick?: number | null;
  /** Makes repeated requests for the same tick focus the editor again. */
  focusRevision?: number;
}) {
  const services = useServices();
  // Fine-grained selectors (GOAL 04): PianoRoll is the deepest re-render
  // hotspot in the project — 4000+ StepCells × any doc mutation. Read only
  // `patterns` (used-pattern finder), `tracks` (other-track lookup), and
  // the root `doc.key` scalar.
  const patterns = usePatterns();
  const tracks = useTracks();
  const doc = services.store.getDoc();
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const velocityScrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  // Window fallback for gestures whose captured element unmounts mid-drag
  // (undo/collab delete of the dragged note): the element's own pointerup
  // never fires. Handlers are wired below, once all cancel paths exist.
  const noteDragGuard = usePointerDragGuard();
  const [drag, setDrag] = useState<DragState | null>(null);
  const notes = pattern.notes?.[track.id] ?? [];
  const eventBarOffsetById = useMemo(() => {
    const nextOffsetByStart = new Map<number, number>();
    const offsets = new Map<string, number>();
    for (const note of notes) {
      const offset = nextOffsetByStart.get(note.start) ?? 0;
      offsets.set(note.id, offset * 5);
      nextOffsetByStart.set(note.start, offset + 1);
    }
    return offsets;
  }, [notes]);
  const patternTicks = STEP_TICKS * pattern.stepCount;
  const notePhraseTicks = midiPhraseLengthTicks(pattern.stepCount, notes);
  // Pitch-window virtualization (quality backlog B5): the roll is 854 px
  // tall inside a ~180 px scroller, so most notes are off-screen at any
  // moment. Measure the scroller on scroll/resize and render only the rows
  // in view (± margin). jsdom and first paint have no layout — null view =
  // render everything (tests, SSR, and drag correctness fall through).
  const [prView, setPrView] = useState<{ top: number; h: number; left: number; width: number } | null>(null);
  const prMeasureRaf = useRef<number | null>(null);
  const measurePrViewport = () => {
    if (prMeasureRaf.current !== null) cancelAnimationFrame(prMeasureRaf.current);
    prMeasureRaf.current = requestAnimationFrame(() => {
      prMeasureRaf.current = null;
      const el = scrollRef.current;
      if (!el) return;
      const next = { top: el.scrollTop, h: el.clientHeight, left: el.scrollLeft, width: el.clientWidth };
      setPrView((prev) =>
        prev && prev.top === next.top && prev.h === next.h && prev.left === next.left && prev.width === next.width
          ? prev
          : next,
      );
    });
  };
  useEffect(() => {
    measurePrViewport();
    const el = scrollRef.current;
    const observer = el && typeof ResizeObserver !== "undefined" ? new ResizeObserver(measurePrViewport) : null;
    if (el && observer) observer.observe(el);
    const onResize = () => measurePrViewport();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
      if (prMeasureRaf.current !== null) cancelAnimationFrame(prMeasureRaf.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const syncVelocityScroll = () => {
    const roll = scrollRef.current;
    const velocity = velocityScrollRef.current;
    if (roll && velocity && Math.abs(roll.scrollLeft - velocity.scrollLeft) > 1) velocity.scrollLeft = roll.scrollLeft;
    measurePrViewport();
  };
  const syncRollScroll = () => {
    const roll = scrollRef.current;
    const velocity = velocityScrollRef.current;
    if (roll && velocity && Math.abs(roll.scrollLeft - velocity.scrollLeft) > 1) roll.scrollLeft = velocity.scrollLeft;
  };
  useEffect(() => {
    if (focusTick === null || !Number.isFinite(focusTick)) return;
    const roll = scrollRef.current;
    if (!roll) return;
    const viewportWidth = roll.clientWidth || 800;
    const stepWidth = Math.max(MIN_PIANO_ROLL_STEP_PX, Math.min(64, viewportWidth / Math.max(1, pattern.stepCount)));
    const focusX = (Math.max(0, focusTick) / STEP_TICKS) * stepWidth;
    const contextWidth = Math.min(viewportWidth * 0.15, stepWidth * 4);
    roll.scrollLeft = Math.max(0, focusX - contextWidth);
    syncVelocityScroll();
  }, [focusRevision, focusTick, pattern.stepCount]);
  const dragPreviewEndTicks =
    drag?.mode === "resize"
      ? drag.baseStart + drag.durSteps * STEP_TICKS
      : drag?.mode === "move"
        ? Math.max(
            0,
            drag.baseStart + drag.dSteps * STEP_TICKS + (notes.find((note) => note.id === drag.noteId)?.duration ?? 0),
          )
        : 0;
  const editorStepCount = Math.min(
    MAX_PIANO_ROLL_STEPS,
    Math.max(pattern.stepCount, Math.ceil(Math.max(notePhraseTicks, dragPreviewEndTicks) / STEP_TICKS)),
  );
  const viewportWidth = prView?.width || 800;
  const stepWidth = Math.max(MIN_PIANO_ROLL_STEP_PX, Math.min(64, viewportWidth / Math.max(1, pattern.stepCount)));
  const gridWidthPx = Math.max(viewportWidth, editorStepCount * stepWidth);
  const visibleStepRange = useMemo(() => {
    if (!prView || prView.width <= 0)
      return { from: 0, to: Math.min(editorStepCount, Math.max(128, pattern.stepCount)) };
    return {
      from: Math.max(0, Math.floor(prView.left / stepWidth) - 4),
      to: Math.min(editorStepCount, Math.ceil((prView.left + prView.width) / stepWidth) + 4),
    };
  }, [editorStepCount, pattern.stepCount, prView, stepWidth]);
  // Ghost notes from other patterns (30% opacity, non-interactive) — memoized
  // so drag re-renders reuse the same note objects and skip the diff.
  const ghostNotes: NoteEvent[] = useMemo(() => {
    const out: NoteEvent[] = [];
    for (const other of patterns) {
      if (other.id === pattern.id) continue;
      const list = other.notes?.[track.id];
      if (!list || list.length === 0) continue;
      for (const n of list) out.push({ ...n, id: `ghost-${other.id}-${n.id}` });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patterns, pattern.id, track.id]);
  // Ghost notes per track (same pattern, other instrument tracks) — 20% opacity
  const ghostTrackNotes: NoteEvent[] = useMemo(() => {
    const out: NoteEvent[] = [];
    for (const [otherTrackId, list] of Object.entries(pattern.notes ?? {})) {
      if (otherTrackId === track.id) continue;
      const otherTrack = tracks.find((t) => t.id === otherTrackId);
      if (!otherTrack || otherTrack.kind !== "instrument") continue;
      for (const n of list as NoteEvent[]) out.push({ ...n, id: `ghost-track-${otherTrackId}-${n.id}` });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pattern.notes, tracks, track.id]);
  const [velDrag, setVelDrag] = useState<{
    anchorId: string;
    startY: number;
    startVels: Record<string, number>;
  } | null>(null);
  const [expressionDrag, setExpressionDrag] = useState<{
    anchorId: string;
    target: NoteExpressionKey;
    startY: number;
    startValues: Record<string, number>;
  } | null>(null);
  const [eventTarget, setEventTarget] = useState<PianoRollEventTarget>("velocity");
  const selectedSlideNotesOnly =
    selectedNote?.trackId === track.id &&
    selectedNote.noteIds.length > 0 &&
    selectedNote.noteIds.every((id) => notes.find((note) => note.id === id)?.slideNote === true);
  const eventTargets: PianoRollEventTarget[] = selectedSlideNotesOnly
    ? ["pitchOffsetSemitones"]
    : ["velocity", "pitchOffsetSemitones", ...noteExpressionTargetsForInstrument(track.instrument)];
  const activeEventTarget = eventTargets.includes(eventTarget) ? eventTarget : (eventTargets[0] ?? "velocity");
  const activeEventDefault = activeEventTarget === "velocity" ? 0.5 : eventLaneDefaultValue(track, activeEventTarget);
  const [velZoom, setVelZoom] = useState(1);
  const [noteClipboard, setNoteClipboard] = useState<NoteEvent[] | null>(null);
  // Touch note menu — opened by a long-press; right-click keeps instant delete.
  const [noteMenu, setNoteMenu] = useState<{ noteId: string; x: number; y: number } | null>(null);
  const noteMenuTimer = useRef<number | null>(null);
  const noteMenuAnchor = useRef<{ x: number; y: number } | null>(null);
  const noteLongPressFired = useRef(false);
  // Pitch-window filter (B5): always-keep selected/dragged/menued notes so
  // interactions never lose their DOM anchor mid-gesture. Declared after the
  // noteMenu state (it reads it).
  const alwaysKeepIds = useMemo(() => {
    const ids = new Set<string>();
    if (drag?.noteId) ids.add(drag.noteId);
    if (noteMenu?.noteId) ids.add(noteMenu.noteId);
    if (velDrag?.anchorId) ids.add(velDrag.anchorId);
    if (expressionDrag?.anchorId) ids.add(expressionDrag.anchorId);
    if (selectedNote?.trackId === track.id) for (const id of selectedNote.noteIds) ids.add(id);
    return ids;
  }, [drag, noteMenu, velDrag, expressionDrag, selectedNote, track.id]);
  const visibleNotes = useMemo(() => {
    if (!prView || prView.h <= 0 || prView.width <= 0) return notes;
    const topRow = Math.floor(prView.top / ROW_HEIGHT) - 8;
    const bottomRow = Math.ceil((prView.top + prView.h) / ROW_HEIGHT) + 8;
    const minPitch = PITCH_MAX - bottomRow;
    const maxPitch = PITCH_MAX - topRow;
    const fromTick = Math.max(0, (prView.left / stepWidth) * STEP_TICKS);
    const toTick = ((prView.left + prView.width) / stepWidth) * STEP_TICKS;
    const out = notes.filter(
      (note) =>
        alwaysKeepIds.has(note.id) ||
        (note.pitch >= minPitch &&
          note.pitch <= maxPitch &&
          note.start + note.duration > fromTick &&
          note.start < toTick),
    );
    return out.length === notes.length ? notes : out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, prView, stepWidth, alwaysKeepIds]);
  const visibleIn = (n: NoteEvent): boolean =>
    !prView ||
    prView.h <= 0 ||
    prView.width <= 0 ||
    (() => {
      const topRow = Math.floor(prView.top / ROW_HEIGHT) - 8;
      const bottomRow = Math.ceil((prView.top + prView.h) / ROW_HEIGHT) + 8;
      const minPitch = PITCH_MAX - bottomRow;
      const maxPitch = PITCH_MAX - topRow;
      const fromTick = Math.max(0, (prView.left / stepWidth) * STEP_TICKS);
      const toTick = ((prView.left + prView.width) / stepWidth) * STEP_TICKS;
      return (
        alwaysKeepIds.has(n.id) ||
        (n.pitch >= minPitch && n.pitch <= maxPitch && n.start + n.duration > fromTick && n.start < toTick)
      );
    })();
  // FL Chord Stamp menu (Shift+C) — shape picker anchored at cursor
  const [chordMenu, setChordMenu] = useState<{ x: number; y: number } | null>(null);
  // Step entry (FL-style): a grid cursor — QWERTY letter keys insert notes at
  // the cursor (cursor row = root, keys = semitone offsets) and the cursor
  // advances by the entry duration; arrows move it, Delete removes the note
  // under it. Live melodicKeys play yields to the editor while this is on.
  const [stepEntry, setStepEntry] = useState(false);
  // Hum-to-melody panel (toolbar HUM) — record a hummed take into note drafts.
  const [humOpen, setHumOpen] = useState(false);
  const [entrySteps, setEntrySteps] = useState(2);
  const [drawDurationTicks, setDrawDurationTicks] = useState<number>(STEP_TICKS);
  const [cursor, setCursor] = useState({ pitch: 60, step: 0 });
  // Chord-snap: notes land on tones of the chord-track chord under them.
  const [chordSnap, setChordSnap] = useState(false);
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
        (target.tagName === "INPUT" ||
          target.tagName === "SELECT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      const cur = cursorRef.current;
      const isArrow =
        event.code === "ArrowLeft" ||
        event.code === "ArrowRight" ||
        event.code === "ArrowUp" ||
        event.code === "ArrowDown";
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
        if (hit) executeUserEdit(services.store, deleteNote(doc, track.id, hit.id));
        return;
      }
      const offset = MELODIC_OFFSETS[event.code];
      if (offset === undefined || event.ctrlKey || event.altKey || event.metaKey) return;
      event.preventDefault();
      // Cursor row is the entry root — keys stack semitones above it, so a
      // chord is just holding several keys before moving on.
      const pitch = Math.max(0, Math.min(127, cur.pitch + offset));
      // Clamp the insert INSIDE the pattern: a cursor parked near the end
      // with a long entry duration used to emit an overflowing note that
      // normalize silently dropped — while the preview note still sounded.
      const patternTicks = stepCount * STEP_TICKS;
      const start = Math.max(0, Math.min(cur.step * STEP_TICKS, patternTicks - STEP_TICKS));
      const duration = Math.max(STEP_TICKS, Math.min(entrySteps * STEP_TICKS, patternTicks - start));
      setDrawDurationTicks(duration);
      executeUserEdit(
        services.store,
        addNote(doc, track.id, {
          pitch,
          start,
          duration,
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
    const x = Math.max(0, event.clientX - rect.left);
    const y = clamp(event.clientY - rect.top, 0, rect.height);
    let pitch = PITCH_MAX - Math.floor(y / ROW_HEIGHT);
    if (scaleSnap && projectKey) {
      pitch = snapToScale(pitch, projectKey);
    }
    if (chordSnap) {
      // A pattern has no single absolute position (scenes can place it
      // anywhere) — the chord under the PLAYHEAD is the musical context.
      const chord = chordAtTick(doc.arrangement.chords ?? [], services.transport.position, ticksPerBar(doc));
      if (chord) pitch = nearestChordPitch(pitch, chord);
    }
    return {
      stepF: x / stepWidth,
      pitch,
    };
  };

  const beginNoteDrag = (event: React.PointerEvent, note: NoteEvent) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    // FL-style sticky note length: touching an existing note makes its exact
    // duration the default for the next note drawn in the grid.
    setDrawDurationTicks(note.duration);
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
    // Alt+drag duplicates selection (or this note if not in selection) before
    // dragging — like FL. The duplicate commits on the FIRST CONTENT-CHANGING
    // move, not here: materializing at pointerdown made a plain Alt+click
    // (press, release, no move) plant an invisible duplicate exactly on top
    // of the original — content the user never asked for, plus a dead undo
    // step.
    const isDuplicate = smartMode === "duplicate" || isAlt;
    let dragNoteId = note.id;
    let pendingDupSrcIds: string[] | undefined;
    if (isDuplicate) {
      const sel = selectedNote?.trackId === track.id ? selectedNote.noteIds : [];
      pendingDupSrcIds = sel.includes(note.id) && sel.length > 0 ? sel : [note.id];
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {}
    const { stepF } = posFromEvent(event);
    const refNote = notes.find((n) => n.id === dragNoteId) ?? note;
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
        altDuplicate: isDuplicate,
        pendingDupSrcIds,
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
        pendingDupSrcIds,
      };
      dragRef.current = state;
      setDrag(state);
    }
    noteDragGuard.arm();
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
      const dSteps = Math.round(stepF - current.grabStep - current.baseStart / STEP_TICKS);
      const dPitch = pitch - current.basePitch;
      let next: DragState = { ...current, dSteps, dPitch };
      if (next.pendingDupSrcIds && (dSteps !== 0 || dPitch !== 0)) next = materializeAltDuplicate(next);
      dragRef.current = next;
      setDrag(next);
    } else {
      const durSteps = Math.max(1, Math.round(stepF - current.baseStart / STEP_TICKS));
      let next: DragState = { ...current, durSteps };
      if (next.pendingDupSrcIds && durSteps !== current.baseDurSteps) next = materializeAltDuplicate(next);
      dragRef.current = next;
      setDrag(next);
    }
  };

  /**
   * Commit the alt-drag duplicate once the gesture actually changes content.
   * Reads the LIVE document (the render-scope `notes` can be stale by the
   * time the first move lands) and re-points the drag at the duplicate, which
   * starts at the same position, so the existing base/delta math is unchanged.
   */
  /**
   * Undo-frame ownership for the alt-drag gesture: the duplicate and the
   * move are ONE gesture, so they collapse into ONE history entry. The flag
   * is true only when THIS component opened the frame (a live MIDI record
   * frame makes the nested begin a no-op — then the gestures stay inside the
   * record take's compound and the flag stays false, so our close never
   * seals a foreign frame).
   */
  const altDragFrameRef = useRef(false);
  const closeAltDragFrame = () => {
    if (!altDragFrameRef.current) return;
    altDragFrameRef.current = false;
    services.store.endUndoFrame();
  };

  const materializeAltDuplicate = (state: DragState): DragState => {
    if (state.mode === "noteVelocity") return state;
    const srcIds = state.pendingDupSrcIds;
    if (!srcIds || srcIds.length === 0) return state;
    const live = services.store.doc.patterns.find((p) => p.id === pattern.id)?.notes?.[track.id] ?? [];
    const dups: NoteEvent[] = [];
    for (const nid of srcIds) {
      const src = live.find((n) => n.id === nid);
      if (!src) continue;
      dups.push({ ...src, id: uid("note") });
    }
    if (dups.length === 0) return { ...state, altDuplicate: false, pendingDupSrcIds: undefined };
    const prev = [...live];
    const next = [...live, ...dups].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    const newIds = dups.map((n) => n.id);
    // Bracket duplicate + the upcoming move into one undoable transaction.
    // Grew===1 at close (cancel with no move, or a no-op move) leaves the
    // duplicate as its own entry — the committed half of a dead gesture.
    // `=== true`: the services union includes a void no-op stand-in, and a
    // frame we did not open must never be closed by us.
    altDragFrameRef.current = services.store.beginUndoFrame(`Duplicate ${dups.length} notes (drag)`) === true;
    executeUserEdit(services.store, {
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
    return { ...state, noteId: newIds[0] ?? state.noteId, altDuplicate: false, pendingDupSrcIds: undefined };
  };

  const onNotePointerUp = (event?: React.PointerEvent) => {
    noteDragGuard.disarm();
    // The hold already opened the note menu — releasing must not commit a move.
    if (noteMenuTimer.current !== null) {
      window.clearTimeout(noteMenuTimer.current);
      noteMenuTimer.current = null;
    }
    if (noteLongPressFired.current) {
      noteLongPressFired.current = false;
      dragRef.current = null;
      setDrag(null);
      closeAltDragFrame();
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
      // The note can vanish mid-drag (undo/collab) — a throwing commit here
      // would skip the drag-state reset below and leave stale bar heights.
      try {
        if (ids.length === 1) executeUserEdit(services.store, setNotesVelocity(doc, track.id, ids, velocities[ids[0]]));
        else if (ids.length > 1) executeUserEdit(services.store, setNotesVelocities(doc, track.id, velocities));
      } catch {
        /* stale ids — drop the commit, still reset drag state */
      }
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
      const noteDuration = notes.find((note) => note.id === current.noteId)?.duration ?? STEP_TICKS;
      const newStart = clamp(
        current.baseStart + current.dSteps * STEP_TICKS,
        0,
        Math.max(0, MAX_ARRANGEMENT_CLIP_TICKS - noteDuration),
      );
      let newPitch = clamp(current.basePitch + current.dPitch, PITCH_MIN, PITCH_MAX);
      if (scaleSnap && projectKey) {
        newPitch = snapToScale(newPitch, projectKey);
      }
      if (chordSnap) {
        const chord = chordAtTick(doc.arrangement.chords ?? [], services.transport.position, ticksPerBar(doc));
        if (chord) newPitch = clamp(nearestChordPitch(newPitch, chord), PITCH_MIN, PITCH_MAX);
      }
      executeUserEdit(
        services.store,
        moveNote(services.store.doc, track.id, current.noteId, { start: newStart, pitch: newPitch }),
      );
    }
    if (current.mode === "resize") {
      const maxDur = Math.floor((MAX_ARRANGEMENT_CLIP_TICKS - current.baseStart) / STEP_TICKS);
      const durationTicks = clamp(current.durSteps, 1, maxDur) * STEP_TICKS;
      setDrawDurationTicks(durationTicks);
      if (current.durSteps !== current.baseDurSteps) {
        executeUserEdit(services.store, resizeNote(services.store.doc, track.id, current.noteId, durationTicks));
      }
    }
    // The duplicate + move were one gesture — collapse their undo entries.
    // A no-op move (note vanished mid-drag) leaves grew===1, and endUndoFrame
    // keeps that single duplicate entry as-is.
    closeAltDragFrame();
  };

  // Interrupted drag (touch takeover, autoscroll, …) — abort without committing.
  const onNotePointerCancel = () => {
    noteDragGuard.disarm();
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
    // If the alt-duplicate already materialized, the frame closes with grew===1
    // and the committed duplicate stays as its own (single) undo entry.
    closeAltDragFrame();
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
      noteDragGuard.arm();
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
      noteDragGuard.arm();
      return;
    }
    const { stepF, pitch } = posFromEvent(event);
    const start = clamp(Math.floor(stepF), 0, MAX_PIANO_ROLL_STEPS - 1) * STEP_TICKS;
    executeUserEdit(
      services.store,
      addNote(services.store.doc, track.id, { pitch, start, duration: drawDurationTicks, velocity: 0.9 }),
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
    noteDragGuard.disarm();
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
    noteDragGuard.disarm();
    marqueeRef.current = null;
    setMarquee(null);
  };

  const previewKey = (pitch: number) => services.engine.previewNote(track.id, pitch);

  const stepPct = (step: number) => (step / editorStepCount) * 100;

  // ── Presence cursors ──────────────────────────────────────────────────
  const remoteCursors = useRemoteCursors();
  const publishCursor = usePublishCursor();
  const lastHoverRef = useRef<string | null>(null);
  /** Broadcast the hovered grid cell — only on cell change, mouse only. */
  const publishHover = (event: React.PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    const { stepF, pitch } = posFromEvent(event);
    const step = clamp(Math.floor(stepF), 0, editorStepCount - 1);
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
    if (e.button !== 0 || note.slideNote) return;
    e.stopPropagation();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* no capture */
    }
    noteDragGuard.arm();
    const isInSel = selectedNote?.trackId === track.id && selectedNote.noteIds.includes(note.id);
    if (isInSel && selectedNote!.noteIds.length > 1) {
      const map: Record<string, number> = {};
      for (const nid of selectedNote!.noteIds) {
        const n = notes.find((x) => x.id === nid);
        if (n && !n.slideNote) map[nid] = n.velocity;
      }
      if (Object.keys(map).length === 0) return;
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
    noteDragGuard.disarm();
    if (!velDrag) return;
    const delta = velDrag.startY - e.clientY;
    const velocities: Record<string, number> = {};
    for (const [nid, startVel] of Object.entries(velDrag.startVels)) {
      velocities[nid] = clamp(startVel + delta / 120, 0.05, 1);
    }
    const ids = Object.keys(velocities);
    try {
      if (ids.length === 1) executeUserEdit(services.store, setNotesVelocity(doc, track.id, ids, velocities[ids[0]]));
      else executeUserEdit(services.store, setNotesVelocities(doc, track.id, velocities));
    } catch {
      /* stale ids — drop the commit, still reset drag state */
    }
    setVelDrag(null);
  };
  // Interrupted velocity drag — abort and restore the lane previews.
  const onVelPointerCancel = () => {
    noteDragGuard.disarm();
    if (!velDrag) return;
    for (const [nid, startVel] of Object.entries(velDrag.startVels)) {
      const el = document.querySelector(`[data-vel="${nid}"]`) as HTMLElement | null;
      if (el) el.style.height = `${startVel * 100}%`;
    }
    setVelDrag(null);
  };

  const beginExpressionDrag = (e: React.PointerEvent, note: NoteEvent, target?: NoteExpressionKey) => {
    if (e.button !== 0 || !target) return;
    if (note.slideNote && target !== "pitchOffsetSemitones") return;
    e.stopPropagation();
    if (e.altKey) {
      const selectedIds =
        selectedNote?.trackId === track.id && selectedNote.noteIds.includes(note.id) ? selectedNote.noteIds : [note.id];
      const defaults = Object.fromEntries(
        selectedIds
          .filter(
            (id) => target === "pitchOffsetSemitones" || !notes.find((candidate) => candidate.id === id)?.slideNote,
          )
          .map((id) => [id, null]),
      );
      try {
        executeUserEdit(services.store, setNotesExpression(doc, track.id, target, defaults));
      } catch {
        /* stale ids — reset is a no-op */
      }
      return;
    }
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* no capture */
    }
    noteDragGuard.arm();
    const isInSel = selectedNote?.trackId === track.id && selectedNote.noteIds.includes(note.id);
    const selectedIds = (isInSel && selectedNote!.noteIds.length > 1 ? selectedNote!.noteIds : [note.id]).filter(
      (id) => target === "pitchOffsetSemitones" || !notes.find((candidate) => candidate.id === id)?.slideNote,
    );
    if (selectedIds.length === 0) return;
    const startValues: Record<string, number> = {};
    for (const id of selectedIds) {
      const selected = notes.find((candidate) => candidate.id === id);
      if (selected) startValues[id] = eventLaneStoredValue(selected, target, eventLaneDefaultValue(track, target));
    }
    if (!isInSel || selectedIds.length === 1) onSelectNote({ trackId: track.id, noteIds: [note.id] });
    setExpressionDrag({ anchorId: note.id, target, startY: e.clientY, startValues });
  };

  const writeExpressionPreview = (id: string, target: NoteExpressionKey, value: number) => {
    const bar = document.getElementById(`pr-expression-${id}`);
    if (!bar) return;
    Object.assign(bar.style, eventBarVisual(target, value));
    bar.dataset.negative = String(eventBarIsNegative(target, value));
  };

  const onExpressionPointerMove = (e: React.PointerEvent) => {
    if (!expressionDrag) return;
    const delta = (expressionDrag.startY - e.clientY) / 120;
    for (const [id, startValue] of Object.entries(expressionDrag.startValues)) {
      const startNormalized = eventLaneNormalizedFromValue(expressionDrag.target, startValue);
      const nextValue = eventLaneValueFromNormalized(expressionDrag.target, startNormalized + delta);
      writeExpressionPreview(id, expressionDrag.target, nextValue);
    }
  };

  const onExpressionPointerUp = (e: React.PointerEvent) => {
    noteDragGuard.disarm();
    if (!expressionDrag) return;
    if (Math.abs(expressionDrag.startY - e.clientY) < 0.5) {
      setExpressionDrag(null);
      return;
    }
    const delta = (expressionDrag.startY - e.clientY) / 120;
    const values: Record<string, number> = {};
    for (const [id, startValue] of Object.entries(expressionDrag.startValues)) {
      const startNormalized = eventLaneNormalizedFromValue(expressionDrag.target, startValue);
      values[id] = eventLaneValueFromNormalized(expressionDrag.target, startNormalized + delta);
    }
    try {
      executeUserEdit(services.store, setNotesExpression(doc, track.id, expressionDrag.target, values));
    } catch {
      /* stale ids — discard the edit */
    }
    setExpressionDrag(null);
  };

  const onExpressionPointerCancel = () => {
    noteDragGuard.disarm();
    if (!expressionDrag) return;
    for (const [id, value] of Object.entries(expressionDrag.startValues)) {
      writeExpressionPreview(id, expressionDrag.target, value);
    }
    setExpressionDrag(null);
  };

  // Window fallback wiring: element-unmount mid-gesture (the dragged note is
  // deleted by undo or a collab peer) otherwise leaves dragRef/velDrag set
  // with no event ever ending them. Idempotent with the element paths —
  // whichever fires first clears the ref, the second is a no-op.
  noteDragGuard.handlers.current = {
    // Note drags commit from drag-state (no event needed). A velocity drag
    // whose element died mid-gesture has no knowable final pointer position —
    // restore, never guess a commit.
    onEnd: () => {
      if (dragRef.current) onNotePointerUp();
      if (velDrag) onVelPointerCancel();
      if (expressionDrag) onExpressionPointerCancel();
    },
    onCancel: () => {
      if (dragRef.current) onNotePointerCancel();
      if (velDrag) onVelPointerCancel();
      if (expressionDrag) onExpressionPointerCancel();
      if (marqueeRef.current) {
        marqueeRef.current = null;
        setMarquee(null);
      }
    },
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
    executeUserEdit(services.store, deleteNote(services.store.doc, track.id, note.id));
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
    // Clamp copied notes to the arrangement ceiling, independent of the
    // bounded step-grid length.
    const newNotes = noteClipboard.map((n) => {
      const duration = Math.max(1, Math.min(n.duration, MAX_ARRANGEMENT_CLIP_TICKS));
      const start = Math.max(0, Math.min(n.start, MAX_ARRANGEMENT_CLIP_TICKS - duration));
      return { ...n, id: uid("note"), start, duration };
    });
    const prev = [...notes];
    const next = [...notes, ...newNotes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    const newIds = newNotes.map((n) => n.id);
    executeUserEdit(services.store, {
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
        try {
          executeUserEdit(services.store, nudgeNotes(doc, track.id, selectedNote!.noteIds, dt, dp));
        } catch {
          // Stale selection (notes deleted by undo/collab between renders) —
          // same tolerance the Ctrl+B / Alt+Q paths have; never an uncaught
          // exception in the window keydown handler.
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [hasSelection, selectedNote, doc, track.id, services.store]);

  // P2.1 shortcuts + P2.5: S strum, Alt+S portamento, Alt+Shift+S held-voice slide note,
  // L legato, Ctrl/Cmd+B duplicate, Shift+C chord stamp menu, Alt+Q quick quantize 50%
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
          executeUserEdit(services.store, duplicateNotes(doc, track.id, selectedNote!.noteIds));
        } catch {
          /* empty */
        }
        return;
      }
      // Alt+Q quick quantize 50% (FL) — partial strength keeps groove feel, 2 keys vs 8
      if (e.altKey && lower === "q" && !ctrl) {
        e.preventDefault();
        try {
          executeUserEdit(
            services.store,
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
        if (e.altKey && e.shiftKey) {
          if (!supportsHeldVoiceSlideNote(track.instrument)) return;
          e.preventDefault();
          const selectedIds = selectedNote!.noteIds;
          const anySlideNote = notes.some((note) => selectedIds.includes(note.id) && note.slideNote);
          try {
            executeUserEdit(services.store, setNotesSlideNote(doc, track.id, selectedIds, !anySlideNote));
          } catch {
            /* stale selection */
          }
          return;
        }
        if (e.altKey) {
          // Alt+S portamento — start a new note that glides from its predecessor.
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
          executeUserEdit(services.store, {
            type: "slideNotes",
            label: anySlid ? `Clear portamento from ${sel.length} notes` : `Set portamento on ${sel.length} notes`,
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
        executeUserEdit(
          services.store,
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
            i + 1 < sel.length
              ? sel[i + 1].start
              : Math.min(MAX_ARRANGEMENT_CLIP_TICKS, cur.start + cur.duration + STEP_TICKS * 2);
          cur.duration = Math.max(STEP_TICKS, nextStart - cur.start);
          if (cur.start + cur.duration > MAX_ARRANGEMENT_CLIP_TICKS)
            cur.duration = MAX_ARRANGEMENT_CLIP_TICKS - cur.start;
        }
        const next = notes.map((n) => map.get(n.id) ?? n);
        executeUserEdit(services.store, {
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
  }, [
    hasSelection,
    selectedNote,
    doc,
    track.id,
    track.instrument,
    pattern.id,
    patternTicks,
    notes,
    scaleSnap,
    services.store,
  ]);

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
  const expressionHandlersRef = useRef<PianoRollVelHandlers>({
    beginDrag: () => {},
    pointerMove: () => {},
    pointerUp: () => {},
    pointerCancel: () => {},
  });
  Object.assign(expressionHandlersRef.current, {
    beginDrag: beginExpressionDrag,
    pointerMove: onExpressionPointerMove,
    pointerUp: onExpressionPointerUp,
    pointerCancel: onExpressionPointerCancel,
  });
  const keyHandlersRef = useRef<PianoKeyHandlers>({ preview: () => {} });
  keyHandlersRef.current = { preview: previewKey };

  return (
    <div className={"pianoroll-wrap" + (fullscreen ? " pr-fullscreen" : "")}>
      <div className="pianoroll-toolbar" role="toolbar" aria-label="Piano roll tools">
        <span className="pr-toolbar-count">{selLabel}</span>
        <SharedSourceBadge patternId={pattern.id} />
        {editorStepCount > pattern.stepCount && (
          <span
            className="pr-source-shared"
            title="Sparse MIDI notes extend beyond the bounded step grid. The step arrays stay unchanged."
          >
            NOTE PHRASE · {Math.ceil(editorStepCount / 16)} BARS
          </span>
        )}
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
          <label
            className="slider-label"
            htmlFor={`pr-note-length-${track.id}`}
            title="Length of the next note placed in the grid"
          >
            LEN
          </label>
          <select
            id={`pr-note-length-${track.id}`}
            className="pr-step-dur"
            aria-label="New note length"
            title="New note length — follows the last note you click or resize; choose here to override"
            value={drawDurationTicks}
            onChange={(event) => setDrawDurationTicks(Number(event.target.value))}
          >
            {!NOTE_LENGTH_OPTIONS.some((option) => option.ticks === drawDurationTicks) && (
              <option value={drawDurationTicks}>
                CUSTOM ·{" "}
                {drawDurationTicks % STEP_TICKS === 0
                  ? `${drawDurationTicks / STEP_TICKS} STEPS`
                  : `${drawDurationTicks} TICKS`}
              </option>
            )}
            {NOTE_LENGTH_OPTIONS.map((option) => (
              <option key={option.ticks} value={option.ticks}>
                {option.label}
              </option>
            ))}
          </select>
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
            onClick={() =>
              runOnSelection((ids) => executeUserEdit(services.store, quantizeNotes(doc, track.id, ids ?? [])))
            }
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
                executeUserEdit(services.store, setNotesVelocities(doc, track.id, velocities));
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
                executeUserEdit(services.store, setNotesVelocities(doc, track.id, velocities));
              })
            }
          >
            HUMAN
          </button>
          <button
            type="button"
            className={`btn btn-small${humOpen ? " active-solo" : ""}`}
            aria-pressed={humOpen}
            title="Hum to melody — record a hummed take and land it as notes snapped to the project key"
            onClick={() => setHumOpen((v) => !v)}
          >
            HUM
          </button>
          <button
            type="button"
            className="btn btn-small"
            title="Duplicate"
            onClick={() => runOnSelection((ids) => executeUserEdit(services.store, duplicateNotes(doc, track.id, ids)))}
          >
            DUP
          </button>
          <button
            type="button"
            className="btn btn-small"
            title="Split notes in half"
            disabled={!hasSelection}
            onClick={() => runOnSelection((ids) => executeUserEdit(services.store, splitNotes(doc, track.id, ids)))}
          >
            SPLIT
          </button>
          <button
            type="button"
            className="btn btn-small"
            title="Glue notes of same pitch"
            disabled={!hasSelection || (selectedNote?.noteIds.length ?? 0) < 2}
            onClick={() => runOnSelection((ids) => executeUserEdit(services.store, glueNotes(doc, track.id, ids)))}
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
                executeUserEdit(services.store, deleteNotes(doc, track.id, selectedNote!.noteIds));
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
                executeUserEdit(
                  services.store,
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
                executeUserEdit(
                  services.store,
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
            className={`btn btn-small${chordSnap ? " active-solo" : ""}`}
            title="Snap notes to the chord track chord under them"
            onClick={() => setChordSnap((on) => !on)}
          >
            CHORD
          </button>
          <button
            type="button"
            className="btn btn-small"
            title="Strum 20 ticks up"
            onClick={() =>
              runOnSelection((ids) =>
                executeUserEdit(
                  services.store,
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
              executeUserEdit(services.store, setNotesVelocity(doc, track.id, selectedNote!.noteIds, vel));
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
              executeUserEdit(services.store, setNotesVelocity(doc, track.id, selectedNote!.noteIds, vel));
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
                executeUserEdit(
                  services.store,
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
                executeUserEdit(
                  services.store,
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
                executeUserEdit(
                  services.store,
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
                executeUserEdit(
                  services.store,
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
              hasSelection &&
              executeUserEdit(services.store, nudgeNotes(doc, track.id, selectedNote!.noteIds, -STEP_TICKS, 0))
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
              hasSelection &&
              executeUserEdit(services.store, nudgeNotes(doc, track.id, selectedNote!.noteIds, STEP_TICKS, 0))
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
              hasSelection && executeUserEdit(services.store, nudgeNotes(doc, track.id, selectedNote!.noteIds, 0, 1))
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
              hasSelection && executeUserEdit(services.store, nudgeNotes(doc, track.id, selectedNote!.noteIds, 0, -1))
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
                executeUserEdit(
                  services.store,
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
                executeUserEdit(
                  services.store,
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
          <label className="slider-label" htmlFor="pr-event-target">
            EVENT
          </label>
          <select
            id="pr-event-target"
            aria-label="Piano roll event target"
            className="btn btn-small"
            value={activeEventTarget}
            disabled={!!expressionDrag}
            onChange={(event) => setEventTarget(event.target.value as PianoRollEventTarget)}
          >
            {eventTargets.map((target) => (
              <option key={target} value={target}>
                {eventLaneTargetLabel(target)}
              </option>
            ))}
          </select>
          <span className="slider-label" title={`${eventLaneTargetLabel(activeEventTarget)} lane zoom`}>
            E-ZOOM
          </span>
          <button
            type="button"
            className="btn btn-small"
            title="Zoom out event lane"
            onClick={() => setVelZoom((z) => Math.max(0.5, z - 0.25))}
          >
            −
          </button>
          <span style={{ fontSize: 11, minWidth: 32, textAlign: "center" }}>{Math.round(velZoom * 100)}%</span>
          <button
            type="button"
            className="btn btn-small"
            title="Zoom in event lane"
            onClick={() => setVelZoom((z) => Math.min(2.5, z + 0.25))}
          >
            +
          </button>
        </div>
      </div>
      <div className="pianoroll">
        {humOpen && (
          <HumToMelodyPanel
            track={track}
            pattern={pattern}
            docKey={doc.key ?? null}
            onClose={() => setHumOpen(false)}
          />
        )}
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
          onScroll={syncVelocityScroll}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) onSelectNote(null);
          }}
        >
          <div
            className="pianoroll-grid"
            ref={gridRef}
            style={{ height: PITCH_COUNT * ROW_HEIGHT, width: gridWidthPx }}
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
            {Array.from(
              { length: Math.max(0, visibleStepRange.to - visibleStepRange.from) },
              (_, offset) => visibleStepRange.from + offset,
            ).map((i) =>
              i % 4 === 0 ? <div key={i} className="pr-beatline" style={{ left: `${stepPct(i)}%` }} /> : null,
            )}
            {/* Bar lines + numbers for multi-bar patterns (FL orientation for long pads) */}
            {editorStepCount > 16 &&
              Array.from(
                {
                  length:
                    Math.ceil(visibleStepRange.to / 16) - Math.max(0, Math.floor(visibleStepRange.from / 16) - 1) + 1,
                },
                (_, offset) => Math.max(0, Math.floor(visibleStepRange.from / 16) - 1) + offset,
              ).map((bar) => {
                const step = bar * 16;
                if (step > editorStepCount) return null;
                return (
                  <div key={`bar-${bar}`} className="pr-barline" style={{ left: `${stepPct(step)}%` }}>
                    {step < editorStepCount && <span className="pr-barnum">{bar + 1}</span>}
                  </div>
                );
              })}
            {playheadStep >= 0 && playheadStep < pattern.stepCount && (
              <div
                className="pr-playhead"
                style={{ left: `${stepPct(playheadStep)}%`, width: `${100 / editorStepCount}%` }}
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
                  width: `${(entrySteps / editorStepCount) * 100}%`,
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
                  left: `${stepPct(Math.min(cursor.stepIndex!, editorStepCount - 1))}%`,
                  top: (PITCH_MAX - cursor.pitch!) * ROW_HEIGHT,
                  background: user.color,
                  borderColor: user.color,
                }}
                title={`${user.name} — ${pitchName(cursor.pitch!)}`}
                aria-label={`${user.name} is pointing at ${pitchName(cursor.pitch!)}`}
              />
            ))}
            {/* Ghost notes from other patterns — 30% opaque, non-interactive */}
            {ghostNotes.filter(visibleIn).map((note) => (
              <GhostNote key={note.id} note={note} stepCount={editorStepCount} variant="ghost" />
            ))}
            {/* Ghost notes per track — same pattern, other instrument tracks (20% opacity) */}
            {ghostTrackNotes.filter(visibleIn).map((note) => (
              <GhostNote key={note.id} note={note} stepCount={editorStepCount} variant="ghost-track" />
            ))}
            {visibleNotes.map((note) => {
              const noteDrag = drag && drag.noteId === note.id && drag.mode !== "noteVelocity" ? drag : null;
              const selected = selectedNote?.trackId === track.id && selectedNote.noteIds.includes(note.id);
              return (
                <PianoRollNote
                  key={note.id}
                  note={note}
                  stepCount={editorStepCount}
                  maxStepCount={MAX_PIANO_ROLL_STEPS}
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
                  left: `${(Math.min(marquee.startStep, marquee.endStep) / editorStepCount) * 100}%`,
                  width: `${(Math.abs(marquee.endStep - marquee.startStep) / editorStepCount) * 100}%`,
                  top: `${(PITCH_MAX - Math.max(marquee.startPitch, marquee.endPitch)) * ROW_HEIGHT}px`,
                  height: `${Math.abs(marquee.endPitch - marquee.startPitch) * ROW_HEIGHT + ROW_HEIGHT}px`,
                }}
              />
            )}
          </div>
        </div>
      </div>
      <div className="pr-velocity-scroll" ref={velocityScrollRef} onScroll={syncRollScroll}>
        <div
          className="pr-velocity-lane"
          aria-label={`${eventLaneTargetLabel(activeEventTarget)} lane`}
          data-event-target={activeEventTarget}
          style={{ height: `${48 * velZoom}px`, width: gridWidthPx }}
        >
          <div className="pr-velocity-bg" style={{ backgroundSize: `${stepWidth}px 100%` }} />
          {notes.map((note) => {
            const selected = selectedNote?.trackId === track.id && selectedNote.noteIds.includes(note.id);
            return activeEventTarget === "velocity" ? (
              <VelocityBar
                key={note.id}
                note={note}
                patternTicks={editorStepCount * STEP_TICKS}
                overlapOffset={eventBarOffsetById.get(note.id) ?? 0}
                selected={selected}
                handlers={velHandlersRef.current}
              />
            ) : (
              <ExpressionBar
                key={note.id}
                note={note}
                patternTicks={editorStepCount * STEP_TICKS}
                overlapOffset={eventBarOffsetById.get(note.id) ?? 0}
                target={activeEventTarget}
                defaultValue={activeEventDefault}
                selected={selected}
                handlers={expressionHandlersRef.current}
              />
            );
          })}
        </div>
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
                  executeUserEdit(
                    services.store,
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
          <div className="context-menu-header">
            {pitchName(notes.find((n) => n.id === noteMenu.noteId)?.pitch ?? 60)}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const target = noteMenu.noteId;
              setNoteMenu(null);
              executeUserEdit(services.store, deleteNote(services.store.doc, track.id, target));
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
              executeUserEdit(services.store, duplicateNotes(services.store.doc, track.id, [target]));
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
              executeUserEdit(services.store, {
                type: "toggleSlide",
                label: `${source.slide ? "Clear portamento" : "Set portamento"} ${pitchName(source.pitch)}`,
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
            {notes.find((n) => n.id === noteMenu.noteId)?.slide ? "Clear portamento" : "Set portamento"}
          </button>
          {supportsHeldVoiceSlideNote(track.instrument) && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const source = notes.find((note) => note.id === noteMenu.noteId);
                const target = noteMenu.noteId;
                setNoteMenu(null);
                if (!source) return;
                executeUserEdit(
                  services.store,
                  setNotesSlideNote(services.store.doc, track.id, [target], !source.slideNote),
                );
              }}
            >
              {notes.find((note) => note.id === noteMenu.noteId)?.slideNote ? "Clear slide note" : "Set slide note"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
