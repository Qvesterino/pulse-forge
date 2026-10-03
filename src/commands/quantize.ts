import type { Command } from "./types";
import type { MusicalKey, ProjectDocument } from "../project-model/types";
import { clampTargetValue, targetOwner, targetParamDef } from "../project-model/targets";
import { snapToScale } from "../project-model/scales";
import { uid } from "../shared/ids";
import { snapshot } from "./core";

/**
 * Quantize: scale quantize (snap notes to a key) and time quantize (snap notes
 * and automation points to the grid).
 */
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

// ---------------------------------------------------------------------------
// MIDI
// ---------------------------------------------------------------------------

function ensureMidi(doc: ProjectDocument): NonNullable<ProjectDocument["midi"]> {
  return (
    doc.midi ?? {
      enabled: false,
      deviceId: "",
      drumChannel: 0,
      instrumentChannel: 0,
      ccMappings: [],
      drumNoteMap: [],
      pitchBendRange: 2,
    }
  );
}

export function setMidiConfig(
  doc: ProjectDocument,
  changes: Partial<import("../project-model/types").MidiConfig>,
): Command {
  const prev = ensureMidi(doc);
  const next: ProjectDocument = { ...doc, midi: { ...prev, ...changes } };
  return snapshot("setMidiConfig", `MIDI settings`, doc, next);
}

export function addMidiCcMapping(
  doc: ProjectDocument,
  ccNumber: number,
  target: import("../project-model/types").AutomationTarget,
  min: number,
  max: number,
): Command {
  const midi = ensureMidi(doc);
  if (!Number.isFinite(ccNumber) || ccNumber < 0 || ccNumber > 127) throw new Error("Invalid CC number");
  if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error("Invalid MIDI mapping range");
  const targetDef = targetParamDef(doc, target);
  // Keep the command usable for legacy imports that refer to a track which
  // is created by a later collab transaction; normalizeProject will remove
  // that unresolved map. Once the owner exists, reject deleted FX/params at
  // the command boundary and clamp the controller range to the target.
  if (targetOwner(doc, target.trackId) && !targetDef) throw new Error("Invalid MIDI CC target");
  const safeMin = targetDef ? clampTargetValue(doc, target, min) : min;
  const safeMax = targetDef ? clampTargetValue(doc, target, max) : max;
  // Copy the caller's target — the mapping must not alias an object the
  // caller could later mutate in place (same discipline as addAutomationLane).
  const mapping: import("../project-model/types").MidiCcMapping = {
    id: uid("midiMap"),
    ccNumber,
    target: { ...target },
    min,
    max,
  };
  mapping.ccNumber = Math.floor(ccNumber);
  mapping.min = Math.min(safeMin, safeMax);
  mapping.max = Math.max(safeMin, safeMax);
  const next: ProjectDocument = { ...doc, midi: { ...midi, ccMappings: [...midi.ccMappings, mapping] } };
  return snapshot("addMidiCcMapping", `Map CC${ccNumber}`, doc, next);
}

export function removeMidiCcMapping(doc: ProjectDocument, mappingId: string): Command {
  const midi = ensureMidi(doc);
  const next: ProjectDocument = {
    ...doc,
    midi: { ...midi, ccMappings: midi.ccMappings.filter((m) => m.id !== mappingId) },
  };
  return snapshot("removeMidiCcMapping", `Remove CC mapping`, doc, next);
}

export function setDrumNoteMapping(doc: ProjectDocument, midiNote: number, padId: string): Command {
  const midi = ensureMidi(doc);
  const existing = midi.drumNoteMap.filter((m) => m.midiNote !== midiNote);
  const next: ProjectDocument = {
    ...doc,
    midi: { ...midi, drumNoteMap: [...existing, { midiNote, padId }] },
  };
  return snapshot("setDrumNoteMapping", `Map note ${midiNote}`, doc, next);
}

export function resetDrumNoteMapping(doc: ProjectDocument): Command {
  const midi = ensureMidi(doc);
  const next: ProjectDocument = { ...doc, midi: { ...midi, drumNoteMap: [] } };
  return snapshot("resetDrumNoteMapping", `Reset drum map`, doc, next);
}

// ---------------------------------------------------------------------------
// Program Change & Bank Select
// ---------------------------------------------------------------------------

export function setTrackPreset(doc: ProjectDocument, trackId: string, presetId: string): Command {
  const track = doc.tracks.find((t) => t.id === trackId && t.kind === "instrument");
  if (!track || track.kind !== "instrument") throw new Error(`Instrument track ${trackId} not found`);
  const prev = track.presetId;
  const hadPresetId = prev !== undefined;
  const apply = (d: ProjectDocument, id: string | null | undefined): ProjectDocument => ({
    ...d,
    tracks: d.tracks.map((t) => {
      if (t.id !== trackId || t.kind !== "instrument") return t;
      if (id === undefined && !hadPresetId) {
        const { presetId: _, ...rest } = t as any;
        return rest;
      }
      return { ...t, presetId: id };
    }),
  });
  return {
    type: "setTrackPreset",
    label: `Program Change → ${presetId}`,
    execute: (d) => apply(d, presetId),
    undo: (d) => apply(d, prev),
    applyToYDoc: (yMap) => {
      const tracks = yMap.get("tracks") as any;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks.get(i);
        if (t.get("id") === trackId) {
          t.set("presetId", presetId);
          break;
        }
      }
    },
  };
}

export function setMidiProgramMap(doc: ProjectDocument, programMap: { program: number; presetId: string }[]): Command {
  const midi = ensureMidi(doc);
  const next: ProjectDocument = { ...doc, midi: { ...midi, programMap } };
  return snapshot("setMidiProgramMap", `Set program map`, doc, next);
}

// ---------------------------------------------------------------------------
// Note-Off (lifecycle extension)
// ---------------------------------------------------------------------------

// Note-off is handled at the AudioEngine level, not as a document command.
// See AudioEngine.noteOff() and MidiInput.handleNoteOff().

// ---------------------------------------------------------------------------
// Aftertouch
// ---------------------------------------------------------------------------

export function setMidiAftertouch(
  doc: ProjectDocument,
  target: import("../project-model/types").AutomationTarget,
  range: number,
): Command {
  const midi = ensureMidi(doc);
  const next: ProjectDocument = { ...doc, midi: { ...midi, aftertouchTarget: target, aftertouchRange: range } };
  return snapshot("setMidiAftertouch", `Aftertouch config`, doc, next);
}

// ---------------------------------------------------------------------------
// MIDI Output
// ---------------------------------------------------------------------------

export function setTrackMidiOutput(
  doc: ProjectDocument,
  trackId: string,
  output: { enabled: boolean; channel: number; deviceId?: string },
): Command {
  const prev = doc.tracks.find((t) => t.id === trackId);
  if (!prev) throw new Error(`Track ${trackId} not found`);
  const next: ProjectDocument = {
    ...doc,
    tracks: doc.tracks.map((t) => (t.id === trackId ? { ...t, midiOutput: output } : t)),
  };
  return snapshot("setTrackMidiOutput", `MIDI output config`, doc, next);
}

// ---------------------------------------------------------------------------
// MIDI Clock
// ---------------------------------------------------------------------------

export function setMidiClockMode(doc: ProjectDocument, clockMode: "off" | "master" | "slave"): Command {
  const midi = ensureMidi(doc);
  const next: ProjectDocument = { ...doc, midi: { ...midi, clockMode } };
  return snapshot("setMidiClockMode", `Clock mode: ${clockMode}`, doc, next);
}
