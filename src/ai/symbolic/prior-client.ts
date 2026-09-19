/**
 * Main-thread client for the ONNX symbolic prior worker — drums AND melodic
 * (INTENT_ENGINE.md T2 / T2 v2).
 *
 * Same guarantees as the ranker client: the worker is spawned LAZILY on first
 * use (never at boot, never in the audio callback); every request is bounded
 * by a timeout and answered with a CONTROLLED fallback status, so a missing
 * model, a timeout or a bad output degrades to "prior unavailable" without
 * ever throwing into the UI; repeated failures trip a circuit breaker that
 * stops spawning the worker for the rest of the session.
 */
import {
  coerceDrumsManifest,
  isDrumsPriorManifest,
  isMelodicPriorManifest,
  type MelodicPriorManifest,
  type PriorKind,
  type PriorManifest,
  type PriorRequest,
  type PriorResponse,
} from "./prior-types";

export type PriorMode = "off" | "on";

/**
 * Feature flag: localStorage `pf:symbolic-prior` = on|off (default on). The
 * flag only gates the worker spawn — actual availability still requires a
 * valid manifest + model asset; anything missing degrades to unavailable.
 */
export function priorMode(): PriorMode {
  try {
    const value = localStorage.getItem("pf:symbolic-prior");
    if (value === "off" || value === "on") return value;
  } catch {
    /* storage blocked — default below */
  }
  return "on";
}

const RUN_TIMEOUT_MS = 500; // preview budget — tiny MLP inferences per request
const LOAD_TIMEOUT_MS = 3000;
const MANIFEST_TIMEOUT_MS = 1500;
const MAX_FAILURES = 3;

const DRUMS_MANIFEST_PATH = "/models/symbolic-prior-v1.manifest.json";
const MELODIC_MANIFEST_PATH = "/models/symbolic-melodic-v1.manifest.json";

let worker: Worker | null = null;
let workerFailures = 0;
let workerDisabled = false;
let nextRequestId = 1;
const cachedManifests = new Map<PriorKind, PriorManifest>();

function spawnWorker(): Worker | null {
  if (workerDisabled) return null;
  if (typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./prior-worker.ts", import.meta.url), { type: "module" });
    return worker;
  } catch {
    workerDisabled = true;
    return null;
  }
}

function request(request: PriorRequest, timeoutMs: number): Promise<Extract<PriorResponse, { requestId: number }>> {
  const active = spawnWorker();
  if (!active)
    return Promise.resolve({ ...request, ok: false, error: "worker-unavailable" } as Extract<
      PriorResponse,
      { requestId: number }
    >);
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const onMessage = (event: MessageEvent<PriorResponse>) => {
      if (event.data?.requestId !== request.requestId || settled) return;
      settled = true;
      active.removeEventListener("message", onMessage);
      clearTimeout(timer);
      if (event.data.ok === false) {
        workerFailures += 1;
      } else {
        workerFailures = 0;
      }
      resolve(event.data);
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      active.removeEventListener("message", onMessage);
      workerFailures += 1;
      if (workerFailures >= MAX_FAILURES) {
        worker?.terminate();
        worker = null;
        workerDisabled = true;
      }
      resolve({ ...request, ok: false, error: "timeout" } as Extract<PriorResponse, { requestId: number }>);
    }, timeoutMs);
    active.addEventListener("message", onMessage);
    active.postMessage(request);
  });
}

async function loadManifest(kind: PriorKind): Promise<PriorManifest | null> {
  const cached = cachedManifests.get(kind);
  if (cached) return cached;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  try {
    const path = kind === "drums" ? DRUMS_MANIFEST_PATH : MELODIC_MANIFEST_PATH;
    const fetchPromise = fetch(path, controller ? { signal: controller.signal } : undefined);
    const response = await Promise.race([
      fetchPromise,
      new Promise<Response>((_, reject) => {
        timer = setTimeout(() => reject(new Error("prior manifest timeout")), MANIFEST_TIMEOUT_MS);
      }),
    ]);
    if (!response.ok) return null;
    const manifest = (await response.json()) as unknown;
    // The drums manifest on disk has no kind field (v1 artifact) — coerce it.
    const validated =
      kind === "drums" ? coerceDrumsManifest(manifest) : isMelodicPriorManifest(manifest) ? manifest : null;
    if (!validated) return null;
    cachedManifests.set(kind, validated);
    return validated;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller?.abort();
  }
}

export interface PriorRunResult {
  ok: boolean;
  probs: number[] | null;
  /** "model" = ONNX probs, "off" = flag off, "fallback" = unavailable. */
  source: "model" | "fallback" | "off";
}

/**
 * Run the DRUM prior over one grid batch. NEVER throws — a missing model,
 * timeout or non-finite output resolves as { ok: false } so the provider
 * deterministically skips the symbolic candidate.
 */
