import type { InstrumentPreset } from "../presets/types";
import { STORE_PRESETS, openDb, tx } from "./db";

/**
 * User presets live in IndexedDB. Factory presets are compiled into the app
 * (see src/presets/factory.ts) and are never written here.
 */
export class PresetRepository {
  async list(): Promise<InstrumentPreset[]> {
    const db = await openDb();
    const all = await tx<InstrumentPreset[]>(db, STORE_PRESETS, "readonly", (store) => store.getAll());
    return all
      .filter((p) => p && typeof p.id === "string" && typeof p.name === "string" && typeof p.instrument === "string")
      .map((p) => ({ ...p, mood: p.mood ?? [], user: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async save(preset: InstrumentPreset): Promise<void> {
    const db = await openDb();
    await tx(
      db,
      STORE_PRESETS,
      "readwrite",
      (store) => store.put({ ...preset, user: true }) as IDBRequest<IDBValidKey>,
    );
  }

  async delete(id: string): Promise<void> {
    const db = await openDb();
    await tx(db, STORE_PRESETS, "readwrite", (store) => store.delete(id) as unknown as IDBRequest<undefined>);
  }
}
