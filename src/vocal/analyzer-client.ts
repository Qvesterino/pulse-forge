import { buildVocalProfile } from "./analyze";
import type { VocalProfile } from "./types";
import type { VocalAnalyzeRequest, VocalAnalyzeResponse } from "./analyzer-worker";

/**
 * Main-thread client for the vocal analyzer worker.
 *
 * Worker is spawned LAZILY on first use, every request is bounded by a
 * timeout, repeated failures trip a session circuit breaker. Unlike the
 * ONNX clients there is always a safe fallback: the analyzer DSP is pure,
 * so a missing/slow worker degrades to a synchronous main-thread run
 * (never the audio thread — callers must not invoke this from realtime
 * code). NEVER throws — failures resolve as { ok: false }.
 */

const ANALYZE_TIMEOUT_MS = 20000;
const MAX_FAILURES = 3;

let worker: Worker | null = null;
let workerFailures = 0;
let workerDisabled = false;
let nextRequestId = 1;
/** In-flight request resolvers — drained by death handling, keyed by requestId. */
const pendingRequests = new Map<number, (response: VocalAnalyzeResponse | null) => void>();

function handleWorkerDeath(): void {
  // A worker that ERRORED stays broken for the session (script load failure,
  // uncaught error) — disable immediately and hand every pending request to
  // the synchronous fallback instead of burning the 20 s timeout three times
  // before the failure breaker would (GOAL 04, re-run 4).
  workerDisabled = true;
  worker?.terminate();
  worker = null;
  const pending = [...pendingRequests.values()];
  pendingRequests.clear();
  for (const resolve of pending) resolve(null);
}

function spawnWorker(): Worker | null {
  if (workerDisabled) return null;
  if (typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./analyzer-worker.ts", import.meta.url), { type: "module" });
    worker.onerror = () => handleWorkerDeath();
    return worker;
  } catch {
    workerDisabled = true;
    return null;
  }
}

export type VocalAnalyzeResult = { ok: true; profile: VocalProfile } | { ok: false; error: string };

function runSync(pcm: Float32Array, sampleRate: number, bpm: number): VocalAnalyzeResult {
  try {
    return { ok: true, profile: buildVocalProfile({ pcm, sampleRate, bpm }) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function analyzeVocalTake(
  pcm: Float32Array,
  sampleRate: number,
  bpm: number,
): Promise<VocalAnalyzeResult> {
  try {
    if (!(pcm instanceof Float32Array) || pcm.length === 0) {
      return { ok: false, error: "empty-take" };
    }
    const active = spawnWorker();
    if (!active) return runSync(pcm, sampleRate, bpm);

    const requestId = nextRequestId++;
    const request: VocalAnalyzeRequest = { requestId, pcm, sampleRate, bpm };
    const response = await new Promise<VocalAnalyzeResponse | null>((resolve) => {
      let settled = false;
      const settle = (value: VocalAnalyzeResponse | null) => {
        if (settled) return;
        settled = true;
        pendingRequests.delete(requestId);
        active.removeEventListener("message", onMessage);
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => settle(null), ANALYZE_TIMEOUT_MS);
      const onMessage = (event: MessageEvent<VocalAnalyzeResponse>) => {
        if (event.data?.requestId !== requestId || settled) return;
        settle(event.data);
      };
      active.addEventListener("message", onMessage);
      pendingRequests.set(requestId, settle);
      active.postMessage(request);
    });

    if (!response || !response.ok) {
      workerFailures += 1;
      if (workerFailures >= MAX_FAILURES) {
        worker?.terminate();
        worker = null;
        workerDisabled = true;
      }
      // Worker path failed — the pure DSP still answers synchronously.
      return runSync(pcm, sampleRate, bpm);
    }
    workerFailures = 0;
    return { ok: true, profile: response.profile };
  } catch {
    return runSync(pcm, sampleRate, bpm);
  }
}

/** Test/diagnostic hook: drop the worker + breaker state. */
export function resetVocalAnalyzer(): void {
  worker?.terminate();
  worker = null;
  workerFailures = 0;
  workerDisabled = false;
  nextRequestId = 1;
  pendingRequests.clear();
}
