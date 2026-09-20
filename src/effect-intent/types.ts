import type { EffectType } from "../project-model/types";

export const EFFECT_INTENT_SCHEMA_VERSION = 1 as const;
export const EFFECT_INTENT_PARSER_VERSION = "effect-intent-lexicon-v1" as const;
export const EFFECT_INTENT_PLANNER_VERSION = "effect-intent-rules-v2" as const;

export type EffectIntentGoal = "warmth" | "brightness" | "space";
export type EffectIntentDirection = "increase" | "decrease";
export type EffectIntentProtectedArea = "lowEnd" | "highs" | "stereo" | "drive";

export interface EffectIntentGoalRequest {
  goal: EffectIntentGoal;
  direction: EffectIntentDirection;
  /** Normalized strength. This is a planner control, not a raw parameter delta. */
  amount: number;
}

export interface EffectIntentSpec {
  schemaVersion: typeof EFFECT_INTENT_SCHEMA_VERSION;
  parserVersion: typeof EFFECT_INTENT_PARSER_VERSION;
  sourceText: string;
  goals: EffectIntentGoalRequest[];
  preserve: EffectIntentProtectedArea[];
}

export interface EffectIntentTarget {
  trackId: string;
  fxId: string;
  effectType: EffectType;
}

export interface EffectParameterOption {
  value: number;
  label: string;
}

/** Technical, read-only projection of an authoritative rack or plugin schema. */
export interface EffectParameterDescriptor {
  id: string;
  label: string;
  min: number;
  max: number;
  default: number;
  current: number;
  unit?: string;
  format?: (value: number) => string;
  kind: "continuous" | "enum" | "toggle" | "discrete" | "unknown";
  taper: "linear" | "log" | "unknown";
  step?: number;
  options?: EffectParameterOption[];
  source: "rack" | "fxeq" | "ultina" | "ozvena" | "kaskada";
  schemaId: string;
  /** `rangeOnly` is used when a vendored schema omits enum/step metadata. */
  currentValidation: "complete" | "rangeOnly";
  /** Plugin-schema capability; absent means the rack schema has no such field. */
  automationSupported?: boolean;
  /** False means persisted data needs normalization; the catalog never repairs it. */
  currentIsValid: boolean;
}

/** Curated semantic view; technical existence alone never grants intent control. */
export interface EffectIntentParameterDescriptor extends EffectParameterDescriptor {
  intentGoals: EffectIntentGoal[];
  intentMappings: EffectIntentParameterMapping[];
}

export interface EffectIntentCatalogSnapshot {
  technicalDescriptors: EffectParameterDescriptor[];
  intentDescriptors: EffectIntentParameterDescriptor[];
  schemaId: string | null;
}

export interface EffectIntentParameterMapping {
  effectType: EffectType;
  paramId: string;
  goal: EffectIntentGoal;
  /** Signed delta/log-ratio when the goal moves in its positive direction. */
  positiveStep: number;
  mode: "add" | "logScale";
  protects: readonly EffectIntentProtectedArea[];
  safeMin: number;
  safeMax: number;
  rationale: Readonly<Record<EffectIntentDirection, string>>;
  risk: "low" | "elevated";
  evidence: "curated-unreviewed" | "golden-reviewed";
}

export interface EffectIntentCatalogCoverageReport {
  effectTypeCount: number;
  rackParameterCount: number;
  technicalParameterCount: number;
  semanticallyMappedParameterCount: number;
  technicallyMappedParameterCount: number;
  semanticCoverage: number;
  technicalSemanticCoverage: number;
  byEffect: Array<{
    effectType: EffectType;
    rackParameterCount: number;
    technicalParameterCount: number;
    deepParameterCount: number;
    parametersBySource: Partial<Record<EffectParameterDescriptor["source"], number>>;
    semanticallyMappedParameterCount: number;
    technicallyMappedParameterCount: number;
    intentWriteAdapter: "rack-param-def" | "none";
    intentPreviewAdapter: "rack-param-def" | "none";
    intentWriteSupported: boolean;
    unmappedSemanticParameterIds: string[];
  }>;
}

export interface EffectIntentChange {
  paramId: string;
  label: string;
  before: number;
  after: number;
  beforeText: string;
  afterText: string;
  rationale: string;
}

export interface EffectChangeProposal {
  schemaVersion: typeof EFFECT_INTENT_SCHEMA_VERSION;
  plannerVersion: typeof EFFECT_INTENT_PLANNER_VERSION;
  target: EffectIntentTarget;
  /** Fingerprint of the authoritative parameter catalog used to plan this proposal. */
  targetSchemaId: string;
  baseStateHash: string;
  intent: EffectIntentSpec;
  summary: string;
  changes: EffectIntentChange[];
  warnings: string[];
}

export type EffectIntentParseResult =
  | { status: "ready"; intent: EffectIntentSpec }
  | { status: "needsClarification" | "unsupported"; diagnostics: string[] };

export type EffectIntentPlanResult =
  | { status: "ready"; proposal: EffectChangeProposal }
  | { status: "needsClarification" | "unsupported" | "noChange"; diagnostics: string[] };
