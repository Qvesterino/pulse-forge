import { describe, expect, it } from "vitest";
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
});
