import type { Command } from "./types";
import type { InstrumentTrack, NoteEvent, ProjectDocument } from "../project-model/types";
import { STEP_TICKS } from "../project-model/types";
import {
  applyScaleOption,
  arpeggiateNotes,
  basslineNotes,
  clusterNotes,
  createChordNotes,
  doubleNotes,
  euclideanNotes,
  gateNotes,
  halveNotes,
  humanizeNotes,
  invertNotes,
  mirrorNotes,
  randomizeVelocity,
  repeatNotes,
  retrogradeNotes,
  reverseNotes,
  snapNotesToScale,
  stampChordNotes,
  strumNotes,
  type MidiCreativeOperation,
} from "../midi/creative";
import { clamp, uid } from "../shared/ids";

/**
 * Note events: the piano-roll note commands plus the MIDI-creative
 * transformation tools (humanize, strum, euclidean, ...).
 */
/* ---------------- notes ---------------- */

function withTrackNotes(
  doc: ProjectDocument,
  trackId: string,
  fn: (notes: NoteEvent[]) => NoteEvent[],
  patternId: string = doc.activePatternId,
): ProjectDocument {
  // The pattern is pinned at FACTORY time and matched here at apply time.
  // Undo stacks outlive pattern switches — resolving against the CURRENTLY
  // active pattern made every note-command undo after a switch a silent
  // no-op (filter/map miss) or, worse, a wholesale note-list replacement of
  // the wrong pattern (quantize/nudge/split/glue undos). A pinned pattern
  // that no longer exists degrades to a no-op.
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) return doc;
  const notes = fn(pattern.notes?.[trackId] ?? []);
  return {
    ...doc,
    patterns: doc.patterns.map((p) =>
      p.id === pattern.id ? { ...p, notes: { ...(p.notes ?? {}), [trackId]: notes } } : p,
    ),
  };
}

export function activeTrackNotes(doc: ProjectDocument, trackId: string): NoteEvent[] {
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId);
  return pattern?.notes?.[trackId] ?? [];
}

export function addNote(
  _doc: ProjectDocument,
  trackId: string,
  note: { pitch: number; start: number; duration: number; velocity: number },
): Command {
  const patternId = _doc.activePatternId;

  const id = uid("note");
  // Audit hardening: addNote had NO sanitization — a NaN pitch or a
  // negative duration from a caller parse bug went straight into the
  // pattern (move/resize clamp at apply time, add never did).
  const finiteOr = (value: number, fallback: number): number => (Number.isFinite(value) ? value : fallback);
  const sanitized = {
    id,
    pitch: clamp(Math.round(finiteOr(note.pitch, 60)), 0, 127),
    start: Math.max(0, Math.round(finiteOr(note.start, 0))),
    duration: Math.max(1, Math.round(finiteOr(note.duration, 1))),
    velocity: clamp(finiteOr(note.velocity, 0.8), 0, 1),
  };
  const apply = (d: ProjectDocument): ProjectDocument =>
    withTrackNotes(
      d,
      trackId,
      (notes) => {
        // Same apply-time pattern-bounds clamp as moveNote: normalize drops
        // overflowing notes on save, so a long note added near the end must
        // shorten FL-style instead of silently disappearing later.
        const pattern = d.patterns.find((p) => p.id === patternId);
        const patternTicks = pattern ? pattern.stepCount * STEP_TICKS : null;
        const fitted =
          patternTicks !== null
            ? { ...sanitized, start: Math.min(sanitized.start, Math.max(0, patternTicks - 1)) }
            : sanitized;
        const maxDur = patternTicks !== null ? Math.max(1, patternTicks - fitted.start) : fitted.duration;
        return [...notes, { ...fitted, duration: Math.min(fitted.duration, maxDur) }];
      },
      patternId,
    );
  return {
    type: "addNote",
    label: `Add note`,
    execute: (d) => apply(d),
    undo: (d) => withTrackNotes(d, trackId, (notes) => notes.filter((n) => n.id !== id), patternId),
  };
}