export async function runPriorGrid(values: Float32Array, rowCount: number): Promise<PriorRunResult> {
  try {
    if (priorMode() === "off") return { ok: false, probs: null, source: "off" };
    const manifest = await loadManifest("drums");
    if (!manifest || !isDrumsPriorManifest(manifest)) return { ok: false, probs: null, source: "fallback" };
    if (values.length !== rowCount * manifest.featureCount) return { ok: false, probs: null, source: "fallback" };
    const active = spawnWorker();
    if (!active) return { ok: false, probs: null, source: "fallback" };
    const load = await request({ type: "load", requestId: nextRequestId++, kind: "drums", manifest }, LOAD_TIMEOUT_MS);
    if (!load.ok) return { ok: false, probs: null, source: "fallback" };
    const response = await request(
      { type: "run", requestId: nextRequestId++, kind: "drums", batch: values, rowCount },
      RUN_TIMEOUT_MS,
    );
    if (response.ok === false || response.type !== "run" || !response.outputs) {
      return { ok: false, probs: null, source: "fallback" };
    }
    const probs = response.outputs[manifest.outputName];
    if (
      !Array.isArray(probs) ||
      probs.length !== rowCount ||
      probs.some((prob) => !Number.isFinite(prob) || prob < 0 || prob > 1)
    ) {
      return { ok: false, probs: null, source: "fallback" };
    }
    return { ok: true, probs, source: "model" };
  } catch {
    // A clone/postMessage/runtime failure must never escape into generation.
    return { ok: false, probs: null, source: "fallback" };
  }
}

export interface MelodicRunResult {
  ok: boolean;
  /** Per-row degree distribution (rest + degrees 0..6), row-major. */
  degree: number[] | null;
  /** Per-row duration distribution (1/2/4/8), row-major. */
  duration: number[] | null;
  source: "model" | "fallback" | "off";
}

/**
 * Run the MELODIC next-note prior over a batch of context rows. NEVER throws.
 */
export async function runMelodicNext(values: Float32Array, rowCount: number): Promise<MelodicRunResult> {
  try {
    if (priorMode() === "off") return { ok: false, degree: null, duration: null, source: "off" };
    const manifest = await loadManifest("melodic");
    if (!manifest || manifest.kind !== "melodic")
      return { ok: false, degree: null, duration: null, source: "fallback" };
    const melodicManifest = manifest as MelodicPriorManifest;
    if (values.length !== rowCount * melodicManifest.featureCount) {
      return { ok: false, degree: null, duration: null, source: "fallback" };
    }
    const active = spawnWorker();
    if (!active) return { ok: false, degree: null, duration: null, source: "fallback" };
    const load = await request(
      { type: "load", requestId: nextRequestId++, kind: "melodic", manifest },
      LOAD_TIMEOUT_MS,
    );
    if (!load.ok) return { ok: false, degree: null, duration: null, source: "fallback" };
    const response = await request(
      { type: "run", requestId: nextRequestId++, kind: "melodic", batch: values, rowCount },
      RUN_TIMEOUT_MS,
    );
    if (response.ok === false || response.type !== "run" || !response.outputs) {
      return { ok: false, degree: null, duration: null, source: "fallback" };
    }
    const degreeSize = rowCount * melodicManifest.degreeClasses;
    const durationSize = rowCount * melodicManifest.durationClasses;
    // The worker keys per-row distributions as "<outputName>:<row>".
    const degree: number[] = [];
    const duration: number[] = [];
    for (let row = 0; row < rowCount; row++) {
      const degreeDist = response.outputs[`${melodicManifest.degreeOutputName}:${row}`];
      const durationDist = response.outputs[`${melodicManifest.durationOutputName}:${row}`];
      if (!Array.isArray(degreeDist) || degreeDist.length !== melodicManifest.degreeClasses) {
        return { ok: false, degree: null, duration: null, source: "fallback" };
      }
      if (!Array.isArray(durationDist) || durationDist.length !== melodicManifest.durationClasses) {
        return { ok: false, degree: null, duration: null, source: "fallback" };
      }
      degree.push(...degreeDist);
      duration.push(...durationDist);
    }
    if (degree.length !== degreeSize || duration.length !== durationSize) {
      return { ok: false, degree: null, duration: null, source: "fallback" };
    }
    return { ok: true, degree, duration, source: "model" };
  } catch {
    return { ok: false, degree: null, duration: null, source: "fallback" };
  }
}

/** Test/diagnostic hook: drop the worker + cached state. */
export function resetPriorClient(): void {
  worker?.terminate();
  worker = null;
  workerFailures = 0;
  workerDisabled = false;
  cachedManifests.clear();
  nextRequestId = 1;
}
