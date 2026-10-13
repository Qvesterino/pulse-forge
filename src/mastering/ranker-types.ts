import { MASTERING_FEATURE_VERSION, MASTERING_RANKER_FEATURE_COUNT } from "./intelligence";

export interface MasteringRankerEvaluationSummary {
  modelHash: string;
  datasetHash: string;
  runtimeMeasurementHash: string;
  split: "held-out-blind";
  pairCount: number;
  reviewerCodeCount: number;
  genreBucketCount: number;
  modelPreferenceRate: number;
  deterministicPreferenceRate: number;
  lower95Delta: number;
  safetyRegressionCount: number;
  p95InferenceMs: number;
  peakMemoryMiB: number;
}

export interface MasteringRankerEvaluationGate extends MasteringRankerEvaluationSummary {
  schemaVersion: 2;
  reportPath: string;
  reportHash: string;
}

export interface MasteringRankerEvaluationReport extends MasteringRankerEvaluationSummary {
  schema: "kyx.mastering-ranker-evaluation";
  schemaVersion: 2;
}

export interface MasteringRankerRuntimeMeasurement {
  schema: "kyx.mastering-ranker-runtime-measurement";
  schemaVersion: 2;
  modelHash: string;
  datasetHash: string;
  browser: "Chromium";
  browserVersion: string;
  platform: string;
  architecture: string;
  cpu: string;
  measurementMethod: "kyx.onnxruntime-web.wasm.chromium-windows-v1";
  memoryMeasurementMethod: "windows.process-tree.private-bytes-baseline-delta-v1";
  benchmarkScriptHash: string;
  rankerWorkerBundleHash: string;
  onnxRuntimeVersion: string;
  onnxRuntimeWasmHash: string;
  pairCount: number;
  inferenceCount: number;
  memorySampleCount: number;
  memorySampleEveryPairs: number;
  memoryBaselineMiB: number;
  p95InferenceMs: number;
  peakMemoryMiB: number;
}

export interface MasteringRankerManifest {
  rankerVersion: string;
  featureVersion: typeof MASTERING_FEATURE_VERSION;
  normalizationId: "mastering-normalization.v1";
  featureCount: typeof MASTERING_RANKER_FEATURE_COUNT;
  modelPath: string;
  inputName: string;
  outputName: string;
  modelHash: string;
  /** Null means this model may run in shadow mode only. */
  evaluation: MasteringRankerEvaluationGate | null;
}

export interface MasteringRankerLoadRequest {
  type: "load";
  requestId: number;
  manifest: MasteringRankerManifest;
}

export interface MasteringRankerScoreRequest {
  type: "score";
  requestId: number;
  batch: Float32Array;
  candidateCount: number;
}

export interface MasteringRankerDisposeRequest {
  type: "dispose";
  requestId: number;
}

export type MasteringRankerRequest =
  MasteringRankerLoadRequest | MasteringRankerScoreRequest | MasteringRankerDisposeRequest;

export interface MasteringRankerLoadResponse {
  type: "load";
  requestId: number;
  ok: boolean;
  error?: string;
}

export interface MasteringRankerScoreResponse {
  type: "score";
  requestId: number;
  ok: boolean;
  scores?: number[];
  error?: string;
}

export interface MasteringRankerDisposeResponse {
  type: "dispose";
  requestId: number;
  ok: boolean;
}

export type MasteringRankerResponse =
  MasteringRankerLoadResponse | MasteringRankerScoreResponse | MasteringRankerDisposeResponse;

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isLocalModelPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/models/") &&
    !value.startsWith("//") &&
    !value.includes("..") &&
    !value.includes(":")
  );
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

const EVALUATION_SUMMARY_KEYS = [
  "modelHash",
  "datasetHash",
  "runtimeMeasurementHash",
  "split",
  "pairCount",
  "reviewerCodeCount",
  "genreBucketCount",
  "modelPreferenceRate",
  "deterministicPreferenceRate",
  "lower95Delta",
  "safetyRegressionCount",
  "p95InferenceMs",
  "peakMemoryMiB",
] as const;

