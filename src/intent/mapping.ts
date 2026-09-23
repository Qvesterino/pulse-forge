import type { IntentSpec } from "./types";
import type { GenerateOptions } from "../ai/types";

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
function clamp(lo: number, hi: number, v: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Derive engine-facing GenerateOptions from an IntentSpec with
 * energy/density/complexity/variation mapping.
 *
 * Mapping intent → engine (deterministic, no RNG):
 * - density  → ghostWeight + prune/densify hint (+ P2 melodic note-count gain)
 * - energy   → velocityVariation + ghostWeight boost (+ P2 melodic velocity gain)
 * - complexity → microWeight + temperature + syncopation/ratchet hint
 * - variation  → temperature + bar-variation hint
 * - mood     → small tweaks (dark/aggressive/chill)
 *
 * The `_dice*` hints are read by generateDrumPattern AND by the melodic
 * consumers (generateMelodicParts, generateMultiVoice) — P2 closed the
 * "energy is a drums-only slider" gap.
 */
export function mapIntentToOptions(intent: IntentSpec, base: GenerateOptions): GenerateOptions {
  // Fast path: default intent (0.7/0.5/0.5) → no mapping (preserve golden-render)
  const isDefaultEnergy = Math.abs(intent.energy - 0.7) < 0.001;
  const isDefaultDensity = Math.abs(intent.density - 0.5) < 0.001;
  const isDefaultComplexity = Math.abs(intent.complexity - 0.5) < 0.001;
  const isDefaultVariation = Math.abs(intent.variation - base.velocityVariation) < 0.001;
  const isDefaultMood = intent.mood == null;
  if (isDefaultEnergy && isDefaultDensity && isDefaultComplexity && isDefaultVariation && isDefaultMood) {
    return base;
  }

  let ghostWeight = base.ghostWeight;
  let microWeight = base.microWeight;
  let velocityVariation = base.velocityVariation;
  let temperature = base.temperature;

  // Density → ghost weight + overall hit density hint
  // 0.2 sparse (×0.6), 0.5 neutral (×1.0), 0.9 dense (×1.4)
  ghostWeight = clamp01(ghostWeight + (intent.density - 0.5) * 0.5);

  // Energy → velocity + ghost boost
  // 0.2 calm → -0.12 vel, 0.9 intense → +0.2 vel
  velocityVariation = clamp01(velocityVariation + (intent.energy - 0.5) * 0.4);
  ghostWeight = clamp01(ghostWeight + (intent.energy - 0.7) * 0.15);

  // Complexity → micro + temp + syncopation
  microWeight = clamp01(microWeight + (intent.complexity - 0.5) * 0.4);
  temperature = clamp(0.2, 2, temperature * (0.85 + intent.complexity * 0.3));

  // Variation → temperature + bar variation
  temperature = clamp(0.2, 2, temperature * (0.8 + intent.variation * 0.5));

  // Mood tweaks
  const mood = intent.mood?.toLowerCase() ?? null;
  if (mood === "dark" || mood === "moody") {
    ghostWeight = clamp01(ghostWeight * 1.15);
    velocityVariation = clamp01(velocityVariation * 0.9);
  } else if (mood === "aggressive" || mood === "hard") {
    velocityVariation = clamp01(velocityVariation * 1.25);
    ghostWeight = clamp01(ghostWeight * 0.85);
    temperature = clamp(0.2, 2, temperature * 1.1);
  } else if (mood === "chill" || mood === "soft" || mood === "mellow") {
    ghostWeight = clamp01(ghostWeight * 0.8);
    microWeight = clamp01(microWeight * 0.85);
    velocityVariation = clamp01(velocityVariation * 0.8);
  } else if (mood === "energetic" || mood === "bright") {
    ghostWeight = clamp01(ghostWeight * 1.1);
    temperature = clamp(0.2, 2, temperature * 1.05);
  }

  return {
    ...base,
    ghostWeight,
    microWeight,
    velocityVariation,
    temperature,
    // Pass hints for drums post-processing (cast to extended type)
    // These are read by generateDrumPattern if present.
    ...(intent.density !== 0.5 ? { _diceDensity: intent.density } : {}),
    ...(intent.complexity !== 0.5 ? { _diceComplexity: intent.complexity } : {}),
    ...(intent.energy !== 0.7 ? { _diceEnergy: intent.energy } : {}),
  } as GenerateOptions & { _diceDensity?: number; _diceComplexity?: number; _diceEnergy?: number };
}

/** Extract dice hints from options (if mapped). */
export function diceHints(options: GenerateOptions): {
  density: number | null;
  complexity: number | null;
  energy: number | null;
} {
  const ext = options as GenerateOptions & { _diceDensity?: number; _diceComplexity?: number; _diceEnergy?: number };
  return {
    density: typeof ext._diceDensity === "number" ? ext._diceDensity : null,
    complexity: typeof ext._diceComplexity === "number" ? ext._diceComplexity : null,
    energy: typeof ext._diceEnergy === "number" ? ext._diceEnergy : null,
  };
}