export function moveNote(
  doc: ProjectDocument,
  trackId: string,
  noteId: string,
  delta: { pitch?: number; start?: number },
): Command {
  const patternId = doc.activePatternId;

  const prev = activeTrackNotes(doc, trackId).find((n) => n.id === noteId);
  if (!prev) {
    // A collab peer can delete the note while a drag is in flight — the
    // pointerup commit must be a no-op, not an exception inside the handler.
    return { type: "moveNote", label: "Move note", execute: (d) => d, undo: (d) => d };
  }
  const apply = (d: ProjectDocument, patch: { pitch?: number; start?: number; duration?: number }) =>
    withTrackNotes(
      d,
      trackId,
      (notes) => {
        // PatternTicks is resolved from the doc AT APPLY time (undo/collab
        // may run against a doc whose pattern length changed since factory).
        const pattern = d.patterns.find((p) => p.id === patternId);
        const patternTicks = pattern ? pattern.stepCount * STEP_TICKS : null;
        return notes.map((n) => {
          if (n.id !== noteId) return n;
          const next = { ...n, ...patch };
          if (next.start < 0) next.start = 0;
          // Pitch out of [0, 127] renders pinned to the wrong row — clamp at
          // the boundary like every other field (nudgeNotes does the same).
          if (next.pitch !== undefined) next.pitch = clamp(Math.round(next.pitch), 0, 127);
          if (patternTicks !== null) {
            // Keep the whole note inside the pattern: normalizeProject drops
            // overflowing notes, so moving a long pad right shortens it
            // FL-style instead of deleting it on the next save.
            if (next.start > patternTicks - 1) next.start = Math.max(0, patternTicks - 1);
            const maxDur = Math.max(1, patternTicks - next.start);
            if (next.duration > maxDur) next.duration = maxDur;
          }
          return next;
        });
      },
      patternId,
    );
  return {
    type: "moveNote",
    label: "Move note",
    execute: (d) => apply(d, delta),
    undo: (d) => apply(d, { pitch: prev.pitch, start: prev.start, duration: prev.duration }),
  };
}

export function resizeNote(doc: ProjectDocument, trackId: string, noteId: string, duration: number): Command {
  const patternId = doc.activePatternId;

  const prev = activeTrackNotes(doc, trackId).find((n) => n.id === noteId);
  if (!prev) {
    // Same in-flight-deletion race as moveNote — abort silently.
    return { type: "resizeNote", label: "Resize note", execute: (d) => d, undo: (d) => d };
  }
  const apply = (d: ProjectDocument, dur: number) =>
    withTrackNotes(
      d,
      trackId,
      (notes) => {
        // Clamp at APPLY time (mirrors moveNote): patternTicks is re-read
        // from the live doc — a resize committed after a collab peer (or
        // history jump) shrank the pattern used to overflow it, and
        // normalize then silently DELETED the note. Non-finite junk is a
        // no-op rather than a poison write.
        if (!Number.isFinite(dur)) return notes;
        const pattern = d.patterns.find((p) => p.id === patternId);
        const patternTicks = pattern ? pattern.stepCount * STEP_TICKS : null;
        return notes.map((n) => {
          if (n.id !== noteId) return n;
          let nextDur = Math.max(1, Math.round(dur));
          if (patternTicks !== null) nextDur = Math.min(nextDur, Math.max(1, patternTicks - n.start));
          return nextDur === n.duration ? n : { ...n, duration: nextDur };
        });
      },
      patternId,
    );
  return {
    type: "resizeNote",
    label: "Resize note",
    execute: (d) => apply(d, duration),
    undo: (d) => apply(d, prev.duration),
  };
}

export function setNoteVelocity(doc: ProjectDocument, trackId: string, noteId: string, velocity: number): Command {
  const patternId = doc.activePatternId;

  const prev = activeTrackNotes(doc, trackId).find((n) => n.id === noteId);
  if (!prev) throw new Error(`Note ${noteId} not found`);
  const clamped = clamp(velocity, 0.05, 1);
  const apply = (d: ProjectDocument, v: number) =>
    withTrackNotes(d, trackId, (notes) => notes.map((n) => (n.id === noteId ? { ...n, velocity: v } : n)), patternId);
  return {
    type: "setNoteVelocity",
    label: "Set note velocity",
    execute: (d) => apply(d, clamped),
    undo: (d) => apply(d, prev.velocity),
  };
}

