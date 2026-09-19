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
});
