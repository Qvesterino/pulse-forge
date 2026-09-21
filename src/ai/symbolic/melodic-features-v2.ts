import { MELODIC_DEGREE_CLASSES, MELODIC_DURATION_CLASSES, contourClass, durationClass } from "./melodic-features";

/**
 * melodic-features-v2 — EMBEDDING-CONDITIONED next-note contract (Fáza G).
 *
 * Replaces v1's genre one-hot (4) with a 16-dim PCA-projected MiniLM semantic
 * vector; the autoregressive context stays WHOLE. Input 41 dims:
 * semantic(16) + role(3) + step-in-bar(5) + prev_degree(8) + prev_duration(4)
 * + contour(5). (The roadmap sketch said 16+13=29, but that arithmetic drops
 * prev_degree/contour — the model's actual context — so the structural block
 * is kept at 25 instead. Replacing ONLY the conditioning block mirrors the
 * drum prior v2 exactly.)
 *
 * Heads are unchanged (degree 8 + duration 4), so the runtime softmax path is
 * shared with v1; only the manifest kind and feature layout differ.
 *
 * Contract rules (mirroring melodic-features.v1): fixed order, builder =
 * single truth, dataset imports this module, version changes = new model.
 */

export const MELV2_FEATURES_VERSION = "melodic-features-v2";

export const MELV2_SEMANTIC_DIMS = 16;

export const MELV2_FEATURE_COUNT =
  MELV2_SEMANTIC_DIMS + // semantic projection (16)
  3 + // role one-hot (bass | chord | lead)
  5 + // note start position in bar
  MELODIC_DEGREE_CLASSES + // previous degree one-hot (rest + 0..6)
  MELODIC_DURATION_CLASSES + // previous duration one-hot
  5; // contour class
// = 41 total

export interface MelodicV2FeatureInput {
  /** PCA-projected MiniLM embedding of the intent text (16 dims). */
  semantic: readonly number[];
  role: "bass" | "chord" | "lead";
  /** Note start position within the bar (cumulative durations mod 16). */
  startStep: number;
  /** Previous note's degree (-1 = rest / sequence start). */
  prevDegree: number;
  /** Previous note's duration in steps (clamped to the nearest class). */
  prevDuration: number;
  /** Degree before the previous note (-1 when unknown → contour "same"). */
  prevPrevDegree: number;
}

/** Build one fixed-order v2 next-note context row. Pure — same input ⇒ same row. */
export function buildMelodicV2FeatureRow(input: MelodicV2FeatureInput): number[] {
  const row = new Array<number>(MELV2_FEATURE_COUNT).fill(0);
  let offset = 0;

  for (let d = 0; d < MELV2_SEMANTIC_DIMS; d++) {
    row[offset + d] = input.semantic[d] ?? 0;
  }
  offset += MELV2_SEMANTIC_DIMS;

  const roleIndex = ["bass", "chord", "lead"].indexOf(input.role);
  row[offset + (roleIndex >= 0 ? roleIndex : 0)] = 1;
  offset += 3;

  const s16 = ((input.startStep % 16) + 16) % 16;
  row[offset++] = s16 / 16;
  row[offset++] = Math.sin((2 * Math.PI * s16) / 16);
  row[offset++] = Math.cos((2 * Math.PI * s16) / 16);
  row[offset++] = Math.sin((4 * Math.PI * s16) / 16);
  row[offset++] = Math.cos((4 * Math.PI * s16) / 16);

  // previous degree: -1 (rest) is class 0, degree d is class d + 1
  const prevClass = input.prevDegree < 0 ? 0 : Math.min(7, input.prevDegree + 1);
  row[offset + prevClass] = 1;
  offset += MELODIC_DEGREE_CLASSES;

  row[offset + durationClass(input.prevDuration)] = 1;
  offset += MELODIC_DURATION_CLASSES;

  const interval = input.prevDegree < 0 || input.prevPrevDegree < 0 ? 0 : input.prevDegree - input.prevPrevDegree;
  row[offset + contourClass(interval)] = 1;

  return row;
}