export function deleteNote(doc: ProjectDocument, trackId: string, noteId: string): Command {
  const patternId = doc.activePatternId;

  return {
    type: "deleteNote",
    label: "Delete note",
    execute: (d) => withTrackNotes(d, trackId, (notes) => notes.filter((n) => n.id !== noteId), patternId),
    undo: (d) => {
      const target = activeTrackNotes(doc, trackId).find((n) => n.id === noteId);
      if (!target) return d;
      return withTrackNotes(
        d,
        trackId,
        (notes) => (notes.some((n) => n.id === noteId) ? notes : [...notes, target]),
        patternId,
      );
    },
  };
}

export function deleteNotes(doc: ProjectDocument, trackId: string, noteIds: string[]): Command {
  const patternId = doc.activePatternId;

  const ids = new Set(noteIds);
  const removed = activeTrackNotes(doc, trackId).filter((note) => ids.has(note.id));
  return {
    type: "deleteNotes",
    label: `Delete ${ids.size} notes`,
    execute: (d) => withTrackNotes(d, trackId, (notes) => notes.filter((note) => !ids.has(note.id)), patternId),
    undo: (d) =>
      withTrackNotes(
        d,
        trackId,
        (notes) => {
          const present = new Set(notes.map((n) => n.id));
          const missing = removed.filter((note) => !present.has(note.id));
          return missing.length === 0 ? notes : [...notes, ...missing];
        },
        patternId,
      ),
  };
}

export function quantizeNotes(
  doc: ProjectDocument,
  trackId: string,
  noteIds?: string[],
  gridTicks: number = STEP_TICKS,
  strength = 1,
): Command {
  const patternId = doc.activePatternId;

  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId);
  if (!pattern) throw new Error("Active pattern not found");
  const all = pattern.notes?.[trackId] ?? [];
  const targetIds = noteIds && noteIds.length > 0 ? new Set(noteIds) : null;
  const before = all.filter((n) => !targetIds || targetIds.has(n.id));
  const prev = [...all];
  const s = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 1;
  const quantized = all.map((n) => {
    if (targetIds && !targetIds.has(n.id)) return n;
    const qStart = Math.round(n.start / gridTicks) * gridTicks;
    const qDur = Math.round(n.duration / gridTicks) * gridTicks;
    // FL partial quantize: strength < 1 moves the start only a fraction of
    // the way to the grid (50% = "quick quantize 50%", keeps the groove feel)
    const start = qStart + (n.start - qStart) * (1 - s);
    let duration = n.duration * (1 - s) + Math.max(gridTicks, qDur) * s;
    // A full-bar note can blend to duration > patternTicks (strength < 1
    // mixes in `gridTicks`); the start clamp below would then go negative →
    // start 0 with an overflowing end → normalize DELETES the note. Cap the
    // duration to the pattern first so quantize never destroys content.
    const patternTicks = pattern.stepCount * STEP_TICKS;
    if (duration > patternTicks) duration = patternTicks;
    return {
      ...n,
      start: Math.max(0, Math.min(patternTicks - duration, Math.round(start))),
      duration: Math.max(1, Math.round(duration)),
    };
  });
  return {
    type: "quantizeNotes",
    label: s < 1 ? `Quantize ${before.length} notes ${Math.round(s * 100)}%` : `Quantize ${before.length} notes`,
    execute: (d) => withTrackNotes(d, trackId, () => quantized, patternId),
    undo: (d) => withTrackNotes(d, trackId, () => prev, patternId),
  };
}

