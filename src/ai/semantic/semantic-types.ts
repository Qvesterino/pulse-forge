/** Shared contract for the semantic embedding worker (INTENT_ENGINE.md T1 krok 2). */

export interface SemanticManifest {
  semanticVersion: string;
  modelId: string;
  dtype: string;
}

export interface SemanticLoadRequest {
  type: "load";
  requestId: number;
}

export interface SemanticEmbedRequest {
  type: "embed";
  requestId: number;
  texts: string[];
}

export interface SemanticWarmupRequest {
  type: "warmup";
  requestId: number;
}

export type SemanticRequest = SemanticLoadRequest | SemanticEmbedRequest | SemanticWarmupRequest;

export interface SemanticLoadResponse {
  type: "load";
  requestId: number;
  ok: boolean;
  error?: string;
}

export interface SemanticEmbedResponse {
  type: "embed";
  requestId: number;
  ok: boolean;
  /** rowCount × 384 L2-normalized embeddings, row-major. */
  vectors?: Float32Array;
  rowCount?: number;
  error?: string;
}

export type SemanticResponse = SemanticLoadResponse | SemanticEmbedResponse;

/**
 * The texts a batch request must embed — the request's OWN texts, in order.
 *
 * Returns null when the request is not a usable batch: not an array, empty,
 * or holding something that is not a string.
 *
 * N texts in, N vectors out. The worker used to FILTER the request's texts
 * before embedding them, so a request for three texts (one of them empty)
 * came back as two vectors. The client could not tell — it returned whatever
 * the worker said — and the caller used the short answer as if it were
 * complete, which silently cost the whole reference-informed conditioning
 * (`buildReferenceEmbedding` checks the length and gives up).
 */
export function semanticBatchTexts(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((text) => typeof text === "string")) return null;
  return value as string[];
}
