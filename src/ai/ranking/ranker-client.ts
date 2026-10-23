/**
 * Main-thread client for the ONNX intent-ranker worker (goal doc Fáze 3/4).
 *
 * Guarantees:
 * - the worker is spawned LAZILY on first use (never at boot, never in the
 *   audio callback — inference is backgrounded in the worker);
 * - every request is bounded by a timeout and answered with a CONTROLLED
 *   fallback status, so a missing model, a timeout or a bad output degrades
 *   to the heuristic ranking without ever throwing into the UI;
 * - repeated worker failures trip a circuit breaker that stops spawning the
 *   worker for the rest of the session.
 */
import { isRankerManifest, type RankerManifest, type RankerRequest, type RankerResponse } from "./ranker-types";

export type RankerMode = "off" | "shadow" | "active";

/** Feature flag (goal doc Fáze 4): localStorage `pf:intent-ranker` = off|shadow|active. */
/**
 * Default ranker mode. "shadow" until human golden preferences exist AND the
 * retrain verdict says ready-for-active — then flip to "active" (the
 * npm run ranker:activate orchestrator does this after the golden gate
 * passes). localStorage override (pf:intent-ranker) always wins.
 */
export const DEFAULT_RANKER_MODE: RankerMode = "active";

export function rankerMode(): RankerMode {
  try {
    const value = localStorage.getItem("pf:intent-ranker");
    if (value === "off" || value === "shadow" || value === "active") return value;
  } catch {
    /* storage blocked — default below */
  }
  return DEFAULT_RANKER_MODE;
}

const SCORE_TIMEOUT_MS = 400; // preview budget — fall back fast
const LOAD_TIMEOUT_MS = 3000;
const MANIFEST_TIMEOUT_MS = 1500;
const MAX_FAILURES = 3;

let worker: Worker | null = null;
let workerFailures = 0;
let workerDisabled = false;
let nextRequestId = 1;
let cachedManifest: RankerManifest | null = null;

function spawnWorker(): Worker | null {
  if (workerDisabled) return null;
  if (typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./ranker-worker.ts", import.meta.url), { type: "module" });
    return worker;
  } catch {
    workerDisabled = true;
    return null;
  }
}

function request(request: RankerRequest, timeoutMs: number): Promise<Extract<RankerResponse, { requestId: number }>> {
  const active = spawnWorker();
  if (!active)
    return Promise.resolve({ ...request, ok: false, error: "worker-unavailable" } as Extract<
      RankerResponse,
      { requestId: number }
    >);
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      active.removeEventListener("message", onMessage);
      active.removeEventListener("error", onError);
      active.removeEventListener("messageerror", onMessageError);
    };
    /**
     * A worker that DIED must settle the caller NOW, not after the timeout.
     * The client used to listen for answers only, so a dead worker produced
     * no event at all: the call sat on its timeout (400 ms for a score, 3 s
     * for a load) and the failure was reported as "timeout" — the model's
     * fault, not the worker's. A worker failure also counts toward the
     * circuit breaker, so a worker that stays dead is not respawned for
     * every request of the rest of the session.
     */
    const fail = (error: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      workerFailures += 1;
      if (workerFailures >= MAX_FAILURES) {
        active.terminate();
        if (worker === active) worker = null;
        workerDisabled = true;
      }
      resolve({ ...request, ok: false, error } as Extract<RankerResponse, { requestId: number }>);
    };
    const onMessage = (event: MessageEvent<RankerResponse>) => {
      if (event.data?.requestId !== request.requestId || settled) return;
      settled = true;
      cleanup();
      if (event.data.ok === false) {
        workerFailures += 1;
      } else {
        workerFailures = 0;
      }
      resolve(event.data);
    };
    const onError = () => fail("worker-error");
    const onMessageError = () => fail("message-error");
    timer = setTimeout(() => fail("timeout"), timeoutMs);
    active.addEventListener("message", onMessage);
    active.addEventListener("error", onError);
    active.addEventListener("messageerror", onMessageError);
    try {
      active.postMessage(request);
    } catch {
      fail("post-message-error");
    }
  });
}

async function loadManifest(): Promise<RankerManifest | null> {
  if (cachedManifest) return cachedManifest;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  try {
    const request = fetch(
      "/models/intent-ranker-v1.manifest.json",
      controller ? { signal: controller.signal } : undefined,
    );
    const response = await Promise.race([
      request,
      new Promise<Response>((_, reject) => {
        timer = setTimeout(() => reject(new Error("ranker manifest timeout")), MANIFEST_TIMEOUT_MS);
      }),
    ]);
    if (!response.ok) return null;
    const manifest = (await response.json()) as unknown;
    if (!isRankerManifest(manifest)) return null;
    cachedManifest = manifest;
    return manifest;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller?.abort();
  }
}

export interface RankerScores {
  ok: boolean;
  scores: number[] | null;
  /** "model" = ONNX scores, "fallback" = worker/model unavailable, "off" = flag off. */
  source: "model" | "fallback" | "off";
}

/**
 * Score a feature batch through the ONNX worker. NEVER throws — a missing
 * model, timeout or non-finite output resolves as { ok: false } so the caller
 * falls back to the heuristic ranking deterministically.
 */
export async function scoreCandidateFeatures(values: Float32Array, candidateCount: number): Promise<RankerScores> {
  try {
    if (rankerMode() === "off") return { ok: false, scores: null, source: "off" };
    const manifest = await loadManifest();
    if (!manifest) return { ok: false, scores: null, source: "fallback" };
    if (values.length !== candidateCount * manifest.featureCount)
      return { ok: false, scores: null, source: "fallback" };
    const active = spawnWorker();
    if (!active) return { ok: false, scores: null, source: "fallback" };
    const load = await request({ type: "load", requestId: nextRequestId++, manifest }, LOAD_TIMEOUT_MS);
    if (!load.ok) return { ok: false, scores: null, source: "fallback" };
    const response = await request(
      { type: "score", requestId: nextRequestId++, batch: values, candidateCount },
      SCORE_TIMEOUT_MS,
    );
    if (
      !response.ok ||
      response.type !== "score" ||
      !Array.isArray(response.scores) ||
      response.scores.length !== candidateCount ||
      response.scores.some((score) => !Number.isFinite(score) || score < 0 || score > 1)
    ) {
      return { ok: false, scores: null, source: "fallback" };
    }
    return { ok: true, scores: response.scores, source: "model" };
  } catch {
    // A clone/postMessage/runtime failure must never escape into generation;
    // the deterministic heuristic remains the release-safe selection path.
    return { ok: false, scores: null, source: "fallback" };
  }
}

export function currentRankerManifest(): RankerManifest | null {
  return cachedManifest;
}

/** Test/diagnostic hook: drop the worker + cached state. */
export function resetRankerClient(): void {
  worker?.terminate();
  worker = null;
  workerFailures = 0;
  workerDisabled = false;
  cachedManifest = null;
  nextRequestId = 1;
}
