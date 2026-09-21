/** Shared contract for the ONNX symbolic prior worker (drums + melodic, T2). */

export type PriorKind = "drums" | "drums-v2" | "melodic" | "melodic-v2";

/** Drum prior: per-(pad,step) hit logits, sigmoid-normalized in the worker. */
export interface DrumsPriorManifest {
  kind: "drums";
  priorVersion: string;
  featureVersion: string;
  featureCount: number;
  modelPath: string;
  inputName: string;
  outputName: string;
  modelHash: string;
  hidden: readonly number[];
}

/**
 * Embedding-conditioned drum prior (v2): same sigmoid head as v1, but the
 * input replaces genre+style one-hots with a 16-dim PCA-projected semantic
 * vector (35 dims total — prior-features-v2).
 */
export interface DrumsV2PriorManifest {
  kind: "drums-v2";
  priorVersion: string;
  featureVersion: string;
  featureCount: number;
  modelPath: string;
  inputName: string;
  outputName: string;
  modelHash: string;
  hidden: readonly number[];
}

/** Melodic prior: next-note model with degree + duration heads (softmax in worker). */
export interface MelodicPriorManifest {
  kind: "melodic";
  priorVersion: string;
  featureVersion: string;
  featureCount: number;
  modelPath: string;
  inputName: string;
  degreeOutputName: string;
  durationOutputName: string;
  degreeClasses: number;
  durationClasses: number;
  modelHash: string;
  hidden: readonly number[];
}

/**
 * Embedding-conditioned melodic prior (v2, Fáza G): same dual softmax heads
 * as v1, but the input replaces the genre one-hot with a 16-dim PCA-projected
 * semantic vector (41 dims total — melodic-features-v2).
 */
export interface MelodicV2PriorManifest {
  kind: "melodic-v2";
  priorVersion: string;
  featureVersion: string;
  featureCount: number;
  modelPath: string;
  inputName: string;
  degreeOutputName: string;
  durationOutputName: string;
  degreeClasses: number;
  durationClasses: number;
  modelHash: string;
  hidden: readonly number[];
}

export type PriorManifest = DrumsPriorManifest | DrumsV2PriorManifest | MelodicPriorManifest | MelodicV2PriorManifest;

/** Sigmoid-head priors share the run/response shape; only the manifest kind differs. */
export type SigmoidPriorManifest = DrumsPriorManifest | DrumsV2PriorManifest;

/** Dual softmax-head priors (melodic v1/v2) share the run/response shape. */
export type DualHeadPriorManifest = MelodicPriorManifest | MelodicV2PriorManifest;

export interface PriorLoadRequest {
  type: "load";
  requestId: number;
  kind: PriorKind;
  manifest: PriorManifest;
}

export interface PriorRunRequest {
  type: "run";
  requestId: number;
  kind: PriorKind;
  /** Batch: rowCount × featureCount, row-major. */
  batch: Float32Array;
  rowCount: number;
}

export interface PriorDisposeRequest {
  type: "dispose";
  requestId: number;
}

export type PriorRequest = PriorLoadRequest | PriorRunRequest | PriorDisposeRequest;

export interface PriorLoadResponse {
  type: "load";
  requestId: number;
  ok: boolean;
  /** Controlled fallback status — never a raw exception. */
  error?: string;
}

export interface PriorRunResponse {
  type: "run";
  requestId: number;
  ok: boolean;
  /**
   * Normalized outputs by tensor name: drums → sigmoid probs under the
   * manifest's outputName; melodic → softmax distributions under the
   * degree/duration output names. Rounded to 4 decimals per prior version.
   */
  outputs?: Record<string, number[]>;
  error?: string;
}

export interface PriorDisposeResponse {
  type: "dispose";
  requestId: number;
  ok: boolean;
}

export type PriorResponse = PriorLoadResponse | PriorRunResponse | PriorDisposeResponse;

const HEX64 = /^[0-9a-f]{64}$/i;

function commonManifestFieldsValid(manifest: Record<string, unknown>): boolean {
  return (
    typeof manifest.priorVersion === "string" &&
    typeof manifest.featureVersion === "string" &&
    typeof manifest.featureCount === "number" &&
    Number.isInteger(manifest.featureCount) &&
    manifest.featureCount > 0 &&
    typeof manifest.modelPath === "string" &&
    manifest.modelPath.startsWith("/models/") &&
    typeof manifest.inputName === "string" &&
    manifest.inputName.length > 0 &&
    typeof manifest.modelHash === "string" &&
    HEX64.test(manifest.modelHash)
  );
}

export function isDrumsPriorManifest(value: unknown): value is DrumsPriorManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Record<string, unknown>;
  return (
    commonManifestFieldsValid(manifest) &&
    manifest.kind === "drums" &&
    manifest.featureVersion === "prior-features.v1" &&
    typeof manifest.outputName === "string" &&
    manifest.outputName.length > 0
  );
}

export function isDrumsV2PriorManifest(value: unknown): value is DrumsV2PriorManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Record<string, unknown>;
  return (
    commonManifestFieldsValid(manifest) &&
    manifest.kind === "drums-v2" &&
    manifest.featureVersion === "prior-features-v2" &&
    typeof manifest.outputName === "string" &&
    manifest.outputName.length > 0
  );
}

export function isMelodicPriorManifest(value: unknown): value is MelodicPriorManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Record<string, unknown>;
  return (
    commonManifestFieldsValid(manifest) &&
    manifest.kind === "melodic" &&
    manifest.featureVersion === "melodic-features.v1" &&
    typeof manifest.degreeOutputName === "string" &&
    manifest.degreeOutputName.length > 0 &&
    typeof manifest.durationOutputName === "string" &&
    manifest.durationOutputName.length > 0 &&
    typeof manifest.degreeClasses === "number" &&
    Number.isInteger(manifest.degreeClasses) &&
    (manifest.degreeClasses as number) > 0 &&
    typeof manifest.durationClasses === "number" &&
    Number.isInteger(manifest.durationClasses) &&
    (manifest.durationClasses as number) > 0
  );
}

export function isMelodicV2PriorManifest(value: unknown): value is MelodicV2PriorManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Record<string, unknown>;
  return (
    commonManifestFieldsValid(manifest) &&
    manifest.kind === "melodic-v2" &&
    manifest.featureVersion === "melodic-features-v2" &&
    typeof manifest.degreeOutputName === "string" &&
    manifest.degreeOutputName.length > 0 &&
    typeof manifest.durationOutputName === "string" &&
    manifest.durationOutputName.length > 0 &&
    typeof manifest.degreeClasses === "number" &&
    Number.isInteger(manifest.degreeClasses) &&
    (manifest.degreeClasses as number) > 0 &&
    typeof manifest.durationClasses === "number" &&
    Number.isInteger(manifest.durationClasses) &&
    (manifest.durationClasses as number) > 0
  );
}

/**
 * Legacy shim: the drums manifest on disk has no kind field yet — accept it
 * absent, but reject a manifest that names a DIFFERENT kind explicitly.
 */
export function coerceDrumsManifest(value: unknown): DrumsPriorManifest | null {
  if (!value || typeof value !== "object") return null;
  const manifest = value as Record<string, unknown>;
  if (manifest.kind !== undefined && manifest.kind !== "drums") return null;
  if (!isDrumsPriorManifest({ ...manifest, kind: "drums" })) return null;
  return { ...(manifest as Omit<DrumsPriorManifest, "kind">), kind: "drums" };
}
