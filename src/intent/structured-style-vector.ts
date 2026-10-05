/**
 * MOBILE-FRIENDLY SEMANTIC FALLBACK (2026-09-28).
 *
 * THE PROBLEM: the v3 semantic channel is the only escape from the v1
 * one-hot drum prior, whose vocabulary covers 21 of the 170 library grooves —
 * 88% of generations fall back to template drums without it. But the channel
 * is driven by a 129 MB MiniLM (112.8 MB q8 model + 16.3 MB tokenizer with a
 * 250 002-word multilingual vocab), so `semanticMode()` opts OUT on any
 * device reporting <= 4 GB RAM or save-data. That is a deliberate,
 * correct call for a full neural embed — and it lands exactly on the users
 * who most need the v3 channel, because they are the ones who cannot afford
 * a neural embed.
 *
 * THE FIX: this module resolves a conditioning vector from the data that is
 * ALREADY IN THE REPO — `scripts/data/style-embeddings.json`, 170 groove
 * styles x 16 dims, in the same PCA space the priors consume. It costs one
 * JSON import (a few hundred KB gzipped) and zero MB of model, so it works on
 * a phone, a metered connection, and a cold first load.
 *
 * WHAT IT IS NOT: a replacement for the embedder. The MiniLM path reads free
 * text ("darker, less hats, more space") that no lookup table can interpret.
 * This resolves the STRUCTURED half of the signal — genre, style, and the
 * artist profile's own genres — which is what a "travis scott type beat"
 * request is made of, and it is the half the v3 drum prior actually needs
 * to pick a pocket. Free-text steering still needs the model; on a phone
 * that steering is simply unavailable and the structured path carries the run.
 *
 * This is also the honest answer to "why is 88% of the library on template
 * fallback for low-memory users": not because the signal is missing, but
 * because the encoder was the only way to reach it.
 */
import STYLE_EMBEDDINGS from "../../scripts/data/style-embeddings.json";
import type { IntentGenre } from "./types";

/** The 16 dims the v2/v3 priors consume; matches PCA_OUTPUT_DIMS. */
export const STYLE_VECTOR_DIMS = 16 as const;

type StyleTable = Readonly<Record<string, readonly number[]>>;

const TABLE: StyleTable = (STYLE_EMBEDDINGS as { styles: Record<string, number[]> }).styles;
const TABLE_VERSION: string = (STYLE_EMBEDDINGS as { version: string }).version;

/** Exposed for diagnostics: which style-embedding table is compiled in. */
export function styleEmbeddingVersion(): string {
  return TABLE_VERSION;
}

function vectorFor(id: string): readonly number[] | null {
  const vector = TABLE[id];
  if (!vector || vector.length !== STYLE_VECTOR_DIMS) return null;
  for (const value of vector) if (!Number.isFinite(value)) return null;
  return vector;
}

/**
 * Style ids that belong to a genre, e.g. "house" -> ["house.driving", ...].
 *
 * The table is keyed "<genre>.<style>", so the prefix split is enough and
 * avoids hard-coding a genre list that would drift from the groove library.
 */
function styleIdsForGenre(genre: string): string[] {
  const prefix = `${genre}.`;
  return Object.keys(TABLE).filter((id) => id.startsWith(prefix));
}

/** Mean of a non-empty list, all entries already in PCA space. */
function meanOf(vectors: readonly (readonly number[])[]): number[] | null {
  if (vectors.length === 0) return null;
  const out = new Array<number>(STYLE_VECTOR_DIMS).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < STYLE_VECTOR_DIMS; i++) out[i] += vector[i];
  }
  for (let i = 0; i < STYLE_VECTOR_DIMS; i++) out[i] /= vectors.length;
  return out;
}

/**
 * Conditioning vector for an explicit style, e.g. "deep" + genre "house"
 * -> the "house.deep" row. Returns null when the style is not in the table
 * (a groove family added after this table was generated), so the caller can
 * fall through to the genre mean rather than silently scoring zeros.
 */
export function styleVectorForStyle(genre: IntentGenre | string, style: string): number[] | null {
  const normalized = style.toLowerCase().replace(/\s+/g, "");
  const direct = vectorFor(`${genre}.${normalized}`);
  if (direct) return [...direct];
  // A style may be written with its genre already attached ("house.deep").
  if (normalized.includes(".")) {
    const asId = vectorFor(normalized);
    if (asId) return [...asId];
  }
  return null;
}

/**
 * Conditioning vector for a genre with no style named: the mean of every
 * style row in that genre, which is the genre's centre in the same 16-dim
 * space. Falls back to the house mean only when the genre itself is absent
 * from the table, mirroring the groove library's own unknown-genre fallback.
 */
export function styleVectorForGenre(genre: IntentGenre | string): number[] | null {
  const ids = styleIdsForGenre(genre);
  const vectors = ids.map(vectorFor).filter((vector): vector is readonly number[] => vector !== null);
  const mean = meanOf(vectors);
  if (mean) return mean;
  const house = meanOf(styleIdsForGenre("house").map(vectorFor).filter(Boolean) as number[][]);
  return house;
}

/**
 * The structured conditioning vector for an intent: an explicit style wins,
 * otherwise the genre centre. Returns null when neither resolves, which the
 * caller must treat as "no semantic channel" rather than as a zero vector —
 * feeding zeros into the prior would bias every pad toward silence.
 */
export function structuredStyleVector(input: { genre: IntentGenre | string; style?: string | null }): number[] | null {
  const style = input.style?.trim();
  if (style) {
    const byStyle = styleVectorForStyle(input.genre, style);
    if (byStyle) return byStyle;
  }
  return styleVectorForGenre(input.genre);
}
