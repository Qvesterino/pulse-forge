import { openDb, STORE_USER_KITS, tx } from "./db";
import type { KitPreset } from "../project-model/kit-presets";

export interface UserKit extends Omit<KitPreset, "genre" | "description"> {
  genre: string;
  description: string;
  createdAt: string;
}

/**
 * Persistence for user-saved drum kits (pad → sample/param mappings).
 * Kits are FIRST-CLASS objects: savable, listed, deletable and shareable via
 * a compact kit share-code — independent of any project document.
 */
export class KitRepository {
  private cache: UserKit[] | null = null;

  async list(): Promise<UserKit[]> {
    if (this.cache) return this.cache;
    try {
      const db = await openDb();
      const all = await tx<UserKit[]>(db, STORE_USER_KITS, "readonly", (s) => s.getAll());
      this.cache = (all ?? []).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return this.cache;
    } catch {
      this.cache = [];
      return this.cache;
    }
  }

  async save(kit: UserKit): Promise<void> {
    this.cache = null;
    const db = await openDb();
    await tx(db, STORE_USER_KITS, "readwrite", (s) => s.put(kit));
    this.cache = null;
  }

  async remove(id: string): Promise<void> {
    this.cache = null;
    const db = await openDb();
    await tx(db, STORE_USER_KITS, "readwrite", (s) => s.delete(id));
    this.cache = null;
  }
}
