import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeReferenceAsync, transcribeTrackAsync } from "../src/reference/reference-client";
import type { ReferenceAudioMetadata } from "../src/reference/types";

/**
 * REFERENCE WORKER LIFECYCLE GATE (browser lifecycle audit 2026-10-18)
 *
 * The reference analyzer and the UN-SUNO transcription ship work to a module
 * worker. A worker can die WITHOUT firing `error` (killed under memory
 * pressure, module torn down after a long idle) — both promises then waited
 * forever: the UI showed a spinner with no bound, and an abort DURING the
 * transcription wait was ignored (only the pre-check looked at the signal).
 *
 * These specs pin the bounded contract with a fake worker:
 *   - no reply  → the deterministic sync fallback resolves after the timeout,
 *   - a reply   → resolves immediately and the timer never double-settles,
 *   - abort     → settles without waiting for the worker or the timeout.
 * Every path terminates the worker exactly once.
 */

type Listener = (event: unknown) => void;

class FakeWorker {
  static instances: FakeWorker[] = [];
  listeners = new Map<string, Set<Listener>>();
  posted: unknown[] = [];
  terminateCalls = 0;

  constructor() {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, callback: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(callback);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, callback: Listener): void {
    this.listeners.get(type)?.delete(callback);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminateCalls += 1;
  }

  emit(type: string, event: unknown): void {
    for (const callback of [...(this.listeners.get(type) ?? [])]) callback(event);
  }
}

const SAMPLE_RATE = 44100;
const SECONDS = 2;

function pcm(): Float32Array {
  const length = SAMPLE_RATE * SECONDS;
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i += 1) samples[i] = Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * 0.2;
  return samples;
}

function metadata(): ReferenceAudioMetadata {
  return { name: "lifecycle.wav", size: 1, duration: SECONDS, sampleRate: SAMPLE_RATE, channels: 1 };
}

const TIMEOUT_MS = 120_000;

beforeEach(() => {
  FakeWorker.instances = [];
  (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { Worker?: unknown }).Worker;
});

describe("reference worker lifecycle", () => {
  it("resolve a hung analysis worker with the deterministic fallback after the timeout", async () => {
    const promise = analyzeReferenceAsync({ mono: pcm(), metadata: metadata() });
    const worker = FakeWorker.instances[0]!;
    expect(worker.posted).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
    const result = await promise;

    expect(result.result, "the sync fallback must produce a real report").toBeDefined();
    expect(worker.terminateCalls, "a timed-out worker must be terminated exactly once").toBe(1);
  });

  it("a worker reply settles immediately and the timer never double-settles", async () => {
    const sentinel = { result: { tempo: { bpm: 120 } } } as never;
    const promise = analyzeReferenceAsync({ mono: pcm(), metadata: metadata() });
    const worker = FakeWorker.instances[0]!;

    worker.emit("message", { data: { type: "REFERENCE_RESULT", payload: sentinel } });
    await expect(promise).resolves.toBe(sentinel);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 2);
    expect(worker.terminateCalls).toBe(1);
  });

  it("resolve a hung transcription worker with the deterministic fallback after the timeout", async () => {
    const promise = transcribeTrackAsync(pcm(), SAMPLE_RATE, { separation: "off" });
    const worker = FakeWorker.instances[0]!;
    expect(worker.posted).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
    const result = await promise;

    expect(result, "the sync transcription must still return a transcription").toBeDefined();
    expect(worker.terminateCalls).toBe(1);
  });

  it("an abort DURING the transcription wait settles without waiting for the worker", async () => {
    const controller = new AbortController();
    const promise = transcribeTrackAsync(pcm(), SAMPLE_RATE, { separation: "off", signal: controller.signal });
    const worker = FakeWorker.instances[0]!;

    controller.abort();
    const result = await promise; // no timer advance: the abort listener settles it

    expect(result).toBeDefined();
    expect(worker.terminateCalls).toBe(1);
    // The timeout is cleared: advancing far past it changes nothing.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 2);
    expect(worker.terminateCalls).toBe(1);
  });
});