export function duplicateNotes(doc: ProjectDocument, trackId: string, noteIds?: string[]): Command {
  const patternId = doc.activePatternId;

  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId);
  if (!pattern) throw new Error("Active pattern not found");
  const all = pattern.notes?.[trackId] ?? [];
  const targetIds = noteIds && noteIds.length > 0 ? new Set(noteIds) : null;
  const toDup = targetIds ? all.filter((n) => targetIds.has(n.id)) : all;
  if (toDup.length === 0) throw new Error("Select at least one note to duplicate");
  const patternTicks = pattern.stepCount * STEP_TICKS;
  const minStart = Math.min(...toDup.map((n) => n.start));
  const maxEnd = Math.max(...toDup.map((n) => n.start + n.duration));
  const width = maxEnd - minStart;
  // Defect R9.D1 (reliability ratchet audit): the copy's `start` is wrapped
  // via `% patternTicks` but the original `duration` was preserved. A long
  // selection whose wrapped start lands near the end of the pattern produced
  // a copy that extended past `patternTicks` — violating the
  // `n.start + n.duration <= patternTicks` invariant enforced by
  // `normalizeProject` in `src/project-model/schema.ts`. The duplicate was
  // silently dropped on the next save/load. Clamp the copy's duration to
  // what remains in the pattern; skip the copy if the wrap leaves no room
  // (a 0-tick note would be filtered anyway, and silently dropping it is
  // preferable to producing a note that does not represent the user's
  // intent).
  const copies: NoteEvent[] = [];
  for (const n of toDup) {
    const rawStart = (n.start + width) % patternTicks;
    const remaining = patternTicks - rawStart;
    if (remaining < 1) continue;
    copies.push({
      ...n,
      id: uid("note"),
      start: rawStart,
      duration: Math.min(n.duration, remaining),
    });
  }
  // If wrap would overlap original, keep original and add copies (allow overlap for now)
  const next = [...all, ...copies].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const prev = [...all];
  return {
    type: "duplicateNotes",
    label: `Duplicate ${toDup.length} notes`,
    execute: (d) => withTrackNotes(d, trackId, () => next, patternId),
    undo: (d) => withTrackNotes(d, trackId, () => prev, patternId),
  };
}

export function splitNotes(doc: ProjectDocument, trackId: string, noteIds?: string[]): Command {
  const patternId = doc.activePatternId;

  const all = activeTrackNotes(doc, trackId);
  const targetIds = noteIds && noteIds.length > 0 ? new Set(noteIds) : null;
  const toSplit = targetIds ? all.filter((n) => targetIds.has(n.id)) : all;
  if (toSplit.length === 0) throw new Error("Select at least one note to split");
  const prev = [...all];
  const next: NoteEvent[] = [];
  for (const n of all) {
    if (!toSplit.includes(n)) {
      next.push(n);
      continue;
    }
    if (n.duration < STEP_TICKS * 2) {
      next.push(n);
      continue;
    }
    const half = Math.floor(n.duration / 2);
    const a = { ...n, duration: half };
    const b = { ...n, id: uid("note"), start: n.start + half, duration: n.duration - half };
    next.push(a, b);
  }
  next.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return {
    type: "splitNotes",
    label: `Split ${toSplit.length} notes`,
    execute: (d) => withTrackNotes(d, trackId, () => next, patternId),
    undo: (d) => withTrackNotes(d, trackId, () => prev, patternId),
  };
}

export function glueNotes(doc: ProjectDocument, trackId: string, noteIds?: string[]): Command {
  const patternId = doc.activePatternId;

  const all = activeTrackNotes(doc, trackId);
  const targetIds = noteIds && noteIds.length > 0 ? new Set(noteIds) : new Set(all.map((n) => n.id));
  const toGlue = all.filter((n) => targetIds.has(n.id));
  if (toGlue.length < 2) throw new Error("Select at least two notes to glue");
  // Group by pitch
  const byPitch = new Map<number, NoteEvent[]>();
  for (const n of toGlue) {
    const arr = byPitch.get(n.pitch) ?? [];
    arr.push(n);
    byPitch.set(n.pitch, arr);
  }
  // If multiple pitches, glue only if all same pitch, else no-op
  if (byPitch.size !== 1) throw new Error("Glue requires notes of the same pitch");
  const group = [...toGlue].sort((a, b) => a.start - b.start);
  const glued: NoteEvent = {
    id: uid("note"),
    pitch: group[0].pitch,
    start: group[0].start,
    duration: Math.max(...group.map((n) => n.start + n.duration)) - group[0].start,
    velocity: group[0].velocity,
  };
  const remaining = all.filter((n) => !targetIds.has(n.id));
  const next = [...remaining, glued].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const prev = [...all];
  return {
    type: "glueNotes",
    label: `Glue ${toGlue.length} notes`,
    execute: (d) => withTrackNotes(d, trackId, () => next, patternId),
    undo: (d) => withTrackNotes(d, trackId, () => prev, patternId),
  };
}

