import type { Command } from "./types";
import type {
  ArrangementClip,
  AutomationLane,
  AutomationTarget,
  DrumPad,
  DrumTrack,
  EffectInstance,
  EffectType,
  GrooveSettings,
  InstrumentKind,
  InstrumentTrack,
  IntensityPoint,
  Lfo,
  Macro,
  MasterConfig,
  Marker,
  MusicalKey,
  NoteEvent,
  ProjectDocument,
  Scene,
  SceneAutomation,
  StepMeta,
  Track,
} from "../project-model/types";
import { STEP_TICKS } from "../project-model/types";
import { setStepVelocity, withPad, withTrack } from "../project-model/transform";
import { insertPointSorted } from "../project-model/automation";
import {
  clampUnit,
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
import type { InstrumentPreset } from "../presets/types";
import { clamp, uid } from "../shared/ids";
import { hashString, mulberry32 } from "../shared/rng";
import { snapToScale } from "../project-model/scales";

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

type TrackParams = Partial<Pick<Track, "name" | "gain" | "pan" | "mute" | "solo">>;

export function setTrackParams(doc: ProjectDocument, trackId: string, params: TrackParams): Command {
  const track = doc.tracks.find((t) => t.id === trackId);
  const prev: TrackParams = track
    ? { name: track.name, gain: track.gain, pan: track.pan, mute: track.mute, solo: track.solo }
    : {};
  const apply = (d: ProjectDocument, values: TrackParams): ProjectDocument =>
    withTrack(d, trackId, (t) => ({ ...t, ...values }));
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
    id: uid("pattern"),
    name: `${source.name} 2`,
    stepCount: source.stepCount,
    rows: Object.fromEntries(Object.entries(source.rows).map(([padId, row]) => [padId, [...row]])),
    notes: Object.fromEntries(Object.entries(source.notes ?? {}).map(([trackId, notes]) => [trackId, notes.map((n) => ({ ...n, id: uid("note") }))])),
    stepMeta: cloneStepMeta(source.stepMeta),
  };
  const next: ProjectDocument = {
    ...doc,
    patterns: [...doc.patterns, copy],
    activePatternId: copy.id,
  };
  return snapshot("duplicatePattern", `Duplicate ${source.name}`, doc, next);
}

