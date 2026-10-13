import { MASTERING_FEATURE_VERSION, MASTERING_RANKER_FEATURE_COUNT } from "./intelligence";
import type { MasteringRankerEvaluationReport, MasteringRankerRuntimeMeasurement } from "./ranker-types";

export type MasteringGenreBucket = "electronic" | "hip-hop" | "rock" | "acoustic" | "orchestral" | "ambient" | "other";
export type MasteringRankerDatasetSplit = "development" | "held-out-blind";
export const MASTERING_RANKER_RUNTIME_MEASUREMENT_METHOD = "kyx.onnxruntime-web.wasm.chromium-windows-v1" as const;
export const MASTERING_RANKER_MEMORY_MEASUREMENT_METHOD =
  "windows.process-tree.private-bytes-baseline-delta-v1" as const;
export const MASTERING_RANKER_MEMORY_SAMPLE_EVERY = 10;

export function masteringRankerMemorySampleEvery(pairCount: number): number {
  return Math.max(MASTERING_RANKER_MEMORY_SAMPLE_EVERY, Math.ceil(pairCount / 100));
}

export interface MasteringRankerBlindCandidate {
  id: string;
  /** Exact, versioned numeric input used for this rendered candidate; contains no project identity or audio. */
  features: number[];
  safeAfterPreview: boolean;
}

export interface MasteringRankerBlindJudgment {
  /** SHA-256 of a reviewer token; raw names or account identifiers are not part of this format. */
  reviewerHash: string;
  /** Null records a blind-listening tie / no preference. */
  preferredCandidateId: string | null;
}

export interface MasteringRankerBlindPair {
  pairId: string;
  /** SHA-256 of the source mix identity; never a filename or project ID. */
  sourceMixHash: string;
  genreBucket: MasteringGenreBucket;
  candidates: [MasteringRankerBlindCandidate, MasteringRankerBlindCandidate];
  judgments: MasteringRankerBlindJudgment[];
}

export interface MasteringRankerBlindDataset {
  schema: "kyx.mastering-ranker-blind-set";
  schemaVersion: 3;
  split: MasteringRankerDatasetSplit;
  pairs: MasteringRankerBlindPair[];
}

export interface MasteringRankerPairPrediction {
  pairId: string;
  modelOrder: [string, string];
  deterministicOrder: [string, string];
}

export interface MasteringRankerPredictions {
  schema: "kyx.mastering-ranker-predictions";
  schemaVersion: 1;
  featureVersion: typeof MASTERING_FEATURE_VERSION;
  modelHash: string;
  p95InferenceMs: number;
  peakMemoryMiB: number;
  pairs: MasteringRankerPairPrediction[];
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;
const GENRE_BUCKETS: readonly MasteringGenreBucket[] = [
  "electronic",
  "hip-hop",
  "rock",
  "acoustic",
  "orchestral",
  "ambient",
  "other",
];
const MAX_PAIRS = 5000;
const MAX_JUDGMENTS_PER_PAIR = 20;
const BOOTSTRAP_RESAMPLES = 10_000;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value) && !value.includes("..");
}

function fail(message: string): never {
  throw new Error(`Mastering ranker evaluation: ${message}`);
}

