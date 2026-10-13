import { describe, expect, it } from "vitest";
import { evaluateMasteringRanker, parseMasteringRankerBlindDataset } from "../src/mastering/evaluation";
import { isMasteringRankerEvaluationGate, type MasteringRankerEvaluationGate } from "../src/mastering/ranker-types";
import { MASTERING_FEATURE_VERSION, MASTERING_RANKER_FEATURE_COUNT } from "../src/mastering/intelligence";

const MODEL_HASH = "a".repeat(64);
const DATASET_HASH = "b".repeat(64);
const RUNTIME_MEASUREMENT_HASH = "f".repeat(64);
const GENRES = ["electronic", "hip-hop", "rock", "acoustic", "ambient"] as const;

function evaluationInputs(pairCount = 100) {
  const pairs = Array.from({ length: pairCount }, (_, index) => ({
    pairId: `pair-${index}`,
    sourceMixHash: index.toString(16).padStart(64, "0"),
    genreBucket: GENRES[index % GENRES.length]!,
    candidates: [
      {
        id: `baseline-${index}`,
        features: new Array(MASTERING_RANKER_FEATURE_COUNT).fill(-0.25),
        safeAfterPreview: true,
      },
      {
        id: `better-${index}`,
        features: new Array(MASTERING_RANKER_FEATURE_COUNT).fill(0.25),
        safeAfterPreview: true,
      },
    ],
    judgments: [
      { reviewerHash: "c".repeat(64), preferredCandidateId: `better-${index}` },
      { reviewerHash: "d".repeat(64), preferredCandidateId: `better-${index}` },
    ],
  }));
  const dataset = {
    schema: "kyx.mastering-ranker-blind-set",
    schemaVersion: 3,
    split: "held-out-blind",
    pairs,
  };
  const predictions = {
    schema: "kyx.mastering-ranker-predictions",
    schemaVersion: 1,
    featureVersion: MASTERING_FEATURE_VERSION,
    modelHash: MODEL_HASH,
    p95InferenceMs: 80,
    peakMemoryMiB: 48,
    pairs: pairs.map((pair, index) => ({
      pairId: pair.pairId,
      modelOrder: [`better-${index}`, `baseline-${index}`],
      deterministicOrder: [`baseline-${index}`, `better-${index}`],
    })),
  };
  const runtimeMeasurement = {
    schema: "kyx.mastering-ranker-runtime-measurement",
    schemaVersion: 2,
    modelHash: MODEL_HASH,
    datasetHash: DATASET_HASH,
    browser: "Chromium",
    browserVersion: "test-browser-1",
    platform: "test-platform",
    architecture: "test-arch",
    cpu: "test-cpu",
    measurementMethod: "kyx.onnxruntime-web.wasm.chromium-windows-v1",
    memoryMeasurementMethod: "windows.process-tree.private-bytes-baseline-delta-v1",
    benchmarkScriptHash: "1".repeat(64),
    rankerWorkerBundleHash: "3".repeat(64),
    onnxRuntimeVersion: "1.29.0",
    onnxRuntimeWasmHash: "2".repeat(64),
    pairCount,
    inferenceCount: pairCount,
    memorySampleCount: Math.ceil(pairCount / Math.max(10, Math.ceil(pairCount / 100))) + 4,
    memorySampleEveryPairs: Math.max(10, Math.ceil(pairCount / 100)),
    memoryBaselineMiB: 64,
    p95InferenceMs: 80,
    peakMemoryMiB: 48,
  };
  return { dataset, predictions, runtimeMeasurement };
}

function gateFromReport(report: ReturnType<typeof evaluateMasteringRanker>): MasteringRankerEvaluationGate {
  return {
    schemaVersion: 2,
    modelHash: report.modelHash,
    datasetHash: report.datasetHash,
    runtimeMeasurementHash: report.runtimeMeasurementHash,
    split: report.split,
    pairCount: report.pairCount,
    reviewerCodeCount: report.reviewerCodeCount,
    genreBucketCount: report.genreBucketCount,
    modelPreferenceRate: report.modelPreferenceRate,
    deterministicPreferenceRate: report.deterministicPreferenceRate,
    lower95Delta: report.lower95Delta,
    safetyRegressionCount: report.safetyRegressionCount,
    p95InferenceMs: report.p95InferenceMs,
    peakMemoryMiB: report.peakMemoryMiB,
    reportPath: "/models/mastering-ranker-evaluation-v2.json",
    reportHash: "e".repeat(64),
  };
}

