/** Local-only adapter for explicit Producer DNA feedback and edit corrections. */
import { FEATURE_CONTRACT } from "../ai/features/pattern-features";
import {
  FEATURE_CONTRACT_V2,
  FEATURE_V2_COUNT,
  isSupportedFeatureVector,
  normalizeFeatureVector,
} from "../ai/features/pattern-features-v2";
import {
  cloneSongDramaturgyFeatureVector,
  type SongDramaturgyFeatureVectorV1,
  type SongPreferenceFocus,
} from "../ai/features/song-dramaturgy-v1";
import type { IntentSpec } from "./types";
import {
  appendProducerMemoryEvent,
  exportProducerMemory,
  forgetProducerMemoryEvents,
  importProducerMemory,
  listProducerMemoryEvents,
  tryListProducerMemoryEvents,
} from "../persistence/ProducerMemoryRepository";
import { exportProducerLineage, importProducerLineage } from "../persistence/ProducerLineageRepository";
import { mergeFavoriteLedgerEntries, readFavoriteLedger } from "./favorites";
import { mergeStyleExamples, readStyleExamples } from "./style-example-ledger";
import {
  createProducerMemoryEventId,
  PRODUCER_MEMORY_EVENT_CAP,
  PRODUCER_MEMORY_PACK_MAX_CHARS,
  PRODUCER_MEMORY_SCHEMA_VERSION,
  sanitizeProducerMemoryEvent,
  sanitizeProducerMemoryFavorite,
  sanitizeProducerMemoryStyleExample,
  PRODUCER_MEMORY_FAVORITE_CAP,
  PRODUCER_MEMORY_STYLE_EXAMPLE_CAP,
  type ProducerMemoryIntentField,
  type ProducerMemoryEvent,
  type ProducerMemoryPackV1,
  type ProducerMemoryScalar,
} from "./producer-memory-core";
import {
  dedupeAndCapPreferences,
  isPreferenceFeatureVersion,
  sanitizePreferenceObservation,
  isValidPreferenceObservation,
  cloneAudioPreferenceVector,
  PREFERENCE_LEDGER_CAP,
  PREFERENCE_LEDGER_VERSION,
  type PreferenceCandidateSnapshot,
  type PreferenceChoice,
  type PreferenceContext,
  type AudioPreferenceVector,
  type PreferenceFeatureVersion,
  type PreferenceLedgerPackV1,
  type PreferenceObservationV1,
  type PreferenceReason,
  type PreferenceTask,
} from "./preference-ledger-core";

export const PREFERENCE_LEDGER_KEY = "pf:producer-dna-preferences";
export const PREFERENCE_LEARNING_KEY = "pf:producer-dna-learning";
export const PREFERENCE_LEDGER_CHANGED_EVENT = "pf:producer-dna-preferences-changed";
export const PREFERENCE_LEDGER_CLEARED_EVENT = "pf:producer-dna-preferences-cleared";
const PREFERENCE_LEDGER_MAX_CHARS = 512_000;

export {
  dedupeAndCapPreferences,
  isPreferenceFeatureVersion,
  isValidPreferenceObservation,
  PREFERENCE_LEDGER_CAP,
  PREFERENCE_LEDGER_VERSION,
} from "./preference-ledger-core";
export type {
  PreferenceCandidateSnapshot,
  PreferenceChoice,
  PreferenceContext,
  AudioPreferenceVectorV1,
  AudioPreferenceVector,
  AudioPreferenceVectorV2,
  PreferenceFeatureVersion,
  PreferenceLedgerPackV1,
  PreferenceObservationV1,
  PreferenceReason,
  PreferenceTask,
} from "./preference-ledger-core";

