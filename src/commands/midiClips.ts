import type { MidiClip, NoteEvent, NoteExpression, Pattern, ProjectDocument } from "../project-model/types";
import { MAX_ARRANGEMENT_CLIP_TICKS } from "../project-model/schema";
import { midiPhraseLengthTicks } from "../project-model/midiTime";
import { cloneStepMeta, unlinkMarkersOfClips } from "./docOps";
import { clipGroupsWithoutIds } from "./clipGroups";
import { clampResizeLength, clampTickSpan, clampValue } from "./geometry";
import { snapshot } from "./core";
import type { Command } from "./types";
import { uid } from "../shared/ids";
import { STEP_TICKS } from "../project-model/types";

function clipOf(doc: ProjectDocument, clipId: string): MidiClip {
  const clip = doc.arrangement.midiClips?.find((candidate) => candidate.id === clipId);
  if (!clip) throw new Error(`MIDI clip ${clipId} not found`);
  return clip;
}

function editable(clip: MidiClip): void {
  if (clip.locked) throw new Error("MIDI clip is locked");
}

function patternOf(doc: ProjectDocument, patternId: string): Pattern {
  const pattern = doc.patterns.find((candidate) => candidate.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  return pattern;
}

/**
 * The phase period of a MIDI clip's source pattern, in ticks.
 *
 * The period is the PHRASE length, not the step grid: a MIDI note may
 * outlive the grid, and BOTH the renderer (`MidiClipLanes`) and the scheduler
 * (`noteEventsInWindow`) repeat the pattern at the phrase length. The
 * commands used the grid, so a trimmed or split clip wrapped its phase
 * against a different period than the one it plays — and the notes after the
 * edit were DIFFERENT notes at different times.
 *
 * One owner, so the phase the commands write and the phase the engine plays
 * cannot drift apart again.
 */
function phasePeriodTicks(pattern: Pattern, trackId: string): number {
  return midiPhraseLengthTicks(pattern.stepCount, pattern.notes?.[trackId] ?? []);
}

/** Transform shared by every note in each selected MIDI object. Blank UI fields are omitted. */
export interface MidiObjectNoteEdit {
  /** Add an integer number of MIDI semitones. */
  transposeSemitones?: number;
  /** Add/subtract musical ticks while keeping note order and duration. */
  startOffsetTicks?: number;
  /** Multiply note lengths by this percentage (100 = unchanged). */
  durationScalePercent?: number;
  /** Multiply note velocities by this percentage (100 = unchanged). */
  velocityScalePercent?: number;
  /** Add to each note's fine pitch offset in semitones. */
  pitchOffsetSemitones?: number;
  pan?: number;
  filterCutoffHz?: number;
  filterResonance?: number;
  releaseVelocity?: number;
  modX?: number;
  modY?: number;
  slide?: boolean;
  slideNote?: boolean;
  clearLocks?: boolean;
}

function clonePatternForMidiClip(source: Pattern): Pattern {
  return {
    ...source,
    id: uid("pattern"),
    name: `${source.name} · MIDI clip`,
    rows: Object.fromEntries(Object.entries(source.rows).map(([padId, row]) => [padId, [...row]])),
    notes: Object.fromEntries(
      Object.entries(source.notes ?? {}).map(([trackId, notes]) => [
        trackId,
        notes.map((note) => ({
          ...note,
          id: uid("note"),
          ...(note.expression ? { expression: { ...note.expression } } : {}),
          ...(note.locks ? { locks: { ...note.locks } } : {}),
        })),
      ]),
    ),
    stepMeta: cloneStepMeta(source.stepMeta),
    generation: source.generation ? { ...source.generation, sourcePatternId: source.id } : undefined,
    phrasePlan: source.phrasePlan?.map((bar) => ({ ...bar })),
    assist: source.assist ? { ...source.assist } : undefined,
  };
}

function editNote(note: NoteEvent, edit: MidiObjectNoteEdit): NoteEvent {
  const start = clampValue(Math.round(note.start + (edit.startOffsetTicks ?? 0)), 0, MAX_ARRANGEMENT_CLIP_TICKS - 1);
  const durationScale = (edit.durationScalePercent ?? 100) / 100;
  const duration = clampValue(
    Math.round(note.duration * durationScale),
    1,
    Math.max(1, MAX_ARRANGEMENT_CLIP_TICKS - start),
  );
  const next: NoteEvent = {
    ...note,
    pitch: clampValue(Math.round(note.pitch + (edit.transposeSemitones ?? 0)), 0, 127),
    start,
    duration,
    velocity: clampValue(note.velocity * ((edit.velocityScalePercent ?? 100) / 100), 0.05, 1),
  };
  if (edit.slide !== undefined) next.slide = edit.slide;
  if (edit.slideNote !== undefined) next.slideNote = edit.slideNote;
  if (edit.clearLocks) delete next.locks;

  const expression: NoteExpression = { ...(note.expression ?? {}) };
  const setExpression = (key: keyof NoteExpression, value: number | undefined, min: number, max: number) => {
    if (value !== undefined) expression[key] = clampValue(value, min, max);
  };
  if (edit.pitchOffsetSemitones !== undefined) {
    setExpression("pitchOffsetSemitones", (expression.pitchOffsetSemitones ?? 0) + edit.pitchOffsetSemitones, -12, 12);
  }
  setExpression("pan", edit.pan, -1, 1);
  setExpression("filterCutoffHz", edit.filterCutoffHz, 20, 20_000);
  setExpression("filterResonance", edit.filterResonance, 0, 1);
  setExpression("releaseVelocity", edit.releaseVelocity, 0, 1);
  setExpression("modX", edit.modX, 0, 1);
  setExpression("modY", edit.modY, 0, 1);
  if (Object.keys(expression).length > 0) next.expression = expression;
  else delete next.expression;
  return next;
}

function validateMidiObjectNoteEdit(edit: MidiObjectNoteEdit): void {
  const numericValues = [
    edit.transposeSemitones,
    edit.startOffsetTicks,
    edit.durationScalePercent,
    edit.velocityScalePercent,
    edit.pitchOffsetSemitones,
    edit.pan,
    edit.filterCutoffHz,
    edit.filterResonance,
    edit.releaseVelocity,
    edit.modX,
    edit.modY,
  ].filter((value): value is number => value !== undefined);
  if (numericValues.some((value) => !Number.isFinite(value))) throw new Error("MIDI note edits must be finite");
  if (edit.durationScalePercent !== undefined && edit.durationScalePercent <= 0)
    throw new Error("Note length scale must be positive");
  if (edit.velocityScalePercent !== undefined && edit.velocityScalePercent < 0)
    throw new Error("Velocity scale cannot be negative");
  if (numericValues.length === 0 && edit.slide === undefined && edit.slideNote === undefined && !edit.clearLocks) {
    throw new Error("Choose at least one note property to edit");
  }
}

/** Apply a batch note edit across multiple MIDI clip sources as one undoable document command. */
export function editMidiClipNotes(doc: ProjectDocument, clipIds: readonly string[], edit: MidiObjectNoteEdit): Command {
  validateMidiObjectNoteEdit(edit);
  const uniqueIds = [...new Set(clipIds)];
  if (uniqueIds.length === 0) throw new Error("Select at least one MIDI object");

  const selected = uniqueIds.map((id) => clipOf(doc, id));
  for (const clip of selected) editable(clip);
  const selectedIdSet = new Set(uniqueIds);

  // Preserve the selected objects' shared-source behavior while isolating them
  // from unselected scene/MIDI placements that still reference the source.
  const scenePatternIds = new Set(
    doc.arrangement.clips.flatMap((clip) => {
      const scene = doc.scenes.find((candidate) => candidate.id === clip.sceneId);
      return scene ? [scene.patternId] : [];
    }),
  );
  const selectedPatternIds = new Set(selected.map((clip) => clip.patternId));
  const patternsToClone = new Set(
    [...selectedPatternIds].filter(
      (patternId) =>
        scenePatternIds.has(patternId) ||
        (doc.arrangement.midiClips ?? []).some((clip) => clip.patternId === patternId && !selectedIdSet.has(clip.id)),
    ),
  );
  const clonedBySourceId = new Map<string, Pattern>();
  for (const patternId of patternsToClone) {
    clonedBySourceId.set(patternId, clonePatternForMidiClip(patternOf(doc, patternId)));
  }

  const patterns = [...doc.patterns, ...clonedBySourceId.values()];
  const targetPatternId = new Map<string, string>();
  for (const clip of selected) {
    targetPatternId.set(clip.id, clonedBySourceId.get(clip.patternId)?.id ?? clip.patternId);
  }
  let editedNotes = 0;
  const editedSourceTracks = new Set<string>();
  const nextPatterns = patterns.map((pattern) => {
    const matching = selected.filter((clip) => targetPatternId.get(clip.id) === pattern.id);
    if (matching.length === 0) return pattern;
    let notesByTrack = pattern.notes ?? {};
    let changed = false;
    for (const trackId of new Set(matching.map((clip) => clip.trackId))) {
      const key = `${pattern.id}:${trackId}`;
      if (editedSourceTracks.has(key)) continue;
      editedSourceTracks.add(key);
      const sourceNotes = notesByTrack[trackId] ?? [];
      if (sourceNotes.length === 0) continue;
      editedNotes += sourceNotes.length;
      notesByTrack = { ...notesByTrack, [trackId]: sourceNotes.map((note) => editNote(note, edit)) };
      changed = true;
    }
    return changed ? { ...pattern, notes: notesByTrack } : pattern;
  });
  if (editedNotes === 0) throw new Error("The selected MIDI objects contain no notes to edit");

  const clipLengths = new Map<string, number>();
  for (const clip of selected) {
    const pattern = nextPatterns.find((candidate) => candidate.id === targetPatternId.get(clip.id));
    const notes = pattern?.notes?.[clip.trackId] ?? [];
    if (!pattern) continue;
    const phraseTicks = midiPhraseLengthTicks(pattern.stepCount, notes);
    if (phraseTicks > clip.lengthTicks) {
      // The clip grows to the phrase — and the phrase may not reach past the
      // timeline: the START stays, the LENGTH gives way (the shared rule).
      clipLengths.set(clip.id, clampResizeLength(clip.startTick, phraseTicks, "MIDI"));
    }
  }

  const midiClips = (doc.arrangement.midiClips ?? []).map((clip) => {
    const nextPatternId = targetPatternId.get(clip.id);
    const lengthTicks = clipLengths.get(clip.id);
    return nextPatternId || lengthTicks !== undefined
      ? { ...clip, ...(nextPatternId ? { patternId: nextPatternId } : {}), ...(lengthTicks ? { lengthTicks } : {}) }
      : clip;
  });
  return snapshot(
    "editMidiClipNotes",
    `Edit notes in ${selected.length} MIDI object${selected.length === 1 ? "" : "s"}`,
    doc,
    {
      ...doc,
      patterns: nextPatterns,
      arrangement: { ...doc.arrangement, midiClips },
    },
  );
}

function safeGeometry(startTick: number, lengthTicks: number): { startTick: number; lengthTicks: number } {
  return clampTickSpan(startTick, lengthTicks, "MIDI");
}

/**
 * A resize moves the clip's END. The START stays where the user put it and
 * the LENGTH gives way at the ceiling.
 *
 * THE CLAMP USED TO FALL ON THE WRONG FIELD. `safeGeometry` pulls the START
 * back when the requested length does not fit (`start = MAX - length`), which
 * is right for a MOVE — a move is a placement, so the position gives way —
 * but wrong for a resize: a resize that asked for a length past the ceiling
 * TELEPORTED the clip to the timeline's beginning.
 *
 * Worse, this lane wrote only the clamped LENGTH and kept the old START, so
 * the clip's end reached past the ceiling. The normalizer drops such a clip
 * (`startTick + lengthTicks <= MAX_ARRANGEMENT_CLIP_TICKS`, schema.ts), so the
 * resize made the user's MIDI clip VANISH — silently, and with an undo step
 * that could not bring it back. The property sweep found it; the hand-written
 * matrix missed it because its fixture sits at tick 0, where the old clamp
 * happened to land on a legal geometry.
 *
 * The rule itself now lives in ONE place — `src/commands/geometry.ts` — so
 * every lane clamps the same way and no lane can invent its own.
 */
function safeResizeLength(startTick: number, lengthTicks: number): number {
  return clampResizeLength(startTick, lengthTicks, "MIDI");
}

function modulo(value: number, period: number): number {
  return ((value % period) + period) % period;
}

export function addMidiClip(
  doc: ProjectDocument,
  trackId: string,
  patternId: string,
  startTick: number,
  lengthTicks = STEP_TICKS * 64,
): Command {
  const track = doc.tracks.find((candidate) => candidate.id === trackId);
  if (!track || track.kind !== "instrument") throw new Error("MIDI clips need an instrument track");
  patternOf(doc, patternId);
  const geometry = safeGeometry(startTick, lengthTicks);
  const clip: MidiClip = { id: uid("midiclip"), trackId, patternId, ...geometry };
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      midiClips: [...(doc.arrangement.midiClips ?? []), clip].sort((a, b) => a.startTick - b.startTick),
    },
  };
  return snapshot("addMidiClip", `Place ${track.name} MIDI clip`, doc, next);
}

