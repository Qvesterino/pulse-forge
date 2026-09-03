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

export class GroovePoolRepository {
  private cache: GroovePoolEntry[] | null = null;

  async list(): Promise<GroovePoolEntry[]> {
    if (this.cache) return this.cache;
    try {
      const db = await openDb();
      const all = await tx<GroovePoolEntry[]>(db, STORE_GROOVE_POOL, "readonly", (s) => s.getAll());
      this.cache = (all ?? []).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return this.cache;
    } catch {
      this.cache = [];
      return this.cache;
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