function hashContext(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Build a privacy-safe context; intentionally excludes prompt, seed and project ids. */
export function preferenceContextForIntent(
  intent: Pick<IntentSpec, "genre" | "productionProfile" | "roles" | "preserve">,
  task: PreferenceTask = "pattern",
): PreferenceContext {
  const genre = String(intent.genre).trim().toLowerCase().slice(0, 40) || "unknown";
  const productionProfile = intent.productionProfile ? String(intent.productionProfile).slice(0, 80) : null;
  const preserved = new Set(intent.preserve ?? []);
  const roleScope = [...new Set(intent.roles.filter((role) => !preserved.has(role)))].sort();
  const canonical = JSON.stringify([genre, productionProfile, task, roleScope]);
  return { genre, productionProfile, task, roleScope, key: hashContext(canonical) };
}

export interface PreferenceCandidateInput {
  contentHash: string;
  features: ArrayLike<number>;
  audioFeatures?: AudioPreferenceVector;
  globalScore?: number;
  globalScoreVersion?: string;
  personalScore?: number;
  songDramaturgyFeatures?: SongDramaturgyFeatureVectorV1;
}

/**
 * Record the contract the vector was actually produced under (W4 dual-read).
 * A v2-width vector is stamped "features.v2"; a v1-width vector keeps the
 * legacy "features.v1" stamp, so old packs stay readable and the personal
 * ranker normalizes at training time instead of discarding the observation.
 */
function snapshot(candidate: PreferenceCandidateInput): PreferenceCandidateSnapshot {
  const featureVersion: PreferenceFeatureVersion =
    candidate.features.length === FEATURE_V2_COUNT ? FEATURE_CONTRACT_V2.version : FEATURE_CONTRACT.version;
  return {
    contentHash: candidate.contentHash,
    featureVersion,
    features: Array.from(candidate.features),
    ...(candidate.audioFeatures ? { audioFeatures: cloneAudioPreferenceVector(candidate.audioFeatures) } : {}),
    ...(candidate.globalScore !== undefined ? { globalScore: candidate.globalScore } : {}),
    ...(candidate.globalScoreVersion !== undefined ? { globalScoreVersion: candidate.globalScoreVersion } : {}),
    ...(candidate.personalScore !== undefined ? { personalScore: candidate.personalScore } : {}),
    ...(candidate.songDramaturgyFeatures
      ? { songDramaturgyFeatures: cloneSongDramaturgyFeatureVector(candidate.songDramaturgyFeatures) }
      : {}),
  };
}

/**
 * Create a canonical pair record. Canonical ordering makes the same pair
 * dedupe even when the UI swaps A and B on a later audition.
 */
export function createPreferenceObservation(
  context: PreferenceContext,
  candidateA: PreferenceCandidateInput,
  candidateB: PreferenceCandidateInput,
  choice: PreferenceChoice,
  options: {
    reason?: PreferenceReason;
    createdAt?: number;
    source?: "edit";
    study?: "producer-dna-blind-pilot";
    pilotAssignment?: { globalSide: "a" | "b"; displayedChoice: PreferenceChoice };
    songReason?: SongPreferenceFocus;
  } = {},
): PreferenceObservationV1 | null {
  if (candidateA.contentHash === candidateB.contentHash) return null;
  const shouldSwap = candidateA.contentHash.localeCompare(candidateB.contentHash) > 0;
  const normalizedChoice = shouldSwap ? (choice === "a" ? "b" : choice === "b" ? "a" : choice) : choice;
  const observation: PreferenceObservationV1 = {
    version: PREFERENCE_LEDGER_VERSION,
    context: { ...context, roleScope: [...context.roleScope] },
    candidateA: snapshot(shouldSwap ? candidateB : candidateA),
    candidateB: snapshot(shouldSwap ? candidateA : candidateB),
    choice: normalizedChoice,
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.source ? { source: options.source } : {}),
    ...(options.study ? { study: options.study } : {}),
    ...(options.pilotAssignment ? { pilotAssignment: { ...options.pilotAssignment } } : {}),
    ...(options.songReason ? { songReason: options.songReason } : {}),
    createdAt: options.createdAt ?? Date.now(),
  };
  return isValidPreferenceObservation(observation) ? observation : null;
}

function safeRead(): PreferenceObservationV1[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(PREFERENCE_LEDGER_KEY);
    if (!raw || raw.length > PREFERENCE_LEDGER_MAX_CHARS) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(sanitizePreferenceObservation)
      .filter((observation): observation is PreferenceObservationV1 => observation !== null)
      .slice(-PREFERENCE_LEDGER_CAP);
  } catch {
    return [];
  }
}

