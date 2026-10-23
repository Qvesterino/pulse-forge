import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A DEAD WORKER MUST SETTLE THE CALLER NOW.
 *
 * Three AI clients (ranker, prior, audio) spawned their worker and listened
 * for exactly one thing: a "message" answer. They registered NO worker
 * "error" listener, so a worker that died — crashed on a module import, was
 * killed under memory pressure, or was deafened by the payload-validation gap
 * next door — produced NO event at all. The caller's promise then sat on its
 * timeout:
 *
 *   ranker   400 ms (score) / 3 000 ms (load)
 *   prior    500 ms (run)   / 3 000 ms (load)
 *   audio    20 000 ms (classify)  ← twenty seconds of nothing
 *
 * Two things were wrong with that, and only one of them is the delay:
 *
 * 1. the wait — the failure was invisible for the whole timeout, and the
 *    answer said "timeout", so a dead worker was mis-attributed to the MODEL;
 * 2. the circuit breaker — a timeout counted as a failure, but a worker ERROR
 *    did not (there was no listener to count it), so the breaker never opened
 *    on a worker that was dead for the whole session. Every later request
 *    spawned/kept a dead worker and paid the full timeout again.
 *
 * The semantic client already had the right shape (`src/ai/semantic/semantic-client.ts`):
 * an "error" listener, a "messageerror" listener, a `fail()` that settles the
 * promise, and a failure that counts toward the breaker. These three clients
 * now follow it.
 */

class FakeWorker {
  static instances: FakeWorker[] = [];

  readonly messages: unknown[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let listeners = this.listeners.get(type);
    if (!listeners) this.listeners.set(type, (listeners = new Set()));
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type });
  }

  get hasErrorListener(): boolean {
    return (this.listeners.get("error")?.size ?? 0) > 0;
  }
}

const settled = <T>(promise: Promise<T>, ms: number): Promise<"settled" | "still-pending"> =>
  Promise.race([
    promise.then(() => "settled" as const),
    new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), ms)),
  ]);

const manifest = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

const RANKER_FEATURE_COUNT = 54;
const PRIOR_FEATURE_COUNT = 44;

beforeEach(() => {
  FakeWorker.instances = [];
  vi.resetModules();
  vi.stubGlobal("Worker", FakeWorker as unknown as typeof Worker);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("intent-ranker")) {
        return { ok: true, json: async () => manifest("public/models/intent-ranker-v1.manifest.json") };
      }
      if (url.includes("symbolic-prior")) {
        return { ok: true, json: async () => manifest("public/models/symbolic-prior-v1.manifest.json") };
      }
      if (url.includes("/models/audio/")) return { ok: true, json: async () => ({}) };
      return { ok: false, json: async () => ({}) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("the ranker client survives a dead worker", () => {
  it("settles the score when the worker dies instead of waiting for the timeout", async () => {
    const { scoreCandidateFeatures } = await import("../src/ai/ranking/ranker-client");
    const pending = scoreCandidateFeatures(new Float32Array(RANKER_FEATURE_COUNT * 2), 2);
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    const worker = FakeWorker.instances[0];
    await vi.waitFor(() => expect(worker.messages.length).toBeGreaterThan(0));

    worker.emit("error");

    expect(await settled(pending, 1000), "a dead worker must not wait for the timeout").toBe("settled");
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.source, "a dead worker is a fallback, never a model answer").toBe("fallback");
  });

  it("opens the circuit breaker on repeated worker deaths", async () => {
    const { scoreCandidateFeatures } = await import("../src/ai/ranking/ranker-client");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // The client reuses its worker until the breaker opens, so the "before"
      // mark is taken on the worker that is currently alive.
      const before = FakeWorker.instances[FakeWorker.instances.length - 1]?.messages.length ?? 0;
      const pending = scoreCandidateFeatures(new Float32Array(RANKER_FEATURE_COUNT * 2), 2);
      await vi.waitFor(() => {
        const worker = FakeWorker.instances[FakeWorker.instances.length - 1];
        expect(worker?.messages.length ?? 0).toBeGreaterThan(before);
      });
      const worker = FakeWorker.instances[FakeWorker.instances.length - 1]!;
      worker.emit("error");
      expect(await settled(pending, 1000), "a dead worker must not wait for the timeout").toBe("settled");
      await pending;
    }

    const spawnCount = FakeWorker.instances.length;
    await scoreCandidateFeatures(new Float32Array(RANKER_FEATURE_COUNT * 2), 2);
    expect(
      FakeWorker.instances.length,
      "a worker that keeps dying must be stopped by the circuit breaker, not respawned forever",
    ).toBe(spawnCount);
    expect(FakeWorker.instances[spawnCount - 1]?.terminated, "the breaker must terminate the dead worker").toBe(true);
  });
});

describe("the prior client survives a dead worker", () => {
  it("settles the grid when the worker dies instead of waiting for the timeout", async () => {
    const { runPriorGrid } = await import("../src/ai/symbolic/prior-client");
    const pending = runPriorGrid(new Float32Array(PRIOR_FEATURE_COUNT * 2), 2);
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    const worker = FakeWorker.instances[0];
    await vi.waitFor(() => expect(worker.messages.length).toBeGreaterThan(0));

    worker.emit("error");

    expect(await settled(pending, 1000), "a dead worker must not wait for the timeout").toBe("settled");
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.source, "a dead worker is a fallback, never a model answer").toBe("fallback");
  });
});

describe("the audio client survives a dead worker", () => {
  it("settles the classification when the worker dies instead of waiting 20 seconds", async () => {
    const { classifyAudio } = await import("../src/ai/audio/audio-client");
    const pending = classifyAudio(new Float32Array(16000));
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    const worker = FakeWorker.instances[0];
    await vi.waitFor(() => expect(worker.messages.length).toBeGreaterThan(0));

    worker.emit("error");

    expect(await settled(pending, 1000), "a dead worker must not wait for the 20 s timeout").toBe("settled");
    await expect(pending).resolves.toBeNull();
  });

  it("opens the circuit breaker on repeated worker deaths", async () => {
    const { classifyAudio } = await import("../src/ai/audio/audio-client");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = FakeWorker.instances[FakeWorker.instances.length - 1]?.messages.length ?? 0;
      const pending = classifyAudio(new Float32Array(16000));
      await vi.waitFor(() => {
        const worker = FakeWorker.instances[FakeWorker.instances.length - 1];
        expect(worker?.messages.length ?? 0).toBeGreaterThan(before);
      });
      const worker = FakeWorker.instances[FakeWorker.instances.length - 1]!;
      worker.emit("error");
      expect(await settled(pending, 1000), "a dead worker must not wait for the timeout").toBe("settled");
      await pending;
    }

    const spawnCount = FakeWorker.instances.length;
    await classifyAudio(new Float32Array(16000));
    expect(
      FakeWorker.instances.length,
      "a worker that keeps dying must be stopped by the circuit breaker, not respawned forever",
    ).toBe(spawnCount);
    expect(FakeWorker.instances[spawnCount - 1]?.terminated, "the breaker must terminate the dead worker").toBe(true);
  });
});
