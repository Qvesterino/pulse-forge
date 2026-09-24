import { describe, expect, it, vi, beforeEach } from "vitest";
import { createBeatManglerNode } from "../src/audio-worklets/beatmangler-node";

/**
 * GOAL-backlog A4 — the beatMangler node wrapper carries playMode/repeatFill
 * over the message port (no AudioParams exist for them). Pins: BOTH write
 * paths (immediate + scheduled) route those params to the port, and
 * AudioParams keep the scheduled safe-apply path.
 */

type ParamLike = { value: number; setValueAtTime: (v: number, t: number) => void };

function makeNodeMock() {
  const params = new Map<string, ParamLike>();
  for (const id of ["mix", "trigger", "interval", "offset", "chance", "gate"]) {
    const p: ParamLike = { value: 0, setValueAtTime: vi.fn((v: number) => (p.value = v)) };
    params.set(id, p);
  }
  const port = { postMessage: vi.fn() };
  const node = {
    parameters: { get: (id: string) => params.get(id) ?? null },
    port,
    disconnect: vi.fn(),
  };
  const gains = new Set<string>();
  const chainable = (obj: Record<string, unknown>) => {
    obj.connect = vi.fn((x: unknown) => x);
    obj.disconnect = vi.fn();
    return obj;
  };
  const ctx = {
    currentTime: 10,
    createGain: () => chainable({ gain: { value: 1 } }),
    createBiquadFilter: () => chainable({}),
  };
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      parameters = { get: (id: string) => params.get(id) ?? null };
      port = port;
      connect = vi.fn((x: unknown) => x);
      disconnect = vi.fn();
      constructor(_ctx: unknown, _name: string, _opts: unknown) {
        gains.add("constructed");
      }
    },
  );
  return { params, port, ctx, node, gains };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("beatMangler node wrapper (GOAL-backlog A4)", () => {
  it("immediate setParameter routes playMode/repeatFill over the port", () => {
    const { port, ctx } = makeNodeMock();
    const rt = createBeatManglerNode(ctx as unknown as BaseAudioContext, { params: { mix: 1 } }, 120);
    rt.setParameter!("playMode", 1);
    rt.setParameter!("repeatFill", 3);
    const modeMsgs = port.postMessage.mock.calls.filter((c) => c[0]?.type === "mode");
    expect(modeMsgs.length).toBeGreaterThanOrEqual(2);
    expect(modeMsgs.at(-1)![0]).toEqual({ type: "mode", playMode: 1, repeatFill: 3 });
  });

  it("scheduled setParameterAt no longer drops port-only params (A4 pin)", () => {
    const { port, ctx } = makeNodeMock();
    const rt = createBeatManglerNode(ctx as unknown as BaseAudioContext, { params: { mix: 1 } }, 120);
    rt.setParameterAt!("playMode", 2, 12.5);
    rt.setParameterAt!("repeatFill", 5, 12.5);
    const modeMsgs = port.postMessage.mock.calls.filter((c) => c[0]?.type === "mode");
    expect(modeMsgs.length).toBeGreaterThanOrEqual(2);
    expect(modeMsgs.at(-1)![0]).toEqual({ type: "mode", playMode: 2, repeatFill: 5 });
  });

  it("AudioParams keep the scheduled safe-apply path", () => {
    const { params, ctx } = makeNodeMock();
    const rt = createBeatManglerNode(ctx as unknown as BaseAudioContext, { params: { mix: 1 } }, 120);
    rt.setParameterAt!("mix", 0.5, 11);
    expect(params.get("mix")!.value).toBe(0.5);
    expect(params.get("mix")!.setValueAtTime).toHaveBeenCalledWith(0.5, 11);
  });
});