function safeWrite(observations: readonly PreferenceObservationV1[]): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.setItem(PREFERENCE_LEDGER_KEY, JSON.stringify(observations));
    return true;
  } catch {
    return false;
  }
}

function notifyChanged(): void {
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(PREFERENCE_LEDGER_CHANGED_EVENT));
  } catch {
    /* storage/UI notification is best-effort */
  }
}

/** Notify local views after an event-store operation has committed. */
export function notifyProducerMemoryChanged(): void {
  notifyChanged();
}

let durablePreferenceCache: PreferenceObservationV1[] = [];
let durablePreferenceCacheRevision = 0;

/** Refresh the synchronous ranker view from IndexedDB; storage errors keep the last usable cache. */
export async function refreshPreferenceEventCache(): Promise<void> {
  const revision = ++durablePreferenceCacheRevision;
  try {
    const events = await tryListProducerMemoryEvents();
    if (revision !== durablePreferenceCacheRevision) return;
    if (!events) return;
    durablePreferenceCache = events.flatMap((event) =>
      event.type === "pairwise-choice" || event.type === "settled-edit" ? [event.observation] : [],
    );
    notifyChanged();
  } catch {
    // Keep the last durable snapshot; the localStorage fallback remains available.
  }
}

function effectivePreferenceLedger(): PreferenceObservationV1[] {
  const merged = new Map<string, PreferenceObservationV1>();
  const rows = [...durablePreferenceCache, ...safeRead()].sort((a, b) => a.createdAt - b.createdAt);
  for (const observation of rows) {
    const pair = [observation.candidateA.contentHash, observation.candidateB.contentHash].sort().join("|");
    const key = [
      observation.context.key,
      pair,
      observation.source ?? "comparison",
      observation.study ?? "ordinary",
      observation.reason ?? "",
      observation.songReason ?? "",
    ].join(":");
    merged.set(key, observation);
  }
  return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-PRODUCER_MEMORY_EVENT_CAP);
}

/** Store an explicit comparison or a privacy-safe before/after correction. */
export function recordPreferenceObservation(
  observation: PreferenceObservationV1,
  context: ProducerMemoryEventContext = {},
): boolean {
  return recordPreferenceObservationWithContext(observation, context);
}

export interface ProducerMemoryEventContext {
  sessionId?: string | null;
  lineageId?: string | null;
}

function preferenceEventFingerprint(observation: PreferenceObservationV1): string {
  return [
    observation.context.key,
    observation.candidateA.contentHash,
    observation.candidateB.contentHash,
    observation.choice,
    observation.source ?? "comparison",
    observation.study ?? "ordinary",
    observation.reason ?? "",
    observation.songReason ?? "",
    observation.pilotAssignment?.globalSide ?? "",
    observation.pilotAssignment?.displayedChoice ?? "",
    observation.createdAt,
  ].join("|");
}

function stableLegacyEventId(observation: PreferenceObservationV1): string {
  const value = preferenceEventFingerprint(observation);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `legacy-${hash.toString(16).padStart(8, "0")}`;
}

function eventForObservation(
  observation: PreferenceObservationV1,
  context: ProducerMemoryEventContext,
  id = createProducerMemoryEventId(),
): ProducerMemoryEvent | null {
  const base = {
    schemaVersion: PRODUCER_MEMORY_SCHEMA_VERSION,
    id,
    createdAt: observation.createdAt,
    sessionId: context.sessionId ?? null,
    lineageId: context.lineageId ?? null,
  };
  if (observation.source === "edit" && (observation.choice === "a" || observation.choice === "b")) {
    const afterContentHash =
      observation.choice === "a" ? observation.candidateA.contentHash : observation.candidateB.contentHash;
    const beforeContentHash =
      observation.choice === "a" ? observation.candidateB.contentHash : observation.candidateA.contentHash;
    return sanitizeProducerMemoryEvent({
      ...base,
      type: "settled-edit",
      beforeContentHash,
      afterContentHash,
      contextKey: observation.context.key,
      observation,
    });
  }
  return sanitizeProducerMemoryEvent({ ...base, type: "pairwise-choice", observation });
}