function cloneStepMeta(meta: Pattern["stepMeta"]): Pattern["stepMeta"] {
  if (!meta) return undefined;
  return Object.fromEntries(
    Object.entries(meta).map(([padId, steps]) => [
      padId,
      Object.fromEntries(Object.entries(steps).map(([step, m]) => [step, { ...m }])),
    ]),
  );
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
  const safeCount = Math.max(1, Math.floor(stepCount));
  const patternTicks = safeCount * STEP_TICKS;
  const next: ProjectDocument = {
    ...doc,
    patterns: doc.patterns.map((p) =>
      p.id === patternId
        ? {
            ...p,
            stepCount: safeCount,
            rows: Object.fromEntries(
              Object.entries(p.rows).map(([padId, row]) => [
                padId,
                new Array<number>(safeCount).fill(0).map((_, i) => row[i] ?? 0),
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
  return snapshot("setPatternLength", `Set pattern length to ${safeCount}`, doc, next);
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

/* ---------------- groove & step performance ---------------- */

export function setGroove(doc: ProjectDocument, groove: Partial<GrooveSettings>): Command {
  const prev = doc.groove ?? {};
  const nextGroove: Partial<GrooveSettings> = { ...prev, ...groove };
  const describe = (g: Partial<GrooveSettings>) =>
    `swing ${Math.round((g.swing ?? 0) * 100)}% · humanize ${Math.round((g.humanizeTiming ?? 0) * 100)}/${Math.round((g.humanizeVelocity ?? 0) * 100)}`;
  return {
    type: "setGroove",
    label: `Groove → ${describe(nextGroove)}`,
    execute: (d) => ({ ...d, groove: nextGroove }),
    undo: (d) => ({ ...d, groove: prev }),
  };
}

/**
 * Merge per-step performance metadata (probability / ratchet / microtiming).
 * Values that land on the defaults (1 / 1 / 0) are pruned so the model stays
 * clean; an entry with nothing left is removed entirely.
 */
export function setStepMeta(
  doc: ProjectDocument,
  patternId: string,
  padId: string,
  stepIndex: number,
  meta: StepMeta,
): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  const prevEntry = pattern.stepMeta?.[padId]?.[stepIndex];

  const apply = (d: ProjectDocument, entry: StepMeta | undefined): ProjectDocument => ({
    ...d,
    patterns: d.patterns.map((p) => {
      if (p.id !== patternId) return p;
      const padMeta = { ...(p.stepMeta?.[padId] ?? {}) };
      if (entry && Object.keys(entry).length > 0) padMeta[stepIndex] = entry;
      else delete padMeta[stepIndex];
      const stepMeta = { ...(p.stepMeta ?? {}) };
      if (Object.keys(padMeta).length > 0) stepMeta[padId] = padMeta;
      else delete stepMeta[padId];
      return { ...p, stepMeta: Object.keys(stepMeta).length > 0 ? stepMeta : undefined };
    }),
  });

  const merged: StepMeta = { ...prevEntry, ...meta };
  const cleaned: StepMeta = {};
  if (merged.probability !== undefined && merged.probability < 1) cleaned.probability = clampUnit(merged.probability);
  if (merged.ratchet !== undefined && merged.ratchet > 1) cleaned.ratchet = Math.max(1, Math.min(8, Math.round(merged.ratchet)));
  if (merged.microtiming !== undefined && merged.microtiming !== 0) cleaned.microtiming = Math.max(-1, Math.min(1, merged.microtiming));

  return {
    type: "setStepMeta",
    label: "Edit step performance",
    execute: (d) => apply(d, cleaned),
    undo: (d) => apply(d, prevEntry),
  };
}

/** Clear velocities (and step meta) for a range of steps across pad rows. */
export function clearSteps(
  doc: ProjectDocument,
  patternId: string,
  padIds: string[],
  fromStep: number,
  toStep: number,
): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  const prevRows: Record<string, number[]> = {};
  for (const padId of padIds) prevRows[padId] = [...(pattern.rows[padId] ?? [])];
  const prevMeta = cloneStepMeta(pattern.stepMeta);

  const apply = (d: ProjectDocument, rows: Record<string, number[]>, meta: Pattern["stepMeta"]): ProjectDocument => ({
    ...d,
    patterns: d.patterns.map((p) =>
      p.id === patternId
        ? { ...p, rows: { ...p.rows, ...rows }, stepMeta: cloneStepMeta(meta) }
        : p,
    ),
  });

  const clearedRows: Record<string, number[]> = {};
  for (const padId of padIds) {
    const row = [...(pattern.rows[padId] ?? [])];
    for (let i = fromStep; i <= toStep && i < row.length; i++) row[i] = 0;
    clearedRows[padId] = row;
  }
  const clearedMeta = cloneStepMeta(pattern.stepMeta) ?? {};
  for (const padId of padIds) {
    const padMeta = clearedMeta[padId];
    if (!padMeta) continue;
    for (const key of Object.keys(padMeta)) {
      const idx = Number(key);
      if (idx >= fromStep && idx <= toStep) delete padMeta[idx];
    }
    if (Object.keys(padMeta).length === 0) delete clearedMeta[padId];
  }

  return {
    type: "clearSteps",
    label: `Clear steps ${fromStep + 1}–${toStep + 1}`,
    execute: (d) => apply(d, clearedRows, Object.keys(clearedMeta).length > 0 ? clearedMeta : undefined),
    undo: (d) => apply(d, prevRows, prevMeta),
  };
}

/** Batch-set velocities for a set of steps (multi-select velocity drag). */
export function setStepsVelocity(
  doc: ProjectDocument,
  patternId: string,
  entries: { padId: string; stepIndex: number; velocity: number }[],
): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  const prev: { padId: string; stepIndex: number; velocity: number }[] = entries.map((e) => ({
    ...e,
    velocity: pattern.rows[e.padId]?.[e.stepIndex] ?? 0,
  }));

  const apply = (d: ProjectDocument, list: { padId: string; stepIndex: number; velocity: number }[]): ProjectDocument => ({
    ...d,
    patterns: d.patterns.map((p) => {
      if (p.id !== patternId) return p;
      const rows = { ...p.rows };
      for (const entry of list) {
        const row = [...(rows[entry.padId] ?? [])];
        if (entry.stepIndex < row.length) row[entry.stepIndex] = entry.velocity;
        rows[entry.padId] = row;
      }
      return { ...p, rows };
    }),
  });

  return {
    type: "setStepsVelocity",
    label: `Set velocity for ${entries.length} steps`,
    execute: (d) => apply(d, entries),
    undo: (d) => apply(d, prev),
  };
}

/**
 * Mutate the active pattern into a variation: seeded velocity jitter, sparse
 * ghost notes next to existing hits, occasional dropped weak hits and a touch
 * of microtiming. One undo step returns the original.
 */
export function mutatePattern(doc: ProjectDocument, patternId: string): Command {
  const source = doc.patterns.find((p) => p.id === patternId);
  if (!source) throw new Error(`Pattern ${patternId} not found`);
  const rand = mulberry32(hashString(`${source.id}|${uid("mut")}`));

  const rows: Record<string, number[]> = {};
  const meta: NonNullable<Pattern["stepMeta"]> = cloneStepMeta(source.stepMeta) ?? {};
  for (const [padId, row] of Object.entries(source.rows)) {
    const next = [...row];
    for (let i = 0; i < next.length; i++) {
      const velocity = next[i];
      if (velocity > 0) {
        if (velocity < 0.5 && rand() < 0.12) {
          next[i] = 0;
          continue;
        }
        next[i] = Math.min(1, Math.max(0.1, velocity + (rand() - 0.5) * 0.35));
        if (rand() < 0.25) {
          const padMeta = meta[padId] ?? (meta[padId] = {});
          const jitter = (rand() - 0.5) * 0.6;
          if (Math.abs(jitter) > 0.05) padMeta[i] = { ...padMeta[i], microtiming: jitter };
        }
      } else {
        const neighbor = row[i - 1] > 0 || row[i + 1] > 0;
        if (neighbor && i % 2 === 1 && rand() < 0.08) {
          next[i] = 0.22 + rand() * 0.15;
        }
      }
    }
    rows[padId] = next;
  }

  const next: ProjectDocument = {
    ...doc,
    patterns: doc.patterns.map((p) =>
      p.id === patternId ? { ...p, rows, stepMeta: Object.keys(meta).length > 0 ? meta : undefined } : p,
    ),
  };
  return snapshot("mutatePattern", `Mutate ${source.name}`, doc, next);
}

/**
 * Duplicate the pattern as an explicit fill: a snare roll with rising velocity
 * over the last beat, capped by a ratcheted final hit. The fill becomes active.
 */
export function createFill(doc: ProjectDocument, patternId: string): Command {
  const source = doc.patterns.find((p) => p.id === patternId);
  if (!source) throw new Error(`Pattern ${patternId} not found`);
  const drumTrack = drumTracksOf(doc)[0];
  if (!drumTrack) throw new Error("No drum track for fill");
  const snarePad =
    drumTrack.pads.find((p) => /snare/i.test(p.name)) ?? drumTrack.pads[4] ?? drumTrack.pads[0];

  const rows = Object.fromEntries(Object.entries(source.rows).map(([padId, row]) => [padId, [...row]]));
  const rollVelocities = [0.45, 0.6, 0.78, 0.95];
  const snareRow = [...(rows[snarePad.id] ?? new Array<number>(source.stepCount).fill(0))];
  for (let k = 0; k < 4; k++) {
    const idx = source.stepCount - 4 + k;
    if (idx >= 0) snareRow[idx] = rollVelocities[k];
  }
  rows[snarePad.id] = snareRow;

  const stepMeta = cloneStepMeta(source.stepMeta) ?? {};
  const lastStep = source.stepCount - 1;
  stepMeta[snarePad.id] = { ...(stepMeta[snarePad.id] ?? {}), [lastStep]: { ratchet: 2 } };

  const copy: Pattern = {
    id: uid("pattern"),
    name: `${source.name} Fill`,
    stepCount: source.stepCount,
    rows,
    notes: Object.fromEntries(
      Object.entries(source.notes ?? {}).map(([trackId, notes]) => [trackId, notes.map((n) => ({ ...n, id: uid("note") }))]),
    ),
    stepMeta,
  };
  const next: ProjectDocument = {
    ...doc,
    patterns: [...doc.patterns, copy],
    activePatternId: copy.id,
  };
  return snapshot("createFill", `Fill from ${source.name}`, doc, next);
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

/**
 * Apply an instrument preset as a single undoable step: replaces the track's
 * parameters (clamped to the instrument's ranges), sampler sample, and records
 * the preset id. Params not present in the preset keep their current value.
 */
export function applyInstrumentPreset(doc: ProjectDocument, trackId: string, preset: InstrumentPreset): Command {
  const track = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.id === trackId);
  if (!track) throw new Error(`Instrument track ${trackId} not found`);
  const prevParams = { ...track.params };
  const prevSample = track.sampleId;
  const prevPresetId = track.presetId ?? null;

  const nextParams: Record<string, number> = { ...track.params };
  for (const [key, value] of Object.entries(preset.params)) {
    nextParams[key] = clampInstrumentParam(track.instrument, key, value);
  }
  const nextSample = preset.sampleId !== undefined ? preset.sampleId : track.sampleId;

  const apply = (d: ProjectDocument, params: Record<string, number>, sampleId: string | null, presetId: string | null): ProjectDocument => ({
    ...d,
    tracks: d.tracks.map((t) =>
      t.kind === "instrument" && t.id === trackId ? { ...t, params, sampleId, presetId } : t,
    ),
  });
  return {
    type: "applyInstrumentPreset",
    label: `Apply preset "${preset.name}"`,
    execute: (d) => apply(d, nextParams, nextSample, preset.id),
    undo: (d) => apply(d, prevParams, prevSample, prevPresetId),
  };
}

/* ---------------- scenes ---------------- */

export function createScene(doc: ProjectDocument, name?: string): Command {
  const scene: Scene = {
    id: uid("scene"),
    name: name ?? `Scene ${patternLetter(doc.scenes.length)}`,
    patternId: doc.activePatternId,
    intensity: 0.7,
  };
  const next: ProjectDocument = { ...doc, scenes: [...doc.scenes, scene] };
  return snapshot("createScene", `Add ${scene.name}`, doc, next);
}

export function renameScene(doc: ProjectDocument, sceneId: string, name: string): Command {
  const prev = doc.scenes.find((s) => s.id === sceneId)?.name ?? "";
  const next = { ...doc, scenes: doc.scenes.map((s) => (s.id === sceneId ? { ...s, name } : s)) };
  return {
    type: "renameScene",
    label: `Rename scene to "${name}"`,
    execute: () => next,
    undo: (d) => ({ ...d, scenes: d.scenes.map((s) => (s.id === sceneId ? { ...s, name: prev } : s)) }),
  };
}

export function setScenePattern(doc: ProjectDocument, sceneId: string, patternId: string): Command {
  const prev = doc.scenes.find((s) => s.id === sceneId)?.patternId ?? "";
  const apply = (d: ProjectDocument, v: string): ProjectDocument => ({
    ...d,
    scenes: d.scenes.map((s) => (s.id === sceneId ? { ...s, patternId: v } : s)),
  });
  return {
    type: "setScenePattern",
    label: "Set scene pattern",
    execute: (d) => apply(d, patternId),
    undo: (d) => apply(d, prev),
  };
}

export function deleteScene(doc: ProjectDocument, sceneId: string): Command {
  if (doc.scenes.length <= 1) throw new Error("Cannot delete the last scene");
  const target = doc.scenes.find((s) => s.id === sceneId);
  if (!target) throw new Error(`Scene ${sceneId} not found`);
  const next: ProjectDocument = {
    ...doc,
    scenes: doc.scenes.filter((s) => s.id !== sceneId),
    arrangement: { clips: doc.arrangement.clips.filter((c) => c.sceneId !== sceneId) },
  };
  return snapshot("deleteScene", `Delete scene ${target.name}`, doc, next);
}

/* ---------------- arrangement ---------------- */

function clipsOverlap(clips: ArrangementClip[], ignoreId: string | null, startBar: number, lengthBars: number): boolean {
  const endBar = startBar + lengthBars;
  return clips.some((c) => {
    if (c.id === ignoreId) return false;
    return startBar < c.startBar + c.lengthBars && c.startBar < endBar;
  });
}

export function addArrangementClip(doc: ProjectDocument, sceneId: string, startBar: number, lengthBars = 4): Command {
  const scene = doc.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`Scene ${sceneId} not found`);
  if (clipsOverlap(doc.arrangement.clips, null, startBar, lengthBars)) {
    throw new Error(`Clip overlaps an existing clip at bar ${startBar + 1}`);
  }
  const clip: ArrangementClip = { id: uid("clip"), sceneId, startBar, lengthBars };
  const next: ProjectDocument = {
    ...doc,
    arrangement: { clips: [...doc.arrangement.clips, clip].sort((a, b) => a.startBar - b.startBar) },
  };
  return snapshot("addArrangementClip", `Place ${scene.name} at bar ${startBar + 1}`, doc, next);
}

export function moveArrangementClip(doc: ProjectDocument, clipId: string, startBar: number): Command {
  const clip = doc.arrangement.clips.find((c) => c.id === clipId);
  if (!clip) throw new Error(`Clip ${clipId} not found`);
  const bar = Math.max(0, Math.round(startBar));
  if (clipsOverlap(doc.arrangement.clips, clipId, bar, clip.lengthBars)) {
    throw new Error(`Clip overlaps an existing clip at bar ${bar + 1}`);
  }
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      clips: doc.arrangement.clips
        .map((c) => (c.id === clipId ? { ...c, startBar: bar } : c))
        .sort((a, b) => a.startBar - b.startBar),
    },
  };
  return snapshot("moveArrangementClip", `Move clip to bar ${bar + 1}`, doc, next);
}

export function resizeArrangementClip(doc: ProjectDocument, clipId: string, lengthBars: number): Command {
  const clip = doc.arrangement.clips.find((c) => c.id === clipId);
  if (!clip) throw new Error(`Clip ${clipId} not found`);
  const bars = Math.max(1, Math.round(lengthBars));
  if (clipsOverlap(doc.arrangement.clips, clipId, clip.startBar, bars)) {
    throw new Error(`Clip would overlap the next clip`);
  }
  const next: ProjectDocument = {
    ...doc,
    arrangement: { clips: doc.arrangement.clips.map((c) => (c.id === clipId ? { ...c, lengthBars: bars } : c)) },
  };
  return snapshot("resizeArrangementClip", `Resize clip to ${bars} bars`, doc, next);
}

export function deleteArrangementClip(doc: ProjectDocument, clipId: string): Command {
  const next: ProjectDocument = {
    ...doc,
    arrangement: { clips: doc.arrangement.clips.filter((c) => c.id !== clipId) },
  };
  return snapshot("deleteArrangementClip", "Delete clip", doc, next);
}

export function duplicateArrangementClip(doc: ProjectDocument, clipId: string): Command {
  const clip = doc.arrangement.clips.find((c) => c.id === clipId);
  if (!clip) throw new Error(`Clip ${clipId} not found`);
  let startBar = clip.startBar + clip.lengthBars;
  while (clipsOverlap(doc.arrangement.clips, null, startBar, clip.lengthBars)) startBar += clip.lengthBars;
  const copy: ArrangementClip = { id: uid("clip"), sceneId: clip.sceneId, startBar, lengthBars: clip.lengthBars };
  const next: ProjectDocument = {
    ...doc,
    arrangement: { clips: [...doc.arrangement.clips, copy].sort((a, b) => a.startBar - b.startBar) },
  };
  return snapshot("duplicateArrangementClip", "Duplicate clip", doc, next);
}

/* ---------------- automation ---------------- */

export function automationLaneOf(doc: ProjectDocument, laneId: string): AutomationLane | undefined {
  return doc.automation.find((l) => l.id === laneId);
}

export function addAutomationLane(doc: ProjectDocument, target: AutomationTarget): Command {
  const track = doc.tracks.find((t) => t.id === target.trackId);
  if (!track) throw new Error(`Track ${target.trackId} not found`);
  if (target.kind === "fxParam") {
    if (!target.fxId) throw new Error("fxParam target requires fxId");
    if (!("effects" in track) || !track.effects.some((f) => f.id === target.fxId)) {
      throw new Error(`Effect ${target.fxId} not found on track ${target.trackId}`);
    }
  }
  if (target.kind === "instParam" && track.kind !== "instrument") {
    throw new Error(`instParam target requires an instrument track`);
  }
  if ((target.kind === "fxParam" || target.kind === "instParam") && !target.paramId) {
    throw new Error(`${target.kind} target requires paramId`);
  }
  const exists = doc.automation.some(
    (l) =>
      l.target.kind === target.kind &&
      l.target.trackId === target.trackId &&
      l.target.fxId === target.fxId &&
      l.target.paramId === target.paramId,
  );
  if (exists) throw new Error("Automation lane for this target already exists");
  const lane: AutomationLane = { id: uid("lane"), target, points: [] };
  const next: ProjectDocument = { ...doc, automation: [...doc.automation, lane] };
  return snapshot("addAutomationLane", "Add automation lane", doc, next);
}

export function removeAutomationLane(doc: ProjectDocument, laneId: string): Command {
  const next: ProjectDocument = { ...doc, automation: doc.automation.filter((l) => l.id !== laneId) };
  return snapshot("removeAutomationLane", "Remove automation lane", doc, next);
}

function withLane(doc: ProjectDocument, laneId: string, fn: (lane: AutomationLane) => AutomationLane): ProjectDocument {
  return { ...doc, automation: doc.automation.map((l) => (l.id === laneId ? fn(l) : l)) };
}

export function addAutomationPoint(doc: ProjectDocument, laneId: string, tick: number, value: number): Command {
  const lane = automationLaneOf(doc, laneId);
  if (!lane) throw new Error(`Lane ${laneId} not found`);
  const prev = lane.points;
  const point = { tick: Math.max(0, Math.round(tick)), value };
  const next = withLane(doc, laneId, (l) => ({ ...l, points: insertPointSorted(l.points, point) }));
  return {
    type: "addAutomationPoint",
    label: "Add automation point",
    execute: () => next,
    undo: (d) => withLane(d, laneId, (l) => ({ ...l, points: prev })),
  };
}

export function moveAutomationPoint(
  doc: ProjectDocument,
  laneId: string,
  index: number,
  delta: { tick?: number; value?: number },
): Command {
  const lane = automationLaneOf(doc, laneId);
  if (!lane || index < 0 || index >= lane.points.length) throw new Error("Automation point not found");
  const prev = lane.points;
  const next = withLane(doc, laneId, (l) => {
    const points = [...l.points];
    const p = points[index];
    points[index] = {
      tick: Math.max(0, Math.round(delta.tick ?? p.tick)),
      value: delta.value ?? p.value,
    };
    return { ...l, points: points.sort((a, b) => a.tick - b.tick) };
  });
  return {
    type: "moveAutomationPoint",
    label: "Move automation point",
    execute: () => next,
    undo: (d) => withLane(d, laneId, (l) => ({ ...l, points: prev })),
  };
}

export function deleteAutomationPoint(doc: ProjectDocument, laneId: string, index: number): Command {
  const lane = automationLaneOf(doc, laneId);
  if (!lane || index < 0 || index >= lane.points.length) throw new Error("Automation point not found");
  const prev = lane.points;
  const next = withLane(doc, laneId, (l) => ({ ...l, points: l.points.filter((_, i) => i !== index) }));
  return {
    type: "deleteAutomationPoint",
    label: "Delete automation point",
    execute: () => next,
    undo: (d) => withLane(d, laneId, (l) => ({ ...l, points: prev })),
  };
}

/* ---------------- LFO ---------------- */

export function addLfo(doc: ProjectDocument, trackId: string): Command {
  const lfo: Lfo = {
    id: uid("lfo"),
    trackId,
    param: "gain",
    wave: "sine",
    rateMode: "sync",
    rateHz: 2,
    division: 2,
    amount: 0.3,
  };
  const next: ProjectDocument = { ...doc, lfos: [...doc.lfos, lfo] };
  return snapshot("addLfo", "Add LFO", doc, next);
}

export function removeLfo(doc: ProjectDocument, lfoId: string): Command {
  const next: ProjectDocument = { ...doc, lfos: doc.lfos.filter((l) => l.id !== lfoId) };
  return snapshot("removeLfo", "Remove LFO", doc, next);
}

export function setLfoParams(doc: ProjectDocument, lfoId: string, patch: Partial<Omit<Lfo, "id" | "trackId">>): Command {
  const prev: Partial<Omit<Lfo, "id" | "trackId">> = {};
  const current = doc.lfos.find((l) => l.id === lfoId);
  if (!current) throw new Error(`LFO ${lfoId} not found`);
  for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
    (prev as Record<string, unknown>)[key] = current[key];
  }
  const apply = (d: ProjectDocument, values: Partial<Omit<Lfo, "id" | "trackId">>): ProjectDocument => ({
    ...d,
    lfos: d.lfos.map((l) => (l.id === lfoId ? { ...l, ...values } : l)),
  });
  return {
    type: "setLfoParams",
    label: "Edit LFO",
    execute: (d) => apply(d, patch),
    undo: (d) => apply(d, prev),
  };
}

