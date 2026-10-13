import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  MASTERING_FEATURE_VERSION,
  MASTERING_RANKER_FEATURE_COUNT,
  type MasteringProposalCandidate,
} from "../src/mastering/intelligence";
import {
  compareMasteringCandidatesInShadowMode,
  resetMasteringRankerClient,
} from "../src/mastering/mastering-ranker-client";

const manifest = {
  rankerVersion: "mastering-ranker.test",
  featureVersion: MASTERING_FEATURE_VERSION,
  normalizationId: "mastering-normalization.v1",
  featureCount: MASTERING_RANKER_FEATURE_COUNT,
  modelPath: "/models/mastering-ranker-v1.onnx",
  inputName: "features",
  outputName: "utility",
  modelHash: "a".repeat(64),
  evaluation: null,
};

function candidates(count = 2): MasteringProposalCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `zenit/limit/increase/${index}`,
    originalIndex: index,
    step: { device: "zenit" as const, param: "limit", adjustment: "increase" as const, value: 0.2, why: "local" },
    currentValue: 0.1,
    featureVector: Array.from({ length: MASTERING_RANKER_FEATURE_COUNT }, (_, feature) =>
      feature === 0 ? 1 : 0.1 * index,
    ),
  }));
}

class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  readonly requests: Array<Record<string, unknown>> = [];
  static nextScores = [0.2, 0.9];

  constructor() {
    super();
    FakeWorker.instances.push(this);
  }

  postMessage(value: unknown) {
    const request = value as Record<string, unknown>;
    this.requests.push(request);
    const type = request.type;
    const response =
      type === "score"
        ? {
            type,
            requestId: request.requestId,
            ok: true,
            scores: FakeWorker.nextScores.slice(0, Number(request.candidateCount)),
          }
        : { type, requestId: request.requestId, ok: true };
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: response })));
  }

  terminate() {}
}

describe("mastering local ranker shadow client", () => {
  beforeEach(() => {
    resetMasteringRankerClient();
    FakeWorker.instances = [];
    FakeWorker.nextScores = [0.2, 0.9];
  });

  afterEach(() => {
    resetMasteringRankerClient();
    vi.unstubAllGlobals();
  });

  it("keeps the deterministic path when no local model is installed and does not spawn a worker", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({ ok: false, status: 404 }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("Worker", FakeWorker);

    const assessment = await compareMasteringCandidatesInShadowMode(candidates());

    expect(assessment).toMatchObject({
      mode: "shadow",
      status: "unavailable",
      reason: "manifest-unavailable",
      shadowOrderIds: null,
      evaluationGatePassed: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/models/mastering-ranker-v1.manifest.json");
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("compares local scores in shadow mode while sending only a numeric feature batch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, text: async () => JSON.stringify(manifest) }) as unknown as Response),
    );
    vi.stubGlobal("Worker", FakeWorker);

    const sourceCandidates = candidates();
    const assessment = await compareMasteringCandidatesInShadowMode(sourceCandidates);

    expect(assessment).toMatchObject({
      mode: "shadow",
      status: "compared",
      shadowOrderIds: [sourceCandidates[1]?.id, sourceCandidates[0]?.id],
      rankerVersion: manifest.rankerVersion,
      evaluationGatePassed: false,
    });
    expect(sourceCandidates.map((candidate) => candidate.id)).toEqual([
      "zenit/limit/increase/0",
      "zenit/limit/increase/1",
    ]);
    const scoreRequest = FakeWorker.instances[0]?.requests.find((request) => request.type === "score");
    expect(scoreRequest).toBeDefined();
    expect(Object.keys(scoreRequest ?? {}).sort()).toEqual(["batch", "candidateCount", "requestId", "type"]);
    expect(scoreRequest?.batch).toBeInstanceOf(Float32Array);
    expect((scoreRequest?.batch as Float32Array).length).toBe(2 * MASTERING_RANKER_FEATURE_COUNT);
    expect(scoreRequest).not.toHaveProperty("projectRevisionId");
    expect(scoreRequest).not.toHaveProperty("pcm");
  });

  it("rejects non-finite model scores and falls back without returning a partial order", async () => {
    FakeWorker.nextScores = [Number.NaN, 0.9];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, text: async () => JSON.stringify(manifest) }) as unknown as Response),
    );
    vi.stubGlobal("Worker", FakeWorker);

    const assessment = await compareMasteringCandidatesInShadowMode(candidates());

    expect(assessment).toMatchObject({
      status: "unavailable",
      reason: "inference-failed",
      shadowOrderIds: null,
      evaluationGatePassed: false,
    });
  });

  it("opens a session circuit breaker after repeated malformed scores despite successful loads", async () => {
    FakeWorker.nextScores = [Number.NaN, 0.9];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, text: async () => JSON.stringify(manifest) }) as unknown as Response),
    );
    vi.stubGlobal("Worker", FakeWorker);

    const results = [];
    for (let index = 0; index < 4; index++) {
      results.push(await compareMasteringCandidatesInShadowMode(candidates()));
    }

    expect(results.every((result) => result.status === "unavailable")).toBe(true);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]?.requests.filter((request) => request.type === "score")).toHaveLength(3);
    expect(results[3]?.reason).toBe("inference-failed");
  });

  it("marks evaluation passed only when its hashed local report matches the manifest summary", async () => {
    const report = {
      schema: "kyx.mastering-ranker-evaluation",
      schemaVersion: 2,
      modelHash: manifest.modelHash,
      datasetHash: "b".repeat(64),
      runtimeMeasurementHash: "f".repeat(64),
      split: "held-out-blind",
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
    const reportText = JSON.stringify(report);
    const reportHash = createHash("sha256").update(reportText).digest("hex");
    const evaluatedManifest = {
      ...manifest,
      evaluation: {
        schemaVersion: report.schemaVersion,
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
        reportHash,
      },
    };
    const fetchMock = vi.fn(async (input: unknown) =>
      String(input).includes("evaluation-v2.json")
        ? { ok: true, text: async () => reportText }
        : { ok: true, text: async () => JSON.stringify(evaluatedManifest) },
    );
    const digest = Uint8Array.from(reportHash.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("crypto", { subtle: { digest: async () => digest.buffer } } as unknown as Crypto);

    const assessment = await compareMasteringCandidatesInShadowMode(candidates());

    expect(assessment.status).toBe("compared");
    expect(assessment.evaluationGatePassed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
