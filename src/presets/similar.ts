import { INSTRUMENT_DEFS } from "../instruments/registry";
import type { InstrumentTrack } from "../project-model/types";
import type { InstrumentPreset } from "./types";

export interface SimilarPreset {
  preset: InstrumentPreset;
  /** 1 = identical shared params, 0 = maximally far. */
  similarity: number;
}

/**
 * "Similar to this patch" — rank factory/user presets of the SAME instrument
 * by mean normalized parameter distance to the track's current params.
 *
 * - Distance is measured over the instrument's numeric ParamDefs, normalized
 *   by each param's range so Hz/C/%/dB live on one scale.
 * - Params a preset omits count as the instrument default (factory presets
 *   store sparse maps), so sparse presets compare fairly.
 * - Same instrument only — cross-instrument "similar" is a different product.
 * - Deterministic: ties break by preset id.
 */
export function rankSimilarPresets(
  candidates: InstrumentPreset[],
  track: InstrumentTrack,
  limit = 12,
): SimilarPreset[] {
  const defs = INSTRUMENT_DEFS[track.instrument].params;
  const scored: SimilarPreset[] = [];
  for (const preset of candidates) {
    if (preset.instrument !== track.instrument) continue;
    if (preset.id === track.presetId) continue;
    let sum = 0;
    for (const def of defs) {
      const range = Math.max(1e-9, def.max - def.min);
      const current = track.params[def.id] ?? def.default;
      const candidate = preset.params[def.id] ?? def.default;
      sum += Math.min(1, Math.abs(current - candidate) / range);
    }
    const similarity = Math.max(0, Math.min(1, 1 - sum / Math.max(1, defs.length)));
    scored.push({ preset, similarity });
  }
  scored.sort((a, b) => b.similarity - a.similarity || a.preset.id.localeCompare(b.preset.id));
  return scored.slice(0, limit);
}
