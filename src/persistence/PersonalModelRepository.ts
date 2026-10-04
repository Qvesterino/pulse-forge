import { openDb, STORE_PERSONAL_MODELS, tx } from "./db";
import { personalWeightsFromJson, type PersonalWeightsPayload } from "../intent/personal-melodic-onnx";

/**
 * PERSONAL MODEL STORE — the ★-trained prior the user keeps
 * (docs/intent-killer-feature-plan.md W3 "Nauč sa ma").
 *
 * One record per installed personal model, keyed by the SHIPPED artifact it
 * was fine-tuned FROM (`baseModelHash`). That key is the whole contract: a
 * personal model is only valid for the exact prior it was derived from, so
 * shipping a new `symbolic-melodic-v2.onnx` must NOT silently keep serving a
 * model trained against the old weights. Lookups are by hash, so a stale
 * record is simply never found — and the honest status is "no personal model
 * for this artifact" rather than a wrong-sounding prior.
 *
 * Defensive like every other repository here: a stored payload is re-validated
 * (shape + finiteness) on EVERY read through `personalWeightsFromJson`, so a
 * corrupted or hand-edited record degrades to "no personal model" instead of
 * feeding garbage weights into inference. Nothing here ever throws into the
 * caller — a storage failure returns null and the runtime falls back to the
 * shipped ONNX.
 *
 * Local only, like the favorites ledger: the record never leaves the machine
 * unless the user explicitly exports it.
 */

export const PERSONAL_MODEL_SCHEMA_VERSION = 1;

/** Identity of the shipped artifact a personal model was trained from. */
export interface PersonalModelBase {
  /** `symbolic-melodic-v1` | `symbolic-melodic-v2` | … */
  kind: string;
  /** modelHash of the shipped manifest the fine-tune started from. */
  baseModelHash: string;
}

export interface PersonalModelRecord extends PersonalModelPayloadRecord {
  base: PersonalModelBase;
  /** How many ★-led entries fed this model (provenance for the UI). */
  favoritesUsed: number;
  /** Final training loss + the A/B proof recorded at install time. */
  report?: PersonalModelReport;
}

export interface PersonalModelPayloadRecord {
  payload: PersonalWeightsPayload;
  createdAt: string;
  schemaVersion: number;
}

export interface PersonalModelReport {
  /** Mean class-weighted loss after the last epoch. */
  finalLoss: number;
  epochs: number;
  steps: number;
  /**
   * A/B proof, the same shape `rerank:fit` reports: "the personal model picks
   * your ★ over the shipped one in X of Y cases". `null` until measured.
   */
  topOneWins: number;
  topOneCases: number;
}

function storageKey(base: PersonalModelBase): string {
  return `${base.kind}#${base.baseModelHash.toLowerCase()}`;
}

/** Validate a record read back from IndexedDB. Returns null when unusable. */
function sanitizeRecord(raw: unknown): PersonalModelRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<PersonalModelRecord>;
  if (record.schemaVersion !== PERSONAL_MODEL_SCHEMA_VERSION) return null;
  if (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) return null;
  if (!record.base || typeof record.base.kind !== "string" || typeof record.base.baseModelHash !== "string") {
    return null;
  }
  if (!record.base.baseModelHash.trim()) return null;
  if (typeof record.favoritesUsed !== "number" || !Number.isFinite(record.favoritesUsed)) return null;
  // The payload must survive the SAME validation the runtime uses, otherwise a
  // corrupt record would only fail later — inside inference.
  const payload = personalWeightsFromJson(record.payload);
  if (!payload) return null;
  const out: PersonalModelRecord = {
    payload,
    base: { kind: record.base.kind, baseModelHash: record.base.baseModelHash.toLowerCase() },
    favoritesUsed: Math.max(0, Math.round(record.favoritesUsed)),
    createdAt: record.createdAt,
    schemaVersion: PERSONAL_MODEL_SCHEMA_VERSION,
  };
  if (record.report) {
    const report = record.report;
    if (
      Number.isFinite(report.finalLoss) &&
      Number.isFinite(report.epochs) &&
      Number.isFinite(report.steps) &&
      Number.isFinite(report.topOneWins) &&
      Number.isFinite(report.topOneCases)
    ) {
      out.report = {
        finalLoss: report.finalLoss,
        epochs: Math.round(report.epochs),
        steps: Math.round(report.steps),
        topOneWins: Math.max(0, Math.round(report.topOneWins)),
        topOneCases: Math.max(0, Math.round(report.topOneCases)),
      };
    }
  }
  return out;
}

/** Install (or replace) the personal model for a shipped artifact. */
export async function putPersonalModel(record: PersonalModelRecord): Promise<boolean> {
  const sanitized = sanitizeRecord(record);
  if (!sanitized) return false;
  try {
    const db = await openDb();
    await tx(db, STORE_PERSONAL_MODELS, "readwrite", (store) => {
      store.put(sanitized, storageKey(sanitized.base));
    });
    return true;
  } catch {
    // Quota, private mode, blocked upgrade — the personal model simply is not
    // installed. The runtime keeps using the shipped prior.
    return false;
  }
}

/**
 * The personal model for a shipped artifact, or null when none is installed /
 * the stored one is unusable. Never throws.
 */
export async function getPersonalModel(base: PersonalModelBase): Promise<PersonalModelRecord | null> {
  try {
    const db = await openDb();
    const raw = await tx<unknown>(db, STORE_PERSONAL_MODELS, "readonly", (store) => store.get(storageKey(base)));
    return sanitizeRecord(raw);
  } catch {
    return null;
  }
}

/** Remove the personal model for a shipped artifact (the kill switch). */
export async function deletePersonalModel(base: PersonalModelBase): Promise<boolean> {
  try {
    const db = await openDb();
    await tx(db, STORE_PERSONAL_MODELS, "readwrite", (store) => {
      store.delete(storageKey(base));
    });
    return true;
  } catch {
    return false;
  }
}

/** Every installed personal model, newest first. Never throws. */
export async function listPersonalModels(): Promise<PersonalModelRecord[]> {
  try {
    const db = await openDb();
    const rows = await tx<unknown[]>(db, STORE_PERSONAL_MODELS, "readonly", (store) => store.getAll());
    return (rows ?? [])
      .map(sanitizeRecord)
      .filter((record): record is PersonalModelRecord => record !== null)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  } catch {
    return [];
  }
}

/**
 * Delete personal models whose base artifact no longer ships. Called on
 * startup so an updated prior does not leave orphaned weight blobs behind —
 * they are small, but they are also *wrong* for the new artifact, and their
 * mere presence in `listPersonalModels` would misreport the user's state.
 */
export async function pruneOrphanedPersonalModels(shipped: readonly PersonalModelBase[]): Promise<number> {
  const live = new Set(shipped.map(storageKey));
  const all = await listPersonalModels();
  let removed = 0;
  for (const record of all) {
    if (live.has(storageKey(record.base))) continue;
    if (await deletePersonalModel(record.base)) removed++;
  }
  return removed;
}
