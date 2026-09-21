/**
 * Favorites CORE — the pure half of the favorites ledger, split from
 * favorites.ts (cross-platform campaign GOAL 02): ledger types, validation,
 * dedupe/cap policy and the training-sample transforms, with zero storage
 * imports. `npm run prior:favorites` and the offline trainers consume this
 * module in bare Node; the localStorage adapter lives in favorites.ts, which
 * re-exports this module's API for backward compatibility.
 */

import type { PadRole } from "../ai/pad-roles";
import { STEP_TICKS } from "../project-model/types";
import { parseKey, SCALE_INTERVALS } from "../project-model/scales";
import type { MusicalKey } from "../project-model/types";
import { degreeToPitch } from "../ai/melodic";
import { MELODIC_BY_GENRE } from "../ai/grooves/melodic-data";
import { buildMelodicFeatureRow, durationClass, melodicGenreOf } from "../ai/symbolic/melodic-features";
import { buildPriorFeatureRow, padRoleForIndex, priorGenreOf, PRIOR_STYLE_VOCAB } from "../ai/symbolic/prior-features";

export const LEDGER_CAP = 200;

export interface FavoriteLedgerEntry {
  savedAt: number;
  seed: string;
  /** Requested genre ("house" | "techno" | "trap" | "ambient"). */
  genre: string;
  /** Resolved groove id — the styleId for prior features (e.g. "house.deep"). */
  grooveId: string;
  energy: number;
  density: number;
  complexity: number;
  variation: number;
  /** Drum track pad ids in index order — rows are keyed by these. */
  padIds: string[];
  /** Drum track pad names in index order — roles derive from these. */
  padNames: string[];
  /** Drum rows by pad id (velocities, 0 = off). */
  rows: Record<string, number[]>;
  // ── v2 additive fields (all optional — v1 packs stay valid) ──────────────

  /** Pattern length in steps — needed for exact ranker-side reconstruction. */
  length?: number;
  /** Resolved style string (grooveId minus genre prefix). */
  style?: string | null;
  /** Effective generation controls (from pattern.generation — the real recipe). */
  ghostWeight?: number;
  microWeight?: number;
  velocityVariation?: number;
  temperature?: number;
  /** Project/intent key at record time — required to invert pitch → degree. */
  key?: string | null;
  /** Melodic content per instrument track (C1). Capped at record time. */
  melodic?: MelodicLedgerPart[];
}

/** One instrument track's melodic content in a favourited roll (C1). */
export interface MelodicLedgerPart {
  role: "bass" | "chord" | "lead";
  trackName: string;
  notes: Array<{ pitch: number; start: number; duration: number; velocity: number }>;
}

/** Max melodic notes stored per ledger entry (localStorage quota guard). */
export const MELODIC_NOTES_CAP = 128;

/**
 * Structural guard for untrusted ledger data (stored JSON, imported packs):
 * an entry must at least carry the fields the transforms index into.
 */
export function isValidLedgerEntry(entry: unknown): entry is FavoriteLedgerEntry {
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof (entry as FavoriteLedgerEntry).seed === "string" &&
    typeof (entry as FavoriteLedgerEntry).grooveId === "string" &&
    Array.isArray((entry as FavoriteLedgerEntry).padIds)
  );
}

/**
 * Ledger insert policy, pure: drop any existing entry with the same
 * seed+grooveId (a re-favourite REPLACES its earlier roll), append, and cap
 * to the newest `cap` entries (FIFO).
 */
