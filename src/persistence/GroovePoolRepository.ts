import { openDb, STORE_GROOVE_POOL, tx } from "./db";

/**
 * Groove pool — saved groove maps (timing + accent per 16th step) extractable
 * from any loop and applicable to any pattern. The bridge between "steal the
 * groove" and "play it anywhere".
 */
export interface GroovePoolEntry {
  id: string;
  name: string;
  timing: number[];
  accent: number[];
  createdAt: string;
}

/** Max steps a groove map may carry — well above any 16th-step pattern size. */
const GROOVE_STEPS_CAP = 128;

function numberArray(value: unknown, cap: number): number[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > cap) return null;
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) return null;
  }
  return value;
}

function sanitizeEntry(entry: unknown): GroovePoolEntry | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== "string" || e.id === "" || typeof e.name !== "string" || e.name.trim() === "") return null;
  // applyGroove indexes `map.timing.length` inside command execution — a
  // record missing the timing array would throw mid-undo-frame. Malformed
  // records are dropped here instead (rehydration-boundary sanitize, same
  // contract as the Morph/Ultina preset stores).
  const timing = numberArray(e.timing, GROOVE_STEPS_CAP);
  if (!timing) return null;
  const accent = e.accent === undefined ? [] : numberArray(e.accent, GROOVE_STEPS_CAP);
  if (accent === null) return null;
  return {
    id: e.id,
    name: e.name,
    timing,
    accent,
    createdAt: typeof e.createdAt === "string" ? e.createdAt : "",
  };
}

export class GroovePoolRepository {
  private cache: GroovePoolEntry[] | null = null;

  async list(): Promise<GroovePoolEntry[]> {
    if (this.cache) return this.cache;
    try {
      const db = await openDb();
      const all = await tx<GroovePoolEntry[]>(db, STORE_GROOVE_POOL, "readonly", (s) => s.getAll());
      this.cache = (all ?? [])
        .map(sanitizeEntry)
        .filter((e): e is GroovePoolEntry => e !== null)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return this.cache;
    } catch {
      // Transient failure: do not cache an empty list — the user's grooves
      // must not appear deleted for the rest of the session.
      return [];
    }
  }

  async save(entry: GroovePoolEntry): Promise<void> {
    this.cache = null;
    const db = await openDb();
    await tx(db, STORE_GROOVE_POOL, "readwrite", (s) => s.put(entry));
    this.cache = null;
  }

  async remove(id: string): Promise<void> {
    this.cache = null;
    const db = await openDb();
    await tx(db, STORE_GROOVE_POOL, "readwrite", (s) => s.delete(id));
    this.cache = null;
  }
}