function validateDataset(value: unknown): MasteringRankerBlindDataset {
  if (!record(value)) fail("blind dataset must be a JSON object.");
  if (
    !hasExactlyKeys(value, ["schema", "schemaVersion", "split", "pairs"]) ||
    value.schema !== "kyx.mastering-ranker-blind-set" ||
    value.schemaVersion !== 3 ||
    (value.split !== "development" && value.split !== "held-out-blind") ||
    !Array.isArray(value.pairs) ||
    value.pairs.length === 0 ||
    value.pairs.length > MAX_PAIRS
  ) {
    fail(`expected ${MAX_PAIRS} or fewer development or held-out blind pairs in schema version 3.`);
  }
  const pairIds = new Set<string>();
  const sourceMixHashes = new Set<string>();
  for (const pairValue of value.pairs) {
    if (
      !record(pairValue) ||
      !hasExactlyKeys(pairValue, ["pairId", "sourceMixHash", "genreBucket", "candidates", "judgments"])
    )
      fail("pair entry has an unsupported field or is not an object.");
    if (
      !isId(pairValue.pairId) ||
      pairIds.has(pairValue.pairId) ||
      !isHash(pairValue.sourceMixHash) ||
      sourceMixHashes.has(pairValue.sourceMixHash) ||
      typeof pairValue.genreBucket !== "string" ||
      !GENRE_BUCKETS.includes(pairValue.genreBucket as MasteringGenreBucket) ||
      !Array.isArray(pairValue.candidates) ||
      pairValue.candidates.length !== 2 ||
      !Array.isArray(pairValue.judgments) ||
      pairValue.judgments.length < 2 ||
      pairValue.judgments.length > MAX_JUDGMENTS_PER_PAIR
    ) {
      fail("pair identity, source hash, genre bucket, candidate count or reviewer count is invalid.");
    }
    pairIds.add(pairValue.pairId);
    sourceMixHashes.add(pairValue.sourceMixHash);
    const candidates = pairValue.candidates;
    const candidateIds = candidates.map((candidateValue) => {
      if (
        !record(candidateValue) ||
        !hasExactlyKeys(candidateValue, ["id", "features", "safeAfterPreview"]) ||
        !isId(candidateValue.id) ||
        !Array.isArray(candidateValue.features) ||
        candidateValue.features.length !== MASTERING_RANKER_FEATURE_COUNT ||
        !candidateValue.features.every(
          (feature) => typeof feature === "number" && Number.isFinite(feature) && feature >= -1 && feature <= 1,
        ) ||
        typeof candidateValue.safeAfterPreview !== "boolean"
      )
        fail(`pair ${pairValue.pairId} has an invalid candidate.`);
      return candidateValue.id;
    });
    if (candidateIds[0] === candidateIds[1]) fail(`pair ${pairValue.pairId} repeats a candidate ID.`);
    const reviewers = new Set<string>();
    for (const judgmentValue of pairValue.judgments) {
      if (
        !record(judgmentValue) ||
        !hasExactlyKeys(judgmentValue, ["reviewerHash", "preferredCandidateId"]) ||
        !isHash(judgmentValue.reviewerHash) ||
        reviewers.has(judgmentValue.reviewerHash) ||
        (judgmentValue.preferredCandidateId !== null &&
          (typeof judgmentValue.preferredCandidateId !== "string" ||
            !candidateIds.includes(judgmentValue.preferredCandidateId)))
      ) {
        fail(`pair ${pairValue.pairId} has an invalid or duplicate reviewer judgment.`);
      }
      reviewers.add(judgmentValue.reviewerHash);
    }
  }
  return value as unknown as MasteringRankerBlindDataset;
}

export function parseMasteringRankerBlindDataset(value: unknown): MasteringRankerBlindDataset {
  return validateDataset(value);
}

function validatePredictions(value: unknown, dataset: MasteringRankerBlindDataset): MasteringRankerPredictions {
  if (!record(value)) fail("prediction input must be a JSON object.");
  if (
    !hasExactlyKeys(value, [
      "schema",
      "schemaVersion",
      "featureVersion",
      "modelHash",
      "p95InferenceMs",
      "peakMemoryMiB",
      "pairs",
    ]) ||
    value.schema !== "kyx.mastering-ranker-predictions" ||
    value.schemaVersion !== 1 ||
    value.featureVersion !== MASTERING_FEATURE_VERSION ||
    !isHash(value.modelHash) ||
    !Number.isFinite(value.p95InferenceMs) ||
    !Number.isFinite(value.peakMemoryMiB) ||
    !Array.isArray(value.pairs) ||
    value.pairs.length !== dataset.pairs.length
  ) {
    fail("prediction schema, feature version, model hash, runtime metrics or pair count is invalid.");
  }
  if ((value.p95InferenceMs as number) < 0 || (value.peakMemoryMiB as number) <= 0) {
    fail("runtime latency and memory measurements must be positive.");
  }
  const expectedPairs = new Map(dataset.pairs.map((pair) => [pair.pairId, pair]));
  const seenPairs = new Set<string>();
  for (const predictionValue of value.pairs) {
    if (
      !record(predictionValue) ||
      !hasExactlyKeys(predictionValue, ["pairId", "modelOrder", "deterministicOrder"]) ||
      !isId(predictionValue.pairId) ||
      seenPairs.has(predictionValue.pairId)
    )
      fail("prediction pair IDs must be unique and valid.");
    const pair = expectedPairs.get(predictionValue.pairId);
    if (!pair) fail(`prediction refers to unknown pair ${predictionValue.pairId}.`);
    const candidateIds = pair.candidates.map((candidate) => candidate.id);
    const isOrder = (order: unknown): order is [string, string] =>
      Array.isArray(order) &&
      order.length === 2 &&
      typeof order[0] === "string" &&
      typeof order[1] === "string" &&
      order[0] !== order[1] &&
      candidateIds.includes(order[0]) &&
      candidateIds.includes(order[1]);
    if (!isOrder(predictionValue.modelOrder) || !isOrder(predictionValue.deterministicOrder)) {
      fail(`pair ${predictionValue.pairId} rankings must be permutations of its two candidates.`);
    }
    if (
      predictionValue.deterministicOrder[0] !== candidateIds[0] ||
      predictionValue.deterministicOrder[1] !== candidateIds[1]
    ) {
      fail(`pair ${predictionValue.pairId} deterministic order must match the stored planner order.`);
    }
    seenPairs.add(predictionValue.pairId);
  }
  return value as unknown as MasteringRankerPredictions;
}