export function setNotesVelocity(doc: ProjectDocument, trackId: string, noteIds: string[], velocity: number): Command {
  const patternId = doc.activePatternId;

  const clamped = clamp(velocity, 0.05, 1);
  const prev = activeTrackNotes(doc, trackId).filter((n) => noteIds.includes(n.id));
  const prevMap = new Map(prev.map((n) => [n.id, n.velocity]));
  return {
    type: "setNotesVelocity",
    label: `Set velocity for ${noteIds.length} notes`,
    execute: (d) =>
      withTrackNotes(
        d,
        trackId,
        (notes) => notes.map((n) => (noteIds.includes(n.id) ? { ...n, velocity: clamped } : n)),
        patternId,
      ),
    undo: (d) =>
      withTrackNotes(
        d,
        trackId,
        (notes) => notes.map((n) => (prevMap.has(n.id) ? { ...n, velocity: prevMap.get(n.id)! } : n)),
        patternId,
      ),
  };
}

export function nudgeNotes(
  doc: ProjectDocument,
  trackId: string,
  noteIds: string[],
  deltaTicks: number,
  deltaPitch: number,
): Command {
  const patternId = doc.activePatternId;

  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId);
  if (!pattern) throw new Error("Active pattern not found");
  const patternTicks = pattern.stepCount * STEP_TICKS;
  const all = activeTrackNotes(doc, trackId);
  const targetIds = new Set(noteIds);
  const before = all.filter((n) => targetIds.has(n.id));
  if (before.length === 0) throw new Error("Select notes to nudge");
  const after = all.map((n) => {
    if (!targetIds.has(n.id)) return n;
    const newStart = clamp(Math.round(n.start + deltaTicks), 0, Math.max(0, patternTicks - n.duration));
    const newPitch = clamp(Math.round(n.pitch + deltaPitch), 0, 127);
    return { ...n, start: newStart, pitch: newPitch };
  });
  // Keep sorted for deterministic order
  const sortedAfter = [...after].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const sortedBefore = [...all].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return {
    type: "nudgeNotes",
    label: `Nudge ${before.length} notes`,
    execute: (d) => withTrackNotes(d, trackId, () => sortedAfter, patternId),
    undo: (d) => withTrackNotes(d, trackId, () => sortedBefore, patternId),
  };
}

export function setNotesVelocities(doc: ProjectDocument, trackId: string, velocities: Record<string, number>): Command {
  const patternId = doc.activePatternId;

  const all = activeTrackNotes(doc, trackId);
  const prev = new Map(all.filter((n) => velocities[n.id] !== undefined).map((n) => [n.id, n.velocity]));
  if (prev.size === 0) throw new Error("No matching notes for velocity update");
  return {
    type: "setNotesVelocities",
    label: `Set velocity for ${prev.size} notes`,
    execute: (d) =>
      withTrackNotes(
        d,
        trackId,
        (notes) =>
          notes.map((n) => (velocities[n.id] !== undefined ? { ...n, velocity: clamp(velocities[n.id], 0.05, 1) } : n)),
        patternId,
      ),
    undo: (d) =>
      withTrackNotes(
        d,
        trackId,
        (notes) => notes.map((n) => (prev.has(n.id) ? { ...n, velocity: prev.get(n.id)! } : n)),
        patternId,
      ),
  };
}

export interface ApplyMidiCreativeOptions {
  trackId: string;
  noteIds?: string[];
  operation: MidiCreativeOperation;
}

function midiCreativeLabel(operation: MidiCreativeOperation): string {
  switch (operation.kind) {
    case "snap-scale":
      return "Snap notes to scale";
    case "chord":
      return "Generate chords";
    case "stamp-chord":
      return `Stamp ${operation.shape} chord`;
    case "reverse":
      return "Reverse notes";
    case "invert":
      return "Invert notes";
    case "mirror":
      return "Mirror notes";
    case "retrograde":
      return "Retrograde notes";
    case "cluster":
      return "Cluster notes";
    case "halve":
      return "Halve note timing";
    case "double":
      return "Double note timing";
    case "strum":
      return "Strum notes";
    case "gate":
      return "Set note gate";
    case "humanize":
      return "Humanize notes";
    case "velocity-randomize":
      return "Randomize note velocity";
    case "arpeggiate":
      return "Arpeggiate notes";
    case "note-repeat":
      return "Repeat notes";
    case "euclidean":
      return "Generate Euclidean rhythm";
    case "bassline":
      return "Generate bassline";
  }
}