function isEvaluationSummaryShape(value: unknown): value is MasteringRankerEvaluationSummary {
  if (!value || typeof value !== "object") return false;
  const gate = value as Record<string, unknown>;
  return (
    isHash(gate.modelHash) &&
    isHash(gate.datasetHash) &&
    isHash(gate.runtimeMeasurementHash) &&
    gate.split === "held-out-blind" &&
    Number.isInteger(gate.pairCount) &&
    (gate.pairCount as number) >= 1 &&
    Number.isInteger(gate.reviewerCodeCount) &&
    (gate.reviewerCodeCount as number) >= 1 &&
    Number.isInteger(gate.genreBucketCount) &&
    (gate.genreBucketCount as number) >= 1 &&
    (gate.genreBucketCount as number) <= 7 &&
    typeof gate.modelPreferenceRate === "number" &&
    Number.isFinite(gate.modelPreferenceRate) &&
    gate.modelPreferenceRate >= 0 &&
    gate.modelPreferenceRate <= 1 &&
    typeof gate.deterministicPreferenceRate === "number" &&
    Number.isFinite(gate.deterministicPreferenceRate) &&
    gate.deterministicPreferenceRate >= 0 &&
    gate.deterministicPreferenceRate <= 1 &&
    typeof gate.lower95Delta === "number" &&
    Number.isFinite(gate.lower95Delta) &&
    gate.lower95Delta >= -1 &&
    gate.lower95Delta <= 1 &&
    Number.isInteger(gate.safetyRegressionCount) &&
    (gate.safetyRegressionCount as number) >= 0 &&
    (gate.safetyRegressionCount as number) <= (gate.pairCount as number) &&
    typeof gate.p95InferenceMs === "number" &&
    Number.isFinite(gate.p95InferenceMs) &&
    gate.p95InferenceMs >= 0 &&
    gate.p95InferenceMs <= 60_000 &&
    typeof gate.peakMemoryMiB === "number" &&
    Number.isFinite(gate.peakMemoryMiB) &&
    gate.peakMemoryMiB > 0 &&
    gate.peakMemoryMiB <= 16_384
  );
}

function clearsActivationCriteria(summary: MasteringRankerEvaluationSummary): boolean {
  return (
    summary.pairCount >= 100 &&
    summary.reviewerCodeCount >= 2 &&
    summary.genreBucketCount >= 4 &&
    summary.modelPreferenceRate > summary.deterministicPreferenceRate &&
    summary.lower95Delta > 0 &&
    summary.safetyRegressionCount === 0 &&
    summary.p95InferenceMs <= 250 &&
    summary.peakMemoryMiB <= 128
  );
}

export function isMasteringRankerEvaluationGate(value: unknown): value is MasteringRankerEvaluationGate {
  if (!value || typeof value !== "object") return false;
  const gate = value as Record<string, unknown>;
  return (
    hasExactlyKeys(gate, [...EVALUATION_SUMMARY_KEYS, "schemaVersion", "reportPath", "reportHash"]) &&
    gate.schemaVersion === 2 &&
    isLocalModelPath(gate.reportPath) &&
    isHash(gate.reportHash) &&
    isEvaluationSummaryShape(gate) &&
    clearsActivationCriteria(gate)
  );
}

export function isMasteringRankerEvaluationReport(value: unknown): value is MasteringRankerEvaluationReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Record<string, unknown>;
  return (
    hasExactlyKeys(report, [...EVALUATION_SUMMARY_KEYS, "schema", "schemaVersion"]) &&
    report.schema === "kyx.mastering-ranker-evaluation" &&
    report.schemaVersion === 2 &&
    isEvaluationSummaryShape(report)
  );
}

export function evaluationReportMatchesGate(
  report: MasteringRankerEvaluationReport,
  gate: MasteringRankerEvaluationGate,
): boolean {
  return (
    report.modelHash === gate.modelHash &&
    report.datasetHash === gate.datasetHash &&
    report.runtimeMeasurementHash === gate.runtimeMeasurementHash &&
    report.split === gate.split &&
    report.pairCount === gate.pairCount &&
    report.reviewerCodeCount === gate.reviewerCodeCount &&
    report.genreBucketCount === gate.genreBucketCount &&
    report.modelPreferenceRate === gate.modelPreferenceRate &&
    report.deterministicPreferenceRate === gate.deterministicPreferenceRate &&
    report.lower95Delta === gate.lower95Delta &&
    report.safetyRegressionCount === gate.safetyRegressionCount &&
    report.p95InferenceMs === gate.p95InferenceMs &&
    report.peakMemoryMiB === gate.peakMemoryMiB
  );
}

/** The report must clear every human-preference, technical-safety and runtime gate before activation is permitted. */
export function hasPassedMasteringRankerEvaluation(manifest: MasteringRankerManifest): boolean {
  return (
    manifest.evaluation !== null &&
    manifest.evaluation.modelHash === manifest.modelHash &&
    isMasteringRankerEvaluationGate(manifest.evaluation)
  );
}

export function isMasteringRankerManifest(value: unknown): value is MasteringRankerManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Record<string, unknown>;
  const modelPath = manifest.modelPath;
  const validPath = isLocalModelPath(modelPath);
  return (
    hasExactlyKeys(manifest, [
      "rankerVersion",
      "featureVersion",
      "normalizationId",
      "featureCount",
      "modelPath",
      "inputName",
      "outputName",
      "modelHash",
      "evaluation",
    ]) &&
    typeof manifest.rankerVersion === "string" &&
    manifest.rankerVersion.length > 0 &&
    manifest.featureVersion === MASTERING_FEATURE_VERSION &&
    manifest.normalizationId === "mastering-normalization.v1" &&
    manifest.featureCount === MASTERING_RANKER_FEATURE_COUNT &&
    validPath &&
    typeof manifest.inputName === "string" &&
    manifest.inputName.length > 0 &&
    typeof manifest.outputName === "string" &&
    manifest.outputName.length > 0 &&
    isHash(manifest.modelHash) &&
    (manifest.evaluation === null || isMasteringRankerEvaluationGate(manifest.evaluation))
  );
}
