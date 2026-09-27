import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMultitapNode, multitapDelaySec } from "../src/audio-worklets/multitap-node";

/**
 * Phase 1 (docs/PLUGIN-AUDIT-FOLLOWUP-ROADMAP.md) — the multi-tap delay moved
 * from a native DelayNode feedback cycle into the multitap worklet processor.
 * The wrapper owns the musical mapping: rack divisions (t1Div..t4Div) + BPM
 * become absolute seconds (t1Time..t4Time) on the audio thread. These pins
 * hold that contract on BOTH write paths (immediate + scheduled) and through
 * tempo changes.
 */

const DIRECT_IDS = ["mix", "feedback", "tone", "spread", "taps"] as const;
const TIME_IDS = ["t1Time", "t2Time", "t3Time", "t4Time"] as const;

type ParamLike = { value: number; setValueAtTime: (v: number, t: number) => void };

function makeNodeMock() {
  const params = new Map<string, ParamLike>();
  for (const id of [...DIRECT_IDS, ...TIME_IDS]) {
    const p: ParamLike = { value: -1, setValueAtTime: vi.fn((v: number) => (p.value = v)) };
    params.set(id, p);
  }
  const chainable = (obj: Record<string, unknown>) => {
    obj.connect = vi.fn((x: unknown) => x);
    obj.disconnect = vi.fn();
    return obj;
  };
  const ctx = {
    currentTime: 10,
    createGain: () => chainable({ gain: { value: 1 } }),
  };
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      parameters = { get: (id: string) => params.get(id) ?? null };
      connect = vi.fn((x: unknown) => x);
      disconnect = vi.fn();
    },
  );
  return { params, ctx };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("multitapDelaySec", () => {
  it("divisions are beats, not bars — 1/4 at 120 BPM is half a second", () => {
    expect(multitapDelaySec(2, 120)).toBeCloseTo(0.5, 6);
    expect(multitapDelaySec(0, 120)).toBeCloseTo(1.0, 6); // 1/2 note = 2 beats
    expect(multitapDelaySec(4, 120)).toBeCloseTo(0.25, 6); // 1/8
  });

  it("clamps out-of-range division indices and floors near-zero times", () => {
    expect(multitapDelaySec(-5, 120)).toBe(multitapDelaySec(0, 120));
    expect(multitapDelaySec(99, 120)).toBe(multitapDelaySec(7, 120));
    expect(multitapDelaySec(0, 300)).toBeGreaterThanOrEqual(0.02);
  });
});

describe("multitap node wrapper (Phase 1)", () => {
  it("maps rack divisions to tap-time seconds at construction", () => {
    const { params, ctx } = makeNodeMock();
    createMultitapNode(ctx as unknown as BaseAudioContext, { params: { t1Div: 4, t2Div: 6, t3Div: 2, t4Div: 0 } }, 124);
    expect(params.get("t1Time")!.value).toBeCloseTo(multitapDelaySec(4, 124), 6);
    expect(params.get("t4Time")!.value).toBeCloseTo(multitapDelaySec(0, 124), 6);
  });

  it("routes division writes through the seconds mapping on both write paths", () => {
    const { params, ctx } = makeNodeMock();
    const rt = createMultitapNode(ctx as unknown as BaseAudioContext, { params: {} }, 124);
    rt.setParameter!("t2Div", 0);
    expect(params.get("t2Time")!.value).toBeCloseTo(multitapDelaySec(0, 124), 6);
    rt.setParameterAt!("t2Div", 4, 12.5);
    expect(params.get("t2Time")!.setValueAtTime).toHaveBeenCalledWith(multitapDelaySec(4, 124), 12.5);
  });

  it("direct params pass through untouched, unknown ids are dropped", () => {
    const { params, ctx } = makeNodeMock();
    const rt = createMultitapNode(ctx as unknown as BaseAudioContext, { params: {} }, 124);
    rt.setParameter!("feedback", 0.85);
    expect(params.get("feedback")!.value).toBe(0.85);
    expect(() => rt.setParameter!("nonsense", 1)).not.toThrow();
    expect(params.get("mix")!.value).toBe(-1);
  });

  it("syncBpm re-derives every tap time from the CURRENT divisions", () => {
    const { params, ctx } = makeNodeMock();
    const rt = createMultitapNode(ctx as unknown as BaseAudioContext, { params: { t1Div: 4 } }, 124);
    rt.setParameter!("t1Div", 2); // 1 beat at 124 → ~0.484 s
    const before = params.get("t1Time")!.value;
    rt.syncBpm?.(160, 7); // 1 beat at 160 → 0.375 s, scheduled at t=7
    expect(before).toBeCloseTo(multitapDelaySec(2, 124), 6);
    expect(params.get("t1Time")!.setValueAtTime).toHaveBeenCalledWith(multitapDelaySec(2, 160), 7);
    expect(params.get("t4Time")!.setValueAtTime).toHaveBeenCalledWith(multitapDelaySec(0, 160), 7);
  });

  it("exposes only direct AudioParams on the modulation bus", () => {
    const { ctx } = makeNodeMock();
    const rt = createMultitapNode(ctx as unknown as BaseAudioContext, { params: {} }, 124);
    expect(rt.getAudioParam?.("mix")).not.toBeNull();
    expect(rt.getAudioParam?.("t1Div")).toBeNull();
  });

  it("disposes without throwing", () => {
    const { ctx } = makeNodeMock();
    const rt = createMultitapNode(ctx as unknown as BaseAudioContext, { params: {} }, 124);
    expect(() => rt.dispose()).not.toThrow();
  });
});
