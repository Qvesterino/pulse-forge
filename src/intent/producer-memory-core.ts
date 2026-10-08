/**
 * Versioned, privacy-bounded event contract for local Producer DNA.
 *
 * Events keep structured intent corrections, explicit preference choices and
 * workflow outcomes. They do not store prompts, projects, filenames or audio.
 * Unknown fields are dropped by the sanitizer so imported data cannot smuggle
 * those values into the local event store.
 */
import { sanitizePreferenceObservation, type PreferenceObservationV1 } from "./preference-ledger-core";
import { isValidProducerLineagePack, type ProducerLineageNodeV1 } from "./producer-lineage-core";
import { inferPadRole } from "../ai/pad-roles";
import { GENRES } from "../ai/types";
import type { FavoriteLedgerEntry, MelodicLedgerPart } from "./favorites-core";
import { isValidStyleExample, type StyleExampleV1 } from "./style-example-ledger";

export const PRODUCER_MEMORY_SCHEMA_VERSION = 1 as const;
export const PRODUCER_MEMORY_EVENT_CAP = 512;
export const PRODUCER_MEMORY_EVENT_MAX_CHARS = 64_000;
export const PRODUCER_MEMORY_PACK_MAX_CHARS = 16_000_000;
export const PRODUCER_MEMORY_FAVORITE_CAP = 200;
export const PRODUCER_MEMORY_STYLE_EXAMPLE_CAP = 64;

export type ProducerMemoryIntentField =
  "genre" | "style" | "productionProfile" | "mood" | "energy" | "density" | "complexity" | "variation" | "bpm" | "role";

export type ProducerMemoryScalar = string | number | null;

interface ProducerMemoryEventBase {
  schemaVersion: typeof PRODUCER_MEMORY_SCHEMA_VERSION;
  id: string;
  createdAt: number;
  /** Random local interaction id; never derived from a project or prompt. */
  sessionId: string | null;
  /** Opaque local node/root id used only to keep evaluation lineages apart. */
  lineageId: string | null;
}

export interface IntentCorrectionEvent extends ProducerMemoryEventBase {
  type: "intent-correction";
  field: ProducerMemoryIntentField;
  predictedValue: ProducerMemoryScalar;
  confirmedValue: Exclude<ProducerMemoryScalar, null>;
  contextKey: string;
  parserVersion: string;
}

export interface PairwiseChoiceEvent extends ProducerMemoryEventBase {
  type: "pairwise-choice";
  observation: PreferenceObservationV1;
}

export interface SettledEditEvent extends ProducerMemoryEventBase {
  type: "settled-edit";
  beforeContentHash: string;
  afterContentHash: string;
  contextKey: string;
  /** Directional feature pair used by the existing ranker after the edit settled. */
  observation: PreferenceObservationV1;
}

export interface CandidateWorkflowEvent extends ProducerMemoryEventBase {
  type: "apply" | "undo" | "dismiss";
  candidateHash: string;
}

export interface ForgetEvent extends ProducerMemoryEventBase {
  type: "forget";
  forgottenEventIds: string[];
}

export type ProducerMemoryEvent =
  IntentCorrectionEvent | PairwiseChoiceEvent | SettledEditEvent | CandidateWorkflowEvent | ForgetEvent;

export interface ProducerMemoryPackV1 {
  schemaVersion: typeof PRODUCER_MEMORY_SCHEMA_VERSION;
  exportedAt: number;
  events: ProducerMemoryEvent[];
  /** Optional, versioned content snapshots for resumable branches. */
  lineage?: ProducerLineageNodeV1[];
  /** Explicitly exported user-kept patterns; ids and labels are anonymized. */
  favorites?: FavoriteLedgerEntry[];
  /** Compact examples used by the local style vector and profile. */
  styleExamples?: StyleExampleV1[];
}

const ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;
const HASH_RE = /^[a-zA-Z0-9._:-]{1,128}$/;
const CONTEXT_KEY_RE = /^[a-f0-9]{8}$/;
const PARSER_VERSION_RE = /^[a-zA-Z0-9._:+-]{1,80}$/;
const INTENT_FIELDS = new Set<ProducerMemoryIntentField>([
  "genre",
  "style",
  "productionProfile",
  "mood",
  "energy",
  "density",
  "complexity",
  "variation",
  "bpm",
  "role",
]);
const NORMALIZED_FIELDS = new Set<ProducerMemoryIntentField>(["genre", "style", "productionProfile", "mood", "role"]);
const NORMALIZED_VALUE_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

