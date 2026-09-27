import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SemanticResponse } from "../src/ai/semantic/semantic-types";

class FakeWorker {
  static instances: FakeWorker[] = [];

  readonly messages: unknown[] = [];
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  terminated = false;

  constructor(_url: URL, _options?: WorkerOptions) {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    let listeners = this.listeners.get(type);
    if (!listeners) this.listeners.set(type, (listeners = new Set()));
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(type: string, event: any = new Event(type)): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  emitMessage(data: SemanticResponse): void {
    this.emit("message", { data });
  }
}

describe("semantic worker client failure handling", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.resetModules();
    vi.stubGlobal("Worker", FakeWorker as unknown as typeof Worker);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("resolves worker runtime errors immediately and trips the circuit breaker", async () => {
    const { embedTexts } = await import("../src/ai/semantic/semantic-client");
    const first = embedTexts(["first request"]);
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    const worker = FakeWorker.instances[0];
    await vi.waitFor(() => expect(worker.messages).toHaveLength(1));

    worker.emit("error");
    await expect(first).resolves.toBeNull();
    expect(worker.terminated).toBe(false);

    const second = embedTexts(["second request"]);
    await vi.waitFor(() => expect(worker.messages).toHaveLength(2));
    worker.emit("messageerror");
    await expect(second).resolves.toBeNull();
    expect(worker.terminated).toBe(true);

    await expect(embedTexts(["after circuit opens"])).resolves.toBeNull();
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it("counts explicit worker error responses toward the same circuit breaker", async () => {
    const { embedTexts } = await import("../src/ai/semantic/semantic-client");
    const workerError = async (expectedMessages: number) => {
      const pending = embedTexts([`request ${expectedMessages}`]);
      await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
      const worker = FakeWorker.instances[0];
      await vi.waitFor(() => expect(worker.messages).toHaveLength(expectedMessages));
      const { requestId } = worker.messages[expectedMessages - 1] as { requestId: number };
      worker.emitMessage({ type: "embed", requestId, ok: false, error: "model-failed" });
      await expect(pending).resolves.toBeNull();
      return worker;
    };

    const worker = await workerError(1);
    expect(worker.terminated).toBe(false);
    await workerError(2);
    expect(worker.terminated).toBe(true);
    await expect(embedTexts(["after circuit opens"])).resolves.toBeNull();
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it("cold-start timeouts resolve to null WITHOUT tripping the circuit breaker", async () => {
    // Regression: the first embed also loads the ~118 MB model; a slow disk
    // could exceed the 20 s budget twice and silently kill the semantic path
    // for the whole session. Cold timeouts must leave the worker loading.
    vi.useFakeTimers();
    try {
      const { embedTexts } = await import("../src/ai/semantic/semantic-client");
      const pending = embedTexts(["slow first load"]);
      await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
      const worker = FakeWorker.instances[0];
      await vi.waitFor(() => expect(worker.messages).toHaveLength(1));

      await vi.advanceTimersByTimeAsync(60_000 + 200 + 1);
      await expect(pending).resolves.toBeNull();
      expect(worker.terminated).toBe(false);

      // Still alive after two cold timeouts — the breaker must not have opened.
      const second = embedTexts(["second attempt"]);
      await vi.waitFor(() => expect(worker.messages).toHaveLength(2));
      await vi.advanceTimersByTimeAsync(60_000 + 200 + 1);
      await expect(second).resolves.toBeNull();
      expect(worker.terminated).toBe(false);

      // Warm failures still count: two explicit errors trip the breaker.
      const third = embedTexts(["third"]);
      await vi.waitFor(() => expect(worker.messages).toHaveLength(3));
      const { requestId: id3 } = worker.messages[2] as { requestId: number };
      worker.emitMessage({ type: "embed", requestId: id3, ok: false, error: "model-failed" });
      await expect(third).resolves.toBeNull();
      const fourth = embedTexts(["fourth"]);
      await vi.waitFor(() => expect(worker.messages).toHaveLength(4));
      const { requestId: id4 } = worker.messages[3] as { requestId: number };
      worker.emitMessage({ type: "embed", requestId: id4, ok: false, error: "model-failed" });
      await expect(fourth).resolves.toBeNull();
      expect(worker.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("semantic worker model-pack cache bridge", () => {
  let previousFetch: typeof self.fetch;
  let previousOnMessage: typeof self.onmessage;

  beforeEach(() => {
    vi.resetModules();
    previousFetch = self.fetch;
    previousOnMessage = self.onmessage;
  });

  afterEach(() => {
    self.fetch = previousFetch;
    self.onmessage = previousOnMessage;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("serves an installed model-pack URL from the shared cache before network", async () => {
    const cachedResponse = new Response("cached model manifest");
    const match = vi.fn().mockResolvedValue(cachedResponse);
    const open = vi.fn().mockResolvedValue({ match });
    const networkFetch = vi.fn();
    vi.stubGlobal("caches", { open });
    vi.stubGlobal("fetch", networkFetch);

    await import("../src/ai/semantic/semantic-worker");
    const url = "/models/semantic/manifest.json";
    await expect(self.fetch(url)).resolves.toBe(cachedResponse);

    expect(open).toHaveBeenCalledWith("pf:model-packs");
    expect(match).toHaveBeenCalledWith(new URL(url, self.location.href).href);
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("falls back to the original fetch when the model-pack cache misses or fails", async () => {
    const networkResponse = new Response("origin model manifest");
    const networkFetch = vi.fn().mockResolvedValue(networkResponse);
    const match = vi.fn().mockResolvedValue(null);
    const open = vi.fn().mockResolvedValue({ match });
    vi.stubGlobal("caches", { open });
    vi.stubGlobal("fetch", networkFetch);

    await import("../src/ai/semantic/semantic-worker");
    const url = "/models/semantic/manifest.json";
    await expect(self.fetch(url)).resolves.toBe(networkResponse);
    expect(networkFetch).toHaveBeenCalledWith(url, undefined);

    open.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(self.fetch(url)).resolves.toBe(networkResponse);
    expect(networkFetch).toHaveBeenCalledTimes(2);
  });
});
