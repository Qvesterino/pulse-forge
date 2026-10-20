import type {
  MusicalKey,
  Pattern,
  ProductionProfile,
  ProjectDocument,
  PatternGeneration,
} from "../project-model/types";
import type { GenerateOptions, GrooveData } from "../ai/types";
import type { CandidateBankEntry } from "./candidate-bank";
import type { CandidateSearchInfo } from "./candidate-search";
import type { ProductionIntent } from "./production";
import type { SelectionReason } from "./selection-reasons";

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
  /** Optional composition profile; absent on legacy intents to preserve their hashes. */
  productionProfile?: ProductionProfile;
  /**
   * Matched artist-preset label (e.g. "drake", "kendrick lamar") — the key
   * into the artist mix-signature table (artist-mix.ts). Absent when no
   * preset matched; omitted from legacy hashes.
   */
  artist?: string;
  /**
   * Rap flow grid for the lead/hook line: straight 16ths, triplet 16ths
   * (the trap/detroit bounce) or offbeat push. Absent = generator default.
   */
  flow?: "straight" | "triplet" | "offbeat";
  /**
   * Song-level harmony plan: the NAME of a progression from the genre's own
   * table (src/ai/harmony.ts). Set by buildSong so every melodic section of
   * one song shares ONE harmonic identity (the bridge takes the related
   * turn — the next progression in the table) instead of each section
   * rolling its own dice. Absent = the legacy per-generation pick, so
   * standalone pattern generations and canonical hashes are unchanged.
   */
  progression?: string;
  mood: string | null;
  energy: number;
  density: number;
  complexity: number;
  variation: number;
  seed: string;
  /**
   * Raw user text (clamped) — provenance record and the embedding-conditioned
   * prior's conditioning input. Absent for programmatic intents.
   */
  text?: string;
  key: MusicalKey | null;
  bpmRange: [number, number] | null;
  length: number;
  /**
   * The requested length in BARS — meter-independent. Present only when the
   * request was framed in bars ("8 bars"); the document's meter turns it into
   * the step count in `length`. Absent = the request was framed in steps, or
   * defaulted to one bar of the document's meter.
   */
  bars?: number;
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
  /**
   * Fáza 1 (AI-first producer): roles explicitly PROTECTED by the brief
   * ("keep my bass", "nechaj akordy") — existing content the generation
   * must not rewrite. plan/options exclude them even when `roles` would
   * include them. Optional and only present when non-empty, so canonical
   * hashes of pre-Fáza-1 intents are unchanged.
   */
  preserve?: readonly IntentRole[];
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
  productionProfile?: unknown;
  flow?: unknown;
  artist?: unknown;
  mood?: unknown;
  energy?: unknown;
  density?: unknown;
  complexity?: unknown;
  variation?: unknown;
  seed?: unknown;
  key?: unknown;
  bpmRange?: unknown;
  length?: unknown;
  bars?: unknown;
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
  /** Protected content source only; unlike `intent.sourcePatternId`, this does not alter the generation seed. */
  preserveSourcePatternId?: string | null;
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
  /**
   * The artist tempo window that constrained `resolvedBpm` (Phase 2 slice 5).
   * Present only when the intent matched an artist AND carried no explicit
   * `bpmRange` — i.e. exactly when the deep profile supplied the constraint.
   * Absent means the request came from the intent (or from nothing).
   */
  artistBpmRange?: [number, number];
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
  /** Keeps pattern, section and whole-song preference evidence separate. */
  preferenceTask?: import("./preference-ledger-core").PreferenceTask;
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
  /** First-pass scorer; an audio rerank may subsequently choose another candidate. */
  source: "model" | "fallback";
  /** Final candidate after every enabled selection stage. */
  selectedIndex?: number;
  /** Present only when audio-fit reordering displaced the first-pass winner. */
  audioRerank?: { displacedCandidateIndex: number; selectedCandidateIndex: number; personalized?: boolean };
  /**
   * Wave B: deterministic identity of the rendered finalist set (see
   * rerankGenerationId). Present only when the sound rerank ran; the apply
   * surface carries it into the reaction ledger so `npm run rerank:fit` can
   * learn from what the human actually kept instead of assuming the engine's
   * delivered winner was it.
   */
  rerankGenerationId?: string;
  /**
   * Wave E1: WHY this candidate won — derived from measured bank scores,
   * rerank displacement and the personal residual only
   * (src/intent/selection-reasons.ts). Never invented prose.
   */
  reasons?: SelectionReason[];
  /** Compact one-line form of `reasons` (tooltip / status line). */
  rationale?: string;
}

/** Full provider ranking output — proposal plus the auditionable bank. */
export interface GenerationRanked {
  /**
   * The winning proposal — null when EVERY candidate (including the
   * deterministic fallback) failed the gates. A rejected run must not expose
   * an applyable pattern: the panel and applyGenerationResultCommand both
   * guard on `proposal` being absent (INTENT-AUDIT-2026-10 D3 — a rejected
   * result used to carry its failed fallback pattern and could be installed
   * over the user's active pattern).
   */
  proposal: GenerationProposal | null;
  /** Provider diagnostics for runs without a proposal (rejected). */
  diagnostics?: GenerationDiagnostics;
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
  /** Non-personal selector score before any Producer DNA residual is applied. */
  globalScore?: number;
  /** Symbolic personal score before the offline audio-fit stage. */
  personalScore?: number;
  /** Version of the non-personal selector used to calculate `globalScore`. */
  globalScoreVersion?: string;
  /** Normalized, ephemeral summary of this rendered candidate (no PCM retained). */
  audioFeatures?: import("./preference-ledger-core").AudioPreferenceVector;
  /** True when a learned audio preference model contributed to finalist order. */
  audioPreferenceApplied?: boolean;
  contentHash: string;
  pattern: Pattern;
  search?: CandidateSearchInfo;
}

export interface GenerationProvider {
  id: string;
  version: string;
  capabilities: readonly string[];
  /**
   * Null when the provider could not produce ANY valid candidate (including
   * its own fallback) — the D3 rejected contract. Callers treat a null
   * proposal as "generation rejected", never as an applyable pattern.
   */
  generate(plan: GenerationPlan, context: GenerationContext, signal?: AbortSignal): Promise<GenerationProposal | null>;
}
