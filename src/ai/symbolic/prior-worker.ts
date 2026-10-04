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
 *
 * PERSONAL OVERLAY (W3 "Nauč sa ma"): a melodic `load` may carry a personal
 * weight payload fine-tuned from THIS manifest's modelHash. When present and
 * shape-compatible, melodic `run` answers from it in plain JS (microseconds,
 * no second session); otherwise the shipped ONNX session answers. The
 * personal path can therefore only ever be consulted for the artifact it was
 * trained from, and a missing/mismatched payload is a silent no-op — the
 * shipped prior keeps serving, which is the whole fallback contract.
 */

import {
  isDrumsPriorManifest,
  isDrumsV2PriorManifest,
  isDrumsV3PriorManifest,
  isMelodicPriorManifest,
  isMelodicV2PriorManifest,
  type DualHeadPriorManifest,
  type PriorManifest,
  type PriorKind,
  type PriorRequest,
  type PriorResponse,
  type PersonalWeightsPayloadLike,
  type SigmoidPriorManifest,
} from "./prior-types";
import {
  personalInferenceFromPayload,
  runPersonalNext,
  type PersonalInferenceModel,
} from "../../intent/personal-melodic-inference";
import { personalWeightsFromJson } from "../../intent/personal-melodic-onnx";

type OrtNamespace = typeof import("onnxruntime-web/wasm");
type OrtSession = Awaited<ReturnType<OrtNamespace["InferenceSession"]["create"]>>;

let ort: OrtNamespace | null = null;
const sessions = new Map<PriorKind, { session: OrtSession; manifest: PriorManifest }>();
/** Personal models, keyed by PriorKind (the manifest hash check lives in the client). */
const personalModels = new Map<PriorKind, PersonalInferenceModel>();

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
  if (kind === "drums-v3" && !isDrumsV3PriorManifest(manifest)) throw new Error("invalid drums-v3 prior manifest");
  if (kind === "melodic" && !isMelodicPriorManifest(manifest)) throw new Error("invalid melodic prior manifest");
  if (kind === "melodic-v2" && !isMelodicV2PriorManifest(manifest))
    throw new Error("invalid melodic-v2 prior manifest");
  const bytes = await verifyModelBytes(manifest.modelPath, manifest.modelHash);
  const session = await ortNs.InferenceSession.create(bytes, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  sessions.set(kind, { session, manifest });
  return session;
}

/**
 * Install the personal overlay for a melodic kind, if the payload lines up
 * with the shipped manifest. Returns true when the overlay is live. NEVER
 * throws and NEVER removes the shipped session: a rejected payload simply
 * means the shipped ONNX keeps answering, which is the whole fallback
 * contract.
 */
function installPersonalModel(kind: PriorKind, manifest: PriorManifest, personal: PersonalWeightsPayloadLike): boolean {
  if (kind !== "melodic" && kind !== "melodic-v2") return false;
  const validated = personalWeightsFromJson(personal as unknown);
  if (!validated) return false;
  // The overlay must be the same architecture as the artifact it was trained
  // from — otherwise its rows are not even the same width. The melodic
  // manifests are the dual-head family; drums never take an overlay.
  const dual = manifest as DualHeadPriorManifest;
  if (validated.featureCount !== dual.featureCount) return false;
  if (validated.degreeClasses !== dual.degreeClasses) return false;
  if (validated.durationClasses !== dual.durationClasses) return false;
  if (validated.hidden[0] !== dual.hidden[0] || validated.hidden[1] !== dual.hidden[1]) return false;
  personalModels.set(kind, personalInferenceFromPayload(validated));
  return true;
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
      // The overlay is installed AFTER the shipped session is live, so even a
      // rejected personal payload leaves a working prior behind.
      const personalLive = request.personal ? installPersonalModel(request.kind, request.manifest, request.personal) : false;
      if (request.personal && !personalLive) {
        // Not an error: the shipped prior answers. Surfaced so the caller can
        // drop a personal model it no longer matches (e.g. after a retrain).
        personalModels.delete(request.kind);
      }
      return { type: "load", requestId: request.requestId, ok: true };
    } catch (error) {
      sessions.delete(request.kind);
      personalModels.delete(request.kind);
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

      // Personal overlay first (melodic only) — when it answers, the shipped
      // ONNX session is not even invoked.
      const personal = personalModels.get(request.kind);
      if (personal) {
        const result = runPersonalNext(personal, batch, rowCount);
        if (result) {
          const melodicManifest = manifest as DualHeadPriorManifest;
          const outputs: Record<string, number[]> = {};
          for (let row = 0; row < rowCount; row++) {
            outputs[`${melodicManifest.degreeOutputName}:${row}`] = result.degree[row];
            outputs[`${melodicManifest.durationOutputName}:${row}`] = result.duration[row];
          }
          return { type: "run", requestId: request.requestId, ok: true, outputs };
        }
        // Overlay could not answer this batch (should not happen — shapes are
        // checked at install) — fall through to the shipped session.
      }

      const input = new ort.Tensor("float32", batch, [rowCount, manifest.featureCount]);
      const output = await session.run({ [manifest.inputName]: input });

      const outputs: Record<string, number[]> = {};
      if (request.kind === "drums" || request.kind === "drums-v2" || request.kind === "drums-v3") {
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
        // melodic v1 and embedding-conditioned v2 share the dual softmax
        // heads — only the manifest kind (and feature layout) differs.
        const melodicManifest = manifest as DualHeadPriorManifest;
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
  personalModels.clear();
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
