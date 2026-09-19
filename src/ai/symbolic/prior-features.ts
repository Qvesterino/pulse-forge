import type { PadRole } from "../pad-roles";
import { inferPadRole } from "../pad-roles";
import type { GenerateOptions } from "../types";

/**
 * prior-features.v1 — the fixed, versioned input contract for the symbolic
 * drum-prior ONNX model (T2 of INTENT_ENGINE.md).
 *
 * ONE row describes one (pad, step) request: "how likely is a hit for this
 * pad role at this position in this genre/style?". The model is a learned
 * prior over the groove LIBRARY — it interpolates between template variations
 * so sampled patterns are style-consistent yet novel. It never sees runtime
 * randomness; sampling/thresholding happens in the provider with seeded RNG.
 *
 * Contract rules (mirroring features.v1):
 * - fixed feature order; `buildPriorFeatureRow` is the single source of truth;
 * - the dataset script IMPORTS this module, so the trainer data can never
 *   drift from the runtime layout;
 * - changing order/count/normalization = new feature version + new model.
 */

export const PRIOR_FEATURES_VERSION = "prior-features.v1";

export const PRIOR_GENRES = ["house", "techno", "trap", "ambient"] as const;
export type PriorGenre = (typeof PRIOR_GENRES)[number];

/** Groove ids the model was trained on — must match GROOVE_LIBRARY exactly. */
export const PRIOR_STYLE_VOCAB = [
  "house.driving",
  "house.minimal",
  "house.funky",
  "house.deep",
  "house.ukg",
  "house.afro",
  "techno.driving",
  "techno.minimal",
  "techno.industrial",
  "techno.dub",
  "techno.acid",
  "trap.classic",
  "trap.rolling",
  "trap.sparse",
  "trap.bouncy",
  "ambient.drifting",
  "ambient.glitch",
  "ambient.organic",
  "hybrid.techhouse",
  "hybrid.ambienttechno",
  "hybrid.lofimap",
] as const;
export type PriorStyleId = (typeof PRIOR_STYLE_VOCAB)[number];

export const PRIOR_ROLE_VOCAB = [
  "kick",
  "snare",
  "clap",
  "closedHat",
  "openHat",
  "perc",
  "tom",
  "fx",
  "unknown",
] as const;

export const PRIOR_FEATURE_COUNT =
  PRIOR_GENRES.length + // genre one-hot
  PRIOR_STYLE_VOCAB.length + // style one-hot
  PRIOR_ROLE_VOCAB.length + // pad role one-hot
  5 + // step-in-bar: s16/16, sin/cos(2π·s16/16), sin/cos(4π·s16/16)
  3 + // frame position: step/stepCount, sin/cos(2π·step/stepCount)
  2; // flags: isDownbeat, isBackbeat

export interface PriorFeatureInput {
  genre: PriorGenre;
  /** Groove id from PRIOR_STYLE_VOCAB, e.g. "house.deep". */
  styleId: string;
  role: PadRole;
  /** Absolute step within the pattern frame (0..stepCount-1). */
  step: number;
  /** Pattern frame length in steps (multiple of 16). */
  stepCount: number;
}

function oneHot(values: readonly string[], value: string, offset: number, row: number[]): void {
  const index = values.indexOf(value);
  row[offset + (index >= 0 ? index : 0)] = 1;
}

/**
 * Build one fixed-order feature row. Pure — same input ⇒ same row.
 * Unknown style/role fall back to index 0 with the one-hot still set (the
 * model saw index 0 classes during training; presence beats absence).
 */
export function buildPriorFeatureRow(input: PriorFeatureInput): number[] {
  const row = new Array<number>(PRIOR_FEATURE_COUNT).fill(0);
  let offset = 0;

  oneHot(PRIOR_GENRES, input.genre, offset, row);
  offset += PRIOR_GENRES.length;

  oneHot(PRIOR_STYLE_VOCAB, input.styleId, offset, row);
  offset += PRIOR_STYLE_VOCAB.length;

  const role = PRIOR_ROLE_VOCAB.includes(input.role as (typeof PRIOR_ROLE_VOCAB)[number])
    ? input.role
    : "unknown";
  oneHot(PRIOR_ROLE_VOCAB, role, offset, row);
  offset += PRIOR_ROLE_VOCAB.length;

  const s16 = ((input.step % 16) + 16) % 16;
  row[offset++] = s16 / 16;
  row[offset++] = Math.sin((2 * Math.PI * s16) / 16);
  row[offset++] = Math.cos((2 * Math.PI * s16) / 16);
  row[offset++] = Math.sin((4 * Math.PI * s16) / 16);
  row[offset++] = Math.cos((4 * Math.PI * s16) / 16);

  const frame = Math.max(16, input.stepCount);
  row[offset++] = input.step / frame;
  row[offset++] = Math.sin((2 * Math.PI * input.step) / frame);
  row[offset++] = Math.cos((2 * Math.PI * input.step) / frame);

  row[offset++] = s16 === 0 ? 1 : 0;
  row[offset] = s16 === 4 || s16 === 12 ? 1 : 0;
  return row;
}

/** Standard-kit pad index → role, using the shared pad-role classifier. */
export function padRoleForIndex(padIndex: number, padNames: readonly string[] | undefined): PadRole {
  return inferPadRole(padNames?.[padIndex], padIndex);
}

/** Map generation options to the prior's genre vocabulary. */
export function priorGenreOf(genre: GenerateOptions["genre"]): PriorGenre {
  return (PRIOR_GENRES as readonly string[]).includes(genre) ? (genre as PriorGenre) : "house";
}

/** Feature rows for a whole drum grid: pads × steps, row-major. */
export function buildPriorGridRows(params: {
  genre: PriorGenre;
  styleId: string;
  stepCount: number;
  padRoles: readonly PadRole[];
}): number[][] {
  const rows: number[][] = [];
  for (const role of params.padRoles) {
    for (let step = 0; step < params.stepCount; step++) {
      rows.push(buildPriorFeatureRow({ genre: params.genre, styleId: params.styleId, role, step, stepCount: params.stepCount }));
    }
  }
  return rows;
}
