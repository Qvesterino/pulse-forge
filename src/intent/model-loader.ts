import { assetUrl } from "../shared/assetUrls";
import {
  isIntentModelManifest,
  manifestGatePassed,
  type IntentModelManifest,
  type IntentModelReply,
  type IntentModelRequest,
  type IntentModelResponse,
} from "./model-loader-types";
import type { IntentModelMode, IntentModelState } from "./model-loader-types";
import { getIntentModelProvider, setIntentModelProvider, type IntentModelProvider } from "./model-resolver";

export type { IntentModelMode, IntentModelState } from "./model-loader-types";

/**
 * LOCAL INTENT MODEL — MAIN-THREAD LOADER (pipeline step [C] client).
 *
 * Same guarantees as the ranker/prior/semantic clients: the worker is
 * spawned LAZILY (never at boot, never in the audio callback); the
 * availability probe is cheap (one manifest fetch); every request is
 * timeout-bounded; repeated failures trip a circuit breaker; every failure
 * resolves controlled. Registration is the whole integration: once the
 * model is loaded, `setIntentModelProvider` hands it to the resolver
 * bridge, and the panel's fallback path starts routing through it — the
 * deterministic parsers stay the DEFAULT and the engine (clamps, strict
 * targets, undo) is untouched.
 *
 * Opt-in by design (docs/LOCAL-INTENT-MODEL.md §5): the flag
 * `localStorage["pf:intent-model"]` defaults to OFF because the artifact
 * is a hundreds-of-MB download class. Without the flag — or without the
 * trained model on the origin — this module costs one 404 and nothing else.
 */

/** Feature flag: localStorage `pf:intent-model` = on|off (default off). */
export function intentModelMode(): IntentModelMode {
  try {
    if (localStorage.getItem("pf:intent-model") === "on") return "on";
  } catch {
    /* storage blocked — default below */
  }
  return "off";
}

export function setIntentModelMode(mode: IntentModelMode): void {
  try {
    if (mode === "on") localStorage.setItem("pf:intent-model", "on");
    else localStorage.removeItem("pf:intent-model");
  } catch {
    /* storage blocked — the in-session state below still flips */
  }
  if (mode === "off") void disableIntentModel();
  notifyState();
}

const MANIFEST_TIMEOUT_MS = 1500;
// First call also loads + hashes a hundreds-of-MB GGUF. A cold timeout is
// NOT a breaker failure and does NOT terminate the worker (semantic-client
// rule): the weights keep loading in the background and the next ensure()
// (the next unmatched prompt, or the chip's retry) answers from the
// already-resident session instead of starting over.
const COLD_LOAD_TIMEOUT_MS = 120_000;
// Desktop budget per docs/LOCAL-INTENT-MODEL.md §6 is 30–80 ms/action;
// bounded generously for weak hardware — but a chat completion that takes
// minutes is a hang, not a feature.
const GENERATE_TIMEOUT_MS = 8_000;
const MAX_FAILURES = 2;

const MANIFEST_PATH = "/models/intent-model-v1.manifest.json";

let worker: Worker | null = null;
let workerFailures = 0;
let workerDisabled = false;
let probeUnavailable = false; // manifest 404 — no artifact on this origin
let nextRequestId = 1;
let ensurePromise: Promise<boolean> | null = null;

type StateListener = (state: IntentModelState) => void;
const stateListeners = new Set<StateListener>();
let lastState: IntentModelState = "off";

function computeState(): IntentModelState {
  if (intentModelMode() === "off") return "off";
  if (getIntentModelProvider()) return "ready";
  if (ensurePromise) return "loading";
  if (probeUnavailable || workerDisabled) return "unavailable";
  return "unavailable";
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

export function onIntentModelStateChange(listener: StateListener): () => void {
  stateListeners.add(listener);
  // Sync the tracked state while pushing the current one — a direct
  // computeState() here would desync lastState from what listeners saw and
  // swallow the next real transition.
  lastState = computeState();
  listener(lastState);
  return () => stateListeners.delete(listener);
}

/** Test/diagnostic seam: jsdom has no Worker; tests inject a scripted fake. */
let workerFactory: (() => Worker | null) | null = null;
export function setIntentModelWorkerFactoryForTests(factory: (() => Worker | null) | null): void {
  workerFactory = factory;
}

/** Test hook: tighten the budgets so timeout/breaker paths run in ms. */
export function setIntentModelTimeoutsForTests(timeouts: { coldLoadMs?: number; generateMs?: number } | null): void {
  coldLoadMs = timeouts?.coldLoadMs ?? COLD_LOAD_TIMEOUT_MS;
  generateMs = timeouts?.generateMs ?? GENERATE_TIMEOUT_MS;
}
let coldLoadMs = COLD_LOAD_TIMEOUT_MS;
let generateMs = GENERATE_TIMEOUT_MS;

function spawnWorker(): Worker | null {
  if (workerDisabled) return null;
  if (typeof Worker === "undefined" && !workerFactory) return null;
  if (worker) return worker;
  try {
    worker = workerFactory
      ? workerFactory()
      : new Worker(new URL("./model-worker.ts", import.meta.url), { type: "module" });
    if (!worker) workerDisabled = true;
    return worker;
  } catch {
    workerDisabled = true;
    return null;
  }
}

function recordFailure(): void {
  workerFailures += 1;
  if (workerFailures < MAX_FAILURES) return;
  worker?.terminate();
  worker = null;
  workerDisabled = true;
  notifyState();
}

function request(
  payload: IntentModelRequest,
  timeoutMs: number,
  timeoutCountsTowardFailure: boolean,
): Promise<IntentModelReply> {
  const active = spawnWorker();
  if (!active) return Promise.resolve({ ...payload, ok: false, error: "worker-unavailable" } as IntentModelReply);
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      active.removeEventListener("message", onMessage);
      active.removeEventListener("error", onError);
    };
    const fail = (error: string, counts: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (counts) recordFailure();
      resolve({ ...payload, ok: false, error } as IntentModelReply);
    };
    const timer = setTimeout(() => fail("timeout", timeoutCountsTowardFailure), timeoutMs);
    const onMessage = (event: MessageEvent<IntentModelResponse>) => {
      if (event.data?.requestId !== payload.requestId || settled) return;
      if (event.data.type === "progress") return; // loading ticks — never settles the request
      settled = true;
      cleanup();
      if (event.data.ok === false) recordFailure();
      else workerFailures = 0;
      resolve(event.data);
    };
    const onError = () => fail("worker-error", true);
    active.addEventListener("message", onMessage);
    active.addEventListener("error", onError);
    try {
      active.postMessage(payload);
    } catch {
      fail("post-message-error", true);
    }
  });
}

