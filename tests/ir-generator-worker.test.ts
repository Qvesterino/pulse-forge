import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Side-effect import: the worker module installs `self.onmessage`.
import "../src/audio-workers/ir-generator";

/**
 * IR-generator worker input validation (canonical worker contract —
 * onset-detector.ts / warp-render.ts). `decay` is multiplied by `sampleRate`
 * into the buffer length, so an unvalidated payload is a memory bomb:
 * { decay: 1e9 } would try to allocate terabytes.
 */

type WorkerGlobal = { onmessage: ((event: MessageEvent) => void) | null };

function fire(data: unknown): void {
  const handler = (self as unknown as WorkerGlobal).onmessage;
  if (!handler) throw new Error("ir-generator did not install an onmessage handler");
  handler({ data } as MessageEvent);
}

describe("ir-generator worker input validation", () => {
  let post: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    post = vi.spyOn(self, "postMessage").mockImplementation(() => {});
  });

  afterEach(() => {
    post.mockRestore();
  });

  it("drops malformed payloads instead of allocating a giant buffer", () => {
    fire(null);
    fire("nope");
    fire({});
    fire({ decay: -5, sampleRate: 44100, seed: 1 });
    fire({ decay: 0, sampleRate: 44100, seed: 1 });
    fire({ decay: 1e9, sampleRate: 44100, seed: 1 });
    fire({ decay: Number.NaN, sampleRate: 44100, seed: 1 });
    fire({ decay: "2", sampleRate: 44100, seed: 1 });
    fire({ decay: 2, sampleRate: 0, seed: 1 });
    fire({ decay: 2, sampleRate: 44100, seed: Number.NaN });
    expect(post).not.toHaveBeenCalled();
  });

  it("generates the stereo IR for a valid payload", () => {
    fire({ decay: 0.05, sampleRate: 8_000, seed: 42 });
    expect(post).toHaveBeenCalledOnce();
    const payload = post.mock.calls[0]![0] as { left: Float32Array; right: Float32Array; length: number };
    expect(payload.length).toBe(400);
    expect(payload.left.length).toBe(400);
    expect(payload.right.length).toBe(400);
    expect(payload.left.every((value) => Number.isFinite(value))).toBe(true);
    expect(payload.right.every((value) => Number.isFinite(value))).toBe(true);
  });
});
