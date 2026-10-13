import { describe, expect, it } from "vitest";
import type { MixHealthReport } from "../src/analysis/mixDoctor";
import type { BufferSummary } from "../src/audio-engine/metering";
import {
  buildMasteringProposalCandidates,
  createMasteringAnalysisSnapshot,
  isMasteringAnalysisSnapshot,
  MASTERING_FEATURE_VERSION,
  MASTERING_RANKER_FEATURE_NAMES,
  MASTERING_RANKER_FEATURE_COUNT,
} from "../src/mastering/intelligence";
import {
  hasPassedMasteringRankerEvaluation,
  isMasteringRankerManifest,
  type MasteringRankerManifest,
} from "../src/mastering/ranker-types";
import type { MasterAssistantStep, MasteringReferenceMeasurement } from "../src/mcp/master-assistant";
import { CUSTOM_PROFILE } from "../src/mastering/profiles";

const summary: BufferSummary = {
  channelCount: 2,
  peak: 0.9,
  peakDb: -0.92,
  truePeakDb: -0.72,
  rms: 0.2,
  rmsDb: -13.98,
  correlation: 0.72,
  lrImbalanceDb: 0.1,
  lufsMomentary: -10,
  lufsShortTerm: -12,
  lufsIntegrated: -14.2,
  loudnessRangeLu: 4.1,
  monoLossDb: -1.2,
};

const health: MixHealthReport = {
  durationSec: 180,
  peak: summary.peak,
  clippedSamples: 0,
  headroomDb: 0.9,
  crestDb: 12,
  dcOffset: 0,
  integratedLufs: -14.2,
  momentaryMaxLufs: -10,
  bandShares: { sub: 0.08, low: 0.2, lowmid: 0.18, mid: 0.2, himid: 0.16, high: 0.12, air: 0.06 },
  lowEndShare: 0.28,
  stereoCorrelation: 0.72,
  flags: [],
  ok: true,
};

const reference: MasteringReferenceMeasurement = {
  id: "reference-1",
  fileName: "private-reference-name.wav",
  measurement: {
    lufs: -13,
    crestDb: 10,
    correlation: 0.5,
    hfShare: 0.2,
    lowEndShare: 0.3,
  },
};

function snapshot() {
  return createMasteringAnalysisSnapshot({
    projectRevisionId: "project:r1",
    sampleBankRevision: 4,
    sampleRate: 48_000,
    summary,
    health,
    delivery: CUSTOM_PROFILE,
    referenceMeasurement: reference,
  });
}

const manifest = (evaluation: MasteringRankerManifest["evaluation"] = null): MasteringRankerManifest => ({
  rankerVersion: "mastering-ranker.v1",
  featureVersion: MASTERING_FEATURE_VERSION,
  normalizationId: "mastering-normalization.v1",
  featureCount: MASTERING_RANKER_FEATURE_COUNT,
  modelPath: "/models/mastering-ranker-v1.onnx",
  inputName: "features",
  outputName: "utility",
  modelHash: "a".repeat(64),
  evaluation,
});

