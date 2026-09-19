/**
 * Main-thread client for the semantic embedding worker (T1 krok 2).
 *
 * Same guarantees as the other intent-engine clients: lazy spawn (never at
 * boot, never in the audio callback), timeout-bounded requests, circuit
 * breaker, feature flag `localStorage["pf:semantic-embed"]`, and a
 * CHEAP availability probe (manifest fetch) so an unfetched model costs
 * one 404, not a worker spawn. Every failure resolves as null — the keyword
 * parser remains the deterministic fallback path, unchanged.
 */
import type { SemanticRequest, SemanticResponse } from "./semantic-types";

export type SemanticMode = "off" | "on";

/** Feature flag: localStorage `pf:semantic-embed` = on|off (default on). */
export function semanticMode(): SemanticMode {
  try {
    const value = localStorage.getItem("pf:semantic-embed");
    if (value === "off" || value === "on") return value;
  } catch {
    /* storage blocked — default below */
  }
  return "on";
}

const EMBED_TIMEOUT_MS = 20_000; // batched q8 inference; first call also loads the model
const MAX_FAILURES = 2;

let worker: Worker | null = null;
let workerFailures = 0;
let workerDisabled = false;
let unavailable = false; // manifest probe failed — model not fetched
let nextRequestId = 1;

function spawnWorker(): Worker | null {
  if (workerDisabled) return null;
  if (typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./semantic-worker.ts", import.meta.url), { type: "module" });
    return worker;
  } catch {
    workerDisabled = true;
    return null;
  }
}

function request(request: SemanticRequest, timeoutMs: number): Promise<SemanticResponse> {
  const active = spawnWorker();
  if (!active) return Promise.resolve({ ...request, ok: false, error: "worker-unavailable" } as SemanticResponse);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      active.removeEventListener("message", onMessage);
      workerFailures += 1;
      if (workerFailures >= MAX_FAILURES) {
        worker?.terminate();
        worker = null;
        workerDisabled = true;
      }
      resolve({ ...request, ok: false, error: "timeout" } as SemanticResponse);
    }, timeoutMs);
    const onMessage = (event: MessageEvent<SemanticResponse>) => {
      if (event.data?.requestId !== request.requestId || settled) return;
      settled = true;
      clearTimeout(timer);
      active.removeEventListener("message", onMessage);
      workerFailures = event.data.ok ? 0 : workerFailures + 1;
      resolve(event.data);
    };
    active.addEventListener("message", onMessage);
    active.postMessage(request);
  });
}

/**
 * Cheap probe: the model is present only when `npm run semantic:fetch`
 * populated /models/semantic/manifest.json. Result is remembered for the
 * session — one 404 instead of repeated probes.
 */
export async function semanticAvailable(): Promise<boolean> {
  if (semanticMode() === "off" || unavailable || workerDisabled) return false;
  try {
    const response = await fetch("/models/semantic/manifest.json");
    if (!response.ok) {
      unavailable = true;
      return false;
    }
    return true;
  } catch {
    unavailable = true;
    return false;
  }
}

/** Embed texts into L2-normalized vectors. Null = semantic unavailable. */
export async function embedTexts(texts: string[]): Promise<Float32Array[] | null> {
  try {
    if (texts.length === 0) return [];
    if (!(await semanticAvailable())) return null;
    const active = spawnWorker();
    if (!active) return null;
    const response = await request(
      { type: "embed", requestId: nextRequestId++, texts },
      EMBED_TIMEOUT_MS + texts.length * 200,
    );
    if (!response.ok || response.type !== "embed" || !response.vectors || !response.rowCount) {
      return null;
    }
    const { vectors, rowCount } = response;
    const dim = vectors.length / rowCount;
    if (!Number.isInteger(dim) || dim === 0) return null;
    const out: Float32Array[] = [];
    for (let row = 0; row < rowCount; row++) {
      out.push(vectors.slice(row * dim, (row + 1) * dim));
    }
    return out;
  } catch {
    return null;
  }
}

/** Test/diagnostic hook. */
export function resetSemanticClient(): void {
  worker?.terminate();
  worker = null;
  workerFailures = 0;
  workerDisabled = false;
  unavailable = false;
  nextRequestId = 1;
}
