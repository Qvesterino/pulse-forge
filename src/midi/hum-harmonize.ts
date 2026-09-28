import type { MusicalKey, NoteEvent, ProjectDocument } from "../project-model/types";
import { uid } from "../shared/ids";
import { snapshot } from "../commands/commands";
import { trackPitch } from "../audio-workers/pitch-tracker";
import { framesToNotes } from "./hum-to-notes";
import { planVocalHarmonyPair, type HarmonyNote } from "../vocal/harmony";

/**
 * HUM & HARMONIZE (vocal lane) — the singer hums, the producer delivers the
 * full stack in ONE undo step: the hummed lead line + its diatonic backing
 * vocals (third above and third below, key-snapped), installed as a
 * `harmonize` command. The analysis is pure and synchronous — YIN tracking
 * runs locally, no worker round-trip needed for the command path (the UI
 * may still prefer trackPitchAsync for long takes and then hand the
 * melody/backing notes straight to `humAndHarmonizeCommand`).
 */

export interface HumHarmonizeTarget {
  patternId: string;
  /** The singer's melody line lands here. */
  leadTrackId: string;
  /** The backing stack lands here — may equal leadTrackId (merged, deduped). */
  backingTrackId: string;
  mode?: "replace" | "merge";
}

export interface HumHarmonyNotes {
  melody: NoteEvent[];
  backing: NoteEvent[];
}

/** Backing voices sit under the lead — the singer owns the top line. Fixed
 * velocities because harmony stacks carry no velocity of their own. */
const BACKING_VELOCITY = { above: 0.72, below: 0.66 };

/**
 * PCM → melody notes + harmony backing, pure and deterministic:
 * YIN pitch track → key-snapped note segmentation → third-above/below stack.
 */
export function buildHumHarmonyNotes(
  pcm: Float32Array,
  sampleRate: number,
  options: { bpm: number; key: MusicalKey; patternLengthTicks: number; clarityGate?: number },
): HumHarmonyNotes {
  const frames = trackPitch(pcm, sampleRate);
  const melody = framesToNotes(frames, {
    bpm: options.bpm,
    key: options.key,
    patternLengthTicks: options.patternLengthTicks,
    ...(options.clarityGate !== undefined ? { clarityGate: options.clarityGate } : {}),
  });
  const pair = planVocalHarmonyPair(melody, options.key);
  const withIds = (notes: readonly HarmonyNote[], velocity: number) =>
    notes.map((note) => ({ ...note, velocity, id: uid("note") }) as NoteEvent);
  const backing = [...withIds(pair.above, BACKING_VELOCITY.above), ...withIds(pair.below, BACKING_VELOCITY.below)].sort(
    (a, b) => a.start - b.start || a.pitch - b.pitch,
  );
  return { melody, backing };
}

/** Merge-with-dedupe by pitch+start (the humToNotes contract). */
function mergeNotes(existing: readonly NoteEvent[], incoming: readonly NoteEvent[]): NoteEvent[] {
  return [
    ...existing,
    ...incoming.filter((note) => !existing.some((e) => e.pitch === note.pitch && e.start === note.start)),
  ].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

/**
 * Install the lead + backing stack as ONE undoable command. Backing notes
 * are marked in their name so the piano roll shows the backing voices
 * without hiding the singer's line.
 */
export function humAndHarmonizeCommand(
  doc: ProjectDocument,
  melody: readonly NoteEvent[],
  backing: readonly NoteEvent[],
  target: HumHarmonizeTarget,
): ReturnType<typeof snapshot> {
  if (melody.length === 0) throw new Error("No hummed notes to harmonize");
  const pattern = doc.patterns.find((p) => p.id === target.patternId);
  if (!pattern) throw new Error("The target pattern no longer exists");
  for (const trackId of new Set([target.leadTrackId, target.backingTrackId])) {
    if (!doc.tracks.some((t) => t.id === trackId)) throw new Error(`The target track ${trackId} no longer exists`);
  }

  const labeled = backing.map((note, index) => ({ ...note, name: `harm ${index + 1}` }));
  const sameTrack = target.leadTrackId === target.backingTrackId;
  const leadNotes = target.mode === "merge" ? mergeNotes(pattern.notes[target.leadTrackId] ?? [], melody) : [...melody];
  const backingNotes = sameTrack
    ? mergeNotes(leadNotes, labeled)
    : target.mode === "merge"
      ? mergeNotes(pattern.notes[target.backingTrackId] ?? [], labeled)
      : [...labeled];

  const next: ProjectDocument = {
    ...doc,
    patterns: doc.patterns.map((p) =>
      p.id === target.patternId
        ? {
            ...p,
            notes: {
              ...p.notes,
              [target.leadTrackId]: leadNotes,
              ...(sameTrack ? {} : { [target.backingTrackId]: backingNotes }),
            },
          }
        : p,
    ),
  };
  const stackNote = sameTrack ? "" : ` + ${backingNotes.length} backing`;
  return snapshot("humAndHarmonize", `Hum & harmonize: ${melody.length} lead${stackNote} (key stack)`, doc, next);
}
