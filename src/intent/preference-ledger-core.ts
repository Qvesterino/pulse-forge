/**
 * Pure, versioned storage contract for explicit Producer DNA comparisons and
 * local before/after correction pairs.
 * Raw prompts, projects, filenames and audio are intentionally not part of
 * this record. Only coarse context labels, content hashes and normalized
 * feature vectors are retained.
 *
 * W4 dual-read: a snapshot carries the feature contract it was recorded
 * under. BOTH features.v1 (54 dims, the shipped ranker contract) and
 * features.v2 (69 dims, the bass/harmony/arrangement extension) are
 * accepted, and each is validated against ITS OWN width — an old v1
 * observation stays valid instead of being invalidated by the contract bump,
 * which is what lets the personal ranker pad it to the v2 width at training
 * time instead of dropping it.
 */
import { FEATURE_CONTRACT, FEATURE_COUNT } from "../ai/features/pattern-features";
import { FEATURE_CONTRACT_V2, FEATURE_V2_COUNT } from "../ai/features/pattern-features-v2";

export const PREFERENCE_LEDGER_VERSION = 1 as const;
export const PREFERENCE_LEDGER_CAP = 128;

export type PreferenceTask = "pattern" | "section" | "song";
export type PreferenceChoice = "a" | "b" | "neither" | "both";
export type PreferenceReason = "groove" | "drums" | "bass" | "harmony" | "melody" | "space" | "energy" | "novelty";

/** Feature contracts a stored snapshot may be recorded under (W4 dual-read). */
export type PreferenceFeatureVersion = typeof FEATURE_CONTRACT.version | typeof FEATURE_CONTRACT_V2.version;

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
  /** The contract the stored vector was recorded under — never re-bumped. */
  featureVersion: PreferenceFeatureVersion;
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
  /** Passive correction pair (edited result preferred over the prior state). */
  source?: "edit";
  createdAt: number;
}

export interface PreferenceLedgerPackV1 {
  version: typeof PREFERENCE_LEDGER_VERSION;
  exportedAt: number;
  /** Newest contract this build can produce; observations keep their own. */
  featureVersion: PreferenceFeatureVersion;
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

const FEATURE_VERSIONS = new Set<PreferenceFeatureVersion>([FEATURE_CONTRACT.version, FEATURE_CONTRACT_V2.version]);

/** The width a snapshot's DECLARED version must actually have. */
function expectedFeatureCount(version: PreferenceFeatureVersion): number {
  return version === FEATURE_CONTRACT_V2.version ? FEATURE_V2_COUNT : FEATURE_COUNT;
}

function isFeatureVector(value: unknown, width: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === width &&
    value.every((feature) => typeof feature === "number" && Number.isFinite(feature) && feature >= 0 && feature <= 1)
  );
}

function isCandidateSnapshot(value: unknown): value is PreferenceCandidateSnapshot {
  if (!isRecord(value)) return false;
  // W4 dual-read: accept either contract, validated against ITS OWN width, so
  // a legacy v1 vector is not invalidated by the v2 bump.
  const version = value.featureVersion as PreferenceFeatureVersion;
  return (
    typeof value.contentHash === "string" &&
    HASH_RE.test(value.contentHash) &&
    FEATURE_VERSIONS.has(version) &&
    isFeatureVector(value.features, expectedFeatureCount(version)) &&
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
    (value.source === undefined || value.source === "edit") &&
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
    if (
      existing.context.key !== observation.context.key ||
      (existing.source ?? "comparison") !== (observation.source ?? "comparison")
    )
      return true;
    const existingPair = [existing.candidateA.contentHash, existing.candidateB.contentHash].sort().join("|");
    return existingPair !== pair;
  });
  const boundedCap = Math.max(1, Math.floor(cap));
  const next = [...retained, observation];
  if (next.length <= boundedCap) return next;

  // Passive edits can be frequent. Reserve half the bounded ledger for
  // deliberate A/B comparisons so correction bursts cannot evict them all.
  const editCap = Math.floor(boundedCap / 2);
  const edits = editCap > 0 ? next.filter((item) => item.source === "edit").slice(-editCap) : [];
  const comparisons = next.filter((item) => item.source !== "edit").slice(-(boundedCap - edits.length));
  const retainedBySource = [...comparisons, ...edits];
  const bounded = retainedBySource.length > 0 ? retainedBySource : next.slice(-boundedCap);
  return bounded.sort((a, b) => a.createdAt - b.createdAt);
}
