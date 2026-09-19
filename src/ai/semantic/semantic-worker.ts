/// <reference lib="webworker" />
/**
 * Semantic embedding worker (INTENT_ENGINE.md T1 krok 2).
 *
 * Runs a multilingual sentence-embedding transformer (Xenova/
 * paraphrase-multilingual-MiniLM-L12-v2, q8 ≈ 120 MB) through
 * transformers.js — LAZY-loaded from our own origin (/models/semantic/,
 * fetched once via npm run semantic:fetch; remote CDN access is DISABLED so
 * the app never silently reaches for the cloud).
 *
 * Embeddings: mean pooling over the attention mask + L2 normalization —
 * cosine similarity is then a plain dot product in the kNN layer.
 *
 * Mirrors the prior/ranker worker guarantees: controlled { ok: false, error }
 * fallback statuses (a missing model degrades to keyword parsing, never an
 * exception), session-cached pipeline, nothing in the audio callback.
 */

import type { SemanticManifest, SemanticRequest, SemanticResponse } from "./semantic-types";

type Transformers = typeof import("@huggingface/transformers");
type Extractor = Awaited<ReturnType<Transformers["pipeline"]>>;

const LOCAL_MODEL_PATH = "/models/semantic/";
const SUPPORTED_MODELS = new Set([
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
  "Xenova/all-MiniLM-L6-v2",
]);

let extractorPromise: Promise<Extractor> | null = null;

async function ensureExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      const response = await fetch(`${LOCAL_MODEL_PATH}manifest.json`, { cache: "force-cache" });
      if (!response.ok) throw new Error(`semantic manifest unavailable (${response.status})`);
      const manifest = (await response.json()) as SemanticManifest;
      if (
        manifest.semanticVersion !== "semantic-embed.v1" ||
        !SUPPORTED_MODELS.has(manifest.modelId) ||
        manifest.dtype !== "q8"
      ) {
        throw new Error("unsupported semantic model manifest");
      }
      // Offline-first: serve the model from our own origin and forbid any
      // remote fallback — a missing local asset must surface as a controlled
      // failure, never a surprise network request.
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      // v4 API: localModelPath prefixes the manifest model ID, matching the
      // repository-shaped path written by semantic:fetch.
      env.localModelPath = LOCAL_MODEL_PATH;
      return pipeline("feature-extraction", manifest.modelId, { dtype: "q8" });
    })();
    extractorPromise.catch(() => {
      // Allow a later retry after a failed load (e.g. model fetched meanwhile).
      extractorPromise = null;
    });
  }
  return extractorPromise;
}

/** Mean-pool the token embeddings over the attention mask, then L2-normalize. */
function poolAndNormalize(lastHiddenState: Float32Array, dims: { batch: number; seq: number; dim: number }, mask: Array<number[]>): Float32Array[] {
  const vectors: Float32Array[] = [];
  for (let row = 0; row < dims.batch; row++) {
    const vector = new Float32Array(dims.dim);
    let tokens = 0;
    for (let token = 0; token < dims.seq; token++) {
      const weight = mask[row]?.[token] ?? 0;
      if (!weight) continue;
      tokens += 1;
      const offset = (row * dims.seq + token) * dims.dim;
      for (let d = 0; d < dims.dim; d++) vector[d] += lastHiddenState[offset + d];
    }
    if (tokens === 0) tokens = 1;
    let norm = 0;
    for (let d = 0; d < dims.dim; d++) {
      vector[d] /= tokens;
      norm += vector[d] * vector[d];
    }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dims.dim; d++) vector[d] /= norm;
    vectors.push(vector);
  }
  return vectors;
}

async function embed(texts: string[]): Promise<{ vectors: Float32Array; rowCount: number }> {
  const extractor = (await ensureExtractor()) as unknown as (
    texts: string[],
    options: Record<string, unknown>,
  ) => Promise<{ last_hidden_state: { data: Float32Array; dims: number[] }; attention_mask?: { dims: number[] } }> & {
    tokenizer?: unknown;
  };

  // The pipeline call returns token embeddings + the tokenizer's mask via the
  // pooled options; request pooling inputs explicitly.
  const output = (await extractor(texts, {
    pooling: "mean",
    normalize: true,
  })) as unknown as { data: Float32Array; dims: number[] };

  // transformers.js v4 with pooling+normalize returns FINAL sentence
  // embeddings [batch, dim] — the pooling helper above is only a fallback
  // for raw token output.
  const dims = output.dims;
  if (dims.length === 2) {
    return { vectors: output.data, rowCount: dims[0] };
  }
  // Raw token output path: [batch, seq, dim] — pool manually using a plain
  // whitespace-independent mask (CLS/SEP included; MiniLM attention handles it).
  const [batch, seq, dim] = dims;
  const mask = Array.from({ length: batch }, () => Array.from({ length: seq }, () => 1));
  const vectors = poolAndNormalize(output.data, { batch, seq, dim }, mask);
  const flat = new Float32Array(batch * dim);
  vectors.forEach((vector, row) => flat.set(vector, row * dim));
  return { vectors: flat, rowCount: batch };
}

async function handle(request: SemanticRequest): Promise<SemanticResponse> {
  if (request.type === "load" || request.type === "warmup") {
    try {
      await ensureExtractor();
      return { type: "load", requestId: request.requestId, ok: true };
    } catch (error) {
      return {
        type: "load",
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  try {
    const texts = request.texts.filter((text) => typeof text === "string" && text.trim().length > 0);
    if (texts.length === 0) throw new Error("no texts to embed");
    const { vectors, rowCount } = await embed(texts);
    return { type: "embed", requestId: request.requestId, ok: true, vectors, rowCount };
  } catch (error) {
    return {
      type: "embed",
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

self.onmessage = async (event: MessageEvent<SemanticRequest>) => {
  const request = event.data;
  try {
    const response = await handle(request);
    (self as unknown as Worker).postMessage(response);
  } catch (error) {
    const response: SemanticResponse = {
      type: "embed",
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    (self as unknown as Worker).postMessage(response);
  }
};