/** Cheap probe: the trained artifact exists on this origin. Remembered for
 * the session — one 404 per origin, not per prompt. */
async function probeManifest(): Promise<IntentModelManifest | null> {
  if (probeUnavailable) return null;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), MANIFEST_TIMEOUT_MS);
  try {
    const response = await fetch(assetUrl(MANIFEST_PATH), controller ? { signal: controller.signal } : undefined);
    if (!response.ok) {
      probeUnavailable = true;
      return null;
    }
    const manifest = (await response.json()) as unknown;
    if (!isIntentModelManifest(manifest)) {
      probeUnavailable = true;
      return null;
    }
    return manifest;
  } catch {
    probeUnavailable = true;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function doEnsure(): Promise<boolean> {
  if (intentModelMode() === "off") return false;
  if (getIntentModelProvider()) return true;
  notifyState();
  const manifest = await probeManifest();
  if (!manifest) {
    notifyState();
    return false;
  }
  // Release-gate pin: a trained artifact without a PASSED validate gate is
  // a candidate, not an actor — the deterministic layer stays the engine.
  if (!manifestGatePassed(manifest)) {
    probeUnavailable = true;
    notifyState();
    return false;
  }
  const load = await request({ type: "load", requestId: nextRequestId++, manifest }, coldLoadMs, false);
  if (!load.ok) {
    notifyState();
    return false;
  }
  if (getIntentModelProvider()) return true; // a late cold load registered us already
  const version = manifest.intentModelVersion;
  const provider: IntentModelProvider = {
    id: "pulse-forge.intent-model",
    version,
    generate: async (instruction: string) => {
      const response = await request({ type: "generate", requestId: nextRequestId++, instruction }, generateMs, true);
      if (!response.ok || response.type !== "generate" || typeof response.text !== "string") {
        const reason =
          response.ok === false && "error" in response && response.error ? response.error : "model-generate-failed";
        throw new Error(reason);
      }
      if (!response.text.trim()) throw new Error("empty completion");
      return response.text;
    },
  };
  setIntentModelProvider(provider);
  notifyState();
  return true;
}

/**
 * Load the model (when enabled + present) and register it as the resolver
 * provider. Idempotent, coalesced, never throws. Resolves false when the
 * model stays unavailable — the panel then falls back exactly as before.
 */
export function ensureIntentModelProvider(): Promise<boolean> {
  if (getIntentModelProvider()) return Promise.resolve(true);
  if (!ensurePromise) {
    ensurePromise = doEnsure().finally(() => {
      ensurePromise = null;
      notifyState();
    });
  }
  return ensurePromise;
}

/** Boot/panel warm hook: start loading in the background (flag permitting). */
export function warmIntentModelProvider(): void {
  if (intentModelMode() !== "on") return;
  setTimeout(() => {
    void ensureIntentModelProvider().catch(() => undefined);
  }, 0);
}

/** Flag-off path: unregister + drop the resident worker for the session. */
export async function disableIntentModel(): Promise<void> {
  setIntentModelProvider(null);
  if (worker) {
    try {
      worker.postMessage({ type: "reset", requestId: nextRequestId++ });
    } catch {
      /* the terminate below is the real cleanup */
    }
    worker.terminate();
    worker = null;
  }
  workerFailures = 0;
  workerDisabled = false;
  notifyState();
}

/** Test/diagnostic hook: drop all cached state. */
export function resetIntentModelLoader(): void {
  worker?.terminate();
  worker = null;
  workerFailures = 0;
  workerDisabled = false;
  probeUnavailable = false;
  ensurePromise = null;
  nextRequestId = 1;
  coldLoadMs = COLD_LOAD_TIMEOUT_MS;
  generateMs = GENERATE_TIMEOUT_MS;
  setIntentModelProvider(null);
  notifyState();
}
