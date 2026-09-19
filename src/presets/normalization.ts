import { FACTORY_PRESET_GAIN_DB } from "./preset-loudness.generated";

/**
 * Preset loudness normalization (factory-content pass).
 *
 * Every factory preset carries a measured normalization gain (see
 * `scripts/measure-preset-loudness.mjs`): the preset's probe note is rendered
 * through its real instrument factory, K-weighted loudness is measured with
 * the shared BS.1770 analyzer, and the delta to the preset's use-case-family
 * median becomes this preset's gain. The engine applies it wherever an
 * instrument chain is built (live, previews, offline renders — one source of
 * truth), so browsing presets sounds consistent and "what you audition is
 * what you apply" holds.
 *
 * Targets are per use-case family (bass / pad / lead / …): the families sit
 * at different loudness plateaus by design — normalization enforces
 * consistency WITHIN a family, not between them.
 *
 * The gain is a property of the PRESET, not of the document — no schema
 * change, no per-instance state. A preset without a measurement (user
 * presets, future additions) plays unnormalized until it is measured.
 */

/** Hard ceiling so a measurement outlier can never shred a preset's design. */
export const PRESET_GAIN_DB_LIMIT = 18;

export function clampPresetGainDb(gainDb: number): number {
  if (!Number.isFinite(gainDb)) return 0;
  return Math.max(-PRESET_GAIN_DB_LIMIT, Math.min(PRESET_GAIN_DB_LIMIT, Math.round(gainDb * 10) / 10));
}

/** Normalization gain for a preset id — measured value, clamped; 0 dB fallback. */
export function presetNormalizationGainDb(presetId: string | null | undefined): number {
  if (!presetId) return 0;
  return clampPresetGainDb(FACTORY_PRESET_GAIN_DB[presetId] ?? 0);
}

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}
