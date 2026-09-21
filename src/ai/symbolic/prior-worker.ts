import { assetUrl } from "../../shared/assetUrls";
/// <reference lib="webworker" />
/**
 * ONNX symbolic prior worker — drums AND melodic models (INTENT_ENGINE.md T2).
 *
 * Mirrors ranker-worker.ts guarantees: lazy local asset load (no network, no
 * cloud, nothing in the audio callback), one session per model kind reused
 * across requests, SHA-256 model verification against the manifest, and
 * controlled fallback statuses — every failure path answers { ok: false,
 * error } so the main thread can degrade to template generation without
 * ever throwing.
 *
 * Normalization happens here so the main thread receives ready-to-use
 * distributions: drums → sigmoid(hit logits); melodic → softmax over the
 * degree and duration heads. Rounded to 4 decimals per prior version.
 */

import {
  isDrumsPriorManifest,
  isDrumsV2PriorManifest,
  isMelodicPriorManifest,
  type MelodicPriorManifest,
  type PriorManifest,
  type PriorKind,
  type PriorRequest,
  type PriorResponse,
  type SigmoidPriorManifest,
} from "./prior-types";

type OrtNamespace = typeof import("onnxruntime-web/wasm");
type OrtSession = Awaited<ReturnType<OrtNamespace["InferenceSession"]["create"]>>;

let ort: OrtNamespace | null = null;
const sessions = new Map<PriorKind, { session: OrtSession; manifest: PriorManifest }>();

async function ensureOrt(): Promise<OrtNamespace> {
  if (ort) return ort;
  const loaded = await import("onnxruntime-web/wasm");
  // Same runtime bytes as the ranker worker (public/models/ort/, synced by
  // npm run ranker:ort-sync). Single-threaded WASM: worker-scoped inference
  // must not spawn pthread pools inside an already-backgrounded context.
  const wasmResponse = await fetch(assetUrl("/models/ort/ort-wasm-simd-threaded.wasm"));
  if (!wasmResponse.ok) throw new Error(`ort wasm fetch failed: ${wasmResponse.status}`);
  loaded.env.wasm.wasmBinary = await wasmResponse.arrayBuffer();
  loaded.env.wasm.numThreads = 1;
  ort = loaded as OrtNamespace;
  return ort;
}