describe("mastering ranker blind evaluation", () => {
  it("compares model and deterministic baseline on held-out human preferences", () => {
    const { dataset, predictions, runtimeMeasurement } = evaluationInputs();
    const report = evaluateMasteringRanker(
      dataset,
      predictions,
      DATASET_HASH,
      runtimeMeasurement,
      RUNTIME_MEASUREMENT_HASH,
    );

    expect(report).toMatchObject({
      schema: "kyx.mastering-ranker-evaluation",
      modelHash: MODEL_HASH,
      datasetHash: DATASET_HASH,
      runtimeMeasurementHash: RUNTIME_MEASUREMENT_HASH,
      split: "held-out-blind",
      pairCount: 100,
      reviewerCodeCount: 2,
      genreBucketCount: 5,
      modelPreferenceRate: 1,
      deterministicPreferenceRate: 0,
      lower95Delta: 1,
      safetyRegressionCount: 0,
    });
    expect(isMasteringRankerEvaluationGate(gateFromReport(report))).toBe(true);
  });

  it("does not pass activation when the model does not beat baseline or has a safety regression", () => {
    const { dataset, predictions, runtimeMeasurement } = evaluationInputs();
    const tiedPredictions = {
      ...predictions,
      pairs: predictions.pairs.map((pair) => ({ ...pair, modelOrder: pair.deterministicOrder })),
    };
    const tied = evaluateMasteringRanker(
      dataset,
      tiedPredictions,
      DATASET_HASH,
      runtimeMeasurement,
      RUNTIME_MEASUREMENT_HASH,
    );
    expect(tied.lower95Delta).toBe(0);
    expect(isMasteringRankerEvaluationGate(gateFromReport(tied))).toBe(false);

    const unsafeDataset = {
      ...dataset,
      pairs: dataset.pairs.map((pair, index) =>
        index === 0
          ? {
              ...pair,
              candidates: [pair.candidates[0], { ...pair.candidates[1], safeAfterPreview: false }],
            }
          : pair,
      ),
    };
    const unsafe = evaluateMasteringRanker(
      unsafeDataset,
      predictions,
      DATASET_HASH,
      runtimeMeasurement,
      RUNTIME_MEASUREMENT_HASH,
    );
    expect(unsafe.safetyRegressionCount).toBe(1);
    expect(isMasteringRankerEvaluationGate(gateFromReport(unsafe))).toBe(false);
  });

  it("rejects stale model features, duplicate source mixes, and rankings with unknown candidates", () => {
    const { dataset, predictions, runtimeMeasurement } = evaluationInputs();
    expect(() =>
      evaluateMasteringRanker(
        dataset,
        { ...predictions, featureVersion: "mastering.features.v2" },
        DATASET_HASH,
        runtimeMeasurement,
        RUNTIME_MEASUREMENT_HASH,
      ),
    ).toThrow(/feature version/);
    const repeatedSource = {
      ...dataset,
      pairs: dataset.pairs.map((pair, index) =>
        index === 1 ? { ...pair, sourceMixHash: dataset.pairs[0]!.sourceMixHash } : pair,
      ),
    };
    expect(() =>
      evaluateMasteringRanker(repeatedSource, predictions, DATASET_HASH, runtimeMeasurement, RUNTIME_MEASUREMENT_HASH),
    ).toThrow(/source hash/);
    const unknownCandidate = {
      ...predictions,
      pairs: predictions.pairs.map((pair, index) =>
        index === 0 ? { ...pair, modelOrder: ["unknown", pair.modelOrder[1]] } : pair,
      ),
    };
    expect(() =>
      evaluateMasteringRanker(dataset, unknownCandidate, DATASET_HASH, runtimeMeasurement, RUNTIME_MEASUREMENT_HASH),
    ).toThrow(/permutations/);
    const incorrectBaseline = {
      ...predictions,
      pairs: predictions.pairs.map((pair, index) =>
        index === 0 ? { ...pair, deterministicOrder: [...pair.deterministicOrder].reverse() } : pair,
      ),
    };
    expect(() =>
      evaluateMasteringRanker(dataset, incorrectBaseline, DATASET_HASH, runtimeMeasurement, RUNTIME_MEASUREMENT_HASH),
    ).toThrow(/stored planner order/);

    expect(() =>
      evaluateMasteringRanker(dataset, predictions, DATASET_HASH, runtimeMeasurement, "invalid-runtime-hash"),
    ).toThrow(/hash-bound/);
    expect(() =>
      evaluateMasteringRanker(
        dataset,
        predictions,
        DATASET_HASH,
        { ...runtimeMeasurement, modelHash: "9".repeat(64) },
        RUNTIME_MEASUREMENT_HASH,
      ),
    ).toThrow(/hash-bound/);
    expect(() =>
      evaluateMasteringRanker(
        dataset,
        predictions,
        DATASET_HASH,
        { ...runtimeMeasurement, datasetHash: "9".repeat(64) },
        RUNTIME_MEASUREMENT_HASH,
      ),
    ).toThrow(/hash-bound/);
    expect(() =>
      evaluateMasteringRanker(
        dataset,
        predictions,
        DATASET_HASH,
        { ...runtimeMeasurement, memorySampleCount: 2 },
        RUNTIME_MEASUREMENT_HASH,
      ),
    ).toThrow(/hash-bound/);
    expect(() =>
      evaluateMasteringRanker(
        dataset,
        { ...predictions, p95InferenceMs: 81 },
        DATASET_HASH,
        runtimeMeasurement,
        RUNTIME_MEASUREMENT_HASH,
      ),
    ).toThrow(/hash-bound/);
  });

  it("rejects missing, stale-width, non-finite, and out-of-range candidate feature vectors", () => {
    const { dataset, predictions, runtimeMeasurement } = evaluationInputs();
    const original = dataset.pairs[0]!.candidates[0]!;
    const invalidCandidates = [
      { ...original, features: undefined },
      { ...original, features: original.features.slice(1) },
      { ...original, features: original.features.map((value, index) => (index === 0 ? Number.NaN : value)) },
      { ...original, features: original.features.map((value, index) => (index === 0 ? 1.01 : value)) },
    ];
    for (const invalid of invalidCandidates) {
      const malformedDataset = {
        ...dataset,
        pairs: dataset.pairs.map((pair, index) =>
          index === 0 ? { ...pair, candidates: [invalid, pair.candidates[1]] } : pair,
        ),
      };
      expect(() =>
        evaluateMasteringRanker(
          malformedDataset,
          predictions,
          DATASET_HASH,
          runtimeMeasurement,
          RUNTIME_MEASUREMENT_HASH,
        ),
      ).toThrow(/candidate/);
    }
  });

  it("reports underpowered preference sets but refuses to gate them", () => {
    const { dataset, predictions, runtimeMeasurement } = evaluationInputs(99);
    const report = evaluateMasteringRanker(
      dataset,
      predictions,
      DATASET_HASH,
      runtimeMeasurement,
      RUNTIME_MEASUREMENT_HASH,
    );
    expect(report.pairCount).toBe(99);
    expect(isMasteringRankerEvaluationGate(gateFromReport(report))).toBe(false);
  });

  it("keeps development data separate from held-out evaluation", () => {
    const { dataset, predictions, runtimeMeasurement } = evaluationInputs();
    const development = parseMasteringRankerBlindDataset({ ...dataset, split: "development" });
    expect(development.split).toBe("development");
    expect(() =>
      evaluateMasteringRanker(development, predictions, DATASET_HASH, runtimeMeasurement, RUNTIME_MEASUREMENT_HASH),
    ).toThrow(/only held-out blind/);
  });
});
