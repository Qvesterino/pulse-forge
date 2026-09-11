/** Shared contract for the ONNX intent-ranker worker (goal doc Fáze 3). */

export interface RankerManifest {
  rankerVersion: string;
  featureVersion: string;
  normalizationId: string;
  featureCount: number;
  modelPath: string;
  inputName: string;
  outputName: string;
  modelHash: string;
  hidden: readonly number[];
}

export interface RankerLoadRequest {
  type: "load";
  requestId: number;
  manifest: RankerManifest;
}

export interface RankerScoreRequest {
  type: "score";
  requestId: number;
  /** Batch: candidates.length × featureCount, row-major. */
  batch: Float32Array;
  candidateCount: number;
}

export interface RankerDisposeRequest {
  type: "dispose";
  requestId: number;
}

export type RankerRequest = RankerLoadRequest | RankerScoreRequest | RankerDisposeRequest;

export interface RankerLoadResponse {
  type: "load";
  requestId: number;
  ok: boolean;
  /** Controlled fallback status — never a raw exception. */
  error?: string;
}

export interface RankerScoreResponse {
  type: "score";
  requestId: number;
  ok: boolean;
  /** One normalized (0..1 via sigmoid) score per candidate. */
  scores?: number[];
  error?: string;
}

export interface RankerDisposeResponse {
  type: "dispose";
  requestId: number;
  ok: boolean;
}

export type RankerResponse = RankerLoadResponse | RankerScoreResponse | RankerDisposeResponse;

export function isRankerManifest(value: unknown): value is RankerManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Record<string, unknown>;
  return (
    typeof manifest.rankerVersion === "string" &&
    manifest.featureVersion === "features.v1" &&
    manifest.normalizationId === "norm.fixed.v1" &&
    typeof manifest.featureCount === "number" &&
    Number.isInteger(manifest.featureCount) &&
    manifest.featureCount > 0 &&
    typeof manifest.modelPath === "string" &&
    manifest.modelPath.startsWith("/models/") &&
    typeof manifest.inputName === "string" &&
    manifest.inputName.length > 0 &&
    typeof manifest.outputName === "string" &&
    manifest.outputName.length > 0 &&
    typeof manifest.modelHash === "string" &&
    /^[0-9a-f]{64}$/i.test(manifest.modelHash)
  );
}
