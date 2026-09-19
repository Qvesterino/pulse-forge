/**
 * Favorites ledger — the LOCAL feedback loop for the symbolic priors
 * (INTENT_ENGINE.md T2 v2 "učenie z favoritov").
 *
 * When the user ★-favourites a dice roll, the roll's intent + drum content is
 * recorded here (localStorage, capped FIFO). Nothing leaves the machine; the
 * EXPORT action in the dice tray downloads the pack as a file, and
 * `npm run prior:favorites -- <pack.json>` converts it into weighted
 * training samples that `train-symbolic-prior.py --favorites` folds into the
 * next drum-prior retraining. Favorites therefore teach the PRIOR to drift
 * toward what the user actually kept.
 *
 * Storage is best-effort: every access is guarded — a blocked/missing
 * localStorage degrades to a no-op ledger, never an exception.
 */

import type { PadRole } from "../ai/pad-roles";
import {
  buildPriorFeatureRow,
  padRoleForIndex,
  priorGenreOf,
  PRIOR_STYLE_VOCAB,
} from "../ai/symbolic/prior-features";

export const FAVORITES_LEDGER_KEY = "pf:intent-favorites";
const LEDGER_CAP = 200;

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
}

export interface FavoritesPack {
  version: 1;
  exportedAt: number;
  entries: FavoriteLedgerEntry[];
}

function safeRead(): FavoriteLedgerEntry[] {
  try {
    const raw = localStorage.getItem(FAVORITES_LEDGER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is FavoriteLedgerEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as FavoriteLedgerEntry).seed === "string" &&
        typeof (entry as FavoriteLedgerEntry).grooveId === "string" &&
        Array.isArray((entry as FavoriteLedgerEntry).padIds),
    );
  } catch {
    return [];
  }
}

function safeWrite(entries: FavoriteLedgerEntry[]): void {
  try {
    localStorage.setItem(FAVORITES_LEDGER_KEY, JSON.stringify(entries));
  } catch {
    /* quota/blocked — the ledger is best-effort */
  }
}

/** Record one favourited roll. Dedupes on seed+grooveId; capped FIFO. */
export function recordFavoriteLedgerEntry(entry: FavoriteLedgerEntry): void {
  const entries = safeRead().filter(
    (existing) => !(existing.seed === entry.seed && existing.grooveId === entry.grooveId),
  );
  entries.push(entry);
  safeWrite(entries.length > LEDGER_CAP ? entries.slice(entries.length - LEDGER_CAP) : entries);
}

export function readFavoriteLedger(): FavoriteLedgerEntry[] {
  return safeRead();
}

export function clearFavoriteLedger(): void {
  try {
    localStorage.removeItem(FAVORITES_LEDGER_KEY);
  } catch {
    /* no-op */
  }
}

export function buildFavoritesPack(): FavoritesPack {
  return { version: 1, exportedAt: Date.now(), entries: safeRead() };
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