/* ---------------- macros ---------------- */

export function setMacroValue(doc: ProjectDocument, macroId: string, value: number): Command {
  const prev = doc.macros.find((m) => m.id === macroId)?.value ?? 0.5;
  const clamped = clamp(value, 0, 1);
  const apply = (d: ProjectDocument, v: number): ProjectDocument => ({
    ...d,
    macros: d.macros.map((m) => (m.id === macroId ? { ...m, value: v } : m)),
  });
  return {
    type: "setMacroValue",
    label: "Set macro",
    execute: (d) => apply(d, clamped),
    undo: (d) => apply(d, prev),
  };
}

export function renameMacro(doc: ProjectDocument, macroId: string, name: string): Command {
  const prev = doc.macros.find((m) => m.id === macroId)?.name ?? "";
  const apply = (d: ProjectDocument, v: string): ProjectDocument => ({
    ...d,
    macros: d.macros.map((m) => (m.id === macroId ? { ...m, name: v } : m)),
  });
  return {
    type: "renameMacro",
    label: `Rename macro to "${name}"`,
    execute: (d) => apply(d, name),
    undo: (d) => apply(d, prev),
  };
}

export function addMacroMapping(doc: ProjectDocument, macroId: string, trackId: string, param: "gain" | "pan"): Command {
  if (!doc.tracks.some((t) => t.id === trackId)) throw new Error(`Track ${trackId} not found`);
  if (!doc.macros.some((m) => m.id === macroId)) throw new Error(`Macro ${macroId} not found`);
  const mapping = { id: uid("map"), trackId, param, amount: 0.5 };
  const next: ProjectDocument = {
    ...dMap(doc, macroId, (m) => ({ ...m, mappings: [...m.mappings, mapping] })),
  };
  return snapshot("addMacroMapping", "Add macro mapping", doc, next);
}

