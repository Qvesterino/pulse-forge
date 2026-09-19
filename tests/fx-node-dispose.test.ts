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
  ({ id: `${type}-1`, type, params: {}, bypassed: false }) as unknown as Parameters<typeof createOzvenaNode>[1];

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

describe("ozvena node ships PRECOMPUTED IR spectra (no time-domain payloads)", () => {
  // The node is the main-thread side of the audio-thread allocation fix:
  // both the user-IR load and the factory-IR reply must carry frequency-
  // domain partition sets (the FFT batch ran HERE), never raw samples that
  // would make the worklet's convolver FFT on the audio rendering thread.
  function fakeAudioBuffer(channels: number, frames: number): AudioBuffer {
    const chans = Array.from({ length: channels }, (_, c) => {
      const d = new Float32Array(frames);
      for (let i = 0; i < frames; i++) d[i] = Math.exp(-i / (frames / 4)) * (c + 1);
      return d;
    });
    return {
      numberOfChannels: channels,
      length: frames,
      sampleRate: 48000,
      duration: frames / 48000,
      getChannelData: (i: number) => chans[i],
      copyFromChannel: () => {},
      copyToChannel: () => {},
    } as unknown as AudioBuffer;
  }

  it("loadUserIr posts per-slot spectra sets (no time-domain samples)", () => {
    const ctx = makeCtx();
    const rt = createOzvenaNode(ctx, instanceOf("ozvena"), {}, 120);
    const node = lastNode as FakeAudioWorkletNode;

    rt.loadUserIr!(fakeAudioBuffer(2, 1000));
    const msg = node.port.posted.find((m) => m.type === "loadIr") as
      | {
          channels?: number;
          sets?: {
            irSpectra: Float64Array;
            blockSpectra: Float64Array;
            numPartitions: number;
            partitionSize: number;
            irLengthSamples: number;
          }[];
          samples?: unknown;
        }
      | undefined;
    expect(msg).toBeDefined();
    expect(msg!.samples).toBeUndefined(); // ← no time-domain payload
    expect(msg!.channels).toBe(2);
    expect(msg!.sets!.length).toBe(2); // stereo bus → L and R slots
    const s0 = msg!.sets![0];
    expect(s0.irLengthSamples).toBe(1000);
    expect(s0.partitionSize).toBe(2048);
    expect(s0.numPartitions).toBe(1); // 1000 < hop 1024
    expect(s0.irSpectra.length).toBe(2048 * 2);
    // The two slots must NOT share a blockSpectra (mutable per convolver).
    expect(s0.blockSpectra).not.toBe(msg!.sets![1].blockSpectra);
  });

  it("irNeeded reply carries quad spectra sets for a true-stereo factory IR", () => {
    const ctx = makeCtx();
    createOzvenaNode(ctx, instanceOf("ozvena"), {}, 120);
    const node = lastNode as FakeAudioWorkletNode;

    node.port.onmessage?.({ data: { type: "irNeeded", irId: "hall", sampleRate: 48000 } });
    const msg = node.port.posted.find((m) => m.type === "factoryIr") as
      { irId?: string; channels?: number; sets?: { irSpectra: Float64Array }[]; samples?: unknown } | undefined;
    expect(msg).toBeDefined();
    expect(msg!.irId).toBe("hall");
    expect(msg!.samples).toBeUndefined();
    expect(msg!.channels).toBe(4); // factory IRs are true-stereo quads
    expect(msg!.sets!.length).toBe(4); // LL, LR, RL, RR slots
    // A 2.5 s hall at 48 kHz → 120000 frames → 118 partitions of 2048.
    expect(msg!.sets![0].irSpectra.length).toBe(118 * 2048 * 2);
  });

  it("factory re-delivery reuses main-thread spectra but mints fresh mutable rings", () => {
    const ctx = makeCtx();
    createOzvenaNode(ctx, instanceOf("ozvena"), {}, 120);
    const node = lastNode as FakeAudioWorkletNode;

    node.port.onmessage?.({ data: { type: "irNeeded", irId: "hall", sampleRate: 48000 } });
    node.port.onmessage?.({ data: { type: "irNeeded", irId: "hall", sampleRate: 48000 } });
    const replies = node.port.posted.filter((m) => m.type === "factoryIr") as Array<{
      sets?: { irSpectra: Float64Array; blockSpectra: Float64Array }[];
    }>;
    expect(replies).toHaveLength(2);
    const first = replies[0].sets!;
    const second = replies[1].sets!;
    expect(first[0].irSpectra).not.toBe(second[0].irSpectra);
    expect(first[0].irSpectra[0]).toBe(second[0].irSpectra[0]);
    expect(first[0].blockSpectra).not.toBe(second[0].blockSpectra);
  });

  it("an empty/zero-frame buffer is ignored without posting a payload", () => {
    const ctx = makeCtx();
    const rt = createOzvenaNode(ctx, instanceOf("ozvena"), {}, 120);
    const node = lastNode as FakeAudioWorkletNode;
    const before = node.port.posted.length;
    rt.loadUserIr!(fakeAudioBuffer(2, 0));
    expect(node.port.posted.length).toBe(before);
  });
});
