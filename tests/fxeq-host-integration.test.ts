/**
 * PRISM host-integration wiring: the dormant core surfaces (A/B morph
 * slots, in-plugin undo/redo, sidechain input, gain-reduction metering)
 * as exposed by fxeqNode over the message port.
 *
 * Runs the REAL node adapter under a stubbed AudioWorkletNode (same harness
 * as fx-node-latency.test.ts) — the worklet side is covered by
 * fxeq-worklet-entry.test.ts against the real entry.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { blendParams, createFxEqNode } from "../src/effects/fxeqNode";
import type { EffectInstance } from "../src/project-model/types";

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  posted: Record<string, unknown>[] = [];
  closed = false;
  postMessage(msg: unknown) {
    this.posted.push(msg as Record<string, unknown>);
  }
  close() {
    this.closed = true;
  }
}

class FakeAudioWorkletNode {
  port = new FakePort();
  static last: FakeAudioWorkletNode | null = null;
  connections: { dest: unknown; output: number; input: number }[] = [];
  disconnections: { source: unknown; dest: unknown }[] = [];
  disconnectedSelf = false;
  constructor(
    _ctx: unknown,
    public name: string,
    public opts: Record<string, unknown>,
  ) {
    FakeAudioWorkletNode.last = this;
  }
  connect(dest: unknown, output = 0, input = 0) {
    this.connections.push({ dest, output, input });
    return dest;
  }
  disconnect(dest?: unknown) {
    if (dest === undefined) {
      this.disconnectedSelf = true;
      return;
    }
    this.disconnections.push({ source: this, dest });
  }
}

function fakeCtx() {
  const gain = () => ({ connect() {}, disconnect() {} });
  return { sampleRate: 48000, createGain: gain } as unknown as BaseAudioContext;
}

function instance(): EffectInstance {
  return { id: "fx1", type: "fxeq", bypassed: false, params: {} };
}

function makeRt() {
  vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
  FakeAudioWorkletNode.last = null;
  const rt = createFxEqNode(fakeCtx(), instance(), {});
  // TS narrows the static to null from the reset above and cannot see the
  // constructor's assignment — rebind through unknown.
  const node = FakeAudioWorkletNode.last as unknown as FakeAudioWorkletNode;
  if (!node) throw new Error("node not constructed");
  return { rt, node, port: node.port };
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeAudioWorkletNode.last = null;
});

describe("blendParams (morph target resolution)", () => {
  it("lerps every shared id and passes a-only ids through", () => {
    const a = { "band1.gainDb": -12, "band2.satDriveDb": 0, globalMix: 0 };
    const b = { "band1.gainDb": 12, "band2.satDriveDb": 24, extra: 5 };
    const out = blendParams(a, b, 0.25);
    expect(out["band1.gainDb"]).toBeCloseTo(-6, 12);
    expect(out["band2.satDriveDb"]).toBeCloseTo(6, 12);
    // Ids missing from b keep a's value; B-only ids are retained as well so a
    // partial persisted snapshot cannot silently drop a parameter at release.
    expect(out.globalMix).toBe(0);
    expect(out.extra).toBe(5);
  });

  it("excludes bandCount — interpolating an active-band count would rebuild the schema per block", () => {
    const a = { bandCount: 4, "band1.gainDb": 0 };
    const b = { bandCount: 6, "band1.gainDb": 6 };
    const out = blendParams(a, b, 0.5);
    expect(out.bandCount).toBeUndefined();
    expect(out["band1.gainDb"]).toBe(3);
  });

  it("treats non-finite entries as no-target (rides from a)", () => {
    const out = blendParams({ x: 2 }, { x: Number.NaN }, 0.9);
    expect(out.x).toBe(2);
  });
});

describe("fxeq node morph slots", () => {
  it("stores and returns snapshot copies (mutations do not leak)", () => {
    const { rt } = makeRt();
    expect(rt.getMorphSnapshot?.(0)).toBeNull();
    const snap = { "band1.gainDb": -3 };
    rt.setMorphSnapshot!(0, snap);
    snap["band1.gainDb"] = 99;
    expect(rt.getMorphSnapshot?.(0)).toEqual({ "band1.gainDb": -3 });
    rt.dispose();
  });

  it("morphToSnapshot posts the snapshot as a morph target with its duration", () => {
    const { rt, port } = makeRt();
    port.posted.length = 0;
    rt.morphToSnapshot!(1, 0.4); // no snapshot yet → silent no-op
    expect(port.posted).toEqual([]);
    rt.setMorphSnapshot!(1, { inputGainDb: 6 });
    rt.morphToSnapshot!(1, 0.4);
    expect(port.posted).toEqual([{ type: "morph", params: { inputGainDb: 6 }, durationSec: 0.4 }]);
    rt.setMorphSnapshot!(1, null);
    expect(rt.getMorphSnapshot?.(1)).toBeNull();
    rt.dispose();
  });

  it("morphBlendSnapshots posts the resolved blend; missing snapshots are a no-op", () => {
    const { rt, port } = makeRt();
    rt.setMorphSnapshot!(0, { "band1.gainDb": -12, bandCount: 6 });
    rt.setMorphSnapshot!(1, { "band1.gainDb": 12, bandCount: 2 });
    port.posted.length = 0;
    rt.morphBlendSnapshots!(0, 1, 0.75, 0.08);
    expect(port.posted).toEqual([{ type: "morph", params: { "band1.gainDb": 6 }, durationSec: 0.08 }]);
    // t is clamped into [0, 1].
    rt.morphBlendSnapshots!(0, 1, 42, 0.08);
    expect((port.posted[1] as { params: Record<string, number> }).params["band1.gainDb"]).toBe(12);
    rt.dispose();
  });
});

describe("fxeq node in-plugin undo/redo", () => {
  it("posts undo and resolves the callback with the restored entry", () => {
    const { rt, port } = makeRt();
    const replies: ({ id: string; value: number } | null)[] = [];
    rt.undoParam!((entry) => replies.push(entry));
    // Reply arrives as a port message (worklet → main).
    port.onmessage!({ data: { type: "history", action: "undo", id: "inputGainDb", value: -6 } });
    expect(replies).toEqual([{ id: "inputGainDb", value: -6 }]);
    rt.dispose();
  });

  it("a null history reply resolves the callback with null (nothing to undo)", () => {
    const { rt, port } = makeRt();
    const replies: ({ id: string; value: number } | null)[] = [];
    rt.redoParam!((entry) => replies.push(entry));
    port.onmessage!({ data: { type: "history", action: "redo", id: null, value: 0 } });
    expect(replies).toEqual([null]);
    rt.dispose();
  });

  it("serializes overlapping undo/redo requests until each port reply arrives", () => {
    const { rt, port } = makeRt();
    const replies: string[] = [];
    rt.undoParam!((entry) => replies.push(entry?.id ?? "null"));
    rt.redoParam!((entry) => replies.push(entry?.id ?? "null"));
    expect(port.posted).toEqual([{ type: "undo" }]);

    port.onmessage!({ data: { type: "history", id: "first", value: 1 } });
    expect(replies).toEqual(["first"]);
    expect(port.posted).toEqual([{ type: "undo" }, { type: "redo" }]);

    port.onmessage!({ data: { type: "history", id: "second", value: 2 } });
    expect(replies).toEqual(["first", "second"]);
    rt.dispose();
  });

  it("begin/endParamSync gate recording over the port (order-preserving)", () => {
    const { rt, port } = makeRt();
    port.posted.length = 0;
    rt.beginParamSync!();
    rt.setParameter("inputGainDb", -6);
    rt.endParamSync!();
    expect(port.posted).toEqual([
      { type: "historyRecording", enabled: false },
      { type: "param", id: "inputGainDb", value: -6 },
      { type: "historyRecording", enabled: true },
    ]);
    rt.dispose();
  });
});

describe("fxeq node sidechain input", () => {
  /** Source stub that records its connect/disconnect calls — the runtime
   *  wires the feed by calling methods on the SOURCE node. */
  function sourceStub() {
    const calls: { connects: unknown[][]; disconnects: unknown[][] } = {
      connects: [],
      disconnects: [],
    };
    const node = {
      connect: (...args: unknown[]) => {
        calls.connects.push(args);
      },
      disconnect: (...args: unknown[]) => {
        calls.disconnects.push(args);
      },
    } as unknown as AudioNode;
    return { node, calls };
  }

  it("connects the source to worklet input 1 and disconnects on null", () => {
    const { rt, node } = makeRt();
    const { node: source, calls } = sourceStub();
    rt.setSidechainInput!(source);
    expect(calls.connects).toEqual([[node, 0, 1]]);
    rt.setSidechainInput!(null);
    expect(calls.disconnects).toEqual([[node]]);
    // Null without a source must not throw or double-disconnect.
    expect(() => rt.setSidechainInput!(null)).not.toThrow();
    expect(calls.disconnects.length).toBe(1);
    rt.dispose();
  });

  it("replacing a source disconnects the old one", () => {
    const { rt, node } = makeRt();
    const a = sourceStub();
    const b = sourceStub();
    rt.setSidechainInput!(a.node);
    rt.setSidechainInput!(b.node);
    expect(a.calls.disconnects).toEqual([[node]]);
    expect(b.calls.connects.length).toBe(1);
    rt.dispose();
  });

  it("dispose releases the sidechain source", () => {
    const { rt, node } = makeRt();
    const { node: source, calls } = sourceStub();
    rt.setSidechainInput!(source);
    rt.dispose();
    expect(calls.disconnects).toEqual([[node]]);
  });
});

