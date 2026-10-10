import type { Command } from "./types";
import type { ChordEvent, ProjectDocument } from "../project-model/types";
import type { ChordQuality } from "../project-model/chords";
import { CHORD_QUALITIES } from "../project-model/chords";
import { uid } from "../shared/ids";
import { snapshot } from "./core";

/**
 * CHORD TRACK commands (schema v17) — the arrangement's harmonic skeleton.
 *
 * Same lane contract as scene clips: whole-bar events, integer bars, at least
 * one bar, and NO OVERLAP — an overlapping add/move/resize is refused with an
 * error the caller surfaces (the UI snaps and nudges; the contract stays in
 * one place). Chords are project data, not audio: nothing downstream needs
 * re-rendering, the scheduler and the piano roll read them live.
 */

function chordsOverlap(chords: ChordEvent[], ignoreId: string | null, startBar: number, lengthBars: number): boolean {
  const endBar = startBar + lengthBars;
  return chords.some((c) => {
    if (c.id === ignoreId) return false;
    return startBar < c.startBar + c.lengthBars && c.startBar < endBar;
  });
}

function findChord(doc: ProjectDocument, chordId: string): ChordEvent {
  const chord = (doc.arrangement.chords ?? []).find((c) => c.id === chordId);
  if (!chord) throw new Error(`Chord ${chordId} not found`);
  return chord;
}

function normalizeBars(value: number, what: string): number {
  if (!Number.isFinite(value)) throw new Error(`${what} must be a finite bar position`);
  return Math.max(0, Math.round(value));
}

export function addChord(
  doc: ProjectDocument,
  startBar: number,
  lengthBars: number,
  root: number,
  quality: ChordQuality,
): Command {
  const start = normalizeBars(startBar, "Start");
  const bars = normalizeBars(lengthBars, "Length");
  if (bars < 1) throw new Error("A chord must span at least one whole bar");
  if (!Number.isFinite(root) || root < 0 || root > 11 || !Number.isInteger(root)) {
    throw new Error("Chord root must be a pitch class 0–11");
  }
  if (!CHORD_QUALITIES.includes(quality)) throw new Error(`Unknown chord quality: ${String(quality)}`);
  if (chordsOverlap(doc.arrangement.chords ?? [], null, start, bars)) {
    throw new Error("Chord would overlap another chord");
  }
  const chord: ChordEvent = { id: uid("chord"), startBar: start, lengthBars: bars, root, quality };
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      chords: [...(doc.arrangement.chords ?? []), chord].sort((a, b) => a.startBar - b.startBar),
    },
  };
  return snapshot("addChord", `Add chord at bar ${start + 1}`, doc, next);
}

export function moveChord(doc: ProjectDocument, chordId: string, newStartBar: number): Command {
  const chord = findChord(doc, chordId);
  const start = normalizeBars(newStartBar, "Start");
  if (start === chord.startBar) return snapshot("moveChord", "Move chord (no-op)", doc, doc);
  if (chordsOverlap(doc.arrangement.chords ?? [], chordId, start, chord.lengthBars)) {
    throw new Error("Chord would overlap another chord");
  }
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      chords: (doc.arrangement.chords ?? [])
        .map((c) => (c.id === chordId ? { ...c, startBar: start } : c))
        .sort((a, b) => a.startBar - b.startBar),
    },
  };
  return snapshot("moveChord", `Move chord to bar ${start + 1}`, doc, next);
}

export function resizeChord(doc: ProjectDocument, chordId: string, lengthBars: number): Command {
  const chord = findChord(doc, chordId);
  const bars = normalizeBars(lengthBars, "Length");
  if (bars < 1) throw new Error("A chord must span at least one whole bar");
  if (bars === chord.lengthBars) return snapshot("resizeChord", "Resize chord (no-op)", doc, doc);
  if (chordsOverlap(doc.arrangement.chords ?? [], chordId, chord.startBar, bars)) {
    throw new Error("Chord would overlap another chord");
  }
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      chords: (doc.arrangement.chords ?? []).map((c) => (c.id === chordId ? { ...c, lengthBars: bars } : c)),
    },
  };
  return snapshot("resizeChord", `Resize chord to ${bars} bars`, doc, next);
}

export function removeChord(doc: ProjectDocument, chordId: string): Command {
  findChord(doc, chordId);
  const next: ProjectDocument = {
    ...doc,
    arrangement: { ...doc.arrangement, chords: (doc.arrangement.chords ?? []).filter((c) => c.id !== chordId) },
  };
  return snapshot("removeChord", "Remove chord", doc, next);
}

/** Re-root or re-quality an existing chord event in place (position/length untouched). */
export function setChord(
  doc: ProjectDocument,
  chordId: string,
  changes: { root?: number; quality?: ChordQuality },
): Command {
  const chord = findChord(doc, chordId);
  const root = changes.root !== undefined ? changes.root : chord.root;
  const quality = changes.quality !== undefined ? changes.quality : chord.quality;
  if (!Number.isFinite(root) || root < 0 || root > 11 || !Number.isInteger(root)) {
    throw new Error("Chord root must be a pitch class 0–11");
  }
  if (!CHORD_QUALITIES.includes(quality)) throw new Error(`Unknown chord quality: ${String(quality)}`);
  if (root === chord.root && quality === chord.quality) {
    return snapshot("setChord", "Edit chord (no-op)", doc, doc);
  }
  const next: ProjectDocument = {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      chords: (doc.arrangement.chords ?? []).map((c) => (c.id === chordId ? { ...c, root, quality } : c)),
    },
  };
  return snapshot("setChord", `Chord ${changes.root !== undefined ? "root" : "quality"} change`, doc, next);
}