export function moveMidiClip(doc: ProjectDocument, clipId: string, startTick: number): Command {
  const clip = clipOf(doc, clipId);
  editable(clip);
  const geometry = safeGeometry(startTick, clip.lengthTicks);
  const nextClips = (doc.arrangement.midiClips ?? [])
    .map((candidate) => (candidate.id === clipId ? { ...candidate, startTick: geometry.startTick } : candidate))
    .sort((a, b) => a.startTick - b.startTick);
  return snapshot("moveMidiClip", `Move MIDI clip to tick ${geometry.startTick}`, doc, {
    ...doc,
    arrangement: { ...doc.arrangement, midiClips: nextClips },
  });
}

export function resizeMidiClip(doc: ProjectDocument, clipId: string, lengthTicks: number): Command {
  const clip = clipOf(doc, clipId);
  editable(clip);
  // The START stays; the LENGTH gives way at the ceiling (safeResizeLength).
  const length = safeResizeLength(clip.startTick, lengthTicks);
  return snapshot("resizeMidiClip", `Resize MIDI clip to ${length} ticks`, doc, {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      midiClips: (doc.arrangement.midiClips ?? []).map((candidate) =>
        candidate.id === clipId ? { ...candidate, lengthTicks: length } : candidate,
      ),
    },
  });
}

