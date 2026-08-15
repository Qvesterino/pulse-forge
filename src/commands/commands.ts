import type { Command } from "./types";
import type { DrumPad, DrumTrack, EffectInstance, EffectType, InstrumentKind, InstrumentTrack, NoteEvent, ProjectDocument } from "../project-model/types";
import { STEP_TICKS } from "../project-model/types";
import { setStepVelocity, withPad, withDrumTrack } from "../project-model/transform";
import {
  createDrumTrackModel,
  createInstrumentTrackModel,
  createPatternForDoc,
  drumTracksOf,
  instrumentTracksOf,
  normalizeProject,
  patternLetter,
} from "../project-model/schema";
import type { Pattern } from "../project-model/types";
import { EFFECT_DEFS, clampEffectParam, defaultParamsOf } from "../effects/registry";
import { INSTRUMENT_DEFS, clampInstrumentParam, defaultInstrumentParams } from "../instruments/registry";
import { clamp, uid } from "../shared/ids";

function snapshot(type: string, label: string, prev: ProjectDocument, next: ProjectDocument): Command {
  return {
    type,
    label,
    execute: () => next,
    undo: () => prev,
  };
}

export function setProjectName(doc: ProjectDocument, name: string): Command {
  const prev = doc.name;
  return {
    type: "setProjectName",
    label: `Rename project to "${name}"`,
    execute: (d) => ({ ...d, name }),
    undo: (d) => ({ ...d, name: prev }),
  };
}

export function setBpm(doc: ProjectDocument, bpm: number): Command {
  const prev = doc.bpm;
  const value = clamp(bpm, 20, 300);
  return {
    type: "setBpm",
    label: `Set BPM to ${value}`,
    execute: (d) => ({ ...d, bpm: value }),
    undo: (d) => ({ ...d, bpm: prev }),
  };
}

export function toggleStep(
  doc: ProjectDocument,
  padId: string,
  stepIndex: number,
  defaultVelocity = 0.8,
): Command {
  const prev = doc.patterns.find((p) => p.id === doc.activePatternId)?.rows[padId][stepIndex] ?? 0;
  const next = prev > 0 ? 0 : defaultVelocity;
  return {
    type: "toggleStep",
    label: prev > 0 ? `Remove step ${stepIndex + 1}` : `Add step ${stepIndex + 1}`,
    execute: (d) => setStepVelocity(d, padId, stepIndex, next),
    undo: (d) => setStepVelocity(d, padId, stepIndex, prev),
  };
}

export function setStepVelocityCommand(
  doc: ProjectDocument,
  padId: string,
  stepIndex: number,
  velocity: number,
): Command {
  const prev = doc.patterns.find((p) => p.id === doc.activePatternId)?.rows[padId][stepIndex] ?? 0;
  return {
    type: "setStepVelocity",
    label: `Set step ${stepIndex + 1} velocity`,
    execute: (d) => setStepVelocity(d, padId, stepIndex, velocity),
    undo: (d) => setStepVelocity(d, padId, stepIndex, prev),
  };
}

type PadParams = Partial<Pick<DrumPad, "name" | "assetId" | "gain" | "pan" | "pitch" | "mute" | "solo" | "chokeGroup">>;

export function setPadParams(doc: ProjectDocument, padId: string, params: PadParams): Command {
  const track = doc.tracks.find((t): t is DrumTrack => t.kind === "drum");
  const prev = { ...track?.pads.find((p) => p.id === padId) } as PadParams;
  const apply = (d: ProjectDocument, values: PadParams): ProjectDocument =>
    withPad(d, padId, (pad) => ({ ...pad, ...values }));
  return {
    type: "setPadParams",
    label: `Edit pad ${padId}`,
    execute: (d) => apply(d, params),
    undo: (d) => apply(d, prev),
  };
}

type TrackParams = Partial<Pick<DrumTrack, "name" | "gain" | "pan" | "mute" | "solo">>;

