import type { ChordEvent } from "../harmony";

/**
 * melodic-features.v3 — harmony-aware next-note context (W1,
 * docs/intent-killer-feature-plan.md).
 *
 * Extends the v1 contract with chord context, harmonic position and motif
 * memory. The model now knows:
 *   - which chord it's on (root degree + quality + harmonic function),
 *   - where it's going (next chord root = resolution target),
 *   - how its rhythm syncopates against the chord boundary,
 *   - whether it's repeating a motif (identity across phrases).
 *
 * The v1 base features (genre, role, position, prev degree/duration,
 * contour) are REUSED verbatim so the dataset can mix v1 and v3 rows
 * (v3 rows are a superset; the model just ignores the extra columns).
 *
 * Contract rules (same as v1):
 * - fixed feature order; buildMelodicFeatureRowV3 is the single source of truth;
 * - the dataset script IMPORTS this module — trainer data cannot drift;
 * - changing order/count/normalization = new feature version + new model.
 */

import {
  MELODIC_GENRES,
  MELODIC_ROLE_VOCAB,
  MELODIC_DEGREE_CLASSES,
  MELODIC_DURATION_CLASSES,
  durationClass,
  contourClass,
} from "./melodic-features";
import type { MelodicGenre, MelodicRole } from "./melodic-features";

export const MELODIC_FEATURES_VERSION_V3 = "melodic-features.v3";

/** Chord quality one-hot vocabulary (8 classes from harmony.ts). */
export const CHORD_QUALITY_VOCAB = ["maj", "min", "dim", "dom7", "maj7", "min7", "sus4", "sus2"] as const;

/** Harmonic function one-hot vocabulary (4 classes from harmony.ts). */
export const HARMONIC_FUNCTION_VOCAB = ["T", "S", "D", "p"] as const;

/** Motif embedding dimension (learnable — the model learns motif identity). */
export const MOTIF_EMBEDDING_DIM = 8;

export const MELODIC_V3_FEATURE_COUNT =
  // ── v1 base (verbatim reuse) ──
  MELODIC_GENRES.length +
  MELODIC_ROLE_VOCAB.length +
  5 + // position sin/cos
  MELODIC_DEGREE_CLASSES +
  MELODIC_DURATION_CLASSES +
  5 + // contour
  // ── v3 harmony context ──
  MELODIC_DEGREE_CLASSES + // current chord root one-hot
  CHORD_QUALITY_VOCAB.length + // current chord quality one-hot
  HARMONIC_FUNCTION_VOCAB.length + // current harmonic function one-hot
  MELODIC_DEGREE_CLASSES + // next chord root one-hot (resolution target)
  3 + // position in chord slot: sin/cos(2π·pos/dur), fraction in [0,1)
  MOTIF_EMBEDDING_DIM; // motif identity (deterministic hash → fixed dim)

export interface MelodicFeatureInputV3 {
  /** v1 base fields (reused verbatim). */
  genre: MelodicGenre;
  role: MelodicRole;
  startStep: number;
  prevDegree: number;
  prevDuration: number;
  prevPrevDegree: number;
  /** Current chord the note lands on (from expandProgression). */
  chord: ChordEvent;
  /** Next chord in the progression (for resolution targeting). */
  nextChord: ChordEvent | null;
  /** Steps into the current chord (0 = chord boundary). */
  stepsIntoChord: number;
  /** Deterministic motif id — same motif = same hash = same embedding input. */
  motifId: number;
}

function oneHot(values: readonly string[], value: string, offset: number, row: number[]): void {
  const index = values.indexOf(value);
  row[offset + (index >= 0 ? index : 0)] = 1;
}

function oneHotDegree(degree: number, offset: number, row: number[]): void {
  const cls = degree < 0 ? 0 : Math.min(7, degree + 1);
  row[offset + cls] = 1;
}

/** Deterministic motif hash → fixed-dim pseudo-embedding. Same motif id →
 * same values every time (pure, no model weights needed for the input). */