function isContentHash(value: unknown): value is string {
  return typeof value === "string" && HASH_RE.test(value);
}

function isContextKey(value: unknown): value is string {
  return typeof value === "string" && CONTEXT_KEY_RE.test(value);
}

function isScalarForField(field: ProducerMemoryIntentField, value: unknown): value is ProducerMemoryScalar {
  if (value === null) return true;
  if (NORMALIZED_FIELDS.has(field)) return typeof value === "string" && NORMALIZED_VALUE_RE.test(value);
  if (field === "bpm") return typeof value === "number" && Number.isInteger(value) && value >= 20 && value <= 400;
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  return value >= 0 && value <= 1;
}

function finiteRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function opaqueSeed(seed: string, savedAt: number, grooveId: string): string {
  let hash = 0x811c9dc5;
  const value = `${seed}|${savedAt}|${grooveId}`;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `memory-${hash.toString(16).padStart(8, "0")}`;
}

/** Canonicalize a favorite for an explicit Producer DNA export/import. */
export function sanitizeProducerMemoryFavorite(value: unknown): FavoriteLedgerEntry | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "savedAt",
      "seed",
      "genre",
      "grooveId",
      "energy",
      "density",
      "complexity",
      "variation",
      "padIds",
      "padNames",
      "rows",
      "length",
      "style",
      "ghostWeight",
      "microWeight",
      "velocityVariation",
      "temperature",
      "key",
      "melodic",
    ])
  )
    return null;
  const { savedAt, seed, genre, grooveId, energy, density, complexity, variation, padIds, padNames, rows } = value;
  if (
    !finiteRange(savedAt, 0, Number.MAX_SAFE_INTEGER) ||
    typeof seed !== "string" ||
    seed.length > 256 ||
    typeof genre !== "string" ||
    !(GENRES as readonly string[]).includes(genre) ||
    typeof grooveId !== "string" ||
    !/^[a-zA-Z0-9._:-]{1,128}$/.test(grooveId) ||
    !finiteRange(energy, 0, 1) ||
    !finiteRange(density, 0, 1) ||
    !finiteRange(complexity, 0, 1) ||
    !finiteRange(variation, 0, 1) ||
    !Array.isArray(padIds) ||
    padIds.length < 1 ||
    padIds.length > 128 ||
    !padIds.every((id) => typeof id === "string" && id.length <= 128) ||
    !Array.isArray(padNames) ||
    padNames.length !== padIds.length ||
    !padNames.every((name) => typeof name === "string" && name.length <= 256) ||
    !isRecord(rows)
  ) {
    return null;
  }
  const safePadIds = padIds.map((_, index) => `pad-${index}`);
  const safePadNames = padNames.map((name, index) => inferPadRole(name, index));
  const safeRows: Record<string, number[]> = {};
  for (const [index, id] of safePadIds.entries()) {
    const row = rows[padIds[index] as string];
    if (!Array.isArray(row) || row.length > 512 || !row.every((velocity) => finiteRange(velocity, 0, 127))) return null;
    safeRows[id] = [...row];
  }

  const result: FavoriteLedgerEntry = {
    savedAt,
    seed: opaqueSeed(seed, savedAt, grooveId),
    genre,
    grooveId,
    energy,
    density,
    complexity,
    variation,
    padIds: safePadIds,
    padNames: safePadNames,
    rows: safeRows,
  };
  const optionalNumber = (name: string, min: number, max: number): number | undefined =>
    finiteRange(value[name], min, max) ? (value[name] as number) : undefined;
  const length = optionalNumber("length", 1, 512);
  if (length !== undefined && Number.isInteger(length)) result.length = length;
  for (const name of ["ghostWeight", "microWeight", "velocityVariation", "temperature"] as const) {
    const field = optionalNumber(name, 0, 1);
    if (field !== undefined) result[name] = field;
  }
  if (typeof value.style === "string" && /^[a-zA-Z0-9._:-]{0,128}$/.test(value.style)) result.style = value.style;
  if (typeof value.key === "string" && /^[a-zA-Z0-9#._-]{1,32}$/.test(value.key)) result.key = value.key;
  else if (value.key === null) result.key = null;
  if (Array.isArray(value.melodic) && value.melodic.length <= 3) {
    const melodic: MelodicLedgerPart[] = [];
    for (const part of value.melodic) {
      if (!isRecord(part) || !["bass", "chord", "lead"].includes(String(part.role)) || !Array.isArray(part.notes))
        return null;
      if (part.notes.length > 128) return null;
      const notes: MelodicLedgerPart["notes"] = [];
      for (const note of part.notes) {
        if (
          !isRecord(note) ||
          !Number.isInteger(note.pitch) ||
          !finiteRange(note.pitch, 0, 127) ||
          !Number.isInteger(note.start) ||
          !finiteRange(note.start, 0, 65_535) ||
          !Number.isInteger(note.duration) ||
          !finiteRange(note.duration, 1, 65_535) ||
          !finiteRange(note.velocity, 0, 1)
        )
          return null;
        notes.push({ pitch: note.pitch, start: note.start, duration: note.duration, velocity: note.velocity });
      }
      melodic.push({ role: part.role as MelodicLedgerPart["role"], trackName: String(part.role), notes });
    }
    result.melodic = melodic;
  } else if (value.melodic !== undefined) {
    return null;
  }
  try {
    if (JSON.stringify(result).length > 256_000) return null;
  } catch {
    return null;
  }
  return result;
}

export function sanitizeProducerMemoryStyleExample(value: unknown): StyleExampleV1 | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "version",
      "contentHash",
      "savedAt",
      "genre",
      "grooveId",
      "energy",
      "density",
      "complexity",
      "variation",
    ])
  )
    return null;
  const candidate = {
    version: value.version,
    contentHash: value.contentHash,
    savedAt: value.savedAt,
    genre: value.genre,
    grooveId: value.grooveId,
    energy: value.energy,
    density: value.density,
    complexity: value.complexity,
    variation: value.variation,
  };
  return isValidStyleExample(candidate) ? candidate : null;
}