export function trimMidiClipStart(doc: ProjectDocument, clipId: string, startTick: number): Command {
  const clip = clipOf(doc, clipId);
  editable(clip);
  if (!Number.isFinite(startTick)) throw new Error("MIDI clip trim position must be finite ticks");
  const endTick = clip.startTick + clip.lengthTicks;
  const nextStart = Math.max(0, Math.min(endTick - 1, Math.round(startTick)));
  const pattern = patternOf(doc, clip.patternId);
  const patternTicks = phasePeriodTicks(pattern, clip.trackId);
  const phaseOffsetTicks =
    patternTicks > 0 ? modulo((clip.phaseOffsetTicks ?? 0) + nextStart - clip.startTick, patternTicks) : 0;
  const nextClip: MidiClip = {
    ...clip,
    startTick: nextStart,
    lengthTicks: endTick - nextStart,
    ...(phaseOffsetTicks > 0 ? { phaseOffsetTicks } : {}),
  };
  if (phaseOffsetTicks === 0) delete nextClip.phaseOffsetTicks;
  return snapshot("trimMidiClipStart", `Trim MIDI clip start to tick ${nextStart}`, doc, {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      midiClips: (doc.arrangement.midiClips ?? []).map((candidate) => (candidate.id === clipId ? nextClip : candidate)),
    },
  });
}

