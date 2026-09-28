import type { IntentSpec } from "./types";
import type { GenerateOptions } from "../ai/types";
import { artistBpmHint } from "./artist-signature";
import { getArtistProfile, normalizeArtistSlug } from "./artist-profiles";

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
function clamp(lo: number, hi: number, v: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * The artist tempo pocket for an intent, from the deep profile layer.
 *
 * Returns null when no artist matched, when the label does not resolve to a
 * profile, or when the profile declares no usable range — every one of those
 * cases must leave groove selection exactly as it was before this existed.
 */
function artistGrooveWindow(intent: IntentSpec): [number, number] | null {
  if (!intent.artist) return null;
  const profile = getArtistProfile(normalizeArtistSlug(intent.artist));
  return profile ? artistBpmHint(profile) : null;
}

/**
 * The artist groove lanes, from the same profile as the tempo window.
 *
 * Returns null when no artist matched or the profile declares no lanes, so
 * an artist without lane data behaves exactly as before this existed — the
 * tempo pocket still narrows, there is just no second filter.
 */
function artistGrooveLanes(intent: IntentSpec): readonly string[] | null {
  if (!intent.artist) return null;
  const profile = getArtistProfile(normalizeArtistSlug(intent.artist));
  const lanes = profile?.grooveLanes;
  return lanes && lanes.length > 0 ? lanes : null;
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
 *
 * NOTE the metric-accent hint is NOT derived here: the default intent takes
 * the fast path below (returns `base` untouched), and a plain "drill" request
 * is exactly a default intent. `generateOptionsFromIntent` seeds it in `base`
 * so every intent — default or explicit — carries it.
 */
export function mapIntentToOptions(intent: IntentSpec, base: GenerateOptions): GenerateOptions {
  // Fast path: default intent (0.7/0.5/0.5) → no mapping (preserve golden-render)
  const isDefaultEnergy = Math.abs(intent.energy - 0.7) < 0.001;
  const isDefaultDensity = Math.abs(intent.density - 0.5) < 0.001;
  const isDefaultComplexity = Math.abs(intent.complexity - 0.5) < 0.001;
  const isDefaultVariation = Math.abs(intent.variation - base.velocityVariation) < 0.001;
  const isDefaultMood = intent.mood == null;
  // The artist tempo pocket is INDEPENDENT of the slider defaults above, so it
  // is resolved on BOTH return paths — otherwise a bare artist preset with
  // default sliders ("travis scott type beat", nothing else) would silently
  // lose its pocket and fall back to whichever groove the hash favoured.
  const grooveWindow = artistGrooveWindow(intent);
  const grooveLanes = artistGrooveLanes(intent);
  const baseWithWindow: GenerateOptions = {
    ...base,
    ...(grooveWindow ? { grooveBpmWindow: grooveWindow } : {}),
    ...(grooveLanes ? { grooveLanes } : {}),
  };
  if (isDefaultEnergy && isDefaultDensity && isDefaultComplexity && isDefaultVariation && isDefaultMood) {
    return baseWithWindow;
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
    ...baseWithWindow,
    ghostWeight,
    microWeight,
    velocityVariation,
    temperature,
    // Metric accent follows the FINAL velocity variation (energy + mood
    // included), so an energetic ask gets a stronger metrical shape.
    _metricAccent: metricAccentFromVelocityVariation(velocityVariation),
    // Pass hints for drums post-processing (cast to extended type)
    // These are read by generateDrumPattern if present.
    ...(intent.density !== 0.5 ? { _diceDensity: intent.density } : {}),
    ...(intent.complexity !== 0.5 ? { _diceComplexity: intent.complexity } : {}),
    ...(intent.energy !== 0.7 ? { _diceEnergy: intent.energy } : {}),
  } as GenerateOptions & {
    _diceDensity?: number;
    _diceComplexity?: number;
    _diceEnergy?: number;
  };
}

/**
 * Metric-accent strength from a FINAL velocity variation: a flat "no
 * dynamics" ask keeps the legacy random-only velocity, an expressive ask gets
 * the metrical shape. Capped at 0.75 so the written groove stays recognisable.
 *
 * Single source of truth for the curve — used by `mapIntentToOptions` (which
 * has the energy/mood-adjusted value) and by `plan.ts` (which seeds the
 * default-intent fast path).
 */
export function metricAccentFromVelocityVariation(velocityVariation: number): number {
  const v = Math.max(0, Math.min(1, Number.isFinite(velocityVariation) ? velocityVariation : 0));
  return Math.max(0, Math.min(1, (v - 0.15) * 1.1)) * 0.75;
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
