import type { MusicalKey, Pattern, ProjectDocument, PatternGeneration } from "../project-model/types";
import type { GenerateOptions, GrooveData } from "../ai/types";
import type { CandidateBankEntry } from "./candidate-bank";
import type { ProductionIntent } from "./production";

export const INTENT_SCHEMA_VERSION = 1 as const;

export type IntentGenre = GenerateOptions["genre"];
export type IntentRole = "drums" | "bass" | "chords" | "lead";
export type GenerationStatus = "accepted" | "repaired" | "fallback" | "rejected";

export interface IntentConstraints {
  preserveAnchors: boolean;
  allowGhosts: boolean;
  allowSwing: boolean;
}

/** Engine-facing controls kept separate from the user-level intent fields. */
export interface IntentControls {
  ghostWeight: number;
  microWeight: number;
  velocityVariation: number;
  temperature: number;
}

/** Fully normalized, serializable intent contract. */
export interface IntentSpec {
  version: typeof INTENT_SCHEMA_VERSION;
  genre: IntentGenre;
  style: string | null;
  mood: string | null;
  energy: number;
  density: number;
  complexity: number;
  variation: number;
  seed: string;
  key: MusicalKey | null;
  bpmRange: [number, number] | null;
  length: number;
  /** Number of local candidates to generate and rank before accepting one. */
  candidateCount?: number;
  /**
   * Number of ADDITIONAL candidates sampled from the ONNX symbolic drum
   * prior (T2). They enter the same candidate bank and pass the same
   * invariant/repair/ranking gates as template candidates. 0 = off (default;
   * also the sync-path and golden-baseline behavior).
   */
  symbolicCandidates?: number;
  roles: readonly IntentRole[];
  targetTracks: {
    drumTrackId: string | null;
    instrumentTrackIds: readonly string[];
  };
  constraints: IntentConstraints;
  controls: IntentControls;
  sourcePatternId: string | null;
  replaceMode: GenerateOptions["replaceMode"];
  applyGrooveSettings: boolean;
  /**
   * FX requests riding WITH the generation (wave: "wobbly drill" — the
   * character travels with the candidate, USE applies pattern + FX as one
   * step). Sanitized by normalizeIntent; null = no FX requested.
   */
  fx?: ProductionIntent | null;
}

/** Untrusted/user input accepted by normalizeIntent. */
export type IntentInput = Partial<IntentSpec> & {
  version?: number;
  genre?: unknown;
  style?: unknown;
  mood?: unknown;
  energy?: unknown;
  density?: unknown;
  complexity?: unknown;
  variation?: unknown;
  seed?: unknown;
  key?: unknown;
  bpmRange?: unknown;
  length?: unknown;
  candidateCount?: unknown;
  symbolicCandidates?: unknown;
  roles?: unknown;
  targetTracks?: unknown;
  constraints?: unknown;
  controls?: unknown;
  sourcePatternId?: unknown;
  replaceMode?: unknown;
  applyGrooveSettings?: unknown;
};

export interface GenerationPlan {
  intent: IntentSpec;
  options: GenerateOptions;
  groove: Pick<GrooveData, "id" | "genre" | "name" | "bpm" | "swing">;
  effectiveSeed: string;
  inputContentHash: string | null;
  intentHash: string;
  rolePlans: Record<
    IntentRole,
    {
      enabled: boolean;
      targetTrackIds: readonly string[];
    }
  >;
  constraints: IntentConstraints;
  /** Optional BPM chosen from the resolved groove/request range. */
  resolvedBpm: number | null;
  /** Stable seed for each local candidate in the bank. */
  candidateSeeds: readonly string[];
  /** Stable seeds for the optional symbolic-prior candidates (T2). */
  symbolicSeeds: readonly string[];
  subSeeds: {
    groove: string;
    drumsCore: string;
    drumsVariation: string;
    drumsMeta: string;
    drumsNeural: string;
    melodyFallback: string;
    bass: string;
    chord: string;
    lead: string;
  };
  outputShape: {
    stepCount: number;
    roles: readonly IntentRole[];
    replaceMode: GenerateOptions["replaceMode"];
  };
  recipe: PatternGeneration;
}

export interface GenerationContext {
  project: ProjectDocument;
  mode: "preview" | "apply";
}

export interface GenerationDiagnostics {
  warnings: string[];
  repairs: string[];
  errors: string[];
  fallbackReason?: string;
  quality?: PatternGeneration["quality"];
}

export interface GenerationProposal {
  pattern: Pattern;
  diagnostics: GenerationDiagnostics;
  /** Provider truth: the quality-gate outcome for this proposal. */
  status?: GenerationStatus;
}

export interface GenerationResult {
  status: GenerationStatus;
  plan: GenerationPlan;
  proposal?: GenerationProposal;
  diagnostics: GenerationDiagnostics;
  provider: {
    id: string;
    version: string;
  };
  /**
   * A1 candidate audition: the FULL ranked candidate bank, best first. Only
   * present when the caller asked for it (`includeBank`) and only meaningful
   * in memory — `applyGenerationResultCommand` persists the selected proposal
   * alone; the bank is never serialized into the project.
   */
  bank?: readonly RankedCandidate[];
  /** How the default (winner) selection was made — used by resultForCandidate. */
  selection?: RankerSelectionMeta;
}

/** Selection provenance for a generation run's candidate ranking. */
export interface RankerSelectionMeta {
  featureVersion: string;
  rankerVersion: string;
  modelHash: string | null;
  /** "off" = heuristic-only ranking (in-memory meta; persisted provenance coerces to "shadow"). */
  mode: "off" | "shadow" | "active";
  source: "model" | "fallback";
}

/** Full provider ranking output — proposal plus the auditionable bank. */
export interface GenerationRanked {
  proposal: GenerationProposal;
  /** Valid candidates, best first. Empty on fallback/rejected runs. */
  ranked: readonly CandidateBankEntry[];
  /** Model scores parallel to `ranked` (null where the model did not score). */
  modelScores: readonly (number | null)[];
  ranker: RankerSelectionMeta;
}

/** One UI-facing audition candidate (derived from a CandidateBankEntry). */
export interface RankedCandidate {
  candidateIndex: number;
  seed: string;
  source: "template" | "symbolic-prior";
  status: "accepted" | "repaired";
  repairs: readonly string[];
  /** Heuristic score (0..1). */
  score: number;
  /** ONNX ranker score when the model participated, else null. */
  modelScore: number | null;
  contentHash: string;
  pattern: Pattern;
}

export interface GenerationProvider {
  id: string;
  version: string;
  capabilities: readonly string[];
  generate(plan: GenerationPlan, context: GenerationContext, signal?: AbortSignal): Promise<GenerationProposal>;
}
