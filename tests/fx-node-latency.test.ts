/**
 * Regression coverage for the async worklet-latency contract:
 *
 * fxEq/Ultina/Ozvena AudioWorklet nodes learn their DSP latency from a port
 * message that arrives AFTER construction. The engine's PDC used to poll
 * getLatencySec() only on document syncs, so the first compensation after a
 * chain (re)build read a stale 0 and mis-aligned parallel tracks until the
 * next unrelated edit. The runtime contract now exposes onLatencyChange();
 * the engine re-runs syncPdc() when it fires.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFxEqNode } from "../src/effects/fxeqNode";
import type { EffectInstance } from "../src/project-model/types";

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  posted: unknown[] = [];
  closed = false;
  postMessage(msg: unknown) {
    this.posted.push(msg);
  }
  close() {
    this.closed = true;
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

function fakeCtx() {
  const gain = () => ({ connect() {}, disconnect() {} });
  return { sampleRate: 48000, createGain: gain } as unknown as BaseAudioContext;
}

function instance(): EffectInstance {
  return { id: "fx1", type: "fxeq", bypassed: false, params: {} };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fxeq node async latency reporting", () => {
  it("reports 0 until the worklet posts latency, then updates getLatencySec", () => {
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    const rt = createFxEqNode(fakeCtx(), instance(), {});
    expect(rt.getLatencySec?.()).toBe(0);
    rt.dispose();
  });

  it("notifies onLatencyChange listeners when latency lands, and unsubscribes cleanly", () => {
    let lastPort: FakePort | null = null;
    class CapturingNode extends FakeAudioWorkletNode {
      constructor(ctx: unknown, name: string, opts: Record<string, unknown>) {
        super(ctx, name, opts);
        lastPort = this.port;
      }
    }
    vi.stubGlobal("AudioWorkletNode", CapturingNode);

    const rt = createFxEqNode(fakeCtx(), instance(), {});
    expect(rt.onLatencyChange).toBeTypeOf("function");
    expect(lastPort).not.toBeNull();
    const port = lastPort!;

    let fires = 0;
    const unsubscribe = rt.onLatencyChange!(() => {
      fires++;
    });

    port.onmessage!({ data: { type: "latency", samples: 512 } });
    expect(fires).toBe(1);
    expect(rt.getLatencySec?.()).toBeCloseTo(512 / 48000, 12);

    // Duplicate latency reports still notify (value-level dedup happens in
    // the worklet's postLatency; the node forwards whatever arrives).
    port.onmessage!({ data: { type: "latency", samples: 512 } });
    expect(fires).toBe(2);

    unsubscribe();
    port.onmessage!({ data: { type: "latency", samples: 64 } });
    expect(fires).toBe(2);
    expect(rt.getLatencySec?.()).toBeCloseTo(64 / 48000, 12);
    rt.dispose();
  });

  it("dispose clears the port handler and stops notifying listeners", () => {
    let lastPort: FakePort | null = null;
    class CapturingNode extends FakeAudioWorkletNode {
      constructor(ctx: unknown, name: string, opts: Record<string, unknown>) {
        super(ctx, name, opts);
        lastPort = this.port;
      }
    }
    vi.stubGlobal("AudioWorkletNode", CapturingNode);

    const rt = createFxEqNode(fakeCtx(), instance(), {});
    const port = lastPort!;
    let fires = 0;
    rt.onLatencyChange!((): void => {
      fires++;
    });
    rt.dispose();
    expect(port.closed).toBe(true);
    expect(port.onmessage).toBeNull();

    // A late message (already queued before close) must not notify and must
    // not throw — the handler is detached.
    expect(() => port.onmessage?.({ data: { type: "latency", samples: 8 } })).not.toThrow();
    expect(fires).toBe(0);
  });
});

describe("fxeq node band-peak metering contract", () => {
  class CapturingNode extends FakeAudioWorkletNode {
    static last: CapturingNode | null = null;
    constructor(ctx: unknown, name: string, opts: Record<string, unknown>) {
      super(ctx, name, opts);
      CapturingNode.last = this;
    }
  }

  afterEach(() => {
    CapturingNode.last = null;
  });

  function makeRt() {
    vi.stubGlobal("AudioWorkletNode", CapturingNode);
    return createFxEqNode(fakeCtx(), instance(), {});
  }

  it("getMeters is null until a bandPeaks snapshot arrives", () => {
    const rt = makeRt();
    expect(rt.getMeters?.()).toBeNull();
    rt.dispose();
  });

  it("setMetersEnabled forwards the gate over the port", () => {
    const rt = makeRt();
    const port = CapturingNode.last!.port;
    port.posted.length = 0;
    rt.setMetersEnabled!(true);
    rt.setMetersEnabled!(false);
    expect(port.posted).toEqual([
      { type: "setMetersEnabled", enabled: true },
      { type: "setMetersEnabled", enabled: false },
    ]);
    rt.dispose();
  });

  it("bandPeaks messages surface through getMeters, and dispose clears them", () => {
    const rt = makeRt();
    const port = CapturingNode.last!.port;
    const peaks = new Float32Array([0.1, 0.5, 0.9, 0.2]);
    port.onmessage!({ data: { type: "bandPeaks", peaks } });
    // The meters snapshot now also carries the limiter's gain reduction
    // (0 until the worklet posts a gr value alongside the peaks).
    expect(rt.getMeters?.()).toEqual({ bandPeaks: peaks, gainReductionDb: 0 });

    // A later snapshot replaces the previous one (latest wins).
    const newer = new Float32Array([0.3]);
    port.onmessage!({ data: { type: "bandPeaks", peaks: newer, gr: 2.5 } });
    expect(rt.getMeters?.()).toEqual({ bandPeaks: newer, gainReductionDb: 2.5 });

    // Non-float garbage is ignored.
    port.onmessage!({ data: { type: "bandPeaks", peaks: "nope" } });
    expect(rt.getMeters?.()).toEqual({ bandPeaks: newer, gainReductionDb: 2.5 });

    rt.dispose();
    expect(rt.getMeters?.()).toBeNull();
  });

  it("setMetersEnabled after dispose is a no-op", () => {
    const rt = makeRt();
    const port = CapturingNode.last!.port;
    rt.dispose();
    port.posted.length = 0;
    expect(() => rt.setMetersEnabled!(true)).not.toThrow();
    expect(port.posted).toEqual([]);
  });
});