export function setTrackParams(doc: ProjectDocument, trackId: string, params: TrackParams): Command {
  const track = doc.tracks.find((t) => t.id === trackId);
  const prev: TrackParams = track
    ? { name: track.name, gain: track.gain, pan: track.pan, mute: track.mute, solo: track.solo }
    : {};
  const apply = (d: ProjectDocument, values: TrackParams): ProjectDocument =>
    withDrumTrack(d, (t) => (t.id === trackId ? { ...t, ...values } : t));
  return {
    type: "setTrackParams",
    label: `Edit track ${trackId}`,
    execute: (d) => apply(d, params),
    undo: (d) => apply(d, prev),
  };
}

/* ---------------- patterns ---------------- */

export function createPattern(doc: ProjectDocument): Command {
  const pattern = createPatternForDoc(doc, `Pattern ${patternLetter(doc.patterns.length)}`);
  const next: ProjectDocument = {
    ...doc,
    patterns: [...doc.patterns, pattern],
    activePatternId: pattern.id,
  };
  return snapshot("createPattern", `Add ${pattern.name}`, doc, next);
}

export function duplicatePattern(doc: ProjectDocument, patternId: string): Command {
  const source = doc.patterns.find((p) => p.id === patternId);
  if (!source) throw new Error(`Pattern ${patternId} not found`);
  const copy: Pattern = {
    id: `pattern-${crypto.randomUUID()}`,
    name: `${source.name} 2`,
    stepCount: source.stepCount,
    rows: Object.fromEntries(Object.entries(source.rows).map(([padId, row]) => [padId, [...row]])),
    notes: Object.fromEntries(Object.entries(source.notes ?? {}).map(([trackId, notes]) => [trackId, notes.map((n) => ({ ...n }))])),
  };
  const next: ProjectDocument = {
    ...doc,
    patterns: [...doc.patterns, copy],
    activePatternId: copy.id,
  };
  return snapshot("duplicatePattern", `Duplicate ${source.name}`, doc, next);
}

export function deletePattern(doc: ProjectDocument, patternId: string): Command {
  if (doc.patterns.length <= 1) throw new Error("Cannot delete the last pattern");
  const target = doc.patterns.find((p) => p.id === patternId);
  if (!target) throw new Error(`Pattern ${patternId} not found`);
  const remaining = doc.patterns.filter((p) => p.id !== patternId);
  const next: ProjectDocument = {
    ...doc,
    patterns: remaining,
    activePatternId: doc.activePatternId === patternId ? remaining[0].id : doc.activePatternId,
  };
  return snapshot("deletePattern", `Delete ${target.name}`, doc, next);
}

export function renamePattern(doc: ProjectDocument, patternId: string, name: string): Command {
  const prev = doc.patterns.find((p) => p.id === patternId)?.name ?? "";
  const next = { ...doc, patterns: doc.patterns.map((p) => (p.id === patternId ? { ...p, name } : p)) };
  return {
    type: "renamePattern",
    label: `Rename pattern to "${name}"`,
    execute: () => next,
    undo: (d) => ({ ...d, patterns: d.patterns.map((p) => (p.id === patternId ? { ...p, name: prev } : p)) }),
  };
}

export function setActivePattern(doc: ProjectDocument, patternId: string): Command {
  const prev = doc.activePatternId;
  return {
    type: "setActivePattern",
    label: `Select pattern ${doc.patterns.find((p) => p.id === patternId)?.name ?? patternId}`,
    execute: (d) => ({ ...d, activePatternId: patternId }),
    undo: (d) => ({ ...d, activePatternId: prev }),
  };
}

export function setPatternLength(doc: ProjectDocument, patternId: string, stepCount: number): Command {
  const target = doc.patterns.find((p) => p.id === patternId);
  if (!target) throw new Error(`Pattern ${patternId} not found`);
  const patternTicks = stepCount * STEP_TICKS;
  const next: ProjectDocument = {
    ...doc,
    patterns: doc.patterns.map((p) =>
      p.id === patternId
        ? {
            ...p,
            stepCount,
            rows: Object.fromEntries(
              Object.entries(p.rows).map(([padId, row]) => [
                padId,
                new Array<number>(stepCount).fill(0).map((_, i) => row[i] ?? 0),
              ]),
            ),
            notes: Object.fromEntries(
              Object.entries(p.notes ?? {}).map(([trackId, notes]) => [
                trackId,
                notes.filter((n) => n.start + n.duration <= patternTicks),
              ]),
            ),
          }
        : p,
    ),
  };
  return snapshot("setPatternLength", `Set pattern length to ${stepCount}`, doc, next);
}