describe("fxeq node gain-reduction metering", () => {
  it("exposes the worklet's gr snapshot and resets on dispose", () => {
    const { rt, port } = makeRt();
    expect(rt.getGainReductionDb?.()).toBe(0);
    port.onmessage!({ data: { type: "bandPeaks", peaks: new Float32Array(6), gr: 3.7 } });
    expect(rt.getGainReductionDb?.()).toBeCloseTo(3.7, 12);
    // Hostile gr values are contained.
    port.onmessage!({ data: { type: "bandPeaks", peaks: new Float32Array(6), gr: Number.NaN } });
    expect(rt.getGainReductionDb?.()).toBe(0);
    rt.dispose();
    expect(rt.getGainReductionDb?.()).toBe(0);
  });
});

describe("fxeq node post-dispose guards", () => {
  it("morph and history calls after dispose post nothing and never throw", () => {
    const { rt, port } = makeRt();
    rt.setMorphSnapshot!(0, { inputGainDb: 3 });
    rt.dispose();
    port.posted.length = 0;
    expect(() => {
      rt.morphToSnapshot!(0, 0.1);
      rt.morphBlendSnapshots!(0, 1, 0.5, 0.08);
      rt.undoParam!(() => {});
      rt.redoParam!(() => {});
      rt.beginParamSync!();
      rt.endParamSync!();
      rt.setSidechainInput!(null);
    }).not.toThrow();
    expect(port.posted).toEqual([]);
  });
});