export function dedupeAndCapLedger(
  entries: FavoriteLedgerEntry[],
  entry: FavoriteLedgerEntry,
  cap = LEDGER_CAP,
): FavoriteLedgerEntry[] {
  const next = entries.filter((existing) => !(existing.seed === entry.seed && existing.grooveId === entry.grooveId));
  next.push(entry);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * Role of an instrument track by name match, else positional — the SAME
 * heuristic the generator uses (bass=0, chord=1, lead=2), so reconstruction
 * matches what actually played.
 */
export function roleForTrack(trackName: string, index: number): "bass" | "chord" | "lead" | null {
  const name = trackName.toLowerCase();
  if (name.includes("bass")) return "bass";
  if (name.includes("chord")) return "chord";
  if (name.includes("lead")) return "lead";
  return index === 0 ? "bass" : index === 1 ? "chord" : index === 2 ? "lead" : null;
}

export interface FavoritesPack {
  version: 1;
  exportedAt: number;
  entries: FavoriteLedgerEntry[];
}

export interface FavoriteTrainingSample {
  x: number[];
  y: 0 | 1;
  weight: number;
  groove: string;
}

/**
 * Convert ledger entries into weighted drum-prior training samples. Entries
 * with grooveIds outside the prior vocabulary are skipped (the model cannot
 * address unknown styles); favourites are weighted ABOVE library samples so
 * retraining drifts toward the user's taste, not the other way around.
 */
export function favoritesToDrumSamples(entries: FavoriteLedgerEntry[], weight = 3): FavoriteTrainingSample[] {
  const samples: FavoriteTrainingSample[] = [];
  for (const entry of entries) {
    if (!(PRIOR_STYLE_VOCAB as readonly string[]).includes(entry.grooveId)) continue;
    if (entry.padIds.length !== entry.padNames.length) continue;
    const genre = priorGenreOf(entry.genre as Parameters<typeof priorGenreOf>[0]);
    for (const [padIndex, padId] of entry.padIds.entries()) {
      const row = entry.rows[padId];
      if (!Array.isArray(row)) continue;
      const role: PadRole = padRoleForIndex(padIndex, entry.padNames);
      for (const [step, velocity] of row.entries()) {
        samples.push({
          x: buildPriorFeatureRow({
            genre,
            styleId: entry.grooveId,
            role,
            step,
            stepCount: row.length,
          }),
          y: velocity > 0 ? 1 : 0,
          weight,
          groove: entry.grooveId,
        });
      }
    }
  }
  return samples;
}

export interface MelodicTrainingSample {
  x: number[];
  /** Degree head class: 0 = rest, 1..7 = degrees 0..6. */
  degree: number;
  /** Duration head class: index into MELODIC_DURATION_VALUES. */
  duration: number;
  weight: number;
  group: string;
}

/**
 * Convert ledger entries into weighted MELODIC next-note training samples
 * (C1). Pitches are inverted to scale degrees through the SAME math the
 * engine used to emit them (degreeToPitch with the recorded key + the role's
 * octave offset), so samples are exact — and every sampled degree is in-key
 * by construction, mirroring the model contract. Chord voicings collapse to
 * their lowest note (the root — expandChord re-adds voicings at generation).
 * Entries without a recorded key are skipped (pitch inversion is impossible).
 */
export function favoritesToMelodicSamples(entries: FavoriteLedgerEntry[], weight = 3): MelodicTrainingSample[] {
  const samples: MelodicTrainingSample[] = [];
  for (const entry of entries) {
    if (!entry.melodic || entry.melodic.length === 0) continue;
    // Without the recorded key, pitch → degree inversion would be garbage —
    // skip the entry entirely (its drum samples are unaffected).
    const parsedKey = entry.key ? parseKey(entry.key as MusicalKey) : null;
    if (!parsedKey) continue;
    const genre = melodicGenreOf(entry.genre as Parameters<typeof melodicGenreOf>[0]);
    const root = parsedKey.root;
    const intervals = SCALE_INTERVALS[parsedKey.scaleType];
    const octaveOffsetFor = (role: MelodicLedgerPart["role"]): number => {
      const pattern = MELODIC_BY_GENRE[genre]?.find((part) => part.role === role);
      return pattern ? pattern.octaveOffset : 0;
    };

    for (const [trackIndex, part] of entry.melodic.entries()) {
      if (!Array.isArray(part.notes) || part.notes.length === 0) continue;
      const role = part.role ?? roleForTrack(part.trackName, trackIndex);
      if (!role) continue;
      const octaveOffset = octaveOffsetFor(role);

      // Time events: chord voicings (shared start) collapse to the root —
      // the lowest pitch — because expandChord re-adds offsets on generation.
      const sorted = [...part.notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
      const events =
        role === "chord"
          ? (() => {
              const byStart = new Map<number, { pitch: number; start: number; duration: number }>();
              for (const note of sorted) {
                const existing = byStart.get(note.start);
                if (!existing) byStart.set(note.start, { ...note });
                else if (note.pitch < existing.pitch) byStart.set(note.start, { ...note });
              }
              return [...byStart.values()].sort((a, b) => a.start - b.start);
            })()
          : sorted;

      let prevDegree = -1;
      let prevDuration = 2;
      let prevPrevDegree = -1;
      for (const event of events) {
        const startStep = Math.max(0, Math.round(event.start / STEP_TICKS));
        const durationSteps = Math.max(1, Math.round(event.duration / STEP_TICKS));
        // Invert pitch → degree: nearest degreeToPitch match over 0..6.
        let degree = 0;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let candidate = 0; candidate <= 6; candidate++) {
          const candidatePitch = degreeToPitch(candidate, octaveOffset, root, intervals);
          const distance = Math.abs(candidatePitch - event.pitch);
          if (distance < bestDistance) {
            bestDistance = distance;
            degree = candidate;
          }
        }
        samples.push({
          x: buildMelodicFeatureRow({ genre, role, startStep, prevDegree, prevDuration, prevPrevDegree }),
          degree: degree + 1,
          duration: durationClass(durationSteps),
          weight,
          group: `fav:${entry.seed}:${role}`,
        });
        prevPrevDegree = prevDegree;
        prevDegree = degree;
        prevDuration = durationSteps;
      }
    }
  }
  return samples;
}