export function clearPattern(doc: ProjectDocument, patternId: string): Command {
  const target = doc.patterns.find((p) => p.id === patternId);
  if (!target) throw new Error(`Pattern ${patternId} not found`);
  const next: ProjectDocument = {
    ...doc,
    patterns: doc.patterns.map((p) =>
      p.id === patternId
        ? {
            ...p,
            rows: Object.fromEntries(Object.entries(p.rows).map(([padId, row]) => [padId, new Array<number>(row.length).fill(0)])),
            notes: {},
          }
        : p,
    ),
  };
  return snapshot("clearPattern", `Clear ${target.name}`, doc, next);
}

export interface PatternClipboard {
  stepCount: number;
  rows: Record<string, number[]>;
  notes: Record<string, NoteEvent[]>;
}

export function pastePattern(doc: ProjectDocument, clip: PatternClipboard): Command {
  const target = doc.patterns.find((p) => p.id === doc.activePatternId);
  if (!target) throw new Error("No active pattern");
  const rows = Object.fromEntries(
    Object.entries(clip.rows).map(([padId, row]) => [padId, [...row]]),
  );
  const notes = Object.fromEntries(
    Object.entries(clip.notes).map(([trackId, noteList]) => [trackId, noteList.map((n) => ({ ...n }))]),
  );
  const pasted: ProjectDocument = {
    ...doc,
    patterns: doc.patterns.map((p) =>
      p.id === target.id ? { ...p, stepCount: clip.stepCount, rows, notes } : p,
    ),
  };
  return snapshot("pastePattern", `Paste into ${target.name}`, doc, normalizeProject(pasted));
}

/* ---------------- tracks ---------------- */

export function createDrumTrack(doc: ProjectDocument): Command {
  const count = drumTracksOf(doc).length;
  const track = createDrumTrackModel(`Drums ${count + 1}`);
  const withTrack: ProjectDocument = { ...doc, tracks: [...doc.tracks, track] };
  const next = normalizeProject(withTrack);
  return snapshot("createDrumTrack", `Add track ${track.name}`, doc, next);
}

export function createInstrumentTrack(doc: ProjectDocument, kind: InstrumentKind): Command {
  const count = instrumentTracksOf(doc).filter((t) => t.instrument === kind).length + 1;
  const track = createInstrumentTrackModel(kind, count);
  const next: ProjectDocument = { ...doc, tracks: [...doc.tracks, track] };
  return snapshot("createInstrumentTrack", `Add track ${track.name}`, doc, next);
}

export function deleteTrack(doc: ProjectDocument, trackId: string): Command {
  if (doc.tracks.length <= 1) throw new Error("Cannot delete the last track");
  const target = doc.tracks.find((t) => t.id === trackId);
  if (!target) throw new Error(`Track ${trackId} not found`);
  const removedPadIds = new Set(target.kind === "drum" ? target.pads.map((p) => p.id) : []);
  const next: ProjectDocument = {
    ...doc,
    tracks: doc.tracks.filter((t) => t.id !== trackId),
    patterns: doc.patterns.map((pattern) => ({
      ...pattern,
      rows: Object.fromEntries(Object.entries(pattern.rows).filter(([padId]) => !removedPadIds.has(padId))),
      notes: Object.fromEntries(Object.entries(pattern.notes ?? {}).filter(([tid]) => tid !== trackId)),
    })),
  };
  return snapshot("deleteTrack", `Delete track ${target.name}`, doc, next);
}

/* ---------------- notes ---------------- */