/** Store the synchronous ranker snapshot and mirror the explicit signal durably. */
export function recordPreferenceObservationWithContext(
  observation: PreferenceObservationV1,
  context: ProducerMemoryEventContext = {},
): boolean {
  const canonical = sanitizePreferenceObservation(observation);
  if (!isPreferenceLearningEnabled() || !canonical) return false;
  const saved = safeWrite(dedupeAndCapPreferences(safeRead(), canonical));
  if (saved) {
    notifyChanged();
    const event = eventForObservation(canonical, context);
    if (event) {
      void appendProducerMemoryEvent(event).then((stored) => {
        if (stored) void refreshPreferenceEventCache();
      });
    }
  }
  return saved;
}

export interface IntentCorrectionInput {
  field: ProducerMemoryIntentField;
  predictedValue: ProducerMemoryScalar;
  confirmedValue: Exclude<ProducerMemoryScalar, null>;
  contextKey: string;
  parserVersion: string;
  sessionId?: string | null;
  lineageId?: string | null;
  createdAt?: number;
}

/** Queue a confirmed brief correction; the raw prompt is never accepted here. */
export async function recordIntentCorrection(input: IntentCorrectionInput): Promise<boolean> {
  if (!isPreferenceLearningEnabled()) return false;
  const event = sanitizeProducerMemoryEvent({
    schemaVersion: PRODUCER_MEMORY_SCHEMA_VERSION,
    id: createProducerMemoryEventId(),
    createdAt: input.createdAt ?? Date.now(),
    sessionId: input.sessionId ?? null,
    lineageId: input.lineageId ?? null,
    type: "intent-correction",
    field: input.field,
    predictedValue: input.predictedValue,
    confirmedValue: input.confirmedValue,
    contextKey: input.contextKey,
    parserVersion: input.parserVersion,
  });
  if (!event || event.type !== "intent-correction") return false;
  const stored = await appendProducerMemoryEvent(event);
  if (stored) notifyChanged();
  return stored;
}

export function recordProducerMemoryWorkflowEvent(
  type: "apply" | "undo" | "dismiss",
  candidateHash: string,
  context: ProducerMemoryEventContext = {},
): boolean {
  if (!isPreferenceLearningEnabled()) return false;
  const event = sanitizeProducerMemoryEvent({
    schemaVersion: PRODUCER_MEMORY_SCHEMA_VERSION,
    id: createProducerMemoryEventId(),
    createdAt: Date.now(),
    sessionId: context.sessionId ?? null,
    lineageId: context.lineageId ?? null,
    type,
    candidateHash,
  });
  if (!event || (event.type !== "apply" && event.type !== "undo" && event.type !== "dismiss")) return false;
  void appendProducerMemoryEvent(event).then((stored) => {
    if (stored) notifyChanged();
  });
  return true;
}

/** Remove one visible memory item from both durable history and the sync ranker ledger. */
export async function forgetProducerMemoryEvent(eventId: string): Promise<boolean> {
  const event = (await listProducerMemoryEvents()).find((item) => item.id === eventId);
  if (!event || event.type === "forget") return false;
  let removedObservation: PreferenceObservationV1 | null = null;
  if (event.type === "pairwise-choice" || event.type === "settled-edit") {
    const fingerprint = preferenceEventFingerprint(event.observation);
    const previous = safeRead();
    removedObservation =
      previous.find((observation) => preferenceEventFingerprint(observation) === fingerprint) ?? null;
    const remaining = previous.filter((observation) => preferenceEventFingerprint(observation) !== fingerprint);
    if (!safeWrite(remaining)) return false;
  }
  const forgotten = await forgetProducerMemoryEvents([event.id]);
  if (!forgotten && removedObservation) {
    safeWrite(
      [...safeRead(), removedObservation].sort((a, b) => a.createdAt - b.createdAt).slice(-PREFERENCE_LEDGER_CAP),
    );
  }
  if (forgotten) await refreshPreferenceEventCache();
  return forgotten;
}

