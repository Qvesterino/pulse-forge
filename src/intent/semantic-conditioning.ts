/**
 * Text → 16-dim semantic conditioning vector (embedding-conditioning Fáza F).
 *
 * Chain: raw intent text → MiniLM embedding (semantic worker, timeout +
 * circuit breaker) → PCA projection → conditioning vector for the v2 drum
 * prior. Returns null when the flag is off, the text is empty, the semantic
 * model is unavailable, or the projection is degenerate — the provider then
 * falls back to the v1 genre+style one-hot prior. NEVER throws.
 *
 * Projections are memoized per trimmed text: generation re-embeds nothing on
 * repeat rolls with the same prompt (determinism is preserved upstream by the
 * seeded candidate loop regardless).
 */
import { embedTexts } from "../ai/semantic/semantic-client";
import { embeddingConditionedMode } from "../ai/symbolic/prior-client";
import { projectEmbedding } from "../ai/symbolic/pca-projection";

export type EmbedFn = (texts: string[]) => Promise<Float32Array[] | null>;

const MAX_TEXT_LENGTH = 300;
const MAX_CACHE_ENTRIES = 64;

const projectionCache = new Map<string, readonly number[] | null>();

/** Test/diagnostic hook: drop the memoized projections. */
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
    if (projectionCache.has(trimmed)) return projectionCache.get(trimmed) ?? null;

    const vectors = await embedFn([trimmed]);
    const projected = vectors && vectors.length === 1 ? projectEmbedding(vectors[0]) : null;
    const result =
      projected && projected.length > 0 && projected.every((value) => Number.isFinite(value))
        ? Object.freeze(projected)
        : null;

    if (projectionCache.size >= MAX_CACHE_ENTRIES) projectionCache.clear();
    projectionCache.set(trimmed, result);
    return result;
  } catch {
    return null;
  }
}