function sanitizeBase(value: Record<string, unknown>): ProducerMemoryEventBase | null {
  if (
    value.schemaVersion !== PRODUCER_MEMORY_SCHEMA_VERSION ||
    !isIdentifier(value.id) ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    value.createdAt < 0 ||
    (value.sessionId !== null && !isIdentifier(value.sessionId)) ||
    (value.lineageId !== null && !isIdentifier(value.lineageId))
  ) {
    return null;
  }
  return {
    schemaVersion: PRODUCER_MEMORY_SCHEMA_VERSION,
    id: value.id,
    createdAt: value.createdAt,
    sessionId: value.sessionId,
    lineageId: value.lineageId,
  };
}

/** Returns a canonical privacy-safe event, or null for invalid/unknown data. */
export function sanitizeProducerMemoryEvent(value: unknown): ProducerMemoryEvent | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  const base = sanitizeBase(value);
  if (!base) return null;

  switch (value.type) {
    case "intent-correction": {
      if (
        !hasOnlyKeys(value, [
          "schemaVersion",
          "id",
          "createdAt",
          "sessionId",
          "lineageId",
          "type",
          "field",
          "predictedValue",
          "confirmedValue",
          "contextKey",
          "parserVersion",
        ]) ||
        typeof value.field !== "string" ||
        !INTENT_FIELDS.has(value.field as ProducerMemoryIntentField) ||
        !isScalarForField(value.field as ProducerMemoryIntentField, value.predictedValue) ||
        value.confirmedValue === null ||
        !isScalarForField(value.field as ProducerMemoryIntentField, value.confirmedValue) ||
        !isContextKey(value.contextKey) ||
        typeof value.parserVersion !== "string" ||
        !PARSER_VERSION_RE.test(value.parserVersion)
      ) {
        return null;
      }
      return {
        ...base,
        type: "intent-correction",
        field: value.field as ProducerMemoryIntentField,
        predictedValue: value.predictedValue,
        confirmedValue: value.confirmedValue as Exclude<ProducerMemoryScalar, null>,
        contextKey: value.contextKey,
        parserVersion: value.parserVersion,
      };
    }
    case "pairwise-choice": {
      if (!hasOnlyKeys(value, ["schemaVersion", "id", "createdAt", "sessionId", "lineageId", "type", "observation"])) {
        return null;
      }
      const observation = sanitizePreferenceObservation(value.observation);
      return observation ? { ...base, type: "pairwise-choice", observation } : null;
    }
    case "settled-edit": {
      if (
        !hasOnlyKeys(value, [
          "schemaVersion",
          "id",
          "createdAt",
          "sessionId",
          "lineageId",
          "type",
          "beforeContentHash",
          "afterContentHash",
          "contextKey",
          "observation",
        ]) ||
        !isContentHash(value.beforeContentHash) ||
        !isContentHash(value.afterContentHash) ||
        value.beforeContentHash === value.afterContentHash ||
        !isContextKey(value.contextKey)
      ) {
        return null;
      }
      const observation = sanitizePreferenceObservation(value.observation);
      if (
        !observation ||
        observation.source !== "edit" ||
        (observation.choice !== "a" && observation.choice !== "b") ||
        ![observation.candidateA.contentHash, observation.candidateB.contentHash].includes(value.beforeContentHash) ||
        ![observation.candidateA.contentHash, observation.candidateB.contentHash].includes(value.afterContentHash)
      ) {
        return null;
      }
      return {
        ...base,
        type: "settled-edit",
        beforeContentHash: value.beforeContentHash,
        afterContentHash: value.afterContentHash,
        contextKey: value.contextKey,
        observation,
      };
    }
    case "apply":
    case "undo":
    case "dismiss": {
      if (
        !hasOnlyKeys(value, ["schemaVersion", "id", "createdAt", "sessionId", "lineageId", "type", "candidateHash"]) ||
        !isContentHash(value.candidateHash)
      ) {
        return null;
      }
      return { ...base, type: value.type, candidateHash: value.candidateHash };
    }
    case "forget": {
      if (
        !hasOnlyKeys(value, [
          "schemaVersion",
          "id",
          "createdAt",
          "sessionId",
          "lineageId",
          "type",
          "forgottenEventIds",
        ]) ||
        !Array.isArray(value.forgottenEventIds) ||
        value.forgottenEventIds.length < 1 ||
        value.forgottenEventIds.length > 128 ||
        !value.forgottenEventIds.every(isIdentifier)
      ) {
        return null;
      }
      return { ...base, type: "forget", forgottenEventIds: [...new Set(value.forgottenEventIds)] };
    }
    default:
      return null;
  }
}