async function verifyModelBytes(modelPath: string, expectedHash: string): Promise<Uint8Array> {
  const response = await fetch(modelPath);
  if (!response.ok) throw new Error(`model fetch failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto unavailable for model verification");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const actualHash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  if (actualHash !== expectedHash.toLowerCase()) throw new Error("model hash mismatch");
  return bytes;
}

async function ensureSession(kind: PriorKind, manifest: PriorManifest): Promise<OrtSession> {
  const cached = sessions.get(kind);
  if (cached && cached.manifest.modelHash === manifest.modelHash) return cached.session;
  const ortNs = await ensureOrt();
  if (kind === "drums" && !isDrumsPriorManifest(manifest)) throw new Error("invalid drums prior manifest");
  if (kind === "drums-v2" && !isDrumsV2PriorManifest(manifest)) throw new Error("invalid drums-v2 prior manifest");
  if (kind === "melodic" && !isMelodicPriorManifest(manifest)) throw new Error("invalid melodic prior manifest");
  const bytes = await verifyModelBytes(manifest.modelPath, manifest.modelHash);
  const session = await ortNs.InferenceSession.create(bytes, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  sessions.set(kind, { session, manifest });
  return session;
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
}

function softmaxRow(values: number[]): number[] {
  const max = Math.max(...values);
  const exp = values.map((value) => Math.exp(Math.max(-30, Math.min(30, value - max))));
  const sum = exp.reduce((total, value) => total + value, 0);
  return exp.map((value) => value / sum);
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

async function handle(request: PriorRequest): Promise<PriorResponse> {
  if (request.type === "load") {
    try {
      await ensureSession(request.kind, request.manifest);
      return { type: "load", requestId: request.requestId, ok: true };
    } catch (error) {
      sessions.delete(request.kind);
      return {
        type: "load",
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (request.type === "run") {
    try {
      const cached = sessions.get(request.kind);
      if (!cached || !ort) throw new Error("model not loaded");
      const { session, manifest } = cached;
      const { batch, rowCount } = request;
      if (!(batch instanceof Float32Array)) throw new Error("batch must be Float32Array");
      if (batch.length !== rowCount * manifest.featureCount)
        throw new Error(`batch size ${batch.length} != ${rowCount}×${manifest.featureCount}`);
      const input = new ort.Tensor("float32", batch, [rowCount, manifest.featureCount]);
      const output = await session.run({ [manifest.inputName]: input });

      const outputs: Record<string, number[]> = {};
      if (request.kind === "drums" || request.kind === "drums-v2") {
        // v1 and embedding-conditioned v2 share the sigmoid head — only the
        // manifest kind (and feature layout) differs.
        const sigmoidManifest = manifest as SigmoidPriorManifest;
        const tensor = output[sigmoidManifest.outputName];
        if (!tensor) throw new Error("missing model output");
        const raw = tensor.data as Float32Array;
        if (raw.length !== rowCount) throw new Error(`output count ${raw.length} != ${rowCount}`);
        outputs[sigmoidManifest.outputName] = Array.from(raw, (value) => {
          const probability = round4(sigmoid(value));
          if (!Number.isFinite(probability)) throw new Error("non-finite model output");
          return probability;
        });
      } else {
        const melodicManifest = manifest as MelodicPriorManifest;
        const degreeTensor = output[melodicManifest.degreeOutputName];
        const durationTensor = output[melodicManifest.durationOutputName];
        if (!degreeTensor || !durationTensor) throw new Error("missing model output");
        const degreeRaw = degreeTensor.data as Float32Array;
        const durationRaw = durationTensor.data as Float32Array;
        if (degreeRaw.length !== rowCount * melodicManifest.degreeClasses)
          throw new Error(`degree count ${degreeRaw.length} != ${rowCount}×${melodicManifest.degreeClasses}`);
        if (durationRaw.length !== rowCount * melodicManifest.durationClasses)
          throw new Error(`duration count ${durationRaw.length} != ${rowCount}×${melodicManifest.durationClasses}`);
        for (let row = 0; row < rowCount; row++) {
          const degreeStart = row * melodicManifest.degreeClasses;
          const durationStart = row * melodicManifest.durationClasses;
          const degreeDist = softmaxRow(
            Array.from(degreeRaw.slice(degreeStart, degreeStart + melodicManifest.degreeClasses)),
          ).map(round4);
          const durationDist = softmaxRow(
            Array.from(durationRaw.slice(durationStart, durationStart + melodicManifest.durationClasses)),
          ).map(round4);
          if (
            degreeDist.some((value) => !Number.isFinite(value)) ||
            durationDist.some((value) => !Number.isFinite(value))
          )
            throw new Error("non-finite model output");
          outputs[`${melodicManifest.degreeOutputName}:${row}`] = degreeDist;
          outputs[`${melodicManifest.durationOutputName}:${row}`] = durationDist;
        }
      }
      return { type: "run", requestId: request.requestId, ok: true, outputs };
    } catch (error) {
      return {
        type: "run",
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  // dispose
  for (const { session } of sessions.values()) {
    try {
      await session.release();
    } catch {
      /* already released */
    }
  }
  sessions.clear();
  return { type: "dispose", requestId: request.requestId, ok: true };
}

self.onmessage = async (event: MessageEvent<PriorRequest>) => {
  const request = event.data;
  try {
    const response = await handle(request);
    (self as unknown as Worker).postMessage(response);
  } catch (error) {
    const response: PriorResponse = {
      type: request.type,
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } as PriorResponse;
    (self as unknown as Worker).postMessage(response);
  }
};
