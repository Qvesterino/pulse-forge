import { setBpm, snapshot } from "../commands/commands";
import type { Command } from "../commands/types";
import { createInstrumentTrackModel } from "../project-model/schema";
import { uid } from "../shared/ids";
import { parseKey } from "../project-model/scales";
import type { MusicalKey } from "../project-model/types";
import { STEP_TICKS, type InstrumentTrack, type NoteEvent, type ProjectDocument } from "../project-model/types";
import type { VocalProfile } from "./types";

/**
 * VOCAL ADAPTATION COMMANDS (V1) — apply a VocalProfile to the project.
 *
 * Key/tempo (one undo step each; key optionally transposes melodic notes),
 * plus the Vlna 3 HERO: applyVocalHookCommand — the user's own take becomes
 * a pitched-up vocalchop "Hook" track whose notes follow the measured
 * phrases. Both refuse honest no-ops: unmeasured fields throw a
 * human-readable error instead of guessing. Drum rows are unpitched and
 * never transposed.
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

/* ---------------- Vlna 3: "urob hook z môjho hlasu" ---------------- */

/** Track params for the planted hook — the UKG-chop voicing (Vlna 2). */
const HOOK_PARAMS: Record<string, number> = {
  root: 60,
  vowel: 1,
  color: 0.85,
  shift: 1.25,
  sharp: 0.7,
  cons: 0.3,
  morph: 0.3,
  tone: 9000,
  reverse: 0,
  attack: 0.004,
  release: 0.12,
  gain: 0.85,
};

export interface VocalHookOptions {
  /** The staged take's bank id (resolveVocalTake → take.bufferId). */
  bufferId: string;
  /** The analyzed profile — phrases drive the hook notes. */
  profile: VocalProfile;
  /** Target pattern; defaults to the active pattern. */
  patternId?: string | null;
}

/**
 * HERO (Vlna 3): "urob hook z môjho hlasu" — the recorded take becomes a
 * pitched-up vocalchop track whose notes follow the measured phrases, added
 * to the ACTIVE pattern. ONE undo step; re-applying the same take REUSES
 * its track and replaces the notes (no duplicate Hook tracks). The vocalchop
 * runtime resolves `sampleId` from the bank at play time, so the hook goes
 * silent — never errors — if the take's buffer is not staged (same
 * degradation as any bank sample).
 */
export function applyVocalHookCommand(doc: ProjectDocument, options: VocalHookOptions): Command {
  if (typeof options.bufferId !== "string" || options.bufferId === "") {
    throw new Error("The take audio is not staged — analyze the take first, then make the hook");
  }
  const profile = options.profile;
  const patternId = options.patternId ?? doc.activePatternId;
  const pattern = doc.patterns.find((p) => p.id === patternId);
  if (!pattern) throw new Error("No active pattern to plant the hook into");

  // Phrase grid → pattern timeline, proportional: the take's phrasing
  // rhythm is preserved across any pattern length.
  const phrases = (profile.phrases ?? []).filter(
    (p) => Number.isFinite(p.startBar) && Number.isFinite(p.endBar) && p.endBar >= p.startBar,
  );
  const takeBars = Math.max(1, ...phrases.map((p) => p.endBar + 1));
  const patternSteps = Math.max(1, Math.round(pattern.stepCount));
  const notes: NoteEvent[] = (
    phrases.length > 0
      ? phrases
      : [{ startBar: 0, endBar: Math.min(1, takeBars - 1), peakEnergy: 0.7, measured: true } as never]
  ).map((phrase) => {
    const from = Math.min(1, Math.max(0, phrase.startBar / takeBars));
    const to = Math.min(1, Math.max(from + 1 / takeBars, (phrase.endBar + 1) / takeBars));
    const start = Math.min(patternSteps - 1, Math.floor(from * patternSteps)) * STEP_TICKS;
    const endSteps = Math.max(1, Math.floor(to * patternSteps) - Math.floor(from * patternSteps));
    const duration = Math.max(STEP_TICKS, Math.min(patternSteps * STEP_TICKS - start, endSteps * STEP_TICKS));
    const velocity = Math.round((0.6 + 0.4 * Math.max(0, Math.min(1, phrase.peakEnergy))) * 100) / 100;
    return { id: uid("note"), pitch: 62, start, duration, velocity };
  });

  // Reuse the hook track for the same take on re-apply; otherwise create one.
  const existing = doc.tracks.find(
    (t): t is InstrumentTrack =>
      t.kind === "instrument" && t.instrument === "vocalchop" && t.sampleId === options.bufferId,
  );
  let track: InstrumentTrack;
  let tracks: ProjectDocument["tracks"];
  if (existing) {
    track = existing;
    tracks = doc.tracks;
  } else {
    const count = doc.tracks.filter((t) => t.kind === "instrument" && t.instrument === "vocalchop").length + 1;
    track = {
      ...createInstrumentTrackModel("vocalchop", count),
      name: "Hook — voice",
      sampleId: options.bufferId,
      params: { ...HOOK_PARAMS },
    };
    tracks = [...doc.tracks, track];
  }

  const next: ProjectDocument = {
    ...doc,
    tracks,
    patterns: doc.patterns.map((p) => (p.id === pattern.id ? { ...p, notes: { ...p.notes, [track.id]: notes } } : p)),
  };
  return snapshot("applyVocalHook", `Voice hook: ${notes.length} phrase${notes.length === 1 ? "" : "s"}`, doc, next);
}