export function removeMacroMapping(doc: ProjectDocument, macroId: string, mappingId: string): Command {
  const next: ProjectDocument = {
    ...dMap(doc, macroId, (m) => ({ ...m, mappings: m.mappings.filter((x) => x.id !== mappingId) })),
  };
  return snapshot("removeMacroMapping", "Remove macro mapping", doc, next);
}

export function setMacroMappingAmount(doc: ProjectDocument, macroId: string, mappingId: string, amount: number): Command {
  const prev = doc.macros
    .find((m) => m.id === macroId)
    ?.mappings.find((x) => x.id === mappingId)?.amount;
  if (prev === undefined) throw new Error("Macro mapping not found");
  const clamped = clamp(amount, -1, 1);
  const apply = (d: ProjectDocument, v: number): ProjectDocument => ({
    ...d,
    macros: d.macros.map((m) =>
      m.id === macroId
        ? { ...m, mappings: m.mappings.map((x) => (x.id === mappingId ? { ...x, amount: v } : x)) }
        : m,
    ),
  });
  return {
    type: "setMacroMappingAmount",
    label: "Set macro amount",
    execute: (d) => apply(d, clamped),
    undo: (d) => apply(d, prev),
  };
}

function dMap(doc: ProjectDocument, macroId: string, fn: (m: Macro) => Macro): ProjectDocument {
  return { ...doc, macros: doc.macros.map((m) => (m.id === macroId ? fn(m) : m)) };
}