/** Apply one materialized MIDI creativity operation as one undoable edit. */
export function applyMidiCreativeTool(doc: ProjectDocument, options: ApplyMidiCreativeOptions): Command {
  const track = doc.tracks.find(
    (candidate): candidate is InstrumentTrack => candidate.kind === "instrument" && candidate.id === options.trackId,
  );
  if (!track) throw new Error(`Instrument track ${options.trackId} not found`);
  const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
  if (!pattern) throw new Error(`Active pattern ${doc.activePatternId} not found`);
  const notes = pattern.notes?.[track.id] ?? [];
  const requestedIds = options.noteIds && options.noteIds.length > 0 ? new Set(options.noteIds) : null;
  const target = requestedIds ? notes.filter((note) => requestedIds.has(note.id)) : notes;
  if (target.length === 0) throw new Error("Select at least one note first");

  const patternTicks = pattern.stepCount * STEP_TICKS;
  let transformed: NoteEvent[];
  const operation = options.operation;
  switch (operation.kind) {
    case "snap-scale":
      transformed = snapNotesToScale(target, operation.key, patternTicks);
      break;
    case "chord":
      transformed = target.flatMap((note) =>
        createChordNotes(note, operation.options, patternTicks, (index) => uid(`note-${index}`)),
      );
      break;
    case "stamp-chord":
      // FL Chord Stamp: every selected note becomes a chord root; roots keep
      // their id so selection persists, added voices get fresh ids.
      transformed = target.flatMap((note) =>
        stampChordNotes(note, operation.shape, patternTicks, (index) => uid(`stamp-${index}`)),
      );
      break;
    case "reverse":
      transformed = applyScaleOption(
        reverseNotes(target, patternTicks),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "invert":
      transformed = applyScaleOption(
        invertNotes(target, patternTicks),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "mirror":
      transformed = applyScaleOption(
        mirrorNotes(target, operation.centerPitch, patternTicks),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "retrograde":
      transformed = applyScaleOption(
        retrogradeNotes(target, patternTicks),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "cluster":
      transformed = applyScaleOption(
        clusterNotes(target, patternTicks),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "halve":
      transformed = applyScaleOption(
        halveNotes(target, patternTicks),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "double":
      transformed = applyScaleOption(
        doubleNotes(target, patternTicks),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "strum":
      transformed = applyScaleOption(
        strumNotes(target, operation.options, patternTicks),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "gate":
      transformed = applyScaleOption(
        gateNotes(target, operation.gate, patternTicks),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "humanize":
      transformed = applyScaleOption(
        humanizeNotes(target, operation.options, patternTicks),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "velocity-randomize":
      transformed = applyScaleOption(
        randomizeVelocity(target, operation.options, patternTicks),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "arpeggiate":
      transformed = applyScaleOption(
        arpeggiateNotes(target, operation.options, patternTicks, (index) => uid(`arp-${index}`)),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "note-repeat":
      transformed = applyScaleOption(
        repeatNotes(target, operation.options, patternTicks, (index) => uid(`repeat-${index}`)),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "euclidean":
      transformed = applyScaleOption(
        euclideanNotes(target, operation.options, patternTicks, (index) => uid(`euclidean-${index}`)),
        operation.key,
        operation.scaleLock,
        patternTicks,
      );
      break;
    case "bassline":
      transformed = basslineNotes(target, operation.options, patternTicks, (index) => uid(`bass-${index}`));
      break;
  }

  const untouched = requestedIds ? notes.filter((note) => !requestedIds.has(note.id)) : [];
  const nextNotes = [...untouched, ...transformed].sort(
    (a, b) => a.start - b.start || a.pitch - b.pitch || a.id.localeCompare(b.id),
  );
  return {
    type: `applyMidiCreativeTool:${operation.kind}`,
    label: midiCreativeLabel(operation),
    execute: (d) => ({
      ...d,
      patterns: d.patterns.map((candidate) =>
        candidate.id === pattern.id
          ? { ...candidate, notes: { ...(candidate.notes ?? {}), [track.id]: nextNotes } }
          : candidate,
      ),
    }),
    undo: (d) => ({
      ...d,
      patterns: d.patterns.map((candidate) =>
        candidate.id === pattern.id
          ? { ...candidate, notes: { ...(candidate.notes ?? {}), [track.id]: notes } }
          : candidate,
      ),
    }),
  };
}
