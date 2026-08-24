import type { EffectType } from "../project-model/types";

export interface EffectPreset {
  id: string;
  name: string;
  type: EffectType;
  params: Record<string, number>;
}

const preset = (id: string, name: string, type: EffectType, params: Record<string, number>): EffectPreset => ({ id, name, type, params });

export const CORE_EFFECT_PRESETS: EffectPreset[] = [
  preset("eq-clean", "Clean", "eq", { lowShelfGain: 0, lowMidGain: 0, highMidGain: 0, highShelfGain: 0 }),
  preset("eq-air", "Air Lift", "eq", { highShelfFreq: 6500, highShelfGain: 2.5, lowMidGain: -1 }),
  preset("eq-warm", "Warm", "eq", { lowShelfGain: 2, lowShelfFreq: 130, highShelfGain: -1.5, highShelfFreq: 8000 }),
  preset("eq-vocal", "Presence", "eq", { lowShelfGain: -2, lowMidGain: -1, highMidFreq: 2800, highMidGain: 2 }),
  preset("transient-punch", "Punch", "transient", { attack: 0.55, sustain: -0.15, sensitivity: 0.65 }),
  preset("transient-tight", "Tight", "transient", { attack: 0.2, sustain: -0.55, sensitivity: 0.7 }),
  preset("transient-body", "Body", "transient", { attack: -0.2, sustain: 0.45, sensitivity: 0.45 }),
  preset("drum-glue", "Glue", "drumBuss", { drive: 0.18, transient: 0.12, compressor: 0.32, boomAmount: 0.08 }),
  preset("drum-crush", "Crush", "drumBuss", { drive: 0.55, transient: 0.4, compressor: 0.7, mix: 0.7 }),
  preset("drum-punch", "Punch", "drumBuss", { drive: 0.2, transient: 0.55, compressor: 0.22, boomAmount: 0.1 }),
  preset("bass-solid", "Solid", "bassBuss", { drive: 0.12, subEnhance: 0.2, compression: 0.35, monoBassFrequency: 100 }),
  preset("bass-grit", "Grit", "bassBuss", { drive: 0.45, subEnhance: 0.12, compression: 0.4, mix: 0.85 }),
  preset("bass-sub", "Sub Focus", "bassBuss", { drive: 0.08, subEnhance: 0.55, subFrequency: 58, monoBassFrequency: 120 }),
  preset("utility-mono", "Mono Bass", "utility", { width: 1, monoBassFrequency: 120 }),
  preset("utility-wide", "Wide", "utility", { width: 1.35, pan: 0 }),
  preset("utility-gain", "Gain Trim", "utility", { gain: -6, width: 1 }),
  preset("gate-tight", "Tight", "gate", { threshold: -32, attack: 0.001, hold: 0.015, release: 0.07, range: -48 }),
  preset("gate-soft", "Soft", "gate", { threshold: -48, attack: 0.008, hold: 0.04, release: 0.18, range: -24 }),
  preset("gate-hard", "Hard", "gate", { threshold: -24, attack: 0.0005, hold: 0.01, release: 0.04, range: -80 }),
  preset("sidechain-pump", "Pump", "sidechain", { threshold: -28, ratio: 8, attack: 0.002, release: 0.18, amount: 1 }),
  preset("sidechain-gentle", "Gentle", "sidechain", { threshold: -18, ratio: 3, attack: 0.01, release: 0.3, amount: 0.65 }),
  preset("sidechain-deep", "Deep", "sidechain", { threshold: -36, ratio: 12, attack: 0.001, release: 0.28, amount: 1 }),
  preset("chorus-subtle", "Subtle", "chorus", { rate: 0.35, depth: 0.25, mix: 0.18 }),
  preset("chorus-wide", "Wide", "chorus", { rate: 0.6, depth: 0.7, mix: 0.45 }),
  preset("chorus-doubler", "Doubler", "chorus", { rate: 1.2, depth: 0.45, mix: 0.55 }),
];

export function presetsForEffect(type: EffectType): EffectPreset[] {
  return CORE_EFFECT_PRESETS.filter((item) => item.type === type);
}
