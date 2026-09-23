import { buildPriorFeatureRow, PRIOR_FEATURE_COUNT, type PriorFeatureInput } from "./prior-features";

/**
 * prior-features-v3 — HYBRID conditioning (semantic + one-hot TOGETHER).
 *
 * The shadow A/B (GOAL 30) found v2 (semantic-only) is complementary to v1
 * (one-hot-only): semantic sees mood-only prompt differences the one-hot is
 * blind to (distance 0 → 0.54), while the one-hot keeps sharper style
 * discrimination on explicit prompts (1.44 vs 0.54). v3 = BOTH channels:
 *
 *   input 60 dims = semantic(16) ++ v1 row(44: genre 4 + style 21 + role 9
 *                   + step 5 + frame 3 + flags 2)
 *
 * so the model keeps v1's discrete sharpness and gains v2's continuous
 * semantics. Layout is literally semantic ++ v1 row — the builder composes
 * the two existing contracts, so there is exactly ONE source of truth per
 * block. Heads unchanged (sigmoid logits); runtime shared with v1/v2.
 *
 * Contract rules: fixed order, builder = single truth, version changes =
 * new model.
 */

export const PRIOR_V3_FEATURES_VERSION = "prior-features-v3";

export const V3_SEMANTIC_DIMS = 16;

export const V3_FEATURE_COUNT = V3_SEMANTIC_DIMS + PRIOR_FEATURE_COUNT;
// = 16 + 44 = 60 total

export interface PriorV3FeatureInput {
  /** PCA-projected MiniLM embedding of the intent text (16 dims). */
  semantic: readonly number[];
  /** Canonical 4-genre vocabulary entry (PRIOR_GENRES). */
  genre: PriorFeatureInput["genre"];
  /** Groove style id from PRIOR_STYLE_VOCAB (e.g. "house.deep"). */
  styleId: string;
  role: PriorFeatureInput["role"];
  step: number;
  stepCount: number;
}

/** Build one fixed-order v3 feature row. Pure — same input ⇒ same row. */
export function buildPriorV3FeatureRow(input: PriorV3FeatureInput): number[] {
  const row = new Array<number>(V3_FEATURE_COUNT).fill(0);
  for (let d = 0; d < V3_SEMANTIC_DIMS; d++) {
    row[d] = input.semantic[d] ?? 0;
  }
  const v1 = buildPriorFeatureRow({
    genre: input.genre,
    styleId: input.styleId,
    role: input.role,
    step: input.step,
    stepCount: input.stepCount,
  });
  for (let index = 0; index < v1.length; index++) {
    row[V3_SEMANTIC_DIMS + index] = v1[index];
  }
  return row;
}

/** Grid rows for a whole pattern: pads × steps, row-major. */
export function buildPriorV3GridRows(params: {
  semantic: readonly number[];
  genre: PriorFeatureInput["genre"];
  styleId: string;
  padRoles: readonly string[];
  stepCount: number;
}): number[][] {
  const rows: number[][] = [];
  for (const role of params.padRoles) {
    for (let step = 0; step < params.stepCount; step++) {
      rows.push(
        buildPriorV3FeatureRow({
          semantic: params.semantic,
          genre: params.genre,
          styleId: params.styleId,
          role: role as PriorFeatureInput["role"],
          step,
          stepCount: params.stepCount,
        }),
      );
    }
  }
  return rows;
}
