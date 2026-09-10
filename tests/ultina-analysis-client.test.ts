import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisRequest } from "../src/effects/ultina-core/analysis/assistant";
import type { UltinaAnalysisWorkerRequest, UltinaAnalysisWorkerResponse } from "../src/analysis/ultinaAnalysisWorker";
import {
  UltinaAnalysisCancelledError,
  isUltinaAnalysisCancelledError,
  startUltinaAnalysis,
  startUltinaTargetAnalysis,
} from "../src/analysis/ultinaAnalysisClient";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<UltinaAnalysisWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly postMessage = vi.fn((request: UltinaAnalysisWorkerRequest, transfer?: Transferable[]) => {
    this.request = request;
    this.transfer = transfer ?? [];
  });
  readonly terminate = vi.fn();
  request: UltinaAnalysisWorkerRequest | null = null;
  transfer: Transferable[] = [];

  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    FakeWorker.instances.push(this);
  }

  respond(response: UltinaAnalysisWorkerResponse) {
    this.onmessage?.({ data: response } as MessageEvent<UltinaAnalysisWorkerResponse>);
  }
}

const request: AnalysisRequest = {
  channels: [new Float32Array([0.1, -0.2, 0.3])],
  sampleRate: 44100,
  minimumDuration: 0,
};

describe("VLYX analysis worker client", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("copies audio channels and resolves an analysis response", async () => {
    const source = request.channels[0];
    const task = startUltinaAnalysis(request);
    const worker = FakeWorker.instances[0];
    expect(worker.options.type).toBe("module");
    expect(worker.request?.kind).toBe("analyze");
    if (worker.request?.kind !== "analyze") throw new Error("missing analyze request");
    expect(worker.request.request.channels[0]).not.toBe(source);
    expect(Array.from(worker.request.request.channels[0])).toEqual(Array.from(source));
    expect(worker.transfer).toHaveLength(1);
    expect(worker.postMessage).toHaveBeenCalledOnce();

    worker.respond({ id: 1, ok: true, kind: "analysis", result: { kind: "error", message: "fixture" } });
    await expect(task.promise).resolves.toEqual({ kind: "error", message: "fixture" });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("supports the reference target-curve operation", async () => {
    const task = startUltinaTargetAnalysis(request.channels, request.sampleRate);
    const worker = FakeWorker.instances[0];
    expect(worker.request?.kind).toBe("target-curve");
    worker.respond({
      id: 1,
      ok: true,
      kind: "target-curve",
      result: { targetCurve: [0, -1, -2] },
    });
    await expect(task.promise).resolves.toEqual({ targetCurve: [0, -1, -2] });
  });

  it("cancels and terminates the worker without surfacing a user error", async () => {
    const task = startUltinaAnalysis(request);
    const worker = FakeWorker.instances[0];
    task.cancel();
    await expect(task.promise).rejects.toBeInstanceOf(UltinaAnalysisCancelledError);
    expect(isUltinaAnalysisCancelledError(new UltinaAnalysisCancelledError())).toBe(true);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("reports an explicit error when workers are unavailable", async () => {
    vi.stubGlobal("Worker", undefined);
    const task = startUltinaAnalysis(request);
    await expect(task.promise).rejects.toThrow("worker is unavailable");
  });
});
