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
import {
  cloneSongDramaturgyFeatureVector,
  isSongDramaturgyFeatureVector,
  type SongDramaturgyFeatureVectorV1,
  type SongPreferenceFocus,
} from "../ai/features/song-dramaturgy-v1";

export const PREFERENCE_LEDGER_VERSION = 1 as const;
export const PREFERENCE_LEDGER_CAP = 128;

export type PreferenceTask = "pattern" | "section" | "song";
export type PreferenceChoice = "a" | "b" | "neither" | "both";
export interface BlindPilotAssignment {
  /** Side that contained the global selector's top candidate before canonical ordering. */
  globalSide: "a" | "b";
  /** Side response as presented to the user; separate from canonical ledger choice. */
  displayedChoice: PreferenceChoice;
}
export type PreferenceReason =
  | "groove"
  | "drums"
  | "bass"
  | "harmony"
  | "melody"
  | "space"
  | "energy"
  | "novelty"
  | "brightness"
  | "lowEnd"
  | "dynamics"
  | "level"
  | "timbre"
  | "voicing"
  | "stereo"
  | "mix";

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
  /** Optional rendered-audio summary; raw PCM is never stored in Producer DNA. */
  audioFeatures?: AudioPreferenceVector;
  /** Non-personal selector baseline; absent on legacy observations. */
  globalScore?: number;
  /** Identifies the global selector policy/model that produced the baseline. */
  globalScoreVersion?: string;
  /** Exact local score after personal residuals at the time of this choice. */
  personalScore?: number;
  /** Task-specific sequence/form measurements; only valid for song choices. */
  songDramaturgyFeatures?: SongDramaturgyFeatureVectorV1;
}

/** audio.v1: [RMS, peak, crest factor / 20, ZCR / 0.4, low-band ratio]. */
export interface AudioPreferenceVectorV1 {
  version: "audio.v1";
  values: number[];
}

export const AUDIO_PREFERENCE_FEATURE_COUNT = 5;

/**
 * audio.v2 keeps the v1 prefix byte-for-byte, then adds timbre/voicing and
 * optional stereo measurements. `available` prevents mono or legacy renders
 * from being mistaken for measured stereo values.
 */
export interface AudioPreferenceVectorV2 {
  version: "audio.v2";
  values: number[];
  available: boolean[];
}

export type AudioPreferenceVector = AudioPreferenceVectorV1 | AudioPreferenceVectorV2;
export const AUDIO_PREFERENCE_V2_FEATURE_COUNT = 11;

