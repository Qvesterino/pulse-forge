/// <reference lib="webworker" />
/**
 * LOCAL STT (WHISPER) — TRANSCRIBE WORKER (pipeline step [A], see
 * docs/LOCAL-INTENT-MODEL.md §6).
 *
 * Manifest #2 in the src/ai drawer. Owns everything heavy about on-device
 * speech-to-text: manifest validation, model-byte fetching (pack-cache
 * aware, own origin only — no cloud), SHA-256 verification, audio
 * normalization to the manifest's sample rate, and the runtime adapter
 * (vendored whisper WASM/ONNX module declared by the manifest).
 *
 * Mirrors the intent-model worker guarantees: every message is
 * shape-validated before use, every failure resolves as a controlled
 * { type: "error" } response — never an exception into the main thread,
 * never the audio callback.
 *
 * The whisper runtime itself is VENDORED (manifest.runtime.module) and not
 * part of this build — until an origin ships the artifact, load requests
 * fail controlled ("runtime not available") and the loader reports the STT
 * chip as unavailable. Nothing here fakes a transcription.
 */

import { isSttManifest, type SttManifest, type SttRequest, type SttResponse } from "./stt-loader-types";

const MODEL_PACK_CACHE = "pf:model-packs";

let manifest: SttManifest | null = null;
let modelBytes: ArrayBuffer | null = null;
let loadPromise: Promise<void> | null = null;

async function fetchWithPackCache(url: string): Promise<ArrayBuffer> {
  try {
    const cache = await caches.open(MODEL_PACK_CACHE);
    const cached = await cache.match(new URL(url, self.location.href).href);
    if (cached) return await cached.arrayBuffer();
  } catch {
    // Cache lookup must never break model loading — fall through to network.
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`model fetch failed (${response.status})`);
  return response.arrayBuffer();
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function ensureLoaded(): Promise<void> {
  if (manifest && modelBytes) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const probe = await fetch("/models/stt-v1.manifest.json");
    if (!probe.ok) throw new Error(`stt manifest fetch failed (${probe.status})`);
    const parsed: unknown = await probe.json();
    if (!isSttManifest(parsed)) throw new Error("invalid stt manifest");
    manifest = parsed;

    const bytes = await fetchWithPackCache(parsed.model.url);
    const hash = await sha256Hex(bytes);
    if (hash !== parsed.model.sha256) throw new Error("stt model sha256 mismatch");
    modelBytes = bytes;

    // The vendored whisper runtime adapter is declared by the manifest and
    // loaded from the same origin. This build ships NO runtime — an origin
    // that provides the artifact provides the module too. The controlled
    // failure here is the honest state until then.
    throw new Error("stt runtime not available in this build");
  })();

  try {
    await loadPromise;
  } finally {
    loadPromise = null;
  }
}

/** Linear resample to the manifest sample rate (mono in, mono out). */
function resampleTo(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const src = i * ratio;
    const left = Math.floor(src);
    const right = Math.min(left + 1, input.length - 1);
    const frac = src - left;
    out[i] = input[left] * (1 - frac) + input[right] * frac;
  }
  return out;
}

function respond(response: SttResponse): void {
  self.postMessage(response);
}

self.onmessage = (event: MessageEvent<SttRequest>) => {
  const request = event.data;
  if (request == null || typeof request !== "object" || typeof request.id !== "number") return;
  const requestId = request.id;

  if (request.type === "load") {
    ensureLoaded()
      .then(() => {
        if (manifest) respond({ type: "loaded", id: requestId, version: manifest.sttModelVersion });
      })
      .catch((error: unknown) => {
        respond({ type: "error", id: requestId, message: error instanceof Error ? error.message : String(error) });
      });
    return;
  }

  if (request.type === "transcribe") {
    const { samples, sampleRate } = request;
    if (
      !(samples instanceof Float32Array) ||
      samples.length === 0 ||
      typeof sampleRate !== "number" ||
      sampleRate <= 0
    ) {
      respond({ type: "error", id: requestId, message: "invalid audio payload" });
      return;
    }
    ensureLoaded()
      .then(() => {
        const normalized = resampleTo(samples, sampleRate, manifest!.audio.sampleRate);
        // With the vendored runtime present, this is where its transcribe
        // export runs over `normalized`. Without it we land here honestly:
        respond({ type: "error", id: requestId, message: "stt runtime not available in this build" });
        void normalized;
      })
      .catch((error: unknown) => {
        respond({ type: "error", id: requestId, message: error instanceof Error ? error.message : String(error) });
      });
    return;
  }

  respond({
    type: "error",
    id: requestId,
    message: `unknown request type: ${String((request as { type?: unknown }).type)}`,
  });
};
