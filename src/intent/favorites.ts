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
 * localStorage degrades to a no-op ledger, never an exception. The pure half
 * (types, validation, dedupe/cap policy, training transforms) lives in
 * `favorites-core.ts` so trainers and future non-browser hosts consume it
 * without a storage import; this module re-exports it for compatibility.
 */

import { dedupeAndCapLedger, isValidLedgerEntry, type FavoriteLedgerEntry, type FavoritesPack } from "./favorites-core";

export const FAVORITES_LEDGER_KEY = "pf:intent-favorites";

export {
  dedupeAndCapLedger,
  favoritesToDrumSamples,
  favoritesToMelodicSamples,
  isValidLedgerEntry,
  LEDGER_CAP,
  MELODIC_NOTES_CAP,
  roleForTrack,
} from "./favorites-core";
export type {
  FavoriteLedgerEntry,
  FavoriteTrainingSample,
  FavoritesPack,
  MelodicLedgerPart,
  MelodicTrainingSample,
} from "./favorites-core";

function safeRead(): FavoriteLedgerEntry[] {
  try {
    const raw = localStorage.getItem(FAVORITES_LEDGER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidLedgerEntry);
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
  safeWrite(dedupeAndCapLedger(safeRead(), entry));
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
