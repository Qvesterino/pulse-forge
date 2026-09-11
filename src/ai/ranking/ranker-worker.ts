/// <reference lib="webworker" />
/**
 * ONNX intent-ranker worker (goal doc Fáze 3).
 *
 * - Lazy-loads the ONNX Runtime (WASM) and the model from LOCAL assets —
 *   no network request, no cloud, nothing in the audio callback.
 * - Session is created once and reused for the whole candidate batch.
 * - Controlled fallback statuses: every failure path answers with
 *   { ok: false, error } so the main thread can fall back to the
 *   heuristic ranking without ever throwing.
 */

import {
  isRankerManifest,
  type RankerManifest,
  type RankerRequest,
  type RankerResponse,
} from "./ranker-types";


// The ranker only needs the CPU/WASM backend. Importing the root package pulls
// the JSEP/WebGPU build and its much larger wasm binary into the lazy chunk.
// Vite can then track the WASM asset and rewrite its URL for production.
type OrtNamespace = typeof import("onnxruntime-web/wasm");
type OrtSession = Awaited<ReturnType<OrtNamespace["InferenceSession"]["create"]>>;

let ort: OrtNamespace | null = null;
let session: OrtSession | null = null;
let loadedManifest: RankerManifest | null = null;

async function ensureOrt(): Promise<OrtNamespace> {
  if (ort) return ort;
  const loaded = await import("onnxruntime-web/wasm");
  // Single-threaded WASM: worker-scoped inference must not spawn pthread
  // pools inside an already-backgrounded context.
  loaded.env.wasm.numThreads = 1;
  ort = loaded as OrtNamespace;
  return ort;
}

async function ensureSession(manifest: RankerManifest): Promise<OrtSession> {
  if (session && loadedManifest?.modelHash === manifest.modelHash) return session;
  const ortNs = await ensureOrt();
  if (!isRankerManifest(manifest)) throw new Error("invalid ranker manifest");
  const response = await fetch(manifest.modelPath);
  if (!response.ok) throw new Error(`model fetch failed: ${response.status}`);
  const bytes = await response.arrayBuffer();
  session = await ortNs.InferenceSession.create(new Uint8Array(bytes), {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  loadedManifest = manifest;
  return session;
}

async function handle(request: RankerRequest): Promise<RankerResponse> {
  if (request.type === "load") {
    try {
      await ensureSession(request.manifest);
      return { type: "load", requestId: request.requestId, ok: true };
    } catch (error) {
      session = null;
      return {
        type: "load",
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (request.type === "score") {
    try {
      if (!session || !loadedManifest || !ort) throw new Error("model not loaded");
      const { batch, candidateCount } = request;
      if (!(batch instanceof Float32Array)) throw new Error("batch must be Float32Array");
      if (batch.length !== candidateCount * loadedManifest.featureCount)
        throw new Error(`batch size ${batch.length} != ${candidateCount}×${loadedManifest.featureCount}`);
      const input = new ort.Tensor("float32", batch, [candidateCount, loadedManifest.featureCount]);
      const feeds = { [loadedManifest.inputName]: input };
      const output = await session.run(feeds);
      const tensor = output[loadedManifest.outputName];
      if (!tensor) throw new Error("missing model output");
      const raw = tensor.data as Float32Array;
      if (raw.length !== candidateCount) throw new Error(`output count ${raw.length} != ${candidateCount}`);
      const scores: number[] = [];
      for (let i = 0; i < raw.length; i++) {
        const value = raw[i];
        // Normalize + round per ranker version before any stable sort.
        const sigmoid = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
        if (!Number.isFinite(sigmoid)) throw new Error("non-finite model output");
        scores.push(Math.round(sigmoid * 10_000) / 10_000);
      }
      return { type: "score", requestId: request.requestId, ok: true, scores };
    } catch (error) {
      return {
        type: "score",
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  // dispose
  try {
    await session?.release();
  } catch {
    /* already released */
  }
  session = null;
  loadedManifest = null;
  return { type: "dispose", requestId: request.requestId, ok: true };
}

self.onmessage = async (event: MessageEvent<RankerRequest>) => {
  const request = event.data;
  try {
    const response = await handle(request);
    (self as unknown as Worker).postMessage(response);
  } catch (error) {
    const response: RankerResponse = {
      type: request.type,
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } as RankerResponse;
    (self as unknown as Worker).postMessage(response);
  }
};
