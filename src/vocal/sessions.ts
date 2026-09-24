/**
 * VOCAL SESSION LEDGER (V3) — local memory of heard takes.
 *
 * Nothing leaves the machine: profile hashes + applied actions + the
 * singer's ★/✗ on the producer notes. Future defaults can weight toward
 * kept sessions (same ledger pattern as pf:intent-favorites); for now the
 * ledger records and reads — weighting is the documented follow-up.
 */

export interface VocalSessionEntry {
  profileHash: string;
  key: string | null;
  tempoBpm: number | null;
  phrases: number;
  applied: string[];
  /** Singer feedback on the producer readout: 1 = kept, -1 = off, 0 = none. */
  rating: 1 | -1 | 0;
  savedAt: number;
}

export const VOCAL_SESSIONS_KEY = "pf:vocal-sessions";
const SESSION_CAP = 50;

function isEntry(value: unknown): value is VocalSessionEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.profileHash === "string" &&
    (typeof e.key === "string" || e.key === null) &&
    (typeof e.tempoBpm === "number" || e.tempoBpm === null) &&
    typeof e.phrases === "number" &&
    Array.isArray(e.applied) &&
    (e.rating === 1 || e.rating === -1 || e.rating === 0) &&
    typeof e.savedAt === "number"
  );
}

export function readVocalSessions(): VocalSessionEntry[] {
  try {
    const raw = localStorage.getItem(VOCAL_SESSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

function writeVocalSessions(entries: readonly VocalSessionEntry[]): void {
  try {
    localStorage.setItem(VOCAL_SESSIONS_KEY, JSON.stringify(entries.slice(-SESSION_CAP)));
  } catch {
    /* quota/blocked — memory stays session-local */
  }
}

/** Keep (dedupe by profile hash, newest wins). */
export function keepVocalSession(entry: Omit<VocalSessionEntry, "savedAt">): VocalSessionEntry[] {
  const full: VocalSessionEntry = { ...entry, savedAt: Date.now() };
  const rest = readVocalSessions().filter((e) => e.profileHash !== full.profileHash);
  const next = [...rest, full].slice(-SESSION_CAP);
  writeVocalSessions(next);
  return next;
}

/** Rate a kept session (no-op when unknown). */
export function rateVocalSession(profileHash: string, rating: 1 | -1 | 0): VocalSessionEntry[] {
  const next = readVocalSessions().map((e) => (e.profileHash === profileHash ? { ...e, rating } : e));
  writeVocalSessions(next);
  return next;
}
