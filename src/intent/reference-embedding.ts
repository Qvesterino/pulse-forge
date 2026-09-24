/**
 * REFERENCE-INFORMED EMBEDDING (T4 depth) — the WAV becomes a point in the
 * semantic space WITHOUT depending on the AST classifier alone.
 *
 * The first cut embedded only the top AST label WORDS as one joined string;
 * a generic or empty classifier answer meant a generic (or absent) reference
 * vector. This module builds the reference vector from BOTH sources the
 * analysis already produces:
 *
 *   1. LABEL ANCHORS — every AST label embedded separately, weighted by its
 *      posterior score (a weighted centroid honors the classifier's
 *      uncertainty instead of flattening it into one string);
 *   2. FEATURE-POLE ANCHORS — a fixed vocabulary of pole phrases per MEASURED
 *      dimension (loud↔quiet, punchy↔compressed, bright↔dark, deep↔thin,
 *      fast↔slow); each pole pair contributes a vector interpolated by the
 *      feature's activation. The SIGNAL ITSELF shapes the vector — this is
 *      what keeps the reference conditioning alive when the AST has nothing
 *      to say.
 *
 * Groups are normalized separately and mixed (0.65 labels / 0.35 poles when
 * labels exist), the 384-dim mix is unit-normalized — the same scale every
 * MiniLM output the PCA has ever seen — then projected through the existing
 * PCA. No new model, no retrain; ~10 short phrases embed once per REF click
 * and the conditioning is reused via the semantic-conditioning epoch cache.
 */
import { projectEmbedding } from "../ai/symbolic/pca-projection";
import type { AudioFeatures } from "../ai/audio-features";

export type EmbedFn = (texts: string[]) => Promise<Float32Array[] | null>;

/** Labels vs poles mix when the classifier answered (poles take the rest). */
const LABEL_SHARE_WITH_LABELS = 0.65;

export interface ReferenceEmbedInput {
  labels: ReadonlyArray<{ label: string; score: number }>;
  features: AudioFeatures;
  /** Tempo estimate gates its own pole pair by confidence. */
  tempo: { bpm: number; confidence: number } | null;
}

interface PolePair {
  /** Provenance name (status line). */
  name: string;
  low: string;
  high: string;
  /** 0 = full low pole, 1 = full high pole. */
  activation: number;
}

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);

/** Feature → pole pairs. Activations map measured values onto [0, 1]. */
export function featurePoles(input: ReferenceEmbedInput): PolePair[] {
  const { features, tempo } = input;
  const pairs: PolePair[] = [
    {
      name: "energy",
      low: "quiet soft gentle ambient pads",
      high: "loud aggressive powerful banger",
      activation: clamp01(features.rms / 0.3),
    },
    {
      name: "punch",
      low: "heavily compressed flat dense wall",
      high: "punchy dynamic drums sharp transient hits",
      activation: clamp01((features.crestFactor - 3) / 7),
    },
    {
      name: "brightness",
      low: "dark warm muffled bass",
      high: "bright crisp airy shimmering highs",
      activation: clamp01(features.zeroCrossingRate / 0.2),
    },
    {
      name: "depth",
      low: "thin light treble focused",
      high: "deep heavy sub bass weight",
      activation: clamp01((features.lowBandRatio - 0.3) / 0.5),
    },
  ];
  if (tempo && tempo.bpm > 0) {
    // Below ~0.15 confidence the autocorrelation peak is noise — the gate
    // fades the tempo poles out instead of letting a guess steer semantics.
    const gate = clamp01((tempo.confidence - 0.15) / 0.35);
    if (gate > 0) {
      pairs.push({
        name: "tempo",
        low: "slow laid back halftime groove",
        high: "fast driving energetic dance rhythm",
        activation: clamp01((tempo.bpm - 80) / 60) * gate,
      });
    }
  }
  return pairs;
}

/**
 * Weighted centroid of label + pole vectors, unit-normalized in 384-dim.
 * Exposed for the contract tests — analyzeAudioReference must produce the
 * projection of exactly this vector. Null when nothing was supplied.
 */
