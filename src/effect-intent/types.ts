import type { EffectType } from "../project-model/types";

export const EFFECT_INTENT_SCHEMA_VERSION = 1 as const;
export const EFFECT_INTENT_PARSER_VERSION = "effect-intent-lexicon-v1" as const;
export const EFFECT_INTENT_PLANNER_VERSION = "effect-intent-rules-v1" as const;

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

export interface EffectIntentParameterDescriptor {
  id: string;
  label: string;
  min: number;
  max: number;
  default: number;
  current: number;
  unit?: string;
  format?: (value: number) => string;
  kind: "continuous" | "enum";
  taper: "linear" | "log";
  intentGoals: EffectIntentGoal[];
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