export function isValidProducerMemoryEvent(value: unknown): value is ProducerMemoryEvent {
  return sanitizeProducerMemoryEvent(value) !== null;
}

export function isValidProducerMemoryPack(value: unknown): value is ProducerMemoryPackV1 {
  if (
    !isRecord(value) ||
    value.schemaVersion !== PRODUCER_MEMORY_SCHEMA_VERSION ||
    !hasOnlyKeys(value, ["schemaVersion", "exportedAt", "events", "lineage", "favorites", "styleExamples"])
  )
    return false;
  try {
    if (JSON.stringify(value).length > PRODUCER_MEMORY_PACK_MAX_CHARS) return false;
  } catch {
    return false;
  }
  if (typeof value.exportedAt !== "number" || !Number.isFinite(value.exportedAt) || value.exportedAt < 0) return false;
  if (!Array.isArray(value.events) || value.events.length > PRODUCER_MEMORY_EVENT_CAP) return false;
  if (!value.events.every((event) => sanitizeProducerMemoryEvent(event) !== null)) return false;
  if (
    value.favorites !== undefined &&
    (!Array.isArray(value.favorites) || value.favorites.length > PRODUCER_MEMORY_FAVORITE_CAP)
  )
    return false;
  if (value.favorites?.some((favorite) => sanitizeProducerMemoryFavorite(favorite) === null)) return false;
  if (
    value.styleExamples !== undefined &&
    (!Array.isArray(value.styleExamples) || value.styleExamples.length > PRODUCER_MEMORY_STYLE_EXAMPLE_CAP)
  )
    return false;
  if (value.styleExamples?.some((example) => sanitizeProducerMemoryStyleExample(example) === null)) return false;
  return (
    value.lineage === undefined ||
    isValidProducerLineagePack({
      schemaVersion: 1,
      exportedAt: value.exportedAt,
      nodes: value.lineage,
    })
  );
}

/** Create collision-resistant local event ids without tying them to user data. */
export function createProducerMemoryEventId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* use the non-cryptographic fallback; event ids are not security tokens */
  }
  return `pm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
