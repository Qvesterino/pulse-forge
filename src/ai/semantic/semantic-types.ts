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
