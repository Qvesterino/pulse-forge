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
import {
  ARTIST_SIGNATURE_PULL,
  artistSignatureSignature,
  artistSignatureText,
  hasArtistSignature,
} from "./artist-signature";
import { getArtistProfile, normalizeArtistSlug, type ArtistProfile } from "./artist-profiles";
import type { IntentSpec } from "./types";

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
  /**
   * Optional artist profile (Phase 2 slice 4). When present and it carries a
   * signature, the profile's sound description seeds the conditioning vector
   * as the BASE and the typed words pull it by ARTIST_SIGNATURE_PULL — the
   * same relationship an installed audio reference has to the text. Omit it
   * (the common case: no artist matched) and the chain is byte-identical to
   * the pre-slice behaviour.
   */
  artist?: ArtistProfile | null,
): Promise<readonly number[] | null> {
  try {
    // Lazy: keep the semantic client out of the landing-route static closure
    // (see style-vector.ts).
    const embed = embedFn ?? embedOverride ?? (await import("../ai/semantic/semantic-client")).embedTexts;
    const trimmed = (text ?? "").trim().slice(0, MAX_TEXT_LENGTH);
    const seedingProfile = hasArtistSignature(artist) ? artist : null;
    const signatureText = seedingProfile ? artistSignatureText(seedingProfile) : "";
    // An empty prompt with a reference OR an artist signature installed is
    // legitimate ("🎧 REF + generate", "travis scott type beat" where the
    // user only typed the name) — the base alone drives the conditioning.
    // Without either there is nothing to say, so empty text stays null.
    if (!trimmed && !audioReferenceOverride && !seedingProfile) return null;
    if (embeddingConditionedMode() !== "on") return null;

    const ledger = readFavoriteLedger();
    const cacheKey = `${trimmed}|${styleVectorSignature(ledger)}|${audioEpoch}|${
      seedingProfile ? artistSignatureSignature(seedingProfile) : "no-artist"
    }`;
    if (projectionCache.has(cacheKey)) return projectionCache.get(cacheKey) ?? null;

    // Embed the typed text and the artist signature in ONE batched call so the
    // seeding costs no extra worker round-trip. The encoder sees two
    // sentences; each is projected independently below.
    const embedInputs: string[] = [];
    if (trimmed) embedInputs.push(trimmed);
    if (signatureText) embedInputs.push(signatureText);
    const vectors = embedInputs.length ? await embed(embedInputs) : null;

    let projectedValid: readonly number[] | null = null;
    if (trimmed && vectors) {
      const textVec = vectors[0];
      const projected = textVec ? projectEmbedding(textVec) : null;
      projectedValid =
        projected && projected.length > 0 && projected.every((value) => Number.isFinite(value)) ? projected : null;
    }

    // Artist signature as the BASE, the typed words pulling it (Phase 2
    // slice 4). When there is no typed text the signature IS the vector.
    let artistBased: readonly number[] | null = null;
    if (seedingProfile && vectors) {
      const signatureVec = vectors[trimmed ? 1 : 0];
      const projected = signatureVec ? projectEmbedding(signatureVec) : null;
      const validSignature =
        projected && projected.length > 0 && projected.every((value) => Number.isFinite(value)) ? projected : null;
      if (validSignature) {
        artistBased = projectedValid
          ? mixWithReference(validSignature, projectedValid, ARTIST_SIGNATURE_PULL)
          : validSignature;
      }
    }

    // An installed audio reference is the BASE ("sprav to ako tento WAV");
    // the prompt pulls it by AUDIO_REF_TEXT_PULL instead of being replaced.
    // A reference outranks the artist signature — it is the more specific
    // statement of what the user wants, so it replaces the signature base and
    // the signature stops contributing rather than fighting the WAV.
    const pure = audioReferenceOverride
      ? projectedValid
        ? mixWithReference(audioReferenceOverride, projectedValid, AUDIO_REF_TEXT_PULL)
        : audioReferenceOverride
      : (artistBased ?? projectedValid);

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

/** Resolve the parsed artist preset and pass its curated signature to the
 * embedding conditioner. Keeping this at the intent boundary means every
 * provider gets the same artist + user-text blend instead of silently
 * dropping artist identity before the semantic prior. */
export function semanticConditioningForIntent(
  intent: Pick<IntentSpec, "artist" | "text">,
): Promise<readonly number[] | null> {
  const artist = intent.artist ? (getArtistProfile(normalizeArtistSlug(intent.artist)) ?? null) : null;
  return semanticConditioning(intent.text, undefined, artist);
}
