import { describe, expect, it, vi } from "vitest";
import { renderWarpPreserveAsync } from "../src/audio-workers/warp-render-client";

const SR = 44100;

function makeSine(freq: number, seconds: number): Float32Array {
  const n = Math.floor(SR * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.7 * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

describe("renderWarpPreserveAsync", () => {
  it("renders stereo warp without a Worker (sync fallback, deterministic core)", async () => {
    const out = await renderWarpPreserveAsync(
      [makeSine(220, 0.5), makeSine(330, 0.5)],
      SR,
      [{ startSec: 0, endSec: 1, rate: 1.2 }],
      Math.round(SR * 0.6),
    );
    expect(out).toHaveLength(2);
    for (const ch of out) {
      expect(ch.length).toBe(Math.round(SR * 0.6));
      expect(ch.every((v) => Number.isFinite(v))).toBe(true);
    }
    // Channels stay distinct (no mono fold-down in the worker path).
    let diff = 0;
    for (let i = 0; i < out[0].length; i++) diff += Math.abs(out[0][i] - out[1][i]);
    expect(diff).toBeGreaterThan(0);
  });

  it("an aborted signal resolves empty without rendering", async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await renderWarpPreserveAsync([makeSine(220, 0.5)], SR, [], 100, controller.signal);
    expect(out).toEqual([]);
  });

  it("rejects (freeing warpManager's in-flight claim) when the worker never replies", async () => {
    // The phase vocoder is the expensive path: if a pathological input hung the
    // worker, running the identical core on the main thread would freeze the UI
    // outright. The watchdog rejects instead, so warpManager's `.catch` releases
    // the claimed cache key and the clip degrades to repitch.
    vi.useFakeTimers();
    const terminate = vi.fn();
    class HangingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      terminate = terminate;
      postMessage() {}
    }
    vi.stubGlobal("Worker", HangingWorker);
    try {
      const pending = renderWarpPreserveAsync(
        [makeSine(220, 1), makeSine(330, 1)],
        SR,
        [{ startSec: 0, endSec: 1, rate: 1.2 }],
        Math.round(SR * 1.2),
      );
      const rejection = expect(pending).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(120_000 + 1);
      await rejection;
      expect(terminate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
