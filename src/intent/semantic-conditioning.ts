/**
 * Text (+ user style) → 16-dim semantic conditioning vector (Fázy F + #7).
 *
 * Chain: raw intent text → MiniLM embedding (semantic worker, timeout +
 * circuit breaker) → PCA projection → blended with the USER STYLE VECTOR
 * (average of the user's ★-kept rolls, INTENT_BLEND_WEIGHT intent vs style) →
 * conditioning vector for the v2 priors (drum + melodic — both consume this
 * ONE vector). Returns null when the flag is off, the text is empty, the
 * semantic model is unavailable, or the projection is degenerate — the
 * provider then falls back to the v1 genre+style one-hot prior. NEVER throws.
 *
 * Memoization key = trimmed text + style-vector SIGNATURE: a new ★ (or a
 * dropped one) changes the signature, so personalization shifts recompute
 * while repeat rolls with an unchanged ledger re-embed nothing.
 */
import { embedTexts } from "../ai/semantic/semantic-client";
import { embeddingConditionedMode } from "../ai/symbolic/prior-client";
import { projectEmbedding } from "../ai/symbolic/pca-projection";
import { readFavoriteLedger } from "./favorites";
import { blendSemantic, computeStyleVector, styleVectorSignature } from "./style-vector";

export type EmbedFn = (texts: string[]) => Promise<Float32Array[] | null>;

const MAX_TEXT_LENGTH = 300;
const MAX_CACHE_ENTRIES = 64;

const projectionCache = new Map<string, readonly number[] | null>();

/** Test/diagnostic hook: drop the memoized conditioning vectors. */
export function resetSemanticConditioning(): void {
  projectionCache.clear();
}

/**
 * The conditioning vector for raw intent text, or null when unavailable.
 * Inject `embedFn` in tests; production uses the semantic worker client.
 */
export async function semanticConditioning(
  text: string | null | undefined,
  embedFn: EmbedFn = embedTexts,
): Promise<readonly number[] | null> {
  try {
    const trimmed = (text ?? "").trim().slice(0, MAX_TEXT_LENGTH);
    if (!trimmed) return null;
    if (embeddingConditionedMode() !== "on") return null;

    const ledger = readFavoriteLedger();
    const cacheKey = `${trimmed}|${styleVectorSignature(ledger)}`;
    if (projectionCache.has(cacheKey)) return projectionCache.get(cacheKey) ?? null;

    const vectors = await embedFn([trimmed]);
    const projected = vectors && vectors.length === 1 ? projectEmbedding(vectors[0]) : null;
    const pure =
      projected && projected.length > 0 && projected.every((value) => Number.isFinite(value)) ? projected : null;

    let result: readonly number[] | null = null;
    if (pure) {
      const style = await computeStyleVector(ledger, embedFn);
      result = style ? Object.freeze(blendSemantic(pure, style)) : Object.freeze(pure);
    }

    if (projectionCache.size >= MAX_CACHE_ENTRIES) projectionCache.clear();
    projectionCache.set(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}
