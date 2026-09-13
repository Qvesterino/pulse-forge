import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentRankerManifest, resetRankerClient, scoreCandidateFeatures } from "../src/ai/ranking/ranker-client";
import type { RankerManifest, RankerRequest, RankerResponse } from "../src/ai/ranking/ranker-types";

const manifest: RankerManifest = {
  rankerVersion: "ranker.v1",
  featureVersion: "features.v1",
  normalizationId: "norm.fixed.v1",
  featureCount: 2,
  modelPath: "/models/intent-ranker-v1.onnx",
  inputName: "input",
  outputName: "output",
  modelHash: "a".repeat(64),
  hidden: [8, 8],
};

type WorkerMode = "success" | "load-fail" | "malformed-score" | "timeout";

class TestWorker {
  static mode: WorkerMode = "success";
  static instances: TestWorker[] = [];
  terminated = false;
  private readonly listeners = new Set<(event: MessageEvent<RankerResponse>) => void>();

  constructor() {
    TestWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<RankerResponse>) => void) {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: MessageEvent<RankerResponse>) => void) {
    if (type === "message") this.listeners.delete(listener);
  }

  postMessage(request: RankerRequest) {
    if (TestWorker.mode === "timeout") return;
    setTimeout(() => {
      if (this.terminated) return;
      if (request.type === "load") {
        this.emit(
          TestWorker.mode === "load-fail"
            ? { type: "load", requestId: request.requestId, ok: false, error: "model hash mismatch" }
            : { type: "load", requestId: request.requestId, ok: true },
        );
        return;
      }
      if (request.type === "score") {
        this.emit(
          TestWorker.mode === "malformed-score"
            ? { type: "score", requestId: request.requestId, ok: true, scores: [Number.NaN] }
            : {
                type: "score",
                requestId: request.requestId,
                ok: true,
                scores: [0.2, 0.8].slice(0, request.candidateCount),
              },
        );
        return;
      }
      this.emit({ type: "dispose", requestId: request.requestId, ok: true });
    }, 0);
  }

  terminate() {
    this.terminated = true;
  }

  private emit(response: RankerResponse) {
    for (const listener of this.listeners) listener({ data: response } as MessageEvent<RankerResponse>);
  }
}

function featureBatch(candidateCount = 1) {
  return new Float32Array(candidateCount * manifest.featureCount);
}

describe("ranker-client controlled fallback contract", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", TestWorker);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => manifest,
      })),
    );
    TestWorker.mode = "success";
    TestWorker.instances = [];
    resetRankerClient();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetRankerClient();
    vi.unstubAllGlobals();
  });

  it("returns a controlled fallback when the manifest is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );

    const result = await scoreCandidateFeatures(featureBatch(), 1);

    expect(result).toEqual({ ok: false, scores: null, source: "fallback" });
    expect(TestWorker.instances).toHaveLength(0);
    expect(currentRankerManifest()).toBeNull();
  });

  it("returns a controlled fallback when the manifest request stalls", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    const pending = scoreCandidateFeatures(featureBatch(), 1);
    await vi.advanceTimersByTimeAsync(1500);

    await expect(pending).resolves.toEqual({ ok: false, scores: null, source: "fallback" });
    expect(TestWorker.instances).toHaveLength(0);
  });

  it("returns a controlled fallback when the worker rejects the model hash", async () => {
    TestWorker.mode = "load-fail";

    const result = await scoreCandidateFeatures(featureBatch(), 1);

    expect(result).toEqual({ ok: false, scores: null, source: "fallback" });
  });

  it("rejects malformed, non-finite or wrong-length model scores", async () => {
    TestWorker.mode = "malformed-score";

    const result = await scoreCandidateFeatures(featureBatch(), 1);

    expect(result).toEqual({ ok: false, scores: null, source: "fallback" });
  });

  it("stops retrying after three load timeouts", async () => {
    vi.useFakeTimers();
    TestWorker.mode = "timeout";

    for (let attempt = 0; attempt < 3; attempt++) {
      const pending = scoreCandidateFeatures(featureBatch(), 1);
      await vi.advanceTimersByTimeAsync(3000);
      await expect(pending).resolves.toEqual({ ok: false, scores: null, source: "fallback" });
    }

    const fourth = await scoreCandidateFeatures(featureBatch(), 1);

    expect(fourth).toEqual({ ok: false, scores: null, source: "fallback" });
    expect(TestWorker.instances).toHaveLength(1);
    expect(TestWorker.instances[0].terminated).toBe(true);
  });
});