function validateRuntimeMeasurement(
  value: unknown,
  predictions: MasteringRankerPredictions,
  datasetHash: string,
  runtimeMeasurementHash: string,
  pairCount: number,
): MasteringRankerRuntimeMeasurement {
  const keys = [
    "schema",
    "schemaVersion",
    "modelHash",
    "datasetHash",
    "browser",
    "browserVersion",
    "platform",
    "architecture",
    "cpu",
    "measurementMethod",
    "memoryMeasurementMethod",
    "benchmarkScriptHash",
    "rankerWorkerBundleHash",
    "onnxRuntimeVersion",
    "onnxRuntimeWasmHash",
    "pairCount",
    "inferenceCount",
    "memorySampleCount",
    "memorySampleEveryPairs",
    "memoryBaselineMiB",
    "p95InferenceMs",
    "peakMemoryMiB",
  ];
  const validLabel = (label: unknown): label is string =>
    typeof label === "string" && label.length > 0 && label.length <= 128 && !/[\u0000-\u001f\u007f]/.test(label);
  if (
    !record(value) ||
    !hasExactlyKeys(value, keys) ||
    value.schema !== "kyx.mastering-ranker-runtime-measurement" ||
    value.schemaVersion !== 2 ||
    value.modelHash !== predictions.modelHash ||
    value.datasetHash !== datasetHash ||
    value.browser !== "Chromium" ||
    !validLabel(value.browserVersion) ||
    !validLabel(value.platform) ||
    !validLabel(value.architecture) ||
    !validLabel(value.cpu) ||
    value.measurementMethod !== MASTERING_RANKER_RUNTIME_MEASUREMENT_METHOD ||
    value.memoryMeasurementMethod !== MASTERING_RANKER_MEMORY_MEASUREMENT_METHOD ||
    !isHash(value.benchmarkScriptHash) ||
    !isHash(value.rankerWorkerBundleHash) ||
    !validLabel(value.onnxRuntimeVersion) ||
    !isHash(value.onnxRuntimeWasmHash) ||
    value.pairCount !== pairCount ||
    value.inferenceCount !== pairCount ||
    value.memorySampleEveryPairs !== masteringRankerMemorySampleEvery(pairCount) ||
    !Number.isInteger(value.memorySampleCount) ||
    (value.memorySampleCount as number) < Math.ceil(pairCount / (value.memorySampleEveryPairs as number)) + 4 ||
    !Number.isFinite(value.p95InferenceMs) ||
    (value.p95InferenceMs as number) <= 0 ||
    (value.p95InferenceMs as number) > 60_000 ||
    (value.p95InferenceMs as number) !== predictions.p95InferenceMs ||
    !Number.isFinite(value.peakMemoryMiB) ||
    (value.peakMemoryMiB as number) <= 0 ||
    (value.peakMemoryMiB as number) > 16_384 ||
    (value.peakMemoryMiB as number) !== predictions.peakMemoryMiB ||
    !Number.isFinite(value.memoryBaselineMiB) ||
    (value.memoryBaselineMiB as number) <= 0 ||
    (value.memoryBaselineMiB as number) > 16_384 ||
    !isHash(runtimeMeasurementHash)
  ) {
    fail(
      "runtime measurement must be the hash-bound Chromium/WASM run for this exact model, dataset, and inference set.",
    );
  }
  return value as unknown as MasteringRankerRuntimeMeasurement;
}

