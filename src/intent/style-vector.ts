/**
 * USER STYLE VECTOR (#7) — the user's ★-kept rolls and explicitly taught
 * pattern summaries averaged into a single point in the SAME 16-dim semantic
 * space the embedding-conditioned priors consume. "Your sound" as a vector:
 * blend it into conditioning so both v2 priors drift toward what the user
 * keeps, without retraining anything.
 *
 * Pipeline: compact local examples → deterministic EN text per example (the
 * same word space the training corpus lives in) → MiniLM embed → average in 384-dim →
 * ONE PCA projection (linear, so mean-then-project ≡ project-then-mean) →
 * 16-dim style vector, cached in localStorage keyed by a ledger signature.
 *
 * Blending happens in semantic-conditioning (INTENT_BLEND_WEIGHT intent vs
 * style) so both v2 priors pick it up through the ONE conditioning vector.
 * Never throws — any failure degrades to pure intent conditioning.
 */
import { projectEmbedding } from "../ai/symbolic/pca-projection";
import { isValidLedgerEntry, type FavoriteLedgerEntry } from "./favorites-core";
import { readFavoriteLedger } from "./favorites";
import { isValidStyleExample, readStyleExamples, type StyleExampleV1 } from "./style-example-ledger";

export type EmbedFn = (texts: string[]) => Promise<Float32Array[] | null>;

export const STYLE_VECTOR_CACHE_KEY = "pf:style-vector-cache";

/** Flag: localStorage `pf:style-vector` = on|off (default ON; only active when pf:embedding-conditioned is on). */
export function styleVectorMode(): "off" | "on" {
  try {
    const value = localStorage.getItem("pf:style-vector");
    if (value === "off" || value === "on") return value;
  } catch {
    /* storage blocked — default below */
  }
  return "on";
}

/**
 * Deterministic EN text projection of a ledger entry — the personal roll
 * described in the training corpus's word space ("energetic dense house deep").
 * Same entry ⇒ same text ⇒ same embedding.
 */
type StyleTextSource = Pick<FavoriteLedgerEntry, "energy" | "density" | "complexity" | "genre" | "grooveId"> & {
  variation?: number;
};

export function styleVectorTextForEntry(entry: StyleTextSource): string {
  const words: string[] = [];
  words.push(entry.energy >= 0.72 ? "driving energetic" : entry.energy <= 0.35 ? "calm restrained" : "steady");
  words.push(entry.density >= 0.68 ? "dense" : entry.density <= 0.34 ? "sparse spacious" : "balanced density");
  if (entry.complexity >= 0.68) words.push("syncopated intricate");
  else if (entry.complexity <= 0.3) words.push("minimal straight");
  else words.push("subtle rhythmic detail");
  const variation = entry.variation ?? 0.5;
  words.push(variation >= 0.65 ? "evolving varied" : variation <= 0.28 ? "hypnotic repetitive" : "subtle variation");
  words.push(entry.genre);
  const dot = entry.grooveId.indexOf(".");
  if (dot >= 0 && dot + 1 < entry.grooveId.length) {
    words.push(entry.grooveId.slice(dot + 1).replace(/[-_]+/g, " "));
  }
  return words.join(" ");
}

/** FNV-1a 32-bit → hex. Small, stable, dependency-free. */
function hashSignature(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Fingerprint the caches key on: any ★ or explicitly taught pattern added,
 * re-kept or dropped changes the signature → style and conditioning vectors
 * recompute.
 */
export function styleVectorSignature(
  entries: readonly FavoriteLedgerEntry[],
  examples: readonly StyleExampleV1[] = readStyleExamples(),
): string {
  const canonical = [
    ...entries.map((entry) => `favorite|${entry.savedAt}|${entry.seed}|${entry.grooveId}`),
    ...examples
      .filter(isValidStyleExample)
      .map(
        (example) =>
          `learned|${example.savedAt}|${example.contentHash}|${example.genre}|${example.grooveId}|${example.energy}|${example.density}|${example.complexity}|${example.variation}`,
      ),
  ]
    .sort()
    .join(";");
  return `${canonical.length}:${hashSignature(canonical)}`;
}

/** Convenience: signature of the live favorite and explicitly taught ledgers. */
export function liveStyleVectorSignature(): string {
  return styleVectorSignature(readFavoriteLedger());
}

/**
 * Blend the intent conditioning with the user style vector. `alpha` = intent
 * weight; 0.75 keeps the current prompt dominant while the personal drift
 * stays audible in all 16 dims.
 */
export const INTENT_BLEND_WEIGHT = 0.75;

export function blendSemantic(intent: readonly number[], style: readonly number[]): number[] {
  const alpha = INTENT_BLEND_WEIGHT;
  const size = Math.min(intent.length, style.length);
  const out = new Array<number>(size);
  for (let index = 0; index < size; index++) out[index] = alpha * intent[index] + (1 - alpha) * style[index];
  return out;
}

interface StyleVectorCache {
  version: 1;
  signature: string;
  vector: number[];
}

/** Test/diagnostic hook: drop the cached style vector. */
export function resetStyleVector(): void {
  try {
    localStorage.removeItem(STYLE_VECTOR_CACHE_KEY);
  } catch {
    /* storage blocked — nothing to drop */
  }
}

/**
 * The user's style vector, or null when the flag is off, the ledger is empty,
 * the embedder is unavailable, or anything downstream fails. Cached in
 * localStorage per ledger signature — repeat generations never re-embed.
 */
export async function computeStyleVector(
  entries: readonly FavoriteLedgerEntry[],
  embedFn?: EmbedFn,
): Promise<readonly number[] | null> {
  try {
    // Lazy: the semantic client (transformers chunk) must NOT enter the
    // static closure of anything the landing route reaches (landing-budget
    // gate). Resolved only when the caller did not inject an embedder.
    const embed = embedFn ?? (await import("../ai/semantic/semantic-client")).embedTexts;
    if (styleVectorMode() === "off") return null;
    const valid = entries.filter(isValidLedgerEntry);
    const examples = readStyleExamples().filter(isValidStyleExample);
    if (valid.length === 0 && examples.length === 0) return null;
    const signature = styleVectorSignature(valid, examples);

    try {
      const raw = localStorage.getItem(STYLE_VECTOR_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StyleVectorCache;
        if (parsed?.version === 1 && parsed.signature === signature && Array.isArray(parsed.vector)) {
          return Object.freeze(parsed.vector);
        }
      }
    } catch {
      /* stale/corrupt cache — recompute below */
    }

    const texts = [...valid, ...examples].map(styleVectorTextForEntry);
    const vectors = await embed(texts);
    if (!vectors || vectors.length !== texts.length) return null;
    const dim = vectors[0]?.length ?? 0;
    if (dim === 0) return null;
    const mean = new Float64Array(dim);
    for (const vector of vectors) {
      if (!vector || vector.length !== dim) return null;
      for (let index = 0; index < dim; index++) mean[index] += vector[index];
    }
    for (let index = 0; index < dim; index++) mean[index] /= vectors.length;
    const projected = projectEmbedding(mean);
    if (!projected || !projected.every((value) => Number.isFinite(value))) return null;

    try {
      const cache: StyleVectorCache = { version: 1, signature, vector: projected };
      localStorage.setItem(STYLE_VECTOR_CACHE_KEY, JSON.stringify(cache));
    } catch {
      /* quota/blocked — vector still valid for this session */
    }
    return Object.freeze(projected);
  } catch {
    return null;
  }
}