function motifEmbedding(motifId: number): number[] {
  const out = new Array<number>(MOTIF_EMBEDDING_DIM).fill(0);
  let hash = motifId * 2654435761; // Knuth multiplicative hash
  for (let i = 0; i < MOTIF_EMBEDDING_DIM; i++) {
    hash = (hash * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (hash / 0x7fffffff) * 2 - 1; // [-1, 1]
  }
  return out;
}

/** Build one harmony-aware next-note context row (v3 superset of v1). Pure. */
export function buildMelodicFeatureRowV3(input: MelodicFeatureInputV3): number[] {
  const row = new Array<number>(MELODIC_V3_FEATURE_COUNT).fill(0);
  let offset = 0;

  // ── v1 base: genre one-hot ──
  oneHot(MELODIC_GENRES, input.genre, offset, row);
  offset += MELODIC_GENRES.length;

  // ── v1 base: role one-hot ──
  oneHot(MELODIC_ROLE_VOCAB, input.role, offset, row);
  offset += MELODIC_ROLE_VOCAB.length;

  // ── v1 base: position sin/cos ──
  const s16 = ((input.startStep % 16) + 16) % 16;
  row[offset++] = s16 / 16;
  row[offset++] = Math.sin((2 * Math.PI * s16) / 16);
  row[offset++] = Math.cos((2 * Math.PI * s16) / 16);
  row[offset++] = Math.sin((4 * Math.PI * s16) / 16);
  row[offset++] = Math.cos((4 * Math.PI * s16) / 16);

  // ── v1 base: previous degree one-hot ──
  const prevClass = input.prevDegree < 0 ? 0 : Math.min(7, input.prevDegree + 1);
  row[offset + prevClass] = 1;
  offset += MELODIC_DEGREE_CLASSES;

  // ── v1 base: previous duration one-hot ──
  row[offset + durationClass(input.prevDuration)] = 1;
  offset += MELODIC_DURATION_CLASSES;

  // ── v1 base: contour class ──
  const interval = input.prevDegree < 0 || input.prevPrevDegree < 0 ? 0 : input.prevDegree - input.prevPrevDegree;
  row[offset + contourClass(interval)] = 1;
  offset += 5;

  // ── v3: current chord root one-hot ──
  oneHotDegree(input.chord.degree, offset, row);
  offset += MELODIC_DEGREE_CLASSES;

  // ── v3: chord quality one-hot ──
  oneHot(CHORD_QUALITY_VOCAB, input.chord.quality, offset, row);
  offset += CHORD_QUALITY_VOCAB.length;

  // ── v3: harmonic function one-hot (T/S/D/p) ──
  oneHot(HARMONIC_FUNCTION_VOCAB, input.chord.func, offset, row);
  offset += HARMONIC_FUNCTION_VOCAB.length;

  // ── v3: next chord root one-hot (resolution target) ──
  if (input.nextChord) oneHotDegree(input.nextChord.degree, offset, row);
  offset += MELODIC_DEGREE_CLASSES;

  // ── v3: position within chord (syncopation vs harmony) ──
  const frac = input.chord.duration > 0 ? input.stepsIntoChord / input.chord.duration : 0;
  row[offset++] = frac;
  row[offset++] = Math.sin(2 * Math.PI * frac);
  row[offset++] = Math.cos(2 * Math.PI * frac);

  // ── v3: motif embedding ──
  const motif = motifEmbedding(input.motifId);
  for (let i = 0; i < MOTIF_EMBEDDING_DIM; i++) row[offset + i] = motif[i];

  return row;
}

/** Map a step index to its chord event + steps-into-chord. The expanded
 * progression is a flat list of ChordEvents; this does the lookup. */
export function chordAtStep(
  expanded: ChordEvent[],
  step: number,
): { chord: ChordEvent; nextChord: ChordEvent | null; stepsIntoChord: number } {
  let cursor = 0;
  for (let i = 0; i < expanded.length; i++) {
    const chord = expanded[i]!;
    if (step >= cursor && step < cursor + chord.duration) {
      return {
        chord,
        nextChord: expanded[(i + 1) % expanded.length] ?? null,
        stepsIntoChord: step - cursor,
      };
    }
    cursor += chord.duration;
  }
  // past the end — wrap to the first chord
  return { chord: expanded[0]!, nextChord: expanded[1] ?? null, stepsIntoChord: 0 };
}