export function combineReferenceVector(
  labelVectors: ReadonlyArray<{ vector: ArrayLike<number>; weight: number }>,
  poleVectors: ReadonlyArray<{ vector: ArrayLike<number>; weight: number }>,
): Float32Array | null {
  const group = (entries: ReadonlyArray<{ vector: ArrayLike<number>; weight: number }>): Float32Array | null => {
    let total = 0;
    for (const entry of entries) if (Number.isFinite(entry.weight) && entry.weight > 0) total += entry.weight;
    if (total <= 0 || entries.length === 0) return null;
    const size = entries[0]!.vector.length;
    const out = new Float32Array(size);
    for (const entry of entries) {
      if (!(Number.isFinite(entry.weight) && entry.weight > 0)) continue;
      for (let index = 0; index < size; index++) out[index] += (entry.weight / total) * entry.vector[index];
    }
    return out;
  };
  const labels = group(labelVectors);
  const poles = group(poleVectors);
  const mix = new Float32Array(labels?.length ?? poles?.length ?? 0);
  if (mix.length === 0) return null;
  const labelShare = labels ? (poles ? LABEL_SHARE_WITH_LABELS : 1) : 0;
  const poleShare = 1 - labelShare;
  for (let index = 0; index < mix.length; index++) {
    mix[index] = labelShare * (labels?.[index] ?? 0) + poleShare * (poles?.[index] ?? 0);
  }
  let norm = 0;
  for (const value of mix) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm <= 0) return null;
  for (let index = 0; index < mix.length; index++) mix[index] /= norm;
  return mix;
}

export interface ReferenceEmbeddingResult {
  /** 16-dim corpus-space conditioning vector. */
  projected: readonly number[];
  /** Human-readable provenance: label words + active feature poles. */
  text: string;
}

/**
 * Embed all anchor texts in ONE batch call (labels + pole phrases), combine,
 * project. Null when the embedder is unavailable or nothing could combine —
 * never throws.
 */
export async function buildReferenceEmbedding(
  input: ReferenceEmbedInput,
  embed: EmbedFn,
): Promise<ReferenceEmbeddingResult | null> {
  try {
    const poles = featurePoles(input);
    const labelEntries = input.labels
      .filter((entry) => Number.isFinite(entry.score) && entry.score > 0 && entry.label.trim().length > 0)
      .slice(0, 8);
    const texts = [...labelEntries.map((entry) => entry.label), ...poles.flatMap((pole) => [pole.low, pole.high])];
    if (texts.length === 0) return null;
    const vectors = await embed(texts);
    if (!vectors || vectors.length !== texts.length) return null;

    const labelVectors = labelEntries.map((entry, index) => ({ vector: vectors[index]!, weight: entry.score }));
    const poleVectors: Array<{ vector: ArrayLike<number>; weight: number }> = [];
    for (let pole = 0; pole < poles.length; pole++) {
      const low = vectors[labelEntries.length + pole * 2]!;
      const high = vectors[labelEntries.length + pole * 2 + 1]!;
      const activation = poles[pole]!.activation;
      if (low.length !== high.length || high.length === 0) continue;
      const interpolated = new Float32Array(high.length);
      for (let index = 0; index < high.length; index++) {
        interpolated[index] = (1 - activation) * low[index]! + activation * high[index]!;
      }
      poleVectors.push({ vector: interpolated, weight: 1 });
    }

    const mix = combineReferenceVector(labelVectors, poleVectors);
    if (!mix) return null;
    const projected = projectEmbedding(mix);
    if (!projected) return null;

    const labelWords = labelEntries.map((entry) => entry.label).join(" ");
    const poleWords = poles
      .filter((pole) => pole.activation > 0.05 && pole.activation < 0.95)
      .map((pole) => `${pole.name} ${(pole.activation * 100).toFixed(0)}%`);
    const text = [labelWords, poleWords.length > 0 ? `poles: ${poleWords.join(", ")}` : null]
      .filter(Boolean)
      .join(" — ");
    return { projected, text: text || "features only" };
  } catch {
    return null;
  }
}
