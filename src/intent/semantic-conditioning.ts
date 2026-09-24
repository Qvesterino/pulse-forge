/**
 * Text (+ user style + AUDIO REFERENCE) → 16-dim semantic conditioning vector
 * (Fázy F + #7 + reference).
 *
 * Chain: raw intent text → MiniLM embedding (semantic worker, timeout +
 * circuit breaker) → PCA projection → an installed AUDIO REFERENCE vector
 * ("sprav to ako tento WAV") forms the BASE with a mild TEXT PULL
 * (AUDIO_REF_TEXT_PULL — the WAV IS the intent, the words steer ±25%: "ten
 * beat ale tvrdší" leans the reference harder instead of being ignored),
 * then the USER STYLE VECTOR blend applies as usual (INTENT_BLEND_WEIGHT)
 * → conditioning vector for the v2 priors (drum + melodic — both consume
 * this ONE vector). Returns null when the flag is off, the text is empty,
 * the semantic model is unavailable, or the projection is degenerate — the
 * provider then falls back to the v1 genre+style one-hot prior. NEVER
 * throws.
 *
 * Memoization key = trimmed text + style-vector SIGNATURE + audio EPOCH:
 * a new ★, a dropped one, or a new reference changes the key, so
 * personalization/reference shifts recompute while repeat rolls with an
 * unchanged ledger re-embed nothing.
 */
import { embeddingConditionedMode } from "../ai/symbolic/prior-client";
import { projectEmbedding } from "../ai/symbolic/pca-projection";
import { readFavoriteLedger } from "./favorites";
import { blendSemantic, computeStyleVector, styleVectorSignature } from "./style-vector";

export type EmbedFn = (texts: string[]) => Promise<Float32Array[] | null>;

const MAX_TEXT_LENGTH = 300;
const MAX_CACHE_ENTRIES = 64;

/** With a reference installed, the prompt still pulls this much (0..1). */
export const AUDIO_REF_TEXT_PULL = 0.25;

/** Linear mix, no renormalization — same convention as blendSemantic. */
export function mixWithReference(reference: readonly number[], text: readonly number[], pull: number): number[] {
  const size = Math.min(reference.length, text.length);
  const keep = 1 - pull;
  const out = new Array<number>(size);
  for (let index = 0; index < size; index++) out[index] = keep * reference[index] + pull * text[index];
  return out;
}

const projectionCache = new Map<string, readonly number[] | null>();

let audioEpoch = 0;
let audioReferenceOverride: readonly number[] | null = null;

/**
 * Install an audio-reference conditioning vector ("sprav to ako tento WAV").
 * Null clears it. Bumps the cache epoch either way.
 */
export function setAudioReferenceConditioning(vector: readonly number[] | null): void {
  audioReferenceOverride = vector;
  audioEpoch += 1;
  projectionCache.clear();
}

/** Test/diagnostic hook: drop the memoized conditioning vectors. */
export function resetSemanticConditioning(): void {
  projectionCache.clear();
}

/**
 * The conditioning vector for raw intent text, or null when unavailable.
 * Inject `embedFn` in tests; production uses the semantic worker client.
 */
let embedOverride: EmbedFn | null = null;

/**
 * Test/shadow-A/B hook: substitute the embedder (e.g. the Node MiniLM
 * pipeline) without touching the production worker client. Cleared by
 * passing null.
 */
export function setSemanticEmbedOverride(fn: EmbedFn | null): void {
  embedOverride = fn;
}

export async function semanticConditioning(
  text: string | null | undefined,
  embedFn?: EmbedFn,
): Promise<readonly number[] | null> {
  try {
    // Lazy: keep the semantic client out of the landing-route static closure
    // (see style-vector.ts).
    const embed = embedFn ?? embedOverride ?? (await import("../ai/semantic/semantic-client")).embedTexts;
    const trimmed = (text ?? "").trim().slice(0, MAX_TEXT_LENGTH);
    // An empty prompt with a reference installed is legitimate ("🎧 REF +
    // generate") — the reference alone drives the conditioning. Without a
    // reference there is nothing to say, so empty text stays null.
    if (!trimmed && !audioReferenceOverride) return null;
    if (embeddingConditionedMode() !== "on") return null;

    const ledger = readFavoriteLedger();
    const cacheKey = `${trimmed}|${styleVectorSignature(ledger)}|${audioEpoch}`;
    if (projectionCache.has(cacheKey)) return projectionCache.get(cacheKey) ?? null;

    let projectedValid: readonly number[] | null = null;
    if (trimmed) {
      const vectors = await embed([trimmed]);
      const projected = vectors && vectors.length === 1 ? projectEmbedding(vectors[0]) : null;
      projectedValid =
        projected && projected.length > 0 && projected.every((value) => Number.isFinite(value)) ? projected : null;
    }
    // An installed audio reference is the BASE ("sprav to ako tento WAV");
    // the prompt pulls it by AUDIO_REF_TEXT_PULL instead of being replaced.
    const pure = audioReferenceOverride
      ? projectedValid
        ? mixWithReference(audioReferenceOverride, projectedValid, AUDIO_REF_TEXT_PULL)
        : audioReferenceOverride
      : projectedValid;

    let result: readonly number[] | null = null;
    if (pure) {
      const style = await computeStyleVector(ledger, embed);
      result = style ? Object.freeze(blendSemantic(pure, style)) : Object.freeze(pure);
    }

    if (projectionCache.size >= MAX_CACHE_ENTRIES) projectionCache.clear();
    projectionCache.set(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}
