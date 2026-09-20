import type { EffectType } from "../project-model/types";
import type { EffectIntentGoal, EffectIntentParameterMapping } from "./types";

/**
 * Reviewed-by-code mappings from an audible goal to a small, bounded device
 * parameter change. Golden listening is not yet complete for this pilot, so
 * the evidence label stays honest and must be promoted by a human review.
 */
export const EFFECT_INTENT_MAPPINGS: readonly EffectIntentParameterMapping[] = [
  {
    effectType: "eq",
    paramId: "lowShelfGain",
    goal: "warmth",
    positiveStep: 0.8,
    mode: "add",
    protects: ["lowEnd"],
    safeMin: -4,
    safeMax: 4,
    rationale: {
      increase: "jemne pridá telo v nízkych frekvenciách",
      decrease: "jemne uberie telo v nízkych frekvenciách",
    },
    risk: "low",
    evidence: "curated-unreviewed",
  },
  {
    effectType: "eq",
    paramId: "highShelfGain",
    goal: "warmth",
    positiveStep: -0.7,
    mode: "add",
    protects: ["highs"],
    safeMin: -4,
    safeMax: 4,
    rationale: {
      increase: "zjemní horný shelf pre teplejší tón",
      decrease: "otvorí horný shelf pre chladnejší tón",
    },
    risk: "low",
    evidence: "curated-unreviewed",
  },
  {
    effectType: "eq",
    paramId: "highShelfGain",
    goal: "brightness",
    positiveStep: 1.1,
    mode: "add",
    protects: ["highs"],
    safeMin: -4,
    safeMax: 4,
    rationale: {
      increase: "jemne otvorí horný shelf",
      decrease: "jemne stlmí horný shelf",
    },
    risk: "low",
    evidence: "curated-unreviewed",
  },
  {
    effectType: "reverb",
    paramId: "tone",
    goal: "warmth",
    positiveStep: -0.14,
    mode: "logScale",
    protects: ["highs"],
    safeMin: 900,
    safeMax: 9000,
    rationale: {
      increase: "stlmí jasnosť dozvuku pre teplejší priestor",
      decrease: "otvorí dozvuk pre chladnejší tón",
    },
    risk: "low",
    evidence: "curated-unreviewed",
  },
  {
    effectType: "reverb",
    paramId: "tone",
    goal: "brightness",
    positiveStep: 0.14,
    mode: "logScale",
    protects: ["highs"],
    safeMin: 900,
    safeMax: 9000,
    rationale: {
      increase: "otvorí horné frekvencie dozvuku",
      decrease: "zjemní horné frekvencie dozvuku",
    },
    risk: "low",
    evidence: "curated-unreviewed",
  },
  {
    effectType: "reverb",
    paramId: "mix",
    goal: "space",
    positiveStep: 0.075,
    mode: "add",
    protects: ["highs"],
    safeMin: 0,
    safeMax: 0.75,
    rationale: {
      increase: "pridá trochu mokrého dozvuku",
      decrease: "stiahne množstvo mokrého dozvuku",
    },
    risk: "low",
    evidence: "curated-unreviewed",
  },
  {
    effectType: "reverb",
    paramId: "decay",
    goal: "space",
    positiveStep: Math.log(1.22),
    mode: "logScale",
    protects: [],
    safeMin: 0.25,
    safeMax: 4.5,
    rationale: {
      increase: "predĺži dozvuk pre väčší priestor",
      decrease: "skráti dozvuk pre suchší výsledok",
    },
    risk: "low",
    evidence: "curated-unreviewed",
  },
] as const satisfies readonly EffectIntentParameterMapping[];

export function effectIntentMappingsForParam(
  effectType: EffectType,
  paramId: string,
): readonly EffectIntentParameterMapping[] {
  return EFFECT_INTENT_MAPPINGS.filter((mapping) => mapping.effectType === effectType && mapping.paramId === paramId);
}

export function effectIntentMappingsForGoal(
  effectType: EffectType,
  goal: EffectIntentGoal,
): readonly EffectIntentParameterMapping[] {
  return EFFECT_INTENT_MAPPINGS.filter((mapping) => mapping.effectType === effectType && mapping.goal === goal);
}

export function effectIntentGoalsForParam(effectType: EffectType, paramId: string): EffectIntentGoal[] {
  return [...new Set(effectIntentMappingsForParam(effectType, paramId).map((mapping) => mapping.goal))];
}

export const EFFECT_INTENT_PILOT_TYPES: readonly EffectType[] = [
  ...new Set(EFFECT_INTENT_MAPPINGS.map((mapping) => mapping.effectType)),
];