export function splitMidiClipAtTick(doc: ProjectDocument, clipId: string, splitTick: number): Command {
  const clip = clipOf(doc, clipId);
  editable(clip);
  if (!Number.isFinite(splitTick)) throw new Error("MIDI clip split position must be finite ticks");
  const split = Math.round(splitTick);
  const end = clip.startTick + clip.lengthTicks;
  if (split <= clip.startTick || split >= end) throw new Error("Split must leave two non-empty MIDI clips");
  const pattern = patternOf(doc, clip.patternId);
  const patternTicks = phasePeriodTicks(pattern, clip.trackId);
  const phaseOffsetTicks =
    patternTicks > 0 ? modulo((clip.phaseOffsetTicks ?? 0) + split - clip.startTick, patternTicks) : 0;
  const right: MidiClip = {
    ...clip,
    id: uid("midiclip"),
    startTick: split,
    lengthTicks: end - split,
    ...(phaseOffsetTicks > 0 ? { phaseOffsetTicks } : {}),
  };
  if (phaseOffsetTicks === 0) delete right.phaseOffsetTicks;
  const left = { ...clip, lengthTicks: split - clip.startTick };
  const midiClips = (doc.arrangement.midiClips ?? [])
    .flatMap((candidate) => (candidate.id === clipId ? [left, right] : [candidate]))
    .sort((a, b) => a.startTick - b.startTick);
  return snapshot("splitMidiClipAtTick", `Split MIDI clip at tick ${split}`, doc, {
    ...doc,
    arrangement: { ...doc.arrangement, midiClips },
  });
}

