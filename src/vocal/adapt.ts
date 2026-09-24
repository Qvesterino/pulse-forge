import { setBpm, snapshot } from "../commands/commands";
import type { Command } from "../commands/types";
import { parseKey } from "../project-model/scales";
import type { MusicalKey, ProjectDocument } from "../project-model/types";
import type { VocalProfile } from "./types";

/**
 * VOCAL ADAPTATION COMMANDS (V1) — apply a VocalProfile to the project.
 *
 * Two one-undo-step commands: key (set + optional transpose of all melodic
 * notes) and tempo (delegates to the canonical setBpm). Both refuse honest
 * no-ops: unmeasured fields throw a human-readable error instead of
 * guessing. Drum rows are unpitched and never transposed.
 */

/** Shortest-path semitone delta between two roots (-6..+5). */
export function keyTransposeDelta(fromRoot: number, toRoot: number): number {
  return ((((toRoot - fromRoot + 6) % 12) + 12) % 12) - 6;
}

function shiftNotes(doc: ProjectDocument, semitones: number): ProjectDocument {
  if (semitones === 0) return doc;
  return {
    ...doc,
    patterns: doc.patterns.map((pattern) => {
      const notes = { ...pattern.notes };
      let changed = false;
      for (const track of doc.tracks) {
        if (track.kind !== "instrument") continue;
        const list = notes[track.id];
        if (!list || list.length === 0) continue;
        notes[track.id] = list.map((note) => ({
          ...note,
          pitch: Math.max(0, Math.min(127, note.pitch + semitones)),
        }));
        changed = true;
      }
      return changed ? { ...pattern, notes } : pattern;
    }),
  };
}

/**
 * Set the project key from the profile, transposing melodic notes when the
 * project already has a key (shortest path). `transpose: false` sets the key
 * without moving notes (regenerate-in-key flow).
 */
export function applyVocalKeyCommand(
  doc: ProjectDocument,
  profile: VocalProfile,
  options: { transpose?: boolean } = {},
): ReturnType<typeof snapshot> {
  if (!profile.keyMeasured || !profile.key) {
    throw new Error("The take carries no measurable key — sing a longer, clearer phrase first");
  }
  const target = parseKey(profile.key);
  if (!target) throw new Error("The detected key is not a project key");
  const transpose = options.transpose !== false;

  let semitones = 0;
  const current = doc.key ? parseKey(doc.key) : null;
  if (transpose && current) semitones = keyTransposeDelta(current.root, target.root);

  const shifted = shiftNotes(doc, semitones);
  const next: ProjectDocument = { ...shifted, key: profile.key as MusicalKey };
  const move = semitones === 0 ? "key set" : `transposed ${semitones > 0 ? "+" : ""}${semitones}`;
  return snapshot(
    "applyVocalKey",
    `Vocal key: ${profile.key} (${move}, ${profile.profileHash.slice(0, 8)})`,
    doc,
    next,
  );
}

/**
 * Match the transport tempo to the vocal flow (canonical setBpm, 1 undo).
 * `useAlt` applies the octave-sibling reading (half/double-time feel) —
 * the card shows it, TEMPO takes the measured value by default.
 */
export function applyVocalTempoCommand(
  doc: ProjectDocument,
  profile: VocalProfile,
  options: { useAlt?: boolean } = {},
): Command {
  if (!profile.tempoMeasured || !profile.tempoBpm) {
    throw new Error("The take carries no measurable tempo — sing over a steadier pulse first");
  }
  if (options.useAlt) {
    if (!profile.tempoAltBpm) {
      throw new Error("This take has no alternative tempo reading — flow and beat coincide here");
    }
    return setBpm(doc, profile.tempoAltBpm);
  }
  return setBpm(doc, profile.tempoBpm);
}
