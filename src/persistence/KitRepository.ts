import { openDb, STORE_USER_KITS, tx } from "./db";
import type { KitPreset } from "../project-model/kit-presets";
import type { DrumSynthConfig } from "../project-model/types";

export interface UserKit extends Omit<KitPreset, "genre" | "description"> {
  genre: string;
  description: string;
  createdAt: string;
}

/** Malformed kits are dropped, not booby-trapped: RackStrip dereferences
 *  `kit.pads.length` and applyKitToDrumTrack maps over `pads` inside a
 *  command — a corrupted record must never reach either (rehydration-boundary
 *  sanitize, same contract as the Morph/Ultina preset stores). */
function sanitizePad(pad: unknown): KitPreset["pads"][number] | null {
  if (typeof pad !== "object" || pad === null) return null;
  const p = pad as Record<string, unknown>;
  if (typeof p.idx !== "number" || !Number.isInteger(p.idx) || p.idx < 0 || p.idx > 15) return null;
  if (p.assetId !== null && typeof p.assetId !== "string") return null;
  if (p.synth !== undefined && p.synth !== null && typeof p.synth !== "object") return null;
  for (const field of ["gain", "pan", "pitch"] as const) {
    if (p[field] !== undefined && (typeof p[field] !== "number" || !Number.isFinite(p[field]))) return null;
  }
  if (p.chokeGroup !== undefined && p.chokeGroup !== null && typeof p.chokeGroup !== "number") return null;
  // Values were validated above; the explicit reads re-narrow past the
  // indexed access the loop validates with.
  const gain = p.gain as number | undefined;
  const pan = p.pan as number | undefined;
  const pitch = p.pitch as number | undefined;
  const chokeGroup = p.chokeGroup as number | null | undefined;
  return {
    idx: p.idx,
    assetId: p.assetId,
    synth: (p.synth ?? null) as DrumSynthConfig | null,
    ...(gain !== undefined ? { gain } : {}),
    ...(pan !== undefined ? { pan } : {}),
    ...(chokeGroup !== undefined ? { chokeGroup } : {}),
    ...(pitch !== undefined ? { pitch } : {}),
  };
}

function sanitizeKit(kit: unknown): UserKit | null {
  if (typeof kit !== "object" || kit === null) return null;
  const k = kit as Record<string, unknown>;
  if (typeof k.id !== "string" || k.id === "") return null;
  if (typeof k.name !== "string" || k.name.trim() === "") return null;
  if (typeof k.genre !== "string" || typeof k.description !== "string") return null;
  if (!Array.isArray(k.pads) || k.pads.length === 0 || k.pads.length > 16) return null;
  const pads: KitPreset["pads"] = [];
  for (const pad of k.pads) {
    const sanitized = sanitizePad(pad);
    if (!sanitized) return null;
    pads.push(sanitized);
  }
  return {
    id: k.id,
    name: k.name,
    genre: k.genre,
    description: k.description,
    pads,
    createdAt: typeof k.createdAt === "string" ? k.createdAt : "",
  };
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
      this.cache = (all ?? [])
        .map(sanitizeKit)
        .filter((k): k is UserKit => k !== null)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return this.cache;
    } catch {
      // Transient failure: do not cache an empty list — the user's kits must
      // not appear deleted for the rest of the session.
      return [];
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
