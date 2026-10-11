import { afterEach, describe, expect, it, vi } from "vitest";
import { createPortalNode } from "../src/audio-worklets/portal-node";

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  posted: unknown[] = [];
  postMessage(message: unknown) {
    this.posted.push(message);
  }
}

class FakeAudioWorkletNode {
  port = new FakePort();
  constructor(
    _ctx: unknown,
    public name: string,
    public opts: Record<string, unknown>,
  ) {}
  connect() {}
  disconnect() {}
}

function fakeCtx(): BaseAudioContext {
  return {
    sampleRate: 48000,
    createGain: () => ({ connect() {}, disconnect() {} }),
  } as unknown as BaseAudioContext;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PORTAL node latency reporting", () => {
  it("waits for the worklet report, then exposes latency to PDC", () => {
    let lastNode: FakeAudioWorkletNode | null = null;
    class CapturingNode extends FakeAudioWorkletNode {
      constructor(ctx: unknown, name: string, opts: Record<string, unknown>) {
        super(ctx, name, opts);
        lastNode = this;
      }
    }
    vi.stubGlobal("AudioWorkletNode", CapturingNode);

    const runtime = createPortalNode(fakeCtx(), { params: {} });
    expect(runtime.getLatencySec?.()).toBe(0);
    expect(runtime.hasLatencyReport?.()).toBe(false);

    const port = lastNode!.port;
    let changes = 0;
    runtime.onLatencyChange?.(() => changes++);
    port.onmessage!({ data: { type: "latency", frames: 768 } });

    expect(runtime.getLatencySec?.()).toBeCloseTo(768 / 48000, 12);
    expect(runtime.hasLatencyReport?.()).toBe(true);
    expect(changes).toBe(1);
    runtime.dispose?.();
  });

  it("rejects malformed reports and resolves a valid report wait", async () => {
    let lastNode: FakeAudioWorkletNode | null = null;
    class CapturingNode extends FakeAudioWorkletNode {
      constructor(ctx: unknown, name: string, opts: Record<string, unknown>) {
        super(ctx, name, opts);
        lastNode = this;
      }
    }
    vi.stubGlobal("AudioWorkletNode", CapturingNode);

    const runtime = createPortalNode(fakeCtx(), { params: {} });
    const pending = runtime.waitForLatencyReport?.(100);
    const port = lastNode!.port;
    port.onmessage!({ data: { type: "latency", frames: Number.NaN } });
    port.onmessage!({ data: { type: "latency", frames: -1 } });
    expect(runtime.hasLatencyReport?.()).toBe(false);

    port.onmessage!({ data: { type: "latency", frames: 768 } });
    await expect(pending).resolves.toBe(true);
    runtime.dispose?.();
  });

  it("settles pending waits and stops notifications on dispose", async () => {
    let lastNode: FakeAudioWorkletNode | null = null;
    class CapturingNode extends FakeAudioWorkletNode {
      constructor(ctx: unknown, name: string, opts: Record<string, unknown>) {
        super(ctx, name, opts);
        lastNode = this;
      }
    }
    vi.stubGlobal("AudioWorkletNode", CapturingNode);

    const runtime = createPortalNode(fakeCtx(), { params: {} });
    const pending = runtime.waitForLatencyReport?.(100);
    const port = lastNode!.port;
    let changes = 0;
    runtime.onLatencyChange?.(() => changes++);
    runtime.dispose?.();

    await expect(pending).resolves.toBe(false);
    expect(port.onmessage).toBeNull();
    port.onmessage?.({ data: { type: "latency", frames: 768 } });
    expect(changes).toBe(0);
  });
});
