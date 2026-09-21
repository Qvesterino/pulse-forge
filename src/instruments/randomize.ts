import type { InstrumentKind } from "../project-model/types";
import { mulberry32 } from "../shared/rng";
import { clampInstrumentParam, INSTRUMENT_META } from "./definitions";

/**
 * Musically-constrained randomize for instrument tracks.
 *
 * mutate — ±12 % of each parameter's range around the CURRENT value:
 * a tasteful nudge that keeps the patch's identity.
 * deep  — full-range redraw; cutoff/tone use a logarithmic distribution
 * (musically centred), options (waves, shapes, filter mode) re-roll freely.
 *
 * NEVER randomized: level / gain (loudness stays under the user's control)
 * and per-instrument anchors (sampler root note). Deterministic per seed.
 */

export type RandomizeMode = "mutate" | "deep";

const NEVER_RANDOMIZE = new Set(["level", "gain"]);

/** Params that sound right when drawn on a logarithmic scale. */
const LOG_SCALE = new Set(["cutoff", "tone"]);

const EXCLUDE: Partial<Record<InstrumentKind, string[]>> = {
  sampler: ["root"], // root note anchors the sampled instrument's pitch
};

export function randomizeParams(
  instrument: InstrumentKind,
  current: Record<string, number>,
  mode: RandomizeMode,
  seed: number,
): Record<string, number> {
  const rand = mulberry32(seed);
  const def = INSTRUMENT_META[instrument];
  const skip = new Set([...NEVER_RANDOMIZE, ...(EXCLUDE[instrument] ?? [])]);
  const out: Record<string, number> = {};
  for (const p of def.params) {
    if (skip.has(p.id)) {
      out[p.id] = current[p.id] ?? p.default;
      continue;
    }
    if (p.options && p.options.length > 0) {
      if (mode === "mutate") {
        out[p.id] = current[p.id] ?? p.default;
        continue;
      }
      out[p.id] = p.options[Math.floor(rand() * p.options.length)].value;
      continue;
    }
    const range = p.max - p.min;
    if (mode === "mutate") {
      const cur = current[p.id] ?? p.default;
      out[p.id] = cur + (rand() * 2 - 1) * 0.12 * range;
    } else if (LOG_SCALE.has(p.id) && p.min > 0) {
      out[p.id] = Math.exp(Math.log(p.min) + rand() * (Math.log(p.max) - Math.log(p.min)));
    } else {
      out[p.id] = p.min + rand() * range;
    }
  }
  for (const id of Object.keys(out)) {
    out[id] = clampInstrumentParam(instrument, id, out[id]);
  }
  return out;
}