/** Build one portable pack containing durable events and unmigrated ledger rows. */
export async function buildProducerMemoryPack(exportedAt = Date.now()): Promise<ProducerMemoryPackV1> {
  const durable = await exportProducerMemory(exportedAt);
  const lineage = await exportProducerLineage(exportedAt);
  const existing = new Set(
    durable.events.flatMap((event) =>
      event.type === "pairwise-choice" || event.type === "settled-edit"
        ? [preferenceEventFingerprint(event.observation)]
        : [],
    ),
  );
  const legacy = safeRead()
    .filter((observation) => !existing.has(preferenceEventFingerprint(observation)))
    .map((observation) => eventForObservation(observation, {}, stableLegacyEventId(observation)))
    .filter((event): event is ProducerMemoryEvent => event !== null);
  let events = [...durable.events, ...legacy]
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .slice(-PRODUCER_MEMORY_EVENT_CAP);
  let nodes = lineage.nodes;
  let favorites = readFavoriteLedger()
    .map(sanitizeProducerMemoryFavorite)
    .filter((favorite): favorite is NonNullable<typeof favorite> => favorite !== null)
    .slice(-PRODUCER_MEMORY_FAVORITE_CAP);
  let styleExamples = readStyleExamples()
    .map(sanitizeProducerMemoryStyleExample)
    .filter((example): example is NonNullable<typeof example> => example !== null)
    .slice(-PRODUCER_MEMORY_STYLE_EXAMPLE_CAP);
  const createPack = (): ProducerMemoryPackV1 => ({
    schemaVersion: PRODUCER_MEMORY_SCHEMA_VERSION,
    exportedAt: durable.exportedAt,
    events,
    ...(nodes.length > 0 ? { lineage: nodes } : {}),
    ...(favorites.length > 0 ? { favorites } : {}),
    ...(styleExamples.length > 0 ? { styleExamples } : {}),
  });
  let pack = createPack();
  while (JSON.stringify(pack).length > PRODUCER_MEMORY_PACK_MAX_CHARS && nodes.length > 0) {
    nodes = nodes.slice(1);
    pack = createPack();
  }
  while (JSON.stringify(pack).length > PRODUCER_MEMORY_PACK_MAX_CHARS && events.length > 0) {
    events = events.slice(1);
    pack = createPack();
  }
  while (JSON.stringify(pack).length > PRODUCER_MEMORY_PACK_MAX_CHARS && favorites.length > 0) {
    favorites = favorites.slice(1);
    pack = createPack();
  }
  while (JSON.stringify(pack).length > PRODUCER_MEMORY_PACK_MAX_CHARS && styleExamples.length > 0) {
    styleExamples = styleExamples.slice(1);
    pack = createPack();
  }
  return pack;
}

export interface ProducerMemoryImportResult {
  eventsImported: boolean;
  rankerLedgerImported: boolean;
  lineageImported: boolean;
  favoritesImported: boolean;
  styleExamplesImported: boolean;
}

/** Import event history and merge its preference evidence into the sync ranker ledger. */
export async function importProducerMemoryPack(value: unknown): Promise<ProducerMemoryImportResult> {
  let events: ProducerMemoryEvent[];
  let lineageImported = true;
  let favoritesImported = true;
  let styleExamplesImported = true;
  if (isValidLegacyPreferencePack(value)) {
    events = value.observations
      .map((observation) => eventForObservation(observation, {}, stableLegacyEventId(observation)))
      .filter((event): event is ProducerMemoryEvent => event !== null);
    const legacyPack: ProducerMemoryPackV1 = {
      schemaVersion: PRODUCER_MEMORY_SCHEMA_VERSION,
      exportedAt: value.exportedAt,
      events: events.slice(-PRODUCER_MEMORY_EVENT_CAP),
    };
    if (!(await importProducerMemory(legacyPack)))
      return {
        eventsImported: false,
        rankerLedgerImported: false,
        lineageImported: false,
        favoritesImported: false,
        styleExamplesImported: false,
      };
  } else {
    if (!(await importProducerMemory(value)))
      return {
        eventsImported: false,
        rankerLedgerImported: false,
        lineageImported: false,
        favoritesImported: false,
        styleExamplesImported: false,
      };
    const pack = value as ProducerMemoryPackV1;
    lineageImported = await importProducerLineage(pack.lineage ?? []);
    favoritesImported =
      !pack.favorites?.length ||
      mergeFavoriteLedgerEntries(
        pack.favorites
          .map(sanitizeProducerMemoryFavorite)
          .filter((favorite): favorite is NonNullable<typeof favorite> => favorite !== null),
      );
    styleExamplesImported =
      !pack.styleExamples?.length ||
      mergeStyleExamples(
        pack.styleExamples
          .map(sanitizeProducerMemoryStyleExample)
          .filter((example): example is NonNullable<typeof example> => example !== null),
      );
    events = pack.events
      .map(sanitizeProducerMemoryEvent)
      .filter((event): event is ProducerMemoryEvent => event !== null);
  }
  await refreshPreferenceEventCache();
  const observations = events.flatMap((event) =>
    event.type === "pairwise-choice" || event.type === "settled-edit" ? [event.observation] : [],
  );
  const rankerLedgerImported = mergePreferenceObservations(observations);
  if (favoritesImported && styleExamplesImported) {
    try {
      const [style, semantic] = await Promise.all([import("./style-vector"), import("./semantic")]);
      style.resetStyleVector();
      semantic.resetSemanticCorpusCache();
    } catch {
      // Rebuilt caches are an optimization; imported source memories remain valid.
    }
  }
  if (observations.length === 0) notifyChanged();
  return { eventsImported: true, rankerLedgerImported, lineageImported, favoritesImported, styleExamplesImported };
}

