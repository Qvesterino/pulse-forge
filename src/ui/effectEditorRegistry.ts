import type { EffectType } from "../project-model/types";
import { EFFECT_DEFS } from "../effects/registry";

/** UI-level grouping and first-view controls; independent from the DSP registry. */
export type EffectEditorFamily = (typeof EFFECT_DEFS)[EffectType]["category"];

export interface EffectEditorSpec {
  family: EffectEditorFamily;
  primaryParamIds?: readonly string[];
}

const EDITOR_OVERRIDES: Partial<Record<EffectType, Pick<EffectEditorSpec, "primaryParamIds">>> = {
  eq: { primaryParamIds: ["hpFreq", "lowShelfGain", "lowMidGain", "highShelfGain"] },
  compressor: { primaryParamIds: ["threshold", "ratio", "attack", "release"] },
  kaskada: { primaryParamIds: ["time", "sync", "feedback", "mix"] },
  // Vinyl Suite: the age macro + the three headline artefacts on page 1;
  // module detail (tones, decay, rates, drive, trims) lives on later pages.
  vinyl: { primaryParamIds: ["amount", "crackle", "hiss", "wow"] },
};

/**
 * Every effect inherits a family from its audio definition. Only effects that
 * need a curated first page need an override here, so new effects get a usable
 * editor without adding another render branch.
 */
export function effectEditorSpec(type: EffectType): EffectEditorSpec {
  return { family: EFFECT_DEFS[type].category, ...EDITOR_OVERRIDES[type] };
}