export interface PreferenceObservationV1 {
  version: typeof PREFERENCE_LEDGER_VERSION;
  context: PreferenceContext;
  candidateA: PreferenceCandidateSnapshot;
  candidateB: PreferenceCandidateSnapshot;
  choice: PreferenceChoice;
  reason?: PreferenceReason;
  /** Passive correction pair (edited result preferred over the prior state). */
  source?: "edit";
  /** Focus explicitly selected for a whole-song comparison. */
  songReason?: SongPreferenceFocus;
  /** Explicit opt-in comparison of global-selector and personal-selector picks. */
  study?: "producer-dna-blind-pilot";
  /** Original display assignment, retained to audit randomization and side bias. */
  pilotAssignment?: BlindPilotAssignment;
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
const AUDIO_REASONS = new Set<PreferenceReason>([
  "brightness",
  "lowEnd",
  "dynamics",
  "level",
  "timbre",
  "voicing",
  "stereo",
  "mix",
]);
const REASONS = new Set<PreferenceReason>([
  "groove",
  "drums",
  "bass",
  "harmony",
  "melody",
  "space",
  "energy",
  "novelty",
  ...AUDIO_REASONS,
]);
const TASKS = new Set<PreferenceTask>(["pattern", "section", "song"]);
const HASH_RE = /^[a-zA-Z0-9._:-]{1,128}$/;
const CONTEXT_KEY_RE = /^[a-f0-9]{8}$/;
const ROLE_RE = /^(drums|bass|chords|lead)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FEATURE_VERSIONS = new Set<PreferenceFeatureVersion>([FEATURE_CONTRACT.version, FEATURE_CONTRACT_V2.version]);

/** Validate a ledger pack's advertised newest feature contract. */
export function isPreferenceFeatureVersion(value: unknown): value is PreferenceFeatureVersion {
  return typeof value === "string" && FEATURE_VERSIONS.has(value as PreferenceFeatureVersion);
}

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

export function isAudioPreferenceVector(value: unknown): value is AudioPreferenceVector {
  if (!isRecord(value)) return false;
  if (
    value.version === "audio.v1" &&
    Array.isArray(value.values) &&
    value.values.length === AUDIO_PREFERENCE_FEATURE_COUNT &&
    value.values.every(
      (feature) => typeof feature === "number" && Number.isFinite(feature) && feature >= 0 && feature <= 1,
    )
  ) {
    return true;
  }
  return (
    value.version === "audio.v2" &&
    Array.isArray(value.values) &&
    value.values.length === AUDIO_PREFERENCE_V2_FEATURE_COUNT &&
    value.values.every(
      (feature) => typeof feature === "number" && Number.isFinite(feature) && feature >= 0 && feature <= 1,
    ) &&
    Array.isArray(value.available) &&
    value.available.length === AUDIO_PREFERENCE_V2_FEATURE_COUNT &&
    value.available.every((available) => typeof available === "boolean") &&
    value.available.slice(0, 9).every((available) => available) &&
    value.available[9] === value.available[10]
  );
}

export function cloneAudioPreferenceVector(value: AudioPreferenceVector): AudioPreferenceVector {
  return value.version === "audio.v1"
    ? { version: "audio.v1", values: [...value.values] }
    : { version: "audio.v2", values: [...value.values], available: [...value.available] };
}

function isCandidateSnapshot(value: unknown): value is PreferenceCandidateSnapshot {
  if (!isRecord(value)) return false;
  // W4 dual-read: accept either contract, validated against ITS OWN width, so
  // a legacy v1 vector is not invalidated by the v2 bump.
  const version = value.featureVersion as PreferenceFeatureVersion;
  return (
    typeof value.contentHash === "string" &&
    HASH_RE.test(value.contentHash) &&
    isPreferenceFeatureVersion(version) &&
    isFeatureVector(value.features, expectedFeatureCount(version)) &&
    (value.audioFeatures === undefined || isAudioPreferenceVector(value.audioFeatures)) &&
    ((value.globalScore === undefined && value.globalScoreVersion === undefined) ||
      (typeof value.globalScore === "number" &&
        Number.isFinite(value.globalScore) &&
        value.globalScore >= 0 &&
        value.globalScore <= 1 &&
        typeof value.globalScoreVersion === "string" &&
        value.globalScoreVersion.length > 0 &&
        value.globalScoreVersion.length <= 128)) &&
    (value.personalScore === undefined ||
      (typeof value.personalScore === "number" &&
        Number.isFinite(value.personalScore) &&
        value.personalScore >= 0 &&
        value.personalScore <= 1)) &&
    (value.songDramaturgyFeatures === undefined || isSongDramaturgyFeatureVector(value.songDramaturgyFeatures))
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
    (value.songReason === undefined ||
      (value.context.task === "song" &&
        (value.songReason === "overall" ||
          value.songReason === "development" ||
          value.songReason === "transitions" ||
          value.songReason === "contrast" ||
          value.songReason === "harmony" ||
          value.songReason === "sound" ||
          value.songReason === "mix"))) &&
    (value.context.task === "song" ||
      (value.candidateA.songDramaturgyFeatures === undefined &&
        value.candidateB.songDramaturgyFeatures === undefined)) &&
    (value.study === undefined || value.study === "producer-dna-blind-pilot") &&
    (value.pilotAssignment === undefined ||
      (value.study === "producer-dna-blind-pilot" &&
        isRecord(value.pilotAssignment) &&
        (value.pilotAssignment.globalSide === "a" || value.pilotAssignment.globalSide === "b") &&
        typeof value.pilotAssignment.displayedChoice === "string" &&
        CHOICES.has(value.pilotAssignment.displayedChoice as PreferenceChoice))) &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    value.createdAt >= 0
  );
}

/** Rebuild a validated observation using only the versioned public fields. */
export function sanitizePreferenceObservation(value: unknown): PreferenceObservationV1 | null {
  if (!isValidPreferenceObservation(value)) return null;
  const snapshot = (candidate: PreferenceCandidateSnapshot): PreferenceCandidateSnapshot => ({
    contentHash: candidate.contentHash,
    featureVersion: candidate.featureVersion,
    features: [...candidate.features],
    ...(candidate.audioFeatures ? { audioFeatures: cloneAudioPreferenceVector(candidate.audioFeatures) } : {}),
    ...(candidate.globalScore !== undefined ? { globalScore: candidate.globalScore } : {}),
    ...(candidate.globalScoreVersion !== undefined ? { globalScoreVersion: candidate.globalScoreVersion } : {}),
    ...(candidate.personalScore !== undefined ? { personalScore: candidate.personalScore } : {}),
    ...(candidate.songDramaturgyFeatures
      ? { songDramaturgyFeatures: cloneSongDramaturgyFeatureVector(candidate.songDramaturgyFeatures) }
      : {}),
  });
  return {
    version: value.version,
    context: {
      genre: value.context.genre,
      productionProfile: value.context.productionProfile,
      task: value.context.task,
      roleScope: [...value.context.roleScope],
      key: value.context.key,
    },
    candidateA: snapshot(value.candidateA),
    candidateB: snapshot(value.candidateB),
    choice: value.choice,
    ...(value.reason ? { reason: value.reason } : {}),
    ...(value.source ? { source: value.source } : {}),
    ...(value.songReason ? { songReason: value.songReason } : {}),
    ...(value.study ? { study: value.study } : {}),
    ...(value.pilotAssignment ? { pilotAssignment: { ...value.pilotAssignment } } : {}),
    createdAt: value.createdAt,
  };
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
      (existing.source ?? "comparison") !== (observation.source ?? "comparison") ||
      (existing.study ?? "ordinary") !== (observation.study ?? "ordinary") ||
      existing.reason !== observation.reason ||
      existing.songReason !== observation.songReason
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