export function duplicateMidiClip(doc: ProjectDocument, clipId: string, startTick?: number): Command {
  const source = clipOf(doc, clipId);
  const geometry = safeGeometry(startTick ?? source.startTick + source.lengthTicks, source.lengthTicks);
  const copy: MidiClip = {
    ...source,
    id: uid("midiclip"),
    ...geometry,
  };
  const midiClips = [...(doc.arrangement.midiClips ?? []), copy].sort((a, b) => a.startTick - b.startTick);
  return snapshot("duplicateMidiClip", "Duplicate MIDI clip", doc, {
    ...doc,
    arrangement: { ...doc.arrangement, midiClips },
  });
}

export function makeMidiClipUnique(doc: ProjectDocument, clipId: string): Command {
  const clip = clipOf(doc, clipId);
  editable(clip);
  const source = patternOf(doc, clip.patternId);
  const copy = clonePatternForMidiClip(source);
  return snapshot("makeMidiClipUnique", `Make MIDI clip unique`, doc, {
    ...doc,
    patterns: [...doc.patterns, copy],
    arrangement: {
      ...doc.arrangement,
      midiClips: (doc.arrangement.midiClips ?? []).map((candidate) =>
        candidate.id === clipId ? { ...candidate, patternId: copy.id } : candidate,
      ),
    },
  });
}

export function setMidiClipMuted(doc: ProjectDocument, clipId: string, muted: boolean): Command {
  clipOf(doc, clipId);
  return snapshot(`setMidiClipMuted:${clipId}:${muted}`, `${muted ? "Mute" : "Unmute"} MIDI clip`, doc, {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      midiClips: (doc.arrangement.midiClips ?? []).map((candidate) => {
        if (candidate.id !== clipId) return candidate;
        const next = { ...candidate };
        if (muted) next.muted = true;
        else delete next.muted;
        return next;
      }),
    },
  });
}

export function setMidiClipLocked(doc: ProjectDocument, clipId: string, locked: boolean): Command {
  clipOf(doc, clipId);
  return snapshot(`setMidiClipLocked:${clipId}:${locked}`, `${locked ? "Lock" : "Unlock"} MIDI clip`, doc, {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      midiClips: (doc.arrangement.midiClips ?? []).map((candidate) => {
        if (candidate.id !== clipId) return candidate;
        const next = { ...candidate };
        if (locked) next.locked = true;
        else delete next.locked;
        return next;
      }),
    },
  });
}

export function deleteMidiClip(doc: ProjectDocument, clipId: string): Command {
  const clip = clipOf(doc, clipId);
  editable(clip);
  const midiClips = (doc.arrangement.midiClips ?? []).filter((candidate) => candidate.id !== clipId);
  const removed = new Set([clipId]);
  const markers = unlinkMarkersOfClips(doc.markers, removed);
  const clipGroups = clipGroupsWithoutIds(doc.arrangement.clipGroups, [...removed]);
  return snapshot("deleteMidiClip", "Delete MIDI clip", doc, {
    ...doc,
    ...(markers ? { markers } : {}),
    arrangement: {
      ...doc.arrangement,
      midiClips,
      ...(clipGroups ? { clipGroups } : {}),
      ...(doc.arrangement.clipGroups && clipGroups?.length === 0 ? { clipGroups: undefined } : {}),
    },
  });
}
