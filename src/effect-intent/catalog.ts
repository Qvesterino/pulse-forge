import type { EffectInstance, EffectType } from "../project-model/types";
import { EFFECT_DEFS, clampEffectParam } from "../effects/registry";
import type { EffectIntentGoal, EffectIntentParameterDescriptor } from "./types";

const PILOT_GOALS: Partial<Record<EffectType, Readonly<Record<string, readonly EffectIntentGoal[]>>>> = {
  eq: {
    lowShelfGain: ["warmth"],
    highShelfGain: ["warmth", "brightness"],
  },
  reverb: {
    tone: ["warmth", "brightness"],
    decay: ["space"],
    mix: ["space"],
  },
};

const EQ_LEGACY_ALIASES = new Set(["lowGain", "lowFreq", "midGain", "midFreq", "midQ", "highGain", "highFreq"]);

export const EFFECT_INTENT_PILOT_TYPES: readonly EffectType[] = ["eq", "reverb"];

export function supportsEffectIntent(type: EffectType): boolean {
  return EFFECT_INTENT_PILOT_TYPES.includes(type);
}

/**
 * Build a read-only, normalized view over the existing rack schema. Semantic
 * capabilities are deliberately curated separately: a valid slider is not
 * automatically safe for natural-language control.
 */
export function effectIntentParameterCatalog(effect: EffectInstance): EffectIntentParameterDescriptor[] {
  const semantic = PILOT_GOALS[effect.type];
  if (!semantic) return [];

  return EFFECT_DEFS[effect.type].params
    .filter((param) => !(effect.type === "eq" && EQ_LEGACY_ALIASES.has(param.id)))
    .map((param) => {
      const current = effect.params[param.id] ?? param.default;
      return {
        id: param.id,
        label: param.label,
        min: param.min,
        max: param.max,
        default: param.default,
        current: clampEffectParam(effect.type, param.id, current),
        ...(param.unit ? { unit: param.unit } : {}),
        ...(param.format ? { format: param.format } : {}),
        kind: param.options ? "enum" : "continuous",
        taper: param.taper ?? "linear",
        intentGoals: [...(semantic[param.id] ?? [])],
      };
    });
}

export function formatEffectIntentValue(
  effectType: EffectType,
  paramId: string,
  value: number,
): string {
  const param = EFFECT_DEFS[effectType].params.find((candidate) => candidate.id === paramId);
  if (!param) return String(value);
  if (param.format) return param.format(value);
  return param.unit ? `${value.toFixed(2)} ${param.unit}` : value.toFixed(2);
}
