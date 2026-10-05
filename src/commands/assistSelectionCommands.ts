import type { DrumTrack, ProjectDocument } from "../project-model/types";
import {
  applyAssistPatchToStepSelection,
  humanizeNoteSelection,
  thinStepSelection,
  varyPattern,
  type NoteSelectionScope,
  type StepSelectionScope,
} from "../assist/patternOps";
import { snapshot } from "./core";
import type { Command } from "./types";

/** Create one undoable, deterministic VARY operation limited to selected drum cells. */
export function assistVarySelectionCommand(
  doc: ProjectDocument,
  patternId: string,
  drumTrackId: string,
  selection: StepSelectionScope,
  seed: string,
  amount: number,
): Command {
  const pattern = doc.patterns.find((candidate) => candidate.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  const drumTrack = doc.tracks.find((track): track is DrumTrack => track.kind === "drum" && track.id === drumTrackId);
  if (!drumTrack) throw new Error(`Drum track ${drumTrackId} not found`);
  if (
    selection.padIds.length === 0 ||
    selection.padIds.some((padId) => !drumTrack.pads.some((pad) => pad.id === padId))
  ) {
    throw new Error("Selected steps do not belong to the target drum track");
  }
  const selectionStart = Math.min(selection.from, selection.to);
  const selectionEnd = Math.max(selection.from, selection.to);
  if (
    !Number.isInteger(selectionStart) ||
    !Number.isInteger(selectionEnd) ||
    selectionStart < 0 ||
    selectionEnd >= pattern.stepCount
  ) {
    throw new Error("Selected steps are outside the current pattern");
  }

  const patch = varyPattern(pattern, drumTrack.pads, seed, amount);
  const nextPattern = applyAssistPatchToStepSelection(pattern, patch, selection);
  if (nextPattern === pattern) throw new Error("Selected steps are outside the current pattern");

  const nextDoc: ProjectDocument = {
    ...doc,
    patterns: doc.patterns.map((candidate) => (candidate.id === patternId ? nextPattern : candidate)),
  };
  return snapshot("assistVarySelection", `Vary selected steps in ${pattern.name}`, doc, nextDoc);
}

/** Create one undoable, selection-locked thinning edit for selected drum cells. */
export function assistThinSelectionCommand(
  doc: ProjectDocument,
  patternId: string,
  drumTrackId: string,
  selection: StepSelectionScope,
  amount = 0.4,
): Command {
  const pattern = doc.patterns.find((candidate) => candidate.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  const drumTrack = doc.tracks.find((track): track is DrumTrack => track.kind === "drum" && track.id === drumTrackId);
  if (!drumTrack) throw new Error(`Drum track ${drumTrackId} not found`);
  if (
    selection.padIds.length === 0 ||
    selection.padIds.some(
      (padId) => !drumTrack.pads.some((pad) => pad.id === padId) || pattern.rows[padId] === undefined,
    )
  ) {
    throw new Error("Selected steps do not belong to the target drum track");
  }
  const selectionStart = Math.min(selection.from, selection.to);
  const selectionEnd = Math.max(selection.from, selection.to);
  if (
    !Number.isInteger(selectionStart) ||
    !Number.isInteger(selectionEnd) ||
    selectionStart < 0 ||
    selectionEnd >= pattern.stepCount
  ) {
    throw new Error("Selected steps are outside the current pattern");
  }

  const nextPattern = thinStepSelection(pattern, selection, amount);
  if (nextPattern === pattern) throw new Error("Selected steps contain no eligible off-beat hits to thin");
  const nextDoc: ProjectDocument = {
    ...doc,
    patterns: doc.patterns.map((candidate) => (candidate.id === patternId ? nextPattern : candidate)),
  };
  return snapshot("assistThinSelection", `Thin selected steps in ${pattern.name}`, doc, nextDoc);
}

/** Create one undoable, deterministic humanization limited to selected notes. */
export function assistVaryNoteSelectionCommand(
  doc: ProjectDocument,
  patternId: string,
  selection: readonly NoteSelectionScope[],
  seed: string,
  amount: number,
): Command {
  const pattern = doc.patterns.find((candidate) => candidate.id === patternId);
  if (!pattern) throw new Error(`Pattern ${patternId} not found`);
  const nextPattern = humanizeNoteSelection(pattern, selection, seed, amount);
  if (nextPattern === pattern) throw new Error("Selected notes are no longer available in this pattern");

  const nextDoc: ProjectDocument = {
    ...doc,
    patterns: doc.patterns.map((candidate) => (candidate.id === patternId ? nextPattern : candidate)),
  };
  return snapshot("assistVaryNoteSelection", `Humanize selected notes in ${pattern.name}`, doc, nextDoc);
}
