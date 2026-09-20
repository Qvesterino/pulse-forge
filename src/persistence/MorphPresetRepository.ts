import { openDb, STORE_MORPH_PRESETS, tx } from "./db";
import { tryGetParamDef, clampParam } from "../effects/morph-dynamics-core/contracts/parameterSchema";

/**
 * User presets for MORPH DYNAMICS — named snapshots of the FULL parameter
 * map (macros, engine sections, mod matrix), stored locally per browser
 * install. Factory presets ship with the core; this store is the user's
 * own layer on top.
 *
 * Loading is DEFENSIVE by design (mirrors UltinaPresetRepository): stored
 * or imported params are re-validated against the schema on every read —
 * unknown ids from older plugin versions are dropped, out-of-range values
 * clamped, non-numbers rejected. A corrupted entry degrades to its valid
 * subset, never to garbage DSP state.
 */

export const MORPH_PRESET_SCHEMA_VERSION = 1;

export interface MorphPresetEntry {
  id: string;
  name: string;
  params: Record<string, number>;
  createdAt: string;
  schemaVersion: number;
}

/** Validate an arbitrary params map against the schema. */
export function sanitizeMorphPresetParams(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const def = tryGetParamDef(id);
    if (!def) continue; // unknown id from an older schema
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    out[id] = clampParam(id, value);
  }
  return out;
}

function sanitizeEntry(entry: MorphPresetEntry): MorphPresetEntry | null {
  if (!entry || typeof entry.id !== "string" || typeof entry.name !== "string") return null;
  if (entry.name.trim() === "") return null;
  return {
    id: entry.id,
    name: entry.name,
    params: sanitizeMorphPresetParams(entry.params),
    createdAt: typeof entry.createdAt === "string" ? entry.createdAt : "",
    schemaVersion: MORPH_PRESET_SCHEMA_VERSION,
  };
}

export class MorphPresetRepository {
  private cache: MorphPresetEntry[] | null = null;

  async list(): Promise<MorphPresetEntry[]> {
    if (this.cache) return this.cache;
    try {
      const db = await openDb();
      const all = await tx<MorphPresetEntry[]>(db, STORE_MORPH_PRESETS, "readonly", (s) => s.getAll());
      this.cache = (all ?? [])
        .map(sanitizeEntry)
        .filter((e): e is MorphPresetEntry => e !== null)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return this.cache;
    } catch {
      // Transient failure: do not cache an empty list — the user's presets
      // must not appear deleted for the rest of the session.
      return [];
    }
  }

  async save(entry: MorphPresetEntry): Promise<void> {
    this.cache = null;
    const db = await openDb();
    await tx(db, STORE_MORPH_PRESETS, "readwrite", (s) => s.put(entry));
    this.cache = null;
  }

  async remove(id: string): Promise<void> {
    this.cache = null;
    const db = await openDb();
    await tx(db, STORE_MORPH_PRESETS, "readwrite", (s) => s.delete(id));
    this.cache = null;
  }
}