function isValidLegacyPreferencePack(
  value: unknown,
): value is PreferenceLedgerPackV1 & { observations: PreferenceObservationV1[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const pack = value as Partial<PreferenceLedgerPackV1>;
  return (
    pack.version === PREFERENCE_LEDGER_VERSION &&
    typeof pack.exportedAt === "number" &&
    Number.isFinite(pack.exportedAt) &&
    isPreferenceFeatureVersion(pack.featureVersion) &&
    Array.isArray(pack.observations) &&
    pack.observations.length <= PREFERENCE_LEDGER_CAP &&
    pack.observations.every(isValidPreferenceObservation)
  );
}

export function mergePreferenceObservations(input: readonly unknown[]): boolean {
  const observations = input
    .map(sanitizePreferenceObservation)
    .filter((observation): observation is PreferenceObservationV1 => observation !== null);
  const merged = observations.reduce(
    (current, observation) => dedupeAndCapPreferences(current, observation),
    safeRead(),
  );
  const saved = safeWrite(merged);
  if (saved) notifyChanged();
  return saved;
}

export function readPreferenceLedger(): PreferenceObservationV1[] {
  return effectivePreferenceLedger();
}

/** Learning is local and pauseable. Feedback is never inferred from USE. */
export function isPreferenceLearningEnabled(): boolean {
  try {
    return typeof localStorage === "undefined" || localStorage.getItem(PREFERENCE_LEARNING_KEY) !== "off";
  } catch {
    return false;
  }
}

export function setPreferenceLearningEnabled(enabled: boolean): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(PREFERENCE_LEARNING_KEY, enabled ? "on" : "off");
    notifyChanged();
  } catch {
    /* preference learning safely becomes unavailable when storage is blocked */
  }
}

export function clearPreferenceLedger(): boolean {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(PREFERENCE_LEDGER_KEY);
    notifyChanged();
    if (typeof window !== "undefined") window.dispatchEvent(new Event(PREFERENCE_LEDGER_CLEARED_EVENT));
    return true;
  } catch {
    /* no-op; all ranking paths retain their global fallback */
    return false;
  }
}

export function buildPreferenceLedgerPack(exportedAt = Date.now()): PreferenceLedgerPackV1 {
  return {
    version: PREFERENCE_LEDGER_VERSION,
    exportedAt,
    // The newest contract this build can produce. Individual observations keep
    // the version they were actually recorded under (W4 dual-read).
    featureVersion: FEATURE_CONTRACT_V2.version,
    observations: safeRead(),
  };
}

if (typeof window !== "undefined") void refreshPreferenceEventCache();

/** True when a candidate vector width is storable under either contract. */
export function isStorableFeatureVector(features: ArrayLike<number>): boolean {
  return isSupportedFeatureVector(features);
}

/** Re-exported so callers can normalize without importing the feature module. */
export { normalizeFeatureVector };