function majorityPreference(pair: MasteringRankerBlindPair): string | null {
  const counts = new Map<string, number>();
  for (const judgment of pair.judgments) {
    const candidateId = judgment.preferredCandidateId ?? "__tie__";
    counts.set(candidateId, (counts.get(candidateId) ?? 0) + 1);
  }
  const ordered = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  if (ordered.length === 0 || ordered[0]?.[1] === ordered[1]?.[1] || ordered[0]?.[0] === "__tie__") return null;
  return ordered[0]?.[0] ?? null;
}

function seededRandom(seedText: string): () => number {
  let state = Number.parseInt(seedText.slice(0, 8), 16) >>> 0;
  if (state === 0) state = 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function lowerBootstrap95(deltas: readonly number[], seedText: string): number {
  if (deltas.length === 0) return 0;
  const random = seededRandom(seedText);
  const means = new Float64Array(BOOTSTRAP_RESAMPLES);
  for (let replicate = 0; replicate < BOOTSTRAP_RESAMPLES; replicate++) {
    let sum = 0;
    for (let index = 0; index < deltas.length; index++) {
      sum += deltas[Math.floor(random() * deltas.length)] ?? 0;
    }
    means[replicate] = sum / deltas.length;
  }
  const sorted = Array.from(means).sort((left, right) => left - right);
  return sorted[Math.floor((BOOTSTRAP_RESAMPLES - 1) * 0.025)] ?? 0;
}

/** Pair-level paired bootstrap evaluation; no raw audio or identifying labels are read by this module. */
export function evaluateMasteringRanker(
  datasetInput: unknown,
  predictionsInput: unknown,
  datasetHash: string,
  runtimeMeasurementInput: unknown,
  runtimeMeasurementHash: string,
): MasteringRankerEvaluationReport {
  if (!isHash(datasetHash)) fail("dataset hash must be a lowercase SHA-256 digest.");
  const dataset = validateDataset(datasetInput);
  if (dataset.split !== "held-out-blind") fail("only held-out blind datasets can be used for evaluation.");
  const predictions = validatePredictions(predictionsInput, dataset);
  validateRuntimeMeasurement(
    runtimeMeasurementInput,
    predictions,
    datasetHash,
    runtimeMeasurementHash,
    dataset.pairs.length,
  );
  const predictionById = new Map(predictions.pairs.map((prediction) => [prediction.pairId, prediction]));
  const reviewers = new Set(dataset.pairs.flatMap((pair) => pair.judgments.map((judgment) => judgment.reviewerHash)));
  const genres = new Set(dataset.pairs.map((pair) => pair.genreBucket));
  let modelTotal = 0;
  let deterministicTotal = 0;
  let safetyRegressionCount = 0;
  const pairDeltas: number[] = [];

  for (const pair of dataset.pairs) {
    const prediction = predictionById.get(pair.pairId);
    if (!prediction) fail(`prediction is missing for pair ${pair.pairId}.`);
    const preferred = majorityPreference(pair);
    const modelTop = prediction.modelOrder[0];
    const deterministicTop = prediction.deterministicOrder[0];
    const modelScore = preferred === null ? 0.5 : Number(modelTop === preferred);
    const deterministicScore = preferred === null ? 0.5 : Number(deterministicTop === preferred);
    modelTotal += modelScore;
    deterministicTotal += deterministicScore;
    pairDeltas.push(modelScore - deterministicScore);
    const safeById = new Map(pair.candidates.map((candidate) => [candidate.id, candidate.safeAfterPreview]));
    if (safeById.get(modelTop) === false && safeById.get(deterministicTop) === true) safetyRegressionCount += 1;
  }

  const pairCount = dataset.pairs.length;
  return {
    schema: "kyx.mastering-ranker-evaluation",
    schemaVersion: 2,
    modelHash: predictions.modelHash,
    datasetHash,
    runtimeMeasurementHash,
    split: "held-out-blind",
    pairCount,
    reviewerCodeCount: reviewers.size,
    genreBucketCount: genres.size,
    modelPreferenceRate: Math.round((modelTotal / pairCount) * 10_000) / 10_000,
    deterministicPreferenceRate: Math.round((deterministicTotal / pairCount) * 10_000) / 10_000,
    lower95Delta: Math.round(lowerBootstrap95(pairDeltas, `${datasetHash}${predictions.modelHash}`) * 10_000) / 10_000,
    safetyRegressionCount,
    p95InferenceMs: Math.round(predictions.p95InferenceMs * 100) / 100,
    peakMemoryMiB: Math.round(predictions.peakMemoryMiB * 100) / 100,
  };
}
