/**
 * Main-thread client for the audio tagging worker (INTENT_ENGINE.md T4).
 *
 * Same guarantees as the other intent-engine clients: lazy spawn, timeout-
 * bounded requests (AST inference on WASM ≈ 0.5–2 s per clip), circuit
 * breaker, feature flag `localStorage["pf:audio-tag"]`, and a cheap
 * availability probe (manifest fetch — one 404 if the model was never
 * fetched). Every failure resolves null — callers degrade silently.
 */
import type { AudioLabel, AudioRequest, AudioResponse } from "./audio-types";

export type AudioTagMode = "off" | "on";

/** Feature flag: localStorage `pf:audio-tag` = on|off (default on). */
export function audioTagMode(): AudioTagMode {
  try {
    const value = localStorage.getItem("pf:audio-tag");
    if (value === "off" || value === "on") return value;
  } catch {
    /* storage blocked — default below */
  }
  return "on";
}

const CLASSIFY_TIMEOUT_MS = 20_000;
const MAX_FAILURES = 2;

let worker: Worker | null = null;
let workerFailures = 0;
let workerDisabled = false;
let unavailable = false;
let nextRequestId = 1;

function spawnWorker(): Worker | null {
  if (workerDisabled) return null;
  if (typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./audio-worker.ts", import.meta.url), { type: "module" });
    return worker;
  } catch {
    workerDisabled = true;
    return null;
  }
}

function request(request: AudioRequest, timeoutMs: number): Promise<AudioResponse> {
  const active = spawnWorker();
  if (!active) return Promise.resolve({ ...request, ok: false, error: "worker-unavailable" } as AudioResponse);
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
      resolve({ ...request, ok: false, error: "timeout" } as AudioResponse);
    }, timeoutMs);
    const onMessage = (event: MessageEvent<AudioResponse>) => {
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

/** Cheap probe: model present only after `npm run audio:fetch`. */
export async function audioTagAvailable(): Promise<boolean> {
  if (audioTagMode() === "off" || unavailable || workerDisabled) return false;
  try {
    const response = await fetch("/models/audio/manifest.json");
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

/**
 * Classify MONO 16 kHz audio into top AudioSet labels.
 * Null = audio tagging unavailable (caller degrades silently).
 */
export async function classifyAudio(audio: Float32Array): Promise<AudioLabel[] | null> {
  try {
    if (!(await audioTagAvailable())) return null;
    const active = spawnWorker();
    if (!active) return null;
    const response = await request(
      { type: "classify", requestId: nextRequestId++, audio },
      CLASSIFY_TIMEOUT_MS,
    );
    if (!response.ok || response.type !== "classify" || !response.labels) return null;
    return response.labels;
  } catch {
    return null;
  }
}

/** Test/diagnostic hook. */
export function resetAudioTagClient(): void {
  worker?.terminate();
  worker = null;
  workerFailures = 0;
  workerDisabled = false;
  unavailable = false;
  nextRequestId = 1;
}
