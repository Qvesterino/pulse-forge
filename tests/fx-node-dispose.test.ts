import { beforeAll, describe, expect, it } from "vitest";
import { createOzvenaNode } from "../src/effects/ozvenaNode.js";
import { createUltinaNode } from "../src/effects/ultinaNode.js";

/**
 * Plugin node disposal contract (main-thread wrappers).
 *
 * Regression (2026-09 audit): dispose() used to postMessage({dispose}) and
 * IMMEDIATELY port.close(). Closing a MessagePort can drop already-queued
 * messages (engine-dependent), so the terminal teardown could silently
 * never reach the processor — leaking one module-global registry entry
 * (Ozvena: IPC peer registry; Ultina: cross-instance spectral registry)
 * per disposed instance, for the page's lifetime. The port must stay open
 * and let the node's GC close it after delivery.
 */

interface FakePort {
  posted: Array<Record<string, unknown>>;
  closed: boolean;
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(msg: Record<string, unknown>): void;
  close(): void;
}

class FakeAudioWorkletNode {
  port: FakePort;
  disconnectCount = 0;
  constructor(_ctx: unknown, _name: string, _opts: unknown) {
    this.port = {
      posted: [],
      closed: false,
      onmessage: null,
      postMessage(msg) {
        this.posted.push(msg);
      },
      close() {
        this.closed = true;
      },
    };
  }
  connect(): FakeAudioWorkletNode {
    return this;
  }
  disconnect(): void {
    this.disconnectCount++;
  }
}

let lastNode: FakeAudioWorkletNode | null = null;

beforeAll(() => {
  Object.defineProperty(globalThis, "AudioWorkletNode", {
    value: class extends FakeAudioWorkletNode {
      constructor(ctx: unknown, name: string, opts: unknown) {
        super(ctx, name, opts);
        lastNode = this;
      }
    },
    configurable: true,
    writable: true,
  });
});

function makeCtx(): BaseAudioContext {
  const createGain = () => ({
    gain: { value: 0 },
    connect() {
      /* chain */
    },
    disconnectCount: 0,
    disconnect(this: { disconnectCount: number }) {
      this.disconnectCount++;
    },
  });
  const gains: ReturnType<typeof createGain>[] = [];
  const ctx = {
    sampleRate: 48000,
    currentTime: 0,
    createGain() {
      const g = createGain();
      gains.push(g);
      return g;
    },
  };
  // Expose the gain list for disconnect assertions without widening types.
  (ctx as unknown as { gains: unknown }).gains = gains;
  return ctx as unknown as BaseAudioContext;
}

const gainsOf = (ctx: BaseAudioContext): { disconnectCount: number }[] =>
  (ctx as unknown as { gains: { disconnectCount: number }[] }).gains;

const instanceOf = (type: string) =>
  ({ id: `${type}-1`, type, params: {}, bypassed: false }) as unknown as Parameters<
    typeof createOzvenaNode
  >[1];

describe("plugin node dispose does not close the message port", () => {
  it("ozvena: dispose message is delivered and the port stays open", () => {
    const ctx = makeCtx();
    const rt = createOzvenaNode(ctx, instanceOf("ozvena"), { "global.dryWet": 100 }, 120);
    const node = lastNode as FakeAudioWorkletNode;
    expect(node).not.toBeNull();

    rt.dispose();

    const types = node.port.posted.map((m) => m.type);
    expect(types).toContain("dispose");
    expect(node.port.closed).toBe(false); // ← the regression
    expect(node.disconnectCount).toBe(1);
    const gains = gainsOf(ctx);
    expect(gains).toHaveLength(2);
    expect(gains.every((g) => g.disconnectCount === 1)).toBe(true);

    // Params after dispose are ignored without throwing.
    expect(() => rt.setParameter("global.dryWet", 0)).not.toThrow();
    const paramsAfter = node.port.posted.filter((m) => m.type === "param");
    expect(paramsAfter).toHaveLength(0);
  });

  it("ultina: dispose message is delivered and the port stays open", () => {
    const ctx = makeCtx();
    const rt = createUltinaNode(ctx, instanceOf("ultina"), { "global.inputGainDb": 0 });
    const node = lastNode as FakeAudioWorkletNode;
    expect(node).not.toBeNull();

    rt.dispose();

    const types = node.port.posted.map((m) => m.type);
    // Construction negotiates meters off; teardown posts the terminal event.
    expect(types).toContain("setMeters");
    expect(types).toContain("dispose");
    expect(node.port.closed).toBe(false); // ← the regression
    expect(node.disconnectCount).toBe(1);
    const gains = gainsOf(ctx);
    expect(gains).toHaveLength(2);
    expect(gains.every((g) => g.disconnectCount === 1)).toBe(true);

    expect(() => rt.setParameter("global.inputGainDb", -3)).not.toThrow();
    expect(node.port.posted.filter((m) => m.type === "param")).toHaveLength(0);
  });

  it("dispose is idempotent (double-dispose must not double-post or throw)", () => {
    const ctx = makeCtx();
    const rt = createOzvenaNode(ctx, instanceOf("ozvena"), {}, 120);
    const node = lastNode as FakeAudioWorkletNode;
    rt.dispose();
    const after1 = node.port.posted.length;
    expect(() => rt.dispose()).not.toThrow();
    expect(node.port.posted.length).toBe(after1);
  });
});
