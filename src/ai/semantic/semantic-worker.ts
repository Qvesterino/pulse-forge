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

import {
  semanticBatchTexts,
  type SemanticManifest,
  type SemanticRequest,
  type SemanticResponse,
} from "./semantic-types";

type Transformers = typeof import("@huggingface/transformers");
type Extractor = Awaited<ReturnType<Transformers["pipeline"]>>;

const LOCAL_MODEL_PATH = "/models/semantic/";
const SUPPORTED_MODELS = new Set(["Xenova/paraphrase-multilingual-MiniLM-L12-v2", "Xenova/all-MiniLM-L6-v2"]);
const MODEL_PACK_CACHE = "pf:model-packs";

let extractorPromise: Promise<Extractor> | null = null;

// ── Pack cache bridge (ROADMAP-FULL-DAW Phase 5) ─────────────────────────
// transformers.js loads model bytes through plain `fetch` against
// env.localModelPath — it has no cache hook of its own. When the semantic
// pack was installed through the model pack manager (src/ai/packs/), the
// files live in the Cache API instead of the origin (deployments don't ship
// the dev-only public/ folder), so we intercept fetch in THIS worker's
// scope: pack URLs are answered from the cache, everything else passes
// through untouched. The original fetch stays the fallback — dev machines
// keep serving the static files exactly as before.
const originalFetch = self.fetch.bind(self);
self.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  try {
    const absolute = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      self.location.href,
    ).href;
    const cache = await caches.open(MODEL_PACK_CACHE);
    const cached = await cache.match(absolute);
    if (cached) return cached;
  } catch {
    // Cache lookup must never break model loading — fall through to network.
  }
  return originalFetch(input as RequestInfo, init);
};

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
function poolAndNormalize(
  lastHiddenState: Float32Array,
  dims: { batch: number; seq: number; dim: number },
  mask: Array<number[]>,
): Float32Array[] {
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
    // The batch to embed is EXACTLY the batch that was asked for: N texts in,
    // N vectors out. Filtering the request's texts answered a DIFFERENT
    // question than the one that was asked — and the caller could not tell.
    const texts = semanticBatchTexts(request.texts);
    if (!texts) throw new Error("texts must be a non-empty array of strings");
    const { vectors, rowCount } = await embed(texts);
    if (rowCount !== texts.length) throw new Error(`embedded ${rowCount} rows for ${texts.length} texts`);
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

/**
 * The worker boundary: `event.data` is a raw structured clone from another
 * thread, so its shape is never trusted (AGENTS.md → defensive parsing;
 * `src/intent/model-worker.ts` is the reference shape). Only the ENVELOPE is
 * checked here — a broken body is answered by `handle()` with a correlated
 * error instead of being dropped.
 */
function isSemanticRequest(value: unknown): value is SemanticRequest {
  if (value == null || typeof value !== "object") return false;
  const request = value as { type?: unknown; requestId?: unknown };
  if (typeof request.requestId !== "number" || !Number.isInteger(request.requestId)) return false;
  return request.type === "load" || request.type === "warmup" || request.type === "embed";
}

self.onmessage = async (event: MessageEvent<unknown>) => {
  // Unshaped garbage is dropped SILENTLY: there is no requestId to answer
  // with. The old code used the payload INSIDE its catch block, so a null
  // payload threw there too — the answer was never posted and the caller
  // waited out its whole timeout (60 s on a cold model).
  if (!isSemanticRequest(event.data)) return;
  const request = event.data;
  try {
    const response = await handle(request);
    (self as unknown as Worker).postMessage(response);
  } catch (error) {
    // `request` is validated, so this block can always answer.
    const response: SemanticResponse = {
      type: "embed",
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    (self as unknown as Worker).postMessage(response);
  }
};
