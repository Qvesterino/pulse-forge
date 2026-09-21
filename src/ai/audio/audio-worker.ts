/// <reference lib="webworker" />
/**
 * Audio tagging worker (INTENT_ENGINE.md T4) — Audio Spectrogram Transformer
 * fine-tuned on AudioSet (527 classes: the whole drum/percussion/bass/sweep
 * palette a beat-maker cares about), via transformers.js.
 *
 * Lazy-loaded from our own origin (/models/audio/, fetched once via
 * npm run audio:fetch; remote CDN access DISABLED — offline-first after the
 * fetch). Input: MONO Float32Array at 16 kHz (the caller downmixes and
 * resamples). Output: top-K AudioSet labels score-desc.
 *
 * Same guarantees as the other intent-engine workers: controlled
 * { ok: false, error } fallback statuses, session-cached pipeline, nothing
 * in the audio callback.
 */

import type { AudioRequest, AudioResponse } from "./audio-types";

const MODEL_ID = "Xenova/ast-finetuned-audioset-10-10-0.4593";
const LOCAL_MODEL_PATH = "/models/audio/";
const TOP_K = 8;

let extractorPromise: Promise<unknown> | null = null;

async function ensureClassifier(): Promise<unknown> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.allowLocalModels = true;
      env.allowRemoteModels = false; // no silent CDN fallback — offline-first
      env.localModelPath = LOCAL_MODEL_PATH;
      return pipeline("audio-classification", MODEL_ID, { dtype: "q8" });
    })();
    extractorPromise.catch(() => {
      extractorPromise = null; // allow retry after a failed load
    });
  }
  return extractorPromise;
}

async function classify(audio: Float32Array): Promise<{ label: string; score: number }[]> {
  const classifier = (await ensureClassifier()) as (
    audio: Float32Array,
    options: Record<string, unknown>,
  ) => Promise<{ label: string; score: number }[]>;
  const results = await classifier(audio, { top_k: TOP_K });
  if (!Array.isArray(results)) throw new Error("unexpected classifier output");
  return results;
}

async function handle(request: AudioRequest): Promise<AudioResponse> {
  if (request.type === "load") {
    try {
      await ensureClassifier();
      return { type: "load", requestId: request.requestId, ok: true };
    } catch (error) {
      return {
        type: "load",
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  try {
    if (!(request.audio instanceof Float32Array) || request.audio.length === 0) {
      throw new Error("audio must be a non-empty Float32Array");
    }
    const labels = await classify(request.audio);
    if (labels.length === 0) throw new Error("classifier returned no labels");
    return { type: "classify", requestId: request.requestId, ok: true, labels };
  } catch (error) {
    return {
      type: "classify",
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

self.onmessage = async (event: MessageEvent<AudioRequest>) => {
  const request = event.data;
  try {
    const response = await handle(request);
    (self as unknown as Worker).postMessage(response);
  } catch (error) {
    const response: AudioResponse = {
      type: "classify",
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    (self as unknown as Worker).postMessage(response);
  }
};
