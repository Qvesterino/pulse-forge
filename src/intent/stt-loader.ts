import { assetUrl } from "../shared/assetUrls";
import type { SttRequest, SttResponse } from "./stt-loader-types";

export type { SttModelMode } from "./stt-loader-types";

/**
 * LOCAL STT (WHISPER) — MAIN-THREAD CLIENT (pipeline step [A]).
 *
 * Manifest #2 in the src/ai drawer — the same guarantees as the intent
 * model loader (its sibling file): lazy worker (never at boot, never in
 * the audio callback), one cheap manifest probe, timeout-bounded
 * transcription, a two-failure circuit breaker, and controlled failures
 * that resolve `null` instead of throwing. Opt-in by flag
 * `localStorage["pf:stt-model"]`; without the flag — or without the
 * artifact on the origin — this module costs one 404 and nothing else.
 *
 * The transcript is a TEXT SOURCE: callers write it into the intent bar
 * where the user sees and edits it before anything routes (docs/
 * LOCAL-INTENT-MODEL.md §6 — voice adds no new action kinds).
 */

const FLAG_KEY = "pf:stt-model";
const MANIFEST_TIMEOUT_MS = 1500;
const COLD_LOAD_TIMEOUT_MS = 60_000;
const TRANSCRIBE_TIMEOUT_MS = 20_000;
const MAX_FAILURES = 2;
const MANIFEST_PATH = "/models/stt-v1.manifest.json";

export type SttState = "off" | "idle" | "loading" | "ready" | "unavailable";

export function sttModelMode(): "on" | "off" {
  try {
    if (localStorage.getItem(FLAG_KEY) === "on") return "on";
  } catch {
    /* storage blocked — default below */
  }
  return "off";
}

export function setSttModelMode(mode: "on" | "off"): void {
  try {
    if (mode === "on") localStorage.setItem(FLAG_KEY, "on");
    else localStorage.removeItem(FLAG_KEY);
  } catch {
    /* storage blocked — in-session state still flips */
  }
  if (mode === "off") void disableStt();
  notifyState();
}

let worker: Worker | null = null;
let workerFailures = 0;
let workerDisabled = false;
let probeUnavailable = false;
let nextRequestId = 1;
let ensurePromise: Promise<boolean> | null = null;
const pending = new Map<number, { resolve: (text: string | null) => void; timer: ReturnType<typeof setTimeout> }>();

type StateListener = (state: SttState) => void;
const stateListeners = new Set<StateListener>();
let lastState: SttState = "off";

function computeState(): SttState {
  if (sttModelMode() === "off") return "off";
  if (ensurePromise) return "loading";
  if (!probeUnavailable && !workerDisabled && worker) return "ready";
  if (probeUnavailable || workerDisabled) return "unavailable";
  return "idle";
}

function notifyState(): void {
  const next = computeState();
  if (next === lastState) return;
  lastState = next;
  for (const listener of [...stateListeners]) {
    try {
      listener(next);
    } catch {
      /* a broken listener must not break the loader */
    }
  }
}

export function onSttStateChange(listener: StateListener): () => void {
  stateListeners.add(listener);
  lastState = computeState();
  listener(lastState);
  return () => stateListeners.delete(listener);
}

let workerFactoryOverride: (() => Worker | null) | null = null;

/** Test hook: inject a fake worker (MessageChannel-shaped). */
export function setSttWorkerFactoryForTests(factory: (() => Worker | null) | null): void {
  workerFactoryOverride = factory;
  worker = null;
  workerDisabled = false;
  probeUnavailable = false;
  workerFailures = 0;
}

function spawnWorker(): Worker | null {
  if (workerFactoryOverride) return workerFactoryOverride();
  try {
    return new Worker(new URL("./stt-worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
}

function terminateWorker(): void {
  worker?.terminate();
  worker = null;
  for (const [, entry] of pending) clearTimeout(entry.timer);
  pending.clear();
}

/** One cheap manifest fetch — the availability probe (404 = no artifact). */
async function probeManifest(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
  try {
    const response = await fetch(assetUrl(MANIFEST_PATH), { signal: controller.signal });
    return response.ok && (await response.json()) != null;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Ensure the worker is alive and its model is resident. Resolves ready? */
export async function ensureStt(): Promise<boolean> {
  if (sttModelMode() === "off") return false;
  if (worker && !probeUnavailable && !workerDisabled) return true;
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    if (probeUnavailable || workerDisabled) return false;
    // A worker factory override (tests) implies a fake artifact — skip the
    // manifest probe, which cannot succeed outside the real origin.
    if (!workerFactoryOverride) {
      const available = await probeManifest();
      if (!available) {
        probeUnavailable = true;
        notifyState();
        return false;
      }
    }
    worker = spawnWorker();
    if (!worker) {
      workerDisabled = true;
      notifyState();
      return false;
    }
    attachWorker(worker);
    const loaded = await requestLoad(worker);
    if (!loaded) {
      workerFailures += 1;
      if (workerFailures >= MAX_FAILURES) {
        workerDisabled = true;
        terminateWorker();
      }
      notifyState();
      return false;
    }
    workerFailures = 0;
    notifyState();
    return true;
  })();

  try {
    return await ensurePromise;
  } finally {
    ensurePromise = null;
    notifyState();
  }
}

function attachWorker(target: Worker): void {
  target.onmessage = (event: MessageEvent<SttResponse>) => {
    const response = event.data;
    if (response == null || typeof response !== "object" || typeof response.id !== "number") return;
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    clearTimeout(entry.timer);
    if (response.type === "result") entry.resolve(response.text);
    else if (response.type === "loaded")
      entry.resolve("ok"); // load request: non-null = ready
    else if (response.type === "error") {
      entry.resolve(null);
      workerFailures += 1;
      if (workerFailures >= MAX_FAILURES) {
        workerDisabled = true;
        terminateWorker();
        notifyState();
      }
    }
  };
  target.onerror = () => {
    workerFailures += 1;
    if (workerFailures >= MAX_FAILURES) {
      workerDisabled = true;
      terminateWorker();
      notifyState();
    }
  };
}

function requestLoad(target: Worker): Promise<boolean> {
  const id = nextRequestId++;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(false);
    }, COLD_LOAD_TIMEOUT_MS);
    pending.set(id, {
      resolve: (text) => resolve(text != null),
      timer,
    });
    const request: SttRequest = { type: "load", id };
    target.postMessage(request);
  });
}

/**
 * Transcribe raw mono audio. Resolves the transcript, or null on any
 * failure (unavailable, timeout, breaker open) — callers show an honest
 * "nič nepočujem" state, never a fabricated text.
 */
export async function transcribeWithStt(samples: Float32Array, sampleRate: number): Promise<string | null> {
  if (sttModelMode() === "off") return null;
  const ready = await ensureStt();
  if (!ready || !worker) return null;
  const id = nextRequestId++;
  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
      workerFailures += 1;
      if (workerFailures >= MAX_FAILURES) {
        workerDisabled = true;
        terminateWorker();
        notifyState();
      }
    }, TRANSCRIBE_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    const request: SttRequest = { type: "transcribe", id, samples, sampleRate };
    worker!.postMessage(request);
  });
}

/** Chip teardown — mirrors disableIntentModel. */
export async function disableStt(): Promise<void> {
  terminateWorker();
  notifyState();
}

export function resetSttLoaderForTests(): void {
  terminateWorker();
  workerFailures = 0;
  workerDisabled = false;
  probeUnavailable = false;
  ensurePromise = null;
  lastState = "off";
}