describe("mastering intelligence analysis contract", () => {
  it("creates a JSON-safe versioned measurement snapshot with per-value provenance", () => {
    const result = snapshot();
    expect(isMasteringAnalysisSnapshot(result)).toBe(true);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(result.measurementTap).toBe("master-output/post-limiter/pre-encode");
    expect(result.provenance.measurements.truePeakDb).toBe("rendered-master");
    expect(result.provenance.reference?.lufsIntegrated).toBe("decoded-reference");
    expect(result).not.toHaveProperty("pcm");
    expect(JSON.stringify(result)).not.toContain(reference.fileName);
  });

  it("records silent and missing measurements as null instead of fabricated zeroes", () => {
    const silent = createMasteringAnalysisSnapshot({
      projectRevisionId: "project:r2",
      sampleBankRevision: 5,
      sampleRate: 44_100,
      summary: { ...summary, peak: 0, lufsIntegrated: -120, truePeakDb: -120 },
      health: { ...health, durationSec: 0.2, peak: 0 },
      delivery: CUSTOM_PROFILE,
    });
    expect(silent.measurements).toMatchObject({
      lufsIntegrated: null,
      peakDb: null,
      truePeakDb: null,
      crestDb: null,
      correlation: null,
      hfShare: null,
      lowEndShare: null,
    });
    expect(Object.values(silent.provenance.measurements)).toEqual(Array(7).fill("not-measured"));
    expect(isMasteringAnalysisSnapshot(silent)).toBe(true);
  });

  it("rejects changed feature schemas and provenance that contradicts measured values", () => {
    const result = snapshot();
    expect(isMasteringAnalysisSnapshot({ ...result, featureVersion: "mastering.features.v2" })).toBe(false);
    expect(
      isMasteringAnalysisSnapshot({
        ...result,
        provenance: {
          ...result.provenance,
          measurements: { ...result.provenance.measurements, truePeakDb: "not-measured" },
        },
      }),
    ).toBe(false);
    expect(
      isMasteringAnalysisSnapshot({
        ...result,
        measurements: { ...result.measurements, truePeakDb: Number.NaN },
      }),
    ).toBe(false);
  });

  it("builds bounded numeric candidates without sending explanations, filenames, or project identity as features", () => {
    const steps: MasterAssistantStep[] = [
      {
        device: "master",
        param: "ceilingDb",
        adjustment: "delta",
        value: -1.5,
        why: "private explanation text",
      },
      { device: "sirka", param: "midWidth", adjustment: "increase", value: 1.2, why: "another explanation" },
    ];
    const candidates = buildMasteringProposalCandidates(snapshot(), steps, [-0.5, 1]);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.featureVector).toHaveLength(MASTERING_RANKER_FEATURE_COUNT);
    expect(candidates.every((candidate) => candidate.featureVector.every((value) => Number.isFinite(value)))).toBe(
      true,
    );
    expect(candidates.every((candidate) => candidate.featureVector.every((value) => value >= -1 && value <= 1))).toBe(
      true,
    );
    expect(candidates[0]?.currentValue).toBe(-0.5);
    expect(
      candidates[0]?.featureVector[MASTERING_RANKER_FEATURE_NAMES.indexOf("candidate.currentValue.available")],
    ).toBe(1);
    expect(
      candidates[0]?.featureVector[MASTERING_RANKER_FEATURE_NAMES.indexOf("candidate.delta.normalized")],
    ).toBeCloseTo(-1 / 12);
    expect(candidates[0]?.featureVector).not.toContain("private explanation text");
    expect(JSON.stringify(candidates.map(({ id, featureVector }) => ({ id, featureVector })))).not.toContain(
      reference.fileName,
    );
    expect(JSON.stringify(candidates.map(({ id, featureVector }) => ({ id, featureVector })))).not.toContain(
      "project:r1",
    );
  });
});

describe("mastering ranker manifest and activation gate", () => {
  it("accepts a local, schema-compatible model for shadow inference without activating it", () => {
    const value = manifest();
    expect(isMasteringRankerManifest(value)).toBe(true);
    expect(hasPassedMasteringRankerEvaluation(value)).toBe(false);
    expect(isMasteringRankerManifest({ ...value, modelPath: "https://example.com/model.onnx" })).toBe(false);
    expect(isMasteringRankerManifest({ ...value, featureCount: value.featureCount + 1 })).toBe(false);
  });

  it("requires held-out human preference lift, zero safety regressions, and runtime budgets to pass", () => {
    const gate = {
      schemaVersion: 2 as const,
      modelHash: "a".repeat(64),
      datasetHash: "b".repeat(64),
      runtimeMeasurementHash: "f".repeat(64),
      reportPath: "/models/mastering-ranker-evaluation-v2.json",
      reportHash: "c".repeat(64),
      split: "held-out-blind" as const,
      pairCount: 120,
      reviewerCodeCount: 3,
      genreBucketCount: 5,
      modelPreferenceRate: 0.68,
      deterministicPreferenceRate: 0.59,
      lower95Delta: 0.02,
      safetyRegressionCount: 0,
      p95InferenceMs: 180,
      peakMemoryMiB: 64,
    };
    expect(hasPassedMasteringRankerEvaluation(manifest(gate))).toBe(true);
    expect(isMasteringRankerManifest(manifest({ ...gate, safetyRegressionCount: 1 }))).toBe(false);
    expect(isMasteringRankerManifest(manifest({ ...gate, lower95Delta: 0 }))).toBe(false);
    expect(isMasteringRankerManifest(manifest({ ...gate, pairCount: 99 }))).toBe(false);
    expect(isMasteringRankerManifest(manifest({ ...gate, p95InferenceMs: 251 }))).toBe(false);
  });
});
