/** Local-only adapter for explicit Producer DNA feedback and edit corrections. */
import { FEATURE_CONTRACT } from "../ai/features/pattern-features";
import {
  FEATURE_CONTRACT_V2,
  FEATURE_V2_COUNT,
  isSupportedFeatureVector,
  normalizeFeatureVector,
} from "../ai/features/pattern-features-v2";
import type { IntentSpec } from "./types";
import {
  dedupeAndCapPreferences,
  isValidPreferenceObservation,
  PREFERENCE_LEDGER_CAP,
  PREFERENCE_LEDGER_VERSION,
  type PreferenceCandidateSnapshot,
  type PreferenceChoice,
  type PreferenceContext,
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
  isValidPreferenceObservation,
  PREFERENCE_LEDGER_CAP,
  PREFERENCE_LEDGER_VERSION,
} from "./preference-ledger-core";
export type {
  PreferenceCandidateSnapshot,
  PreferenceChoice,
  PreferenceContext,
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
  globalScore?: number;
  globalScoreVersion?: string;
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
    ...(candidate.globalScore !== undefined ? { globalScore: candidate.globalScore } : {}),
    ...(candidate.globalScoreVersion !== undefined ? { globalScoreVersion: candidate.globalScoreVersion } : {}),
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
  options: { reason?: PreferenceReason; createdAt?: number; source?: "edit" } = {},
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
    return parsed.filter(isValidPreferenceObservation).slice(-PREFERENCE_LEDGER_CAP);
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

/** Store an explicit comparison or a privacy-safe before/after correction. */
export function recordPreferenceObservation(observation: PreferenceObservationV1): boolean {
  if (!isPreferenceLearningEnabled() || !isValidPreferenceObservation(observation)) return false;
  const saved = safeWrite(dedupeAndCapPreferences(safeRead(), observation));
  if (saved) notifyChanged();
  return saved;
}

export function readPreferenceLedger(): PreferenceObservationV1[] {
  return safeRead();
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

export function clearPreferenceLedger(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(PREFERENCE_LEDGER_KEY);
    notifyChanged();
    if (typeof window !== "undefined") window.dispatchEvent(new Event(PREFERENCE_LEDGER_CLEARED_EVENT));
  } catch {
    /* no-op; all ranking paths retain their global fallback */
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

/** True when a candidate vector width is storable under either contract. */
export function isStorableFeatureVector(features: ArrayLike<number>): boolean {
  return isSupportedFeatureVector(features);
}

/** Re-exported so callers can normalize without importing the feature module. */
export { normalizeFeatureVector };