function withTrackNotes(doc: ProjectDocument, trackId: string, fn: (notes: NoteEvent[]) => NoteEvent[]): ProjectDocument {
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId);
  if (!pattern) throw new Error("No active pattern");
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
  doc: ProjectDocument,
  trackId: string,
  note: { pitch: number; start: number; duration: number; velocity: number },
): Command {
  const id = uid("note");
  const prev = activeTrackNotes(doc, trackId);
  const next = withTrackNotes(doc, trackId, (notes) => [...notes, { id, ...note }]);
  return {
    type: "addNote",
    label: `Add note`,
    execute: () => next,
    undo: (d) => withTrackNotes(d, trackId, () => prev),
  };
}

export function moveNote(
  doc: ProjectDocument,
  trackId: string,
  noteId: string,
  delta: { pitch?: number; start?: number },
): Command {
  const prev = activeTrackNotes(doc, trackId).find((n) => n.id === noteId);
  if (!prev) throw new Error(`Note ${noteId} not found`);
  const apply = (d: ProjectDocument, patch: { pitch?: number; start?: number }) =>
    withTrackNotes(d, trackId, (notes) =>
      notes.map((n) => (n.id === noteId ? { ...n, ...patch } : n)),
    );
  return {
    type: "moveNote",
    label: "Move note",
    execute: (d) => apply(d, delta),
    undo: (d) => apply(d, { pitch: prev.pitch, start: prev.start }),
  };
}

export function resizeNote(doc: ProjectDocument, trackId: string, noteId: string, duration: number): Command {
  const prev = activeTrackNotes(doc, trackId).find((n) => n.id === noteId);
  if (!prev) throw new Error(`Note ${noteId} not found`);
  const apply = (d: ProjectDocument, dur: number) =>
    withTrackNotes(d, trackId, (notes) => notes.map((n) => (n.id === noteId ? { ...n, duration: dur } : n)));
  return {
    type: "resizeNote",
    label: "Resize note",
    execute: (d) => apply(d, duration),
    undo: (d) => apply(d, prev.duration),
  };
}

export function setNoteVelocity(doc: ProjectDocument, trackId: string, noteId: string, velocity: number): Command {
  const prev = activeTrackNotes(doc, trackId).find((n) => n.id === noteId);
  if (!prev) throw new Error(`Note ${noteId} not found`);
  const clamped = clamp(velocity, 0.05, 1);
  const apply = (d: ProjectDocument, v: number) =>
    withTrackNotes(d, trackId, (notes) => notes.map((n) => (n.id === noteId ? { ...n, velocity: v } : n)));
  return {
    type: "setNoteVelocity",
    label: "Set note velocity",
    execute: (d) => apply(d, clamped),
    undo: (d) => apply(d, prev.velocity),
  };
}

export function deleteNote(doc: ProjectDocument, trackId: string, noteId: string): Command {
  const prev = activeTrackNotes(doc, trackId);
  const next = withTrackNotes(doc, trackId, (notes) => notes.filter((n) => n.id !== noteId));
  return {
    type: "deleteNote",
    label: "Delete note",
    execute: () => next,
    undo: (d) => withTrackNotes(d, trackId, () => prev),
  };
}

/* ---------------- instrument params ---------------- */

export function setInstrumentParam(doc: ProjectDocument, trackId: string, paramId: string, value: number): Command {
  const track = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.id === trackId);
  if (!track) throw new Error(`Instrument track ${trackId} not found`);
  const prev = track.params[paramId] ?? defaultInstrumentParams(track.instrument)[paramId];
  const clamped = clampInstrumentParam(track.instrument, paramId, value);
  const apply = (d: ProjectDocument, v: number): ProjectDocument => ({
    ...d,
    tracks: d.tracks.map((t) =>
      t.kind === "instrument" && t.id === trackId ? { ...t, params: { ...t.params, [paramId]: v } } : t,
    ),
  });
  return {
    type: "setInstrumentParam",
    label: `Set ${INSTRUMENT_DEFS[track.instrument].name} ${paramId}`,
    execute: (d) => apply(d, clamped),
    undo: (d) => apply(d, prev),
  };
}

