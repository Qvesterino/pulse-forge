import type { Command } from "./types";
import type { ChordEvent, ProjectDocument } from "../project-model/types";
import type { ChordQuality } from "../project-model/chords";
import { CHORD_QUALITIES } from "../project-model/chords";
import { uid } from "../shared/ids";
import { snapshot } from "./core";
import { expandProgression, PROGRESSIONS_BY_GENRE, selectProgression } from "../ai/harmony";

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

/**
 * GENERATE a chord progression onto the chord track (v2): the AI harmony
 * library's genre progressions (learned tables, 21 genres) laid out over the
 * requested span — deterministic via `progressionIndex`, replacing every
 * chord inside the span and leaving chords outside untouched. One command,
 * one undo entry.
 *
 * Layout: each progression event covers `duration` steps (16 steps = 1 bar),
 * scaled proportionally so the whole progression fills `lengthBars` exactly,
 * cycled if the progression is shorter than the span and trimmed if longer.
 * Whole-bar rounding: events get at least one bar, and rounding drift is
 * absorbed by the last event so the span never gaps or overflows.
 *
 * Degree→pitch: the event's scale degree resolves through the mode's scale
 * (major [0,2,4,5,7,9,11] / natural minor [0,2,3,5,7,8,10]) from `tonic` —
 * the event's own quality carries the color (a "maj" on minor degree 6 is a
 * harmonic-minor-style VI, exactly as the progression library intends).
 */
export interface GenerateChordProgressionOptions {
  genre?: string;
  tonic: number;
  mode?: "major" | "minor";
  progressionIndex?: number;
}

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const NATURAL_MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

export function generateChordProgression(
  doc: ProjectDocument,
  startBar: number,
  lengthBars: number,
  options: GenerateChordProgressionOptions,
): Command {
  const start = normalizeBars(startBar, "Start");
  const span = normalizeBars(lengthBars, "Length");
  if (span < 1) throw new Error("Generated progression must span at least one whole bar");
  if (!Number.isFinite(options.tonic) || options.tonic < 0 || options.tonic > 11 || !Number.isInteger(options.tonic)) {
    throw new Error("Tonic must be a pitch class 0–11");
  }
  const genre = options.genre ?? "house";
  const table = PROGRESSIONS_BY_GENRE[genre];
  if (!table || table.length === 0) throw new Error(`Unknown progression genre: ${genre}`);
  const progression = selectProgression(genre, options.progressionIndex ?? 0);
  const scale = options.mode === "major" ? MAJOR_SCALE : NATURAL_MINOR_SCALE;

  const expanded = expandProgression(progression, span * 16); // 16 steps per bar
  const weights = expanded.map((event) => event.duration);
  const totalSteps = weights.reduce((sum, w) => sum + w, 0);
  if (totalSteps <= 0) throw new Error("Progression has no content");

  // STRETCH-TO-FILL layout (largest-remainder): each event's exact share of
  // the span is proportional to its duration; whole-bar rounding distributes
  // the remainder to the events with the largest fractional part. More
  // events than bars (a dense 1-bar loop over an 8-bar span) collapses to
  // one bar per event in progression order — the loop's musical order
  // survives, only the count is capped.
  let bars: number[];
  if (expanded.length >= span) {
    bars = expanded.slice(0, span).map(() => 1);
  } else {
    const exact = weights.map((w) => (w * span) / totalSteps);
    bars = exact.map((b) => Math.max(1, Math.floor(b + 1e-9)));
    let leftover = span - bars.reduce((sum, b) => sum + b, 0);
    const order = exact
      .map((share, i) => ({ i, frac: share - Math.floor(share) }))
      .sort((a, b) => b.frac - a.frac);
    let k = 0;
    while (leftover > 0) {
      bars[order[k % order.length]!.i]! += 1;
      leftover -= 1;
      k += 1;
    }
  }

  const degreeRoot = (degree: number): number => {
    const pc = options.tonic + scale[((degree % 7) + 7) % 7] + 12 * Math.floor(degree / 7);
    return ((pc % 12) + 12) % 12;
  };

  const generated: ChordEvent[] = [];
  let cursor = start;
  let index = 0;
  let remaining = span;
  while (remaining > 0 && index < bars.length) {
    const event = expanded[index]!;
    const barsForEvent = Math.min(bars[index]!, remaining);
    generated.push({
      id: uid("chord"),
      startBar: cursor,
      lengthBars: barsForEvent,
      root: degreeRoot(event.degree),
      quality: event.quality,
    });
    cursor += barsForEvent;
    remaining -= barsForEvent;
    index += 1;
  }

  // Replace-in-range: chords inside the generated span are replaced (their
  // content is what the user asked to regenerate); chords outside survive.
  const rangeEnd = start + span;
  const kept = (doc.arrangement.chords ?? []).filter(
    (c) => c.startBar + c.lengthBars <= start || c.startBar >= rangeEnd,
  );
  const next: ProjectDocument = {
    ...doc,
    arrangement: { ...doc.arrangement, chords: [...kept, ...generated].sort((a, b) => a.startBar - b.startBar) },
  };
  return snapshot(
    "generateChordProgression",
    `Generate "${progression.name}" (${generated.length} chords)`,
    doc,
    next,
  );
}