/* ---------------- master / sends / returns ---------------- */

export function setMasterConfig(doc: ProjectDocument, patch: Partial<MasterConfig>): Command {
  const next: ProjectDocument = { ...doc, master: { ...doc.master, ...patch } };
  return snapshot("setMasterConfig", "Edit master chain", doc, next);
}

export function setTrackSend(doc: ProjectDocument, trackId: string, returnId: string, level: number): Command {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`Track ${trackId} not found`);
  const prev = track.sends[returnId] ?? 0;
  const clamped = clamp(level, 0, 1.5);
  const apply = (d: ProjectDocument, v: number): ProjectDocument => ({
    ...d,
    tracks: d.tracks.map((t) => (t.id === trackId ? { ...t, sends: { ...t.sends, [returnId]: v } } : t)),
  });
  return {
    type: "setTrackSend",
    label: "Set send level",
    execute: (d) => apply(d, clamped),
    undo: (d) => apply(d, prev),
  };
}

export function setReturnGain(doc: ProjectDocument, returnId: string, gain: number): Command {
  const prev = doc.returns.find((r) => r.id === returnId)?.gain ?? 0.9;
  const clamped = clamp(gain, 0, 1.5);
  const apply = (d: ProjectDocument, v: number): ProjectDocument => ({
    ...d,
    returns: d.returns.map((r) => (r.id === returnId ? { ...r, gain: v } : r)),
  });
  return {
    type: "setReturnGain",
    label: "Set return gain",
    execute: (d) => apply(d, clamped),
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
  const target = trackEffectsOf(doc, trackId).find((f) => f.id === fxId);
  if (!target) throw new Error(`Effect ${fxId} not found`);
  const { type, params } = target;
  const def = EFFECT_DEFS[type].params.find((p) => p.id === paramId);
  if (!def) throw new Error(`Effect param ${paramId} not defined for ${type}`);
  const prev = params[paramId] ?? def.default;
  const clamped = clampEffectParam(type, paramId, value);
  const apply = (d: ProjectDocument, v: number): ProjectDocument =>
    withTrackEffects(d, trackId, (effects) =>
      effects.map((f) => (f.id === fxId ? { ...f, params: { ...f.params, [paramId]: v } } : f)),
    );
  return {
    type: "setEffectParam",
    label: `Set ${EFFECT_DEFS[type].name} ${paramId}`,
    execute: (d) => apply(d, clamped),
    undo: (d) => apply(d, prev),
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
/* ---------------- metadata & scorepack ---------------- */export function setProjectKey(doc: ProjectDocument, key: MusicalKey | null): Command {  const prev = doc.key;  const next: ProjectDocument = key    ? { ...doc, key }    : (() => {        const { key: _drop, ...rest } = doc;        return rest as ProjectDocument;      })();  return {    type: "setProjectKey",    label: key ? `Set project key to ${key}` : "Clear project key",    execute: () => next,    undo: (d) =>      prev        ? { ...d, key: prev }        : (() => {            const { key: _drop, ...rest } = d;            return rest as ProjectDocument;          })(),  };}export function setProjectTags(doc: ProjectDocument, tags: string[]): Command {  const prev = doc.tags;  const cleaned = tags.map((t) => t.trim()).filter((t) => t.length > 0);  return {    type: "setProjectTags",    label: "Edit project tags",    execute: (d) => ({ ...d, tags: cleaned }),    undo: (d) =>      prev        ? { ...d, tags: prev }        : (() => {            const { tags: _drop, ...rest } = d;            return rest as ProjectDocument;          })(),  };}/* ---------------- markers ---------------- */export function addMarker(  doc: ProjectDocument,  partial: { tick: number; type?: Marker["type"]; name?: string; linkedClipId?: string; customId?: string },): Command {  const marker: Marker = {    id: uid("marker"),    name: partial.name?.trim() || `Marker ${doc.markers.length + 1}`,    type: partial.type ?? "cue",    tick: Math.max(0, Math.floor(partial.tick)),    linkedClipId: partial.linkedClipId,    customId: partial.customId,  };  const next: ProjectDocument = { ...doc, markers: [...doc.markers, marker] };  return snapshot("addMarker", `Add marker ${marker.name}`, doc, next);}export function removeMarker(doc: ProjectDocument, markerId: string): Command {  const target = doc.markers.find((m) => m.id === markerId);  if (!target) throw new Error(`Marker ${markerId} not found`);  const next: ProjectDocument = { ...doc, markers: doc.markers.filter((m) => m.id !== markerId) };  return snapshot("removeMarker", `Remove marker ${target.name}`, doc, next);}export function renameMarker(doc: ProjectDocument, markerId: string, name: string): Command {  const target = doc.markers.find((m) => m.id === markerId);  if (!target) throw new Error(`Marker ${markerId} not found`);  const trimmed = name.trim() || target.name;  const next = {    ...doc,    markers: doc.markers.map((m) => (m.id === markerId ? { ...m, name: trimmed } : m)),  };  return snapshot("renameMarker", `Rename marker to ${trimmed}`, doc, next);}export function setMarkerType(doc: ProjectDocument, markerId: string, type: Marker["type"]): Command {  const target = doc.markers.find((m) => m.id === markerId);  if (!target) throw new Error(`Marker ${markerId} not found`);  const next = {    ...doc,    markers: doc.markers.map((m) => (m.id === markerId ? { ...m, type } : m)),  };  return snapshot("setMarkerType", `Marker type to ${type}`, doc, next);}export function moveMarker(doc: ProjectDocument, markerId: string, tick: number): Command {  const target = doc.markers.find((m) => m.id === markerId);  if (!target) throw new Error(`Marker ${markerId} not found`);  const clamped = Math.max(0, Math.floor(tick));  const next = {    ...doc,    markers: doc.markers.map((m) => (m.id === markerId ? { ...m, tick: clamped } : m)),  };  return snapshot("moveMarker", "Move marker", doc, next);}export function setMarkerLinkedClip(doc: ProjectDocument, markerId: string, linkedClipId: string | null): Command {  const target = doc.markers.find((m) => m.id === markerId);  if (!target) throw new Error(`Marker ${markerId} not found`);  const next = {    ...doc,    markers: doc.markers.map((m) =>      m.id === markerId ? { ...m, linkedClipId: linkedClipId ?? undefined } : m,    ),  };  return snapshot("setMarkerLinkedClip", "Link marker to clip", doc, next);}/* ---------------- scenes (intensity / loop) ---------------- */export function setSceneIntensity(doc: ProjectDocument, sceneId: string, intensity: number): Command {  const target = doc.scenes.find((s) => s.id === sceneId);  if (!target) throw new Error(`Scene ${sceneId} not found`);  const clamped = Math.min(1, Math.max(0, Number.isFinite(intensity) ? intensity : 0.7));  const next = {    ...doc,    scenes: doc.scenes.map((s) => (s.id === sceneId ? { ...s, intensity: clamped } : s)),  };  return snapshot("setSceneIntensity", `Scene intensity to ${clamped.toFixed(2)}`, doc, next);}export function setSceneIntensityCurve(doc: ProjectDocument, sceneId: string, curve: IntensityPoint[]): Command {  const target = doc.scenes.find((s) => s.id === sceneId);  if (!target) throw new Error(`Scene ${sceneId} not found`);  const cleaned = curve    .map((p) => ({      offset: Math.max(0, Math.floor(p.offset)),      value: Math.min(1, Math.max(0, Number.isFinite(p.value) ? p.value : 0)),    }))    .sort((a, b) => a.offset - b.offset);  const next = {    ...doc,    scenes: doc.scenes.map((s) =>      s.id === sceneId        ? { ...s, intensityCurve: cleaned.length > 0 ? cleaned : undefined }        : s,    ),  };  return snapshot("setSceneIntensityCurve", "Scene intensity curve", doc, next);}export function setSceneLoop(doc: ProjectDocument, sceneId: string, loop: boolean): Command {  const target = doc.scenes.find((s) => s.id === sceneId);  if (!target) throw new Error(`Scene ${sceneId} not found`);  const next = {    ...doc,    scenes: doc.scenes.map((s) => (s.id === sceneId ? { ...s, loop } : s)),  };  return snapshot("setSceneLoop", loop ? "Loop scene" : "Unloop scene", doc, next);}export function setArrangementClipLoop(doc: ProjectDocument, clipId: string, loop: boolean): Command {  const target = doc.arrangement.clips.find((c) => c.id === clipId);  if (!target) throw new Error(`Clip ${clipId} not found`);  const next = {    ...doc,    arrangement: {      ...doc.arrangement,      clips: doc.arrangement.clips.map((c) => (c.id === clipId ? { ...c, loop } : c)),    },  };  return snapshot("setArrangementClipLoop", loop ? "Loop clip" : "Unloop clip", doc, next);}/* ---------------- scene automation ---------------- */export function addSceneAutomation(doc: ProjectDocument, sceneId: string, target: AutomationTarget): Command {  if (!doc.scenes.some((s) => s.id === sceneId)) throw new Error(`Scene ${sceneId} not found`);  const lane: SceneAutomation = { id: uid("sceneAuto"), sceneId, target, points: [{ tick: 0, value: 0 }] };  const next = { ...doc, sceneAutomation: [...doc.sceneAutomation, lane] };  return snapshot("addSceneAutomation", "Add scene lane", doc, next);}export function removeSceneAutomation(doc: ProjectDocument, laneId: string): Command {  const target = doc.sceneAutomation.find((l) => l.id === laneId);  if (!target) throw new Error(`Scene lane ${laneId} not found`);  const next = { ...doc, sceneAutomation: doc.sceneAutomation.filter((l) => l.id !== laneId) };  return snapshot("removeSceneAutomation", "Remove scene lane", doc, next);}export function addSceneAutomationPoint(doc: ProjectDocument, laneId: string, tick: number, value: number): Command {  const lane = doc.sceneAutomation.find((l) => l.id === laneId);  if (!lane) throw new Error(`Scene lane ${laneId} not found`);  const next = {    ...doc,    sceneAutomation: doc.sceneAutomation.map((l) =>      l.id === laneId        ? {            ...l,            points: [...l.points, { tick: Math.max(0, Math.floor(tick)), value }].sort(              (a, b) => a.tick - b.tick,            ),          }        : l,    ),  };  return snapshot("addSceneAutomationPoint", "Add scene point", doc, next);}export function moveSceneAutomationPoint(  doc: ProjectDocument,  laneId: string,  index: number,  delta: { tick?: number; value?: number },): Command {  const lane = doc.sceneAutomation.find((l) => l.id === laneId);  if (!lane) throw new Error(`Scene lane ${laneId} not found`);  if (index < 0 || index >= lane.points.length) throw new Error("Scene point out of range");  const next = {    ...doc,    sceneAutomation: doc.sceneAutomation.map((l) => {      if (l.id !== laneId) return l;      const points = [...l.points];      const p = points[index];      points[index] = {        tick: delta.tick !== undefined ? Math.max(0, Math.floor(delta.tick)) : p.tick,        value: delta.value !== undefined ? delta.value : p.value,      };      points.sort((a, b) => a.tick - b.tick);      return { ...l, points };    }),  };  return snapshot("moveSceneAutomationPoint", "Move scene point", doc, next);}export function removeSceneAutomationPoint(doc: ProjectDocument, laneId: string, index: number): Command {  const lane = doc.sceneAutomation.find((l) => l.id === laneId);  if (!lane) throw new Error(`Scene lane ${laneId} not found`);  if (index < 0 || index >= lane.points.length) throw new Error("Scene point out of range");  const next = {    ...doc,    sceneAutomation: doc.sceneAutomation.map((l) =>      l.id === laneId ? { ...l, points: l.points.filter((_, i) => i !== index) } : l,    ),  };  return snapshot("removeSceneAutomationPoint", "Remove scene point", doc, next);}

/* ---------------- scale quantize ---------------- */

export function quantizePatternToScale(doc: ProjectDocument, patternId: string, key: MusicalKey): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  const nextNotes: Record<string, import("../project-model/types").NoteEvent[]> = {};
  for (const [trackId, notes] of Object.entries(pattern.notes ?? {})) {
    nextNotes[trackId] = notes.map((n) => ({
      ...n,
      pitch: snapToScale(n.pitch, key),
    }));
  }
  const next: ProjectDocument = {
    ...doc,
    patterns: doc.patterns.map((p) => (p.id === patternId ? { ...p, notes: nextNotes } : p)),
  };
  return snapshot("quantizePatternToScale", `Quantize to ${key}`, doc, next);
}

/* ---------------- time quantize ---------------- */

export function quantizePatternToGrid(doc: ProjectDocument, patternId: string, gridTicks: number): Command {
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  if (gridTicks <= 0) throw new Error("Grid resolution must be positive");

  const nextNotes: Record<string, import("../project-model/types").NoteEvent[]> = {};
  for (const [trackId, notes] of Object.entries(pattern.notes ?? {})) {
    nextNotes[trackId] = notes.map((n) => ({
      ...n,
      start: Math.round(n.start / gridTicks) * gridTicks,
    }));
  }
  const next: ProjectDocument = {
    ...doc,
    patterns: doc.patterns.map((p) => (p.id === patternId ? { ...p, notes: nextNotes } : p)),
  };
  return snapshot("quantizePatternToGrid", `Quantize to grid`, doc, next);
}
