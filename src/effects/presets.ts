import type { EffectType } from "../project-model/types";

export interface EffectPreset {
  id: string;
  name: string;
  type: EffectType;
  params: Record<string, number>;
  /** Step pattern for step-sequenced effects. */
  steps?: number[];
}

const preset = (id: string, name: string, type: EffectType, params: Record<string, number>): EffectPreset => ({ id, name, type, params });
const stepPreset = (id: string, name: string, type: EffectType, params: Record<string, number>, steps: number[]): EffectPreset => ({ id, name, type, params, steps });

export const CORE_EFFECT_PRESETS: EffectPreset[] = [
  preset("eq-clean", "Clean", "eq", { lowShelfGain: 0, lowMidGain: 0, highMidGain: 0, highShelfGain: 0 }),
  preset("eq-air", "Air Lift", "eq", { highShelfFreq: 6500, highShelfGain: 2.5, lowMidGain: -1 }),
  preset("eq-warm", "Warm", "eq", { lowShelfGain: 2, lowShelfFreq: 130, highShelfGain: -1.5, highShelfFreq: 8000 }),
  preset("eq-vocal", "Presence", "eq", { lowShelfGain: -2, lowMidGain: -1, highMidFreq: 2800, highMidGain: 2 }),
  preset("transient-punch", "Punch", "transient", { attack: 0.55, sustain: -0.15, sensitivity: 0.65 }),
  preset("transient-tight", "Tight", "transient", { attack: 0.2, sustain: -0.55, sensitivity: 0.7 }),
  preset("transient-body", "Body", "transient", { attack: -0.2, sustain: 0.45, sensitivity: 0.45 }),
  preset("limiter-safety", "Safety", "limiter", { ceiling: -1, threshold: -1.5, release: 0.12, lookaheadMs: 5, link: 1, mix: 1 }),
  preset("limiter-punch", "Punch", "limiter", { ceiling: -1, threshold: -6, release: 0.06, lookaheadMs: 3, link: 1, mix: 1 }),
  preset("limiter-slam", "Slam", "limiter", { ceiling: -1, threshold: -14, release: 0.18, lookaheadMs: 5, link: 1, mix: 1 }),
  stepPreset("stepgate-trance", "Trance 1/16", "stepGate", { division: 4, depth: 1, smooth: 0.08, mix: 1 }, [
    1, 0.35, 0.75, 0.25, 0.9, 0.3, 0.7, 0.2, 1, 0.35, 0.75, 0.25, 0.9, 0.3, 0.65, 0.18,
  ]),
  stepPreset("stepgate-stutter", "Stutter", "stepGate", { division: 4, depth: 1, smooth: 0.02, mix: 1 }, [
    1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 0,
  ]),
  stepPreset("stepgate-swell", "Slow Swell", "stepGate", { division: 1, depth: 0.85, smooth: 0.75, mix: 1 }, [
    0, 0.2, 0.5, 0.8, 1, 1, 0.8, 0.4,
  ]),
  stepPreset("stepgate-pad", "Gated Pad", "stepGate", { division: 3, depth: 1, smooth: 0.25, mix: 1 }, [
    1, 0.6, 0.2, 0.6, 1, 0.4, 0.7, 0.3,
  ]),
  preset("comp-glue", "Glue", "compressor", { threshold: -20, ratio: 2, attack: 0.03, release: 0.25, knee: 12, detector: 0, scHpf: 20, makeup: 3, mix: 1 }),
  preset("comp-punch", "Punch", "compressor", { threshold: -16, ratio: 4, attack: 0.005, release: 0.12, knee: 6, detector: 1, scHpf: 20, makeup: 4, mix: 1 }),
  preset("comp-smash", "Smash", "compressor", { threshold: -24, ratio: 12, attack: 0.003, release: 0.08, knee: 0, detector: 1, scHpf: 60, makeup: 7, mix: 0.7 }),
  preset("comp-bass-level", "Bass Level", "compressor", { threshold: -22, ratio: 3, attack: 0.02, release: 0.3, knee: 9, detector: 0, scHpf: 120, makeup: 2, mix: 1 }),
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
  preset("sidechain-mb", "Multiband Pump", "sidechain", { threshold: -22, ratio: 8, attack: 0.003, release: 0.18, amount: 0.9, splitFreq: 150 }),
  preset("chorus-subtle", "Subtle", "chorus", { rate: 0.35, depth: 0.25, mix: 0.18 }),
  preset("chorus-wide", "Wide", "chorus", { rate: 0.6, depth: 0.7, mix: 0.45 }),
  preset("chorus-doubler", "Doubler", "chorus", { rate: 1.2, depth: 0.45, mix: 0.55 }),
];

export function presetsForEffect(type: EffectType): EffectPreset[] {
  return CORE_EFFECT_PRESETS.filter((item) => item.type === type);
}
