/// <reference lib="webworker" />

import { assetUrl } from "../shared/assetUrls";
import { MASTERING_RANKER_FEATURE_COUNT } from "./intelligence";
import {
  isMasteringRankerManifest,
  type MasteringRankerDisposeRequest,
  type MasteringRankerLoadRequest,
  type MasteringRankerManifest,
  type MasteringRankerRequest,
  type MasteringRankerScoreRequest,
  type MasteringRankerResponse,
} from "./ranker-types";

type OrtNamespace = typeof import("onnxruntime-web/wasm");
type OrtSession = Awaited<ReturnType<OrtNamespace["InferenceSession"]["create"]>>;

const MAX_CANDIDATES = 64;
const MAX_MODEL_BYTES = 16 * 1024 * 1024;
const MAX_ORT_WASM_BYTES = 32 * 1024 * 1024;
let ort: OrtNamespace | null = null;
let session: OrtSession | null = null;
let loadedManifest: MasteringRankerManifest | null = null;

async function ensureOrt(): Promise<OrtNamespace> {
  if (ort) return ort;
  const loaded = await import("onnxruntime-web/wasm");
  const wasmResponse = await fetch(assetUrl("/models/ort/ort-wasm-simd-threaded.wasm"));
  if (!wasmResponse.ok) throw new Error(`runtime unavailable (${wasmResponse.status})`);
  const wasmBytes = await wasmResponse.arrayBuffer();
  if (wasmBytes.byteLength === 0 || wasmBytes.byteLength > MAX_ORT_WASM_BYTES)
    throw new Error("runtime asset size invalid");
  loaded.env.wasm.wasmBinary = wasmBytes;
  loaded.env.wasm.numThreads = 1;
  ort = loaded as OrtNamespace;
  return ort;
}

async function readModelBytes(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MODEL_BYTES)
    throw new Error("model asset exceeds size cap");
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_MODEL_BYTES) throw new Error("model asset size invalid");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_MODEL_BYTES) {
        await reader.cancel();
        throw new Error("model asset exceeds size cap");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error("model asset is empty");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function ensureSession(manifest: MasteringRankerManifest): Promise<OrtSession> {
  if (!isMasteringRankerManifest(manifest)) throw new Error("manifest invalid");
  if (session && loadedManifest?.modelHash === manifest.modelHash) return session;
  const ortNs = await ensureOrt();
  const response = await fetch(assetUrl(manifest.modelPath));
  if (!response.ok) throw new Error(`model asset unavailable (${response.status})`);
  const bytes = await readModelBytes(response);
  if (!globalThis.crypto?.subtle) throw new Error("model verification unavailable");
  const digestInput = bytes.slice().buffer as ArrayBuffer;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", digestInput);
  const actualHash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  if (actualHash !== manifest.modelHash) throw new Error("model hash mismatch");
  const nextSession = await ortNs.InferenceSession.create(bytes, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  if (!nextSession.inputNames.includes(manifest.inputName) || !nextSession.outputNames.includes(manifest.outputName)) {
    await nextSession.release();
    throw new Error("model input/output contract mismatch");
  }
  await session?.release();
  session = nextSession;
  loadedManifest = manifest;
  return session;
}

function controlledError(error: unknown): string {
  const message = error instanceof Error ? error.message : "worker request failed";
  return message.slice(0, 240);
}

async function handle(input: unknown): Promise<MasteringRankerResponse> {
  if (!input || typeof input !== "object") {
    return { type: "score", requestId: -1, ok: false, error: "invalid worker request" };
  }
  const envelope = input as Record<string, unknown>;
  const requestId = envelope.requestId;
  if (!Number.isSafeInteger(requestId)) {
    return { type: "score", requestId: -1, ok: false, error: "invalid worker request" };
  }
  const validRequestId = requestId as number;
  if (envelope.type === "load") {
    const request = input as MasteringRankerLoadRequest;
    try {
      await ensureSession(request.manifest);
      return { type: "load", requestId: request.requestId, ok: true };
    } catch (error) {
      return { type: "load", requestId: request.requestId, ok: false, error: controlledError(error) };
    }
  }
  if (envelope.type === "score") {
    const request = input as MasteringRankerScoreRequest;
    try {
      if (!session || !loadedManifest || !ort) throw new Error("model is not loaded");
      const { batch, candidateCount } = request;
      if (
        !(batch instanceof Float32Array) ||
        !Number.isSafeInteger(candidateCount) ||
        candidateCount < 1 ||
        candidateCount > MAX_CANDIDATES ||
        batch.length !== candidateCount * MASTERING_RANKER_FEATURE_COUNT ||
        batch.length !== candidateCount * loadedManifest.featureCount
      ) {
        throw new Error("feature batch shape invalid");
      }
      for (const feature of batch) {
        if (!Number.isFinite(feature) || feature < -1 || feature > 1) throw new Error("feature batch value invalid");
      }
      const tensor = new ort.Tensor("float32", batch, [candidateCount, loadedManifest.featureCount]);
      const output = await session.run({ [loadedManifest.inputName]: tensor });
      const scoresTensor = output[loadedManifest.outputName];
      if (!scoresTensor || scoresTensor.data.length !== candidateCount) throw new Error("model score count invalid");
      const scores: number[] = [];
      for (const raw of scoresTensor.data) {
        if (typeof raw !== "number" || !Number.isFinite(raw)) throw new Error("model score is non-finite");
        const normalized = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, raw))));
        scores.push(Math.round(normalized * 10_000) / 10_000);
      }
      return { type: "score", requestId: request.requestId, ok: true, scores };
    } catch (error) {
      return { type: "score", requestId: request.requestId, ok: false, error: controlledError(error) };
    }
  }
  if (envelope.type === "dispose") {
    const request = input as MasteringRankerDisposeRequest;
    try {
      await session?.release();
    } catch {
      /* session may already be released */
    }
    session = null;
    loadedManifest = null;
    return { type: "dispose", requestId: request.requestId, ok: true };
  }
  return { type: "score", requestId: validRequestId, ok: false, error: "unknown worker request" };
}

let requestQueue: Promise<void> = Promise.resolve();

self.onmessage = (event: MessageEvent<MasteringRankerRequest>) => {
  requestQueue = requestQueue
    .then(async () => {
      try {
        const response = await handle(event.data as unknown);
        (self as unknown as Worker).postMessage(response);
      } catch {
        const input = event.data as unknown;
        const requestId =
          input && typeof input === "object" && Number.isSafeInteger((input as Record<string, unknown>).requestId)
            ? ((input as Record<string, unknown>).requestId as number)
            : -1;
        (self as unknown as Worker).postMessage({
          type: "score",
          requestId,
          ok: false,
          error: "worker request failed",
        } satisfies MasteringRankerResponse);
      }
    })
    .catch(() => {
      requestQueue = Promise.resolve();
    });
};
