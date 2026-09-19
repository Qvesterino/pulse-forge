import type { MusicalKey, Pattern, ProjectDocument, PatternGeneration } from "../project-model/types";
import type { GenerateOptions, GrooveData } from "../ai/types";

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
}

export interface GenerationProvider {
  id: string;
  version: string;
  capabilities: readonly string[];
  generate(plan: GenerationPlan, context: GenerationContext, signal?: AbortSignal): Promise<GenerationProposal>;
}