export function setInstrumentSample(doc: ProjectDocument, trackId: string, assetId: string | null): Command {
  const track = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.id === trackId);
  if (!track) throw new Error(`Instrument track ${trackId} not found`);
  const prev = track.sampleId;
  const apply = (d: ProjectDocument, v: string | null): ProjectDocument => ({
    ...d,
    tracks: d.tracks.map((t) => (t.kind === "instrument" && t.id === trackId ? { ...t, sampleId: v } : t)),
  });
  return {
    type: "setInstrumentSample",
    label: `Set sample`,
    execute: (d) => apply(d, assetId),
    undo: (d) => apply(d, prev),
  };
}

/* ---------------- effects ---------------- */

function withTrackEffects(doc: ProjectDocument, trackId: string, fn: (effects: EffectInstance[]) => EffectInstance[]): ProjectDocument {
  return {
    ...doc,
    tracks: doc.tracks.map((t) => (t.id === trackId && "effects" in t ? { ...t, effects: fn(t.effects) } : t)),
  };
}

function trackEffectsOf(doc: ProjectDocument, trackId: string): EffectInstance[] {
  const track = doc.tracks.find((t) => t.id === trackId);
  return track && "effects" in track ? track.effects : [];
}

export function addEffect(doc: ProjectDocument, trackId: string, type: EffectType): Command {
  const fx: EffectInstance = { id: uid("fx"), type, bypassed: false, params: defaultParamsOf(type) };
  const next = withTrackEffects(doc, trackId, (effects) => [...effects, fx]);
  return snapshot("addEffect", `Add ${EFFECT_DEFS[type].name}`, doc, next);
}

export function removeEffect(doc: ProjectDocument, trackId: string, fxId: string): Command {
  const target = trackEffectsOf(doc, trackId).find((f) => f.id === fxId);
  const next = withTrackEffects(doc, trackId, (effects) => effects.filter((f) => f.id !== fxId));
  return snapshot("removeEffect", `Remove ${target ? EFFECT_DEFS[target.type].name : fxId}`, doc, next);
}

export function setEffectParam(doc: ProjectDocument, trackId: string, fxId: string, paramId: string, value: number): Command {
  const prev = trackEffectsOf(doc, trackId).find((f) => f.id === fxId)?.params[paramId];
  const type = trackEffectsOf(doc, trackId).find((f) => f.id === fxId)?.type;
  if (!type) throw new Error(`Effect ${fxId} not found`);
  const clamped = clampEffectParam(type, paramId, value);
  const apply = (d: ProjectDocument, v: number): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((f) => (f.id === fxId ? { ...f, params: { ...f.params, [paramId]: v } } : f)),
    );
  return {
    type: "setEffectParam",
    label: `Set ${EFFECT_DEFS[type].name} ${paramId}`,
    execute: (d) => apply(d, clamped),
    undo: (d) => apply(d, prev ?? EFFECT_DEFS[type].params.find((p) => p.id === paramId)?.default ?? clamped),
  };
}

export function toggleEffectBypass(doc: ProjectDocument, trackId: string, fxId: string): Command {
  const prev = trackEffectsOf(doc, trackId).find((f) => f.id === fxId)?.bypassed ?? false;
  const apply = (d: ProjectDocument, bypassed: boolean): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) => effects.map((f) => (f.id === fxId ? { ...f, bypassed } : f)));
  return {
    type: "toggleEffectBypass",
    label: `${prev ? "Enable" : "Bypass"} effect`,
    execute: (d) => apply(d, !prev),
    undo: (d) => apply(d, prev),
  };
}

export function moveEffect(doc: ProjectDocument, trackId: string, fxId: string, direction: -1 | 1): Command {
  const effects = trackEffectsOf(doc, trackId);
  const index = effects.findIndex((f) => f.id === fxId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= effects.length) throw new Error("Effect cannot move in that direction");
  const reordered = [...effects];
  const [moved] = reordered.splice(index, 1);
  reordered.splice(target, 0, moved);
  const next = withTrackEffects(doc, trackId, () => reordered);
  return snapshot("moveEffect", `Reorder ${EFFECT_DEFS[moved.type].name}`, doc, next);
}
