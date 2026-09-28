/// <reference lib="webworker" />
/**
 * LOCAL INTENT MODEL — INFERENCE WORKER (pipeline step [C], see
 * docs/LOCAL-INTENT-MODEL.md).
 *
 * Owns everything heavy about the on-device LLM: manifest validation, the
 * grammar-drift pin against this build's `toGbnfGrammar()`, model-byte
 * fetching (pack-cache aware, own origin only — no cloud), SHA-256
 * verification, and the runtime adapter (vendored llama.cpp-class WASM
 * module declared by the manifest) that runs GBNF-constrained decoding.
 *
 * Mirrors the ranker/prior/semantic worker guarantees: every message is
 * shape-validated before use, every failure resolves as a controlled
 * { ok: false, error } response — never an exception into the main thread,
 * never the audio callback.
 */

import {
  buildIntentModelPrompt,
  isIntentModelManifest,
  manifestGrammarDrift,
  sha256Mismatch,
  type IntentLlmRuntime,
  type IntentModelManifest,
  type IntentModelRequest,
  type IntentModelResponse,
} from "./model-loader-types";

const MODEL_PACK_CACHE = "pf:model-packs";

let runtime: IntentLlmRuntime | null = null;
let loadPromise: Promise<void> | null = null;
let activeManifest: IntentModelManifest | null = null;

/** Pack-cache-first fetch: a pack-manager-installed model is answered from
 * the Cache API (deployments don't ship dev-only public/ folders); every
 * other URL passes through to the origin. Same contract as the semantic
 * worker's fetch bridge. */
async function fetchWithPackCache(url: string, onProgress?: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
  try {
    const cache = await caches.open(MODEL_PACK_CACHE);
    const cached = await cache.match(new URL(url, self.location.href).href);
    if (cached) return await cached.arrayBuffer();
  } catch {
    // Cache lookup must never break model loading — fall through to network.
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`model fetch failed (${response.status})`);
  if (!response.body || !onProgress) return response.arrayBuffer();
  const total = Number(response.headers.get("content-length") ?? 0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded, total);
    }
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

async function ensureRuntime(manifest: IntentModelManifest): Promise<void> {
  if (runtime && activeManifest === manifest) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    // 1. The artifact must match THIS build's action grammar — a vocab
    //    change after training refuses the pair instead of prompting blind.
    const drift = await manifestGrammarDrift(manifest);
    if (drift) throw new Error(drift);
    // 2. Weights: fetch (pack cache → origin), size sanity, SHA-256 verify.
    const post = (loaded: number, total: number) => {
      const progress: IntentModelResponse = { type: "progress", requestId: -1, loaded, total };
      (self as unknown as Worker).postMessage(progress);
    };
    const weights = await fetchWithPackCache(manifest.model.url, post);
    if (weights.byteLength !== manifest.model.bytes) {
      throw new Error(`model size mismatch: expected ${manifest.model.bytes} bytes, got ${weights.byteLength}`);
    }
    const hashError = await sha256Mismatch(weights, manifest.model.sha256);
    if (hashError) throw new Error(hashError);
    // 3. Runtime adapter: a vendored own-origin module (no CDN imports) that
    //    exports createIntentLlmRuntime() (or the manifest-named export).
    const moduleUrl = new URL(manifest.runtime.module, self.location.href).href;
    const mod = (await import(/* @vite-ignore */ moduleUrl)) as Record<string, unknown>;
    const factory = mod[manifest.runtime.export];
    if (typeof factory !== "function") {
      throw new Error(`runtime module has no export "${manifest.runtime.export}"`);
    }
    const instance = (await (factory as () => Promise<IntentLlmRuntime>)()) as IntentLlmRuntime;
    await instance.load({
      weights,
      grammar: (await import("./model-schema")).toGbnfGrammar(),
      system: manifest.prompt.system,
      instructionTemplate: manifest.prompt.instructionTemplate,
      maxTokens: manifest.generation.maxTokens,
      temperature: manifest.generation.temperature,
    });
    runtime?.dispose?.();
    runtime = instance;
    activeManifest = manifest;
  })();

  try {
    await loadPromise;
  } finally {
    loadPromise = null;
  }
}

function isRequest(value: unknown): value is IntentModelRequest {
  if (value == null || typeof value !== "object") return false;
  const r = value as Partial<IntentModelRequest>;
  if (typeof r.requestId !== "number" || !Number.isInteger(r.requestId)) return false;
  if (r.type === "generate") return typeof (r as { instruction?: unknown }).instruction === "string";
  if (r.type === "load") return isIntentModelManifest((r as { manifest?: unknown }).manifest);
  return r.type === "reset";
}

self.onmessage = async (event: MessageEvent<unknown>) => {
  // Defensive boundary: never trust event.data shape (AGENTS worklet/worker rule).
  if (!isRequest(event.data)) {
    return; // unshaped garbage is dropped silently — there is no requestId to answer with
  }
  const request = event.data;
  const respond = (response: IntentModelResponse) => (self as unknown as Worker).postMessage(response);

  if (request.type === "load") {
    try {
      await ensureRuntime(request.manifest);
      respond({ type: "load", requestId: request.requestId, ok: true });
    } catch (err) {
      runtime?.dispose?.();
      runtime = null;
      activeManifest = null;
      respond({
        type: "load",
        requestId: request.requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (request.type === "generate") {
    try {
      if (!runtime || !activeManifest) throw new Error("model not loaded");
      const instruction = request.instruction.slice(0, 500); // bounded — prompts are one clause
      const text = await runtime.generate(buildIntentModelPrompt(activeManifest, instruction));
      if (typeof text !== "string") throw new Error("runtime returned a non-string completion");
      respond({ type: "generate", requestId: request.requestId, ok: true, text });
    } catch (err) {
      respond({
        type: "generate",
        requestId: request.requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // reset — test/diagnostic hook: drop the resident session so a later load re-inits.
  runtime?.dispose?.();
  runtime = null;
  activeManifest = null;
  loadPromise = null;
  respond({ type: "reset", requestId: request.requestId, ok: true });
};
