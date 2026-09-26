/**
 * Pure, versioned storage contract for explicit Producer DNA comparisons.
 * Raw prompts, projects, filenames and audio are intentionally not part of
 * this record. Only coarse context labels, content hashes and normalized
 * feature vectors are retained.
 */
import { FEATURE_CONTRACT, FEATURE_COUNT } from "../ai/features/pattern-features";

export const PREFERENCE_LEDGER_VERSION = 1 as const;
export const PREFERENCE_LEDGER_CAP = 128;

export type PreferenceTask = "pattern" | "section" | "song";
export type PreferenceChoice = "a" | "b" | "neither" | "both";
export type PreferenceReason = "groove" | "drums" | "bass" | "harmony" | "melody" | "space" | "energy" | "novelty";

export interface PreferenceContext {
  /** Coarse, non-identifying context. Never store the original prompt. */
  genre: string;
  productionProfile: string | null;
  task: PreferenceTask;
  roleScope: string[];
  /** Stable hash of the coarse context fields above. */
  key: string;
}

export interface PreferenceCandidateSnapshot {
  contentHash: string;
  featureVersion: typeof FEATURE_CONTRACT.version;
  features: number[];
  /** Non-personal selector baseline; absent on legacy observations. */
  globalScore?: number;
  /** Identifies the global selector policy/model that produced the baseline. */
  globalScoreVersion?: string;
}

export interface PreferenceObservationV1 {
  version: typeof PREFERENCE_LEDGER_VERSION;
  context: PreferenceContext;
  candidateA: PreferenceCandidateSnapshot;
  candidateB: PreferenceCandidateSnapshot;
  choice: PreferenceChoice;
  reason?: PreferenceReason;
  createdAt: number;
}

export interface PreferenceLedgerPackV1 {
  version: typeof PREFERENCE_LEDGER_VERSION;
  exportedAt: number;
  featureVersion: typeof FEATURE_CONTRACT.version;
  observations: PreferenceObservationV1[];
}

const CHOICES = new Set<PreferenceChoice>(["a", "b", "neither", "both"]);
const REASONS = new Set<PreferenceReason>([
  "groove",
  "drums",
  "bass",
  "harmony",
  "melody",
  "space",
  "energy",
  "novelty",
]);
const TASKS = new Set<PreferenceTask>(["pattern", "section", "song"]);
const HASH_RE = /^[a-zA-Z0-9._:-]{1,128}$/;
const CONTEXT_KEY_RE = /^[a-f0-9]{8}$/;
const ROLE_RE = /^(drums|bass|chords|lead)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFeatureVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === FEATURE_COUNT &&
    value.every((feature) => typeof feature === "number" && Number.isFinite(feature) && feature >= 0 && feature <= 1)
  );
}

function isCandidateSnapshot(value: unknown): value is PreferenceCandidateSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.contentHash === "string" &&
    HASH_RE.test(value.contentHash) &&
    value.featureVersion === FEATURE_CONTRACT.version &&
    isFeatureVector(value.features) &&
    ((value.globalScore === undefined && value.globalScoreVersion === undefined) ||
      (typeof value.globalScore === "number" &&
        Number.isFinite(value.globalScore) &&
        value.globalScore >= 0 &&
        value.globalScore <= 1 &&
        typeof value.globalScoreVersion === "string" &&
        value.globalScoreVersion.length > 0 &&
        value.globalScoreVersion.length <= 128))
  );
}

function isContext(value: unknown): value is PreferenceContext {
  if (!isRecord(value)) return false;
  return (
    typeof value.genre === "string" &&
    value.genre.length > 0 &&
    value.genre.length <= 40 &&
    (value.productionProfile === null ||
      (typeof value.productionProfile === "string" && value.productionProfile.length <= 80)) &&
    typeof value.task === "string" &&
    TASKS.has(value.task as PreferenceTask) &&
    Array.isArray(value.roleScope) &&
    value.roleScope.length <= 4 &&
    value.roleScope.every((role) => typeof role === "string" && ROLE_RE.test(role)) &&
    typeof value.key === "string" &&
    CONTEXT_KEY_RE.test(value.key)
  );
}

/** Validate untrusted localStorage/import data before it reaches ranking. */
export function isValidPreferenceObservation(value: unknown): value is PreferenceObservationV1 {
  if (!isRecord(value)) return false;
  return (
    value.version === PREFERENCE_LEDGER_VERSION &&
    isContext(value.context) &&
    isCandidateSnapshot(value.candidateA) &&
    isCandidateSnapshot(value.candidateB) &&
    value.candidateA.contentHash !== value.candidateB.contentHash &&
    typeof value.choice === "string" &&
    CHOICES.has(value.choice as PreferenceChoice) &&
    (value.reason === undefined ||
      (typeof value.reason === "string" && REASONS.has(value.reason as PreferenceReason))) &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    value.createdAt >= 0
  );
}

/** Deduplicate repeat comparisons of the same pair in the same context. */
export function dedupeAndCapPreferences(
  observations: readonly PreferenceObservationV1[],
  observation: PreferenceObservationV1,
  cap = PREFERENCE_LEDGER_CAP,
): PreferenceObservationV1[] {
  const pair = [observation.candidateA.contentHash, observation.candidateB.contentHash].sort().join("|");
  const retained = observations.filter((existing) => {
    if (existing.context.key !== observation.context.key) return true;
    const existingPair = [existing.candidateA.contentHash, existing.candidateB.contentHash].sort().join("|");
    return existingPair !== pair;
  });
  const boundedCap = Math.max(1, Math.floor(cap));
  const next = [...retained, observation];
  return next.length > boundedCap ? next.slice(next.length - boundedCap) : next;
}
