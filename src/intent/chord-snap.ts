import type { Command } from "../commands/types";
import type { ID, InstrumentTrack, NoteEvent, Pattern, ProjectDocument } from "../project-model/types";

/**
 * SNAP-TO-CHORD-TONES (de-dup wave follow-up; the model-free answer to
 * chord-tone agreement): a deterministic post-process that moves every
 * melody note to the nearest CHORD-TONE PITCH of the chord sounding under
 * it. No ML — a nearest-pitch lookup against the chords track.
 *
 * Rules:
 *   - the snap target is the set of chord-note PITCHES active at the
 *     melody note's start (candidates extend by ±5 octave copies so a
 *     melody far above the chord track still finds its tone);
 *   - the melody note keeps START/DURATION/VELOCITY/ID — only the pitch
 *     moves;
 *   - slide notes keep their pitch (a glide's target is expressive);
 *   - notes with no active chord (pickup bars) pass through untouched.
 *
 * Pure: same inputs → same outputs (AGENTS determinism invariant). The
 * command wrapper (snapMelodyToChordsCommand) provides the one-undo step.
 */

/** Active chord pitches at a given step, expanded across octaves so the
 * nearest-tone search covers the melody's register. */
function chordPitchCandidates(chordNotes: NoteEvent[], atStep: number): number[] {
  const base: number[] = [];
  for (const note of chordNotes) {
    if (note.start <= atStep && atStep < note.start + note.duration) {
      if (!base.includes(note.pitch)) base.push(note.pitch);
    }
  }
  if (base.length === 0) return [];
  const candidates: number[] = [];
  for (const pitch of base) {
    for (let octave = -5; octave <= 5; octave++) {
      const extended = pitch + octave * 12;
      if (extended >= 12 && extended <= 120) candidates.push(extended);
    }
  }
  return candidates.sort((a, b) => a - b);
}

function nearestCandidate(pitch: number, candidates: number[]): number {
  let best = candidates[0] as number;
  let bestDistance = Math.abs(pitch - best);
  for (const candidate of candidates) {
    const distance = Math.abs(pitch - candidate);
    // equidistant → prefer the HIGHER tone (leading feel)
    if (distance < bestDistance || (distance === bestDistance && candidate > best)) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

export interface ChordSnapResult {
  /** Snapped notes (new objects — the input array is untouched). */
  notes: NoteEvent[];
  /** How many notes actually moved pitch. */
  movedCount: number;
  /** Notes with no active chord under them (passed through untouched). */
  unharmonizedCount: number;
}

/** Pure snap of melody notes to the nearest chord-tone pitch of the chords
 * track. Deterministic; returns new note objects, never mutates. */
export function snapNotesToChords(melody: NoteEvent[], chordNotes: NoteEvent[]): ChordSnapResult {
  const notes: NoteEvent[] = [];
  let movedCount = 0;
  let unharmonizedCount = 0;
  for (const note of melody) {
    if (note.slide) {
      notes.push(note);
      continue;
    }
    const candidates = chordPitchCandidates(chordNotes, note.start);
    if (candidates.length === 0) {
      notes.push(note);
      unharmonizedCount += 1;
      continue;
    }
    const snapped = nearestCandidate(note.pitch, candidates);
    if (snapped !== note.pitch) movedCount += 1;
    notes.push({ ...note, pitch: snapped });
  }
  return { notes, movedCount, unharmonizedCount };
}

/** Resolve the CHORDS track of a document (the harmonic source for snaps). */
export function chordsTrackOf(doc: ProjectDocument): InstrumentTrack | null {
  for (const track of doc.tracks) {
    if (track.kind === "instrument" && /chord/i.test(track.name)) {
      return track as InstrumentTrack;
    }
  }
  return null;
}

/**
 * SNAP-TO-CHORD-TONES command — snap one instrument track's notes onto the
 * chords track's harmony. One undo step; track id and pattern id are
 * preserved so scenes and arrangement clips stay bound. Throws when the
 * track has no pattern with notes — the caller picks sensible tracks.
 */
export function snapMelodyToChordsCommand(doc: ProjectDocument, melodyTrackId: ID, chordTrackId: ID): Command {
  const pattern = doc.patterns.find((candidate) => candidate.notes[melodyTrackId] != null);
  if (!pattern) throw new Error(`No pattern with notes for track ${melodyTrackId}`);
  const melodyNotes = pattern.notes[melodyTrackId] ?? [];
  const chordNotes = pattern.notes[chordTrackId] ?? [];
  const result = snapNotesToChords(melodyNotes, chordNotes);

  const rewriteNotes = (current: ProjectDocument): ProjectDocument => {
    const livePattern = current.patterns.find((candidate) => candidate.id === pattern.id);
    if (!livePattern) return current;
    const nextPattern: Pattern = { ...livePattern, notes: { ...livePattern.notes, [melodyTrackId]: result.notes } };
    return {
      ...current,
      patterns: current.patterns.map((candidate) => (candidate.id === pattern.id ? nextPattern : candidate)),
    };
  };
  const restoreNotes = (current: ProjectDocument): ProjectDocument => {
    const livePattern = current.patterns.find((candidate) => candidate.id === pattern.id);
    if (!livePattern) return current;
    const nextPattern: Pattern = { ...livePattern, notes: { ...livePattern.notes, [melodyTrackId]: melodyNotes } };
    return {
      ...current,
      patterns: current.patterns.map((candidate) => (candidate.id === pattern.id ? nextPattern : candidate)),
    };
  };

  const label =
    result.movedCount > 0
      ? `Snap to chords — ${result.movedCount} note(s) snapped to chord tones`
      : "Snap to chords — already harmonized";
  const command: Command = {
    type: "snapMelodyToChords",
    label,
    execute: rewriteNotes,
    undo: restoreNotes,
  };
  return command;
}
