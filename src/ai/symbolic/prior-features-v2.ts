import { inferPadRole } from "../pad-roles";

/**
 * prior-features-v2 — EMBEDDING-CONDITIONED drum prior contract.
 *
 * Replaces v1 genre(4)+style(21) one-hot with a 16-dim PCA-projected
 * MiniLM semantic vector. Input: 35 dims = semantic(16) + role(9) +
 * step(5) + frame(3) + flags(2).
 *
 * Contract rules (same as v1): fixed order, builder = single truth,
 * dataset imports this module, version changes = new model.
 */

export const PRIOR_V2_FEATURES_VERSION = "prior-features-v2";

export const V2_SEMANTIC_DIMS = 16;

export const V2_ROLE_VOCAB = [
  "kick", "snare", "clap", "closedHat", "openHat", "perc", "tom", "fx", "unknown",
] as const;

export const V2_FEATURE_COUNT =
  V2_SEMANTIC_DIMS + // semantic projection (16)
  V2_ROLE_VOCAB.length + // role one-hot (9)
  5 + // step-in-bar encoding
  3 + // frame position
  2; // flags
// = 35 total

export interface V2PriorFeatureInput {
  semantic: readonly number[];
  role: string;
  step: number;
  stepCount: number;
}

/** Build one fixed-order v2 feature row. Pure — same input ⇒ same row. */
export function buildPriorV2FeatureRow(input: V2PriorFeatureInput): number[] {
  const row = new Array<number>(V2_FEATURE_COUNT).fill(0);
  let offset = 0;

  // Semantic projection (16 dims, copied verbatim)
  for (let d = 0; d < V2_SEMANTIC_DIMS; d++) {
    row[offset + d] = input.semantic[d] ?? 0;
  }
  offset += V2_SEMANTIC_DIMS;

  // Role one-hot
  const roleIndex = V2_ROLE_VOCAB.indexOf(input.role as never);
  if (roleIndex >= 0) row[offset + roleIndex] = 1;
  offset += V2_ROLE_VOCAB.length;

  // Step-in-bar encoding
  const s16 = ((input.step % 16) + 16) % 16;
  row[offset++] = s16 / 16;
  row[offset++] = Math.sin((2 * Math.PI * s16) / 16);
  row[offset++] = Math.cos((2 * Math.PI * s16) / 16);
  row[offset++] = Math.sin((4 * Math.PI * s16) / 16);
  row[offset++] = Math.cos((4 * Math.PI * s16) / 16);

  // Frame position
  const frame = Math.max(16, input.stepCount);
  row[offset++] = input.step / frame;
  row[offset++] = Math.sin((2 * Math.PI * input.step) / frame);
  row[offset++] = Math.cos((2 * Math.PI * input.step) / frame);

  // Flags
  row[offset++] = s16 === 0 ? 1 : 0;
  row[offset] = s16 === 4 || s16 === 12 ? 1 : 0;

  return row;
}

/** Grid rows for a whole pattern: pads × steps, row-major. */
export function buildPriorV2GridRows(params: {
  semantic: readonly number[];
  padRoles: readonly string[];
  stepCount: number;
}): number[][] {
  const rows: number[][] = [];
  for (const role of params.padRoles) {
    for (let step = 0; step < params.stepCount; step++) {
      rows.push(buildPriorV2FeatureRow({
        semantic: params.semantic,
        role: role as V2PriorFeatureInput["role"],
        step,
        stepCount: params.stepCount,
      }));
    }
  }
  return rows;
}

export { inferPadRole };
