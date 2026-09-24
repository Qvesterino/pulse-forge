import { buildVocalProfile } from "./analyze";
import type { VocalProfile } from "./types";

/**
 * VOCAL ANALYZER WORKER — runs buildVocalProfile off the main thread.
 *
 * Same contract as the ranker/prior workers: validate event.data shape
 * before processing (extensions postMessage into workers), never throw —
 * every failure resolves as { ok: false } so the client falls back.
 */

export interface VocalAnalyzeRequest {
  requestId: number;
  pcm: Float32Array;
  sampleRate: number;
  bpm: number;
}

export type VocalAnalyzeResponse =
  | { requestId: number; ok: true; profile: VocalProfile }
  | { requestId: number; ok: false; error: string };

function isAnalyzeRequest(data: unknown): data is VocalAnalyzeRequest {
  if (typeof data !== "object" || data === null) return false;
  const r = data as Record<string, unknown>;
  return (
    typeof r.requestId === "number" &&
    r.pcm instanceof Float32Array &&
    typeof r.sampleRate === "number" &&
    Number.isFinite(r.sampleRate) &&
    r.sampleRate > 0 &&
    typeof r.bpm === "number" &&
    Number.isFinite(r.bpm) &&
    r.bpm > 0
  );
}

if (typeof self !== "undefined" && typeof (self as unknown as { postMessage?: unknown }).postMessage === "function") {
  (self as unknown as { onmessage: (e: MessageEvent<VocalAnalyzeRequest>) => void }).onmessage = (
    e: MessageEvent<VocalAnalyzeRequest>,
  ) => {
    const data = e.data;
    if (!isAnalyzeRequest(data)) return; // not ours — ignore silently
    try {
      const profile = buildVocalProfile({ pcm: data.pcm, sampleRate: data.sampleRate, bpm: data.bpm });
      (self as unknown as { postMessage: (msg: VocalAnalyzeResponse) => void }).postMessage({
        requestId: data.requestId,
        ok: true,
        profile,
      });
    } catch (error) {
      (self as unknown as { postMessage: (msg: VocalAnalyzeResponse) => void }).postMessage({
        requestId: data.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
