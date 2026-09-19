import type { GenerateOptions } from "../types";

/**
 * melodic-features.v1 — the fixed, versioned input contract for the symbolic
 * MELODIC prior ONNX model (INTENT_ENGINE.md T2 v2).
 *
 * Unlike the drum prior (per-step hit probability), melody is note-sequential,
 * so this is a NEXT-NOTE model: one row describes the context before a note —
 * "given genre, role, rhythmic position, the previous note's degree/duration
 * and the contour into it, which degree and duration comes next?".
 *
 * Outputs (heads): DEGREE_CLASSES (rest + scale degrees 0..6) and
 * DURATION_CLASSES (1, 2, 4, 8 steps). Degrees are SCALE-RELATIVE, so any
 * sample is in-key by construction — the provider maps degree → pitch through
 * the same root+intervals math as the template engine.
 *
 * Contract rules (mirroring prior-features.v1):
 * - fixed feature order; `buildMelodicFeatureRow` is the single source of truth;
 * - the dataset script IMPORTS this module, so trainer data cannot drift;
 * - changing order/count/normalization = new feature version + new model.
 */

export const MELODIC_FEATURES_VERSION = "melodic-features.v1";

export const MELODIC_GENRES = ["house", "techno", "trap", "ambient"] as const;
export type MelodicGenre = (typeof MELODIC_GENRES)[number];

export const MELODIC_ROLE_VOCAB = ["bass", "chord", "lead"] as const;
export type MelodicRole = (typeof MELODIC_ROLE_VOCAB)[number];

/** Degree head classes: index 0 = rest (degree -1), 1..7 = degrees 0..6. */
export const MELODIC_DEGREE_CLASSES = 8;

/** Duration head classes in steps. */
export const MELODIC_DURATION_VALUES = [1, 2, 4, 8] as const;
export const MELODIC_DURATION_CLASSES = MELODIC_DURATION_VALUES.length;

export const MELODIC_FEATURE_COUNT =
  MELODIC_GENRES.length + // genre one-hot
  MELODIC_ROLE_VOCAB.length + // role one-hot
  5 + // note start position in bar: s16/16, sin/cos(2π·s16/16), sin/cos(4π·s16/16)
  MELODIC_DEGREE_CLASSES + // previous degree one-hot (rest + 0..6)
  MELODIC_DURATION_CLASSES + // previous duration one-hot
  5; // contour class: big-down ≤-3, down -2..-1, same 0, up 1..2, big-up ≥3

export interface MelodicFeatureInput {
  genre: MelodicGenre;
  role: MelodicRole;
  /** Note start position within the bar (cumulative durations mod 16). */
  startStep: number;
  /** Previous note's degree (-1 = rest / sequence start). */
  prevDegree: number;
  /** Previous note's duration in steps (clamped to the nearest class). */
  prevDuration: number;
  /** Degree before the previous note (-1 when unknown → contour "same"). */
  prevPrevDegree: number;
}

function oneHot(values: readonly string[], value: string, offset: number, row: number[]): void {
  const index = values.indexOf(value);
  row[offset + (index >= 0 ? index : 0)] = 1;
}

/** Duration → class index, clamped to the nearest known class. */
export function durationClass(duration: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < MELODIC_DURATION_VALUES.length; index++) {
    const distance = Math.abs(MELODIC_DURATION_VALUES[index] - duration);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

/** Contour class index for the interval prev - prevPrev (0..4). */
export function contourClass(interval: number): number {
  if (interval <= -3) return 0;
  if (interval <= -1) return 1;
  if (interval === 0) return 2;
  if (interval <= 2) return 3;
  return 4;
}

/** Build one fixed-order next-note context row. Pure — same input ⇒ same row. */
export function buildMelodicFeatureRow(input: MelodicFeatureInput): number[] {
  const row = new Array<number>(MELODIC_FEATURE_COUNT).fill(0);
  let offset = 0;

  oneHot(MELODIC_GENRES, input.genre, offset, row);
  offset += MELODIC_GENRES.length;

  oneHot(MELODIC_ROLE_VOCAB, input.role, offset, row);
  offset += MELODIC_ROLE_VOCAB.length;

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

/** Map generation options to the melodic prior's genre vocabulary. */
export function melodicGenreOf(genre: GenerateOptions["genre"]): MelodicGenre {
  return (MELODIC_GENRES as readonly string[]).includes(genre) ? (genre as MelodicGenre) : "house";
}
