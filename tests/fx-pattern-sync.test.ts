import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStepGateNode } from "../src/audio-worklets/stepgate-node";
import { createStutterNode } from "../src/audio-worklets/stutter-node";

/**
 * FX pattern-sync contract (audio-engine audit 12 follow-up).
 *
 * `stepGate` and `stutter` read their gate pattern from `EffectInstance.steps`.
 * The constructors copy the pattern once, and the runtime's `setPattern` is
 * the ONLY path that pushes edits. The effect factory used to snapshot the
 * pattern at construction and expose no `setPattern`, and the engine never
 * forwarded `fx.steps` on sync — so a pattern edit (or its undo) was audible
 * only until the first chain rebuild, then silently reverted to the old
 * pattern. This pins the reference-compare `setPattern` contract that makes
 * edits stick while keeping unchanged patterns off the audio thread.
 *
 * The fakes model the real contract: a `MessagePort` that records posts, and
 * an `AudioWorkletNode` whose `parameters.get` returns null for unknown ids.
 */

interface FakePort {
  posted: Array<Record<string, unknown>>;
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(msg: Record<string, unknown>): void;
}

class FakeAudioWorkletNode {
  port: FakePort;
  parameters = { get: (_id: string) => null };
  constructor(_ctx: unknown, _name: string, _opts: unknown) {
    this.port = {
      posted: [],
      onmessage: null,
      postMessage(msg) {
        this.posted.push(msg);
      },
    };
  }
  connect(): this {
    return this;
  }
  disconnect(): void {}
}

function fakeCtx(): BaseAudioContext {
  const chainable = {
    gain: { value: 1 },
    connect(x: unknown) {
      return x;
    },
    disconnect() {},
  };
  return { currentTime: 0, createGain: () => chainable } as unknown as BaseAudioContext;
}

const patternPosts = (node: FakeAudioWorkletNode) =>
  node.port.posted.filter((m) => m.type === "pattern").map((m) => m.steps);

let lastNode: FakeAudioWorkletNode | null = null;

beforeEach(() => {
  lastNode = null;
  vi.stubGlobal(
    "AudioWorkletNode",
    class extends FakeAudioWorkletNode {
      constructor(ctx: unknown, name: string, opts: unknown) {
        super(ctx, name, opts);
        lastNode = this;
      }
    },
  );
});

describe("stepGate pattern sync", () => {
  it("pushes the construction pattern once, and edits through setPattern", () => {
    const rt = createStepGateNode(fakeCtx(), { params: {}, steps: [1, 0, 1, 0] });
    const node = lastNode!;
    const a = [1, 0, 0, 1];
    rt.setPattern(a);
    rt.setPattern(a); // same reference — ignored
    rt.setPattern([0, 1, 0, 1]);
    expect(patternPosts(node)).toEqual([[1, 0, 1, 0], [1, 0, 0, 1], [0, 1, 0, 1]]);
  });

  it("a patternless construction posts nothing until setPattern arrives", () => {
    const rt = createStepGateNode(fakeCtx(), { params: {} });
    const node = lastNode!;
    expect(patternPosts(node)).toEqual([]);
    rt.setPattern([1, 1, 1, 1]);
    expect(patternPosts(node)).toEqual([[1, 1, 1, 1]]);
  });
});

describe("stutter pattern sync", () => {
  it("pushes the construction pattern once, and edits through setPattern", () => {
    const rt = createStutterNode(fakeCtx(), { params: {}, steps: [1, 1, 1, 1] });
    const node = lastNode!;
    const a = [0.2, 0.4, 0.6, 0.8];
    rt.setPattern(a);
    rt.setPattern(a); // same reference — ignored
    expect(patternPosts(node)).toEqual([[1, 1, 1, 1], [0.2, 0.4, 0.6, 0.8]]);
  });
});
