import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Audit 12 (Audio Engine) — regression pins.
 *
 * Source-level pins (the worklets cannot run outside an AudioWorkletGlobalScope):
 *  1. Denormal flush-to-zero guards on the per-sample states that decay in
 *     silence (one-poles, allpass cascades, DC blockers) — a state parked in
 *     the subnormal range stalls the per-sample arithmetic for as long as the
 *     quiet tail lasts.
 *  2. Full-ring denormal sweeps on feedback ring buffers (once per wrap).
 *  3. Warp caches cleared on bare context swaps (stale AudioBuffers from the
 *     old context would play off-pitch after a sample-rate change).
 */

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("audit 12 — denormal flush guards (worklet processors)", () => {
  it("freqshifter flushes the allpass cascade and tone LP states", () => {
    const src = read("src/audio-worklets/freqshifter-processor.js");
    expect(src).toContain("if (yPrev > -1e-20 && yPrev < 1e-20) yPrev = 0;");
    expect(src).toContain("if (this.toneLpL > -1e-20 && this.toneLpL < 1e-20) this.toneLpL = 0;");
    expect(src).toContain("if (this.toneLpR > -1e-20 && this.toneLpR < 1e-20) this.toneLpR = 0;");
  });

  it("vinyl flushes the year/tone chains and pop/crackle envelopes", () => {
    const src = read("src/audio-worklets/vinyl-processor.js");
    expect(src).toContain("if (this.yearLpState[0] > -1e-20 && this.yearLpState[0] < 1e-20)");
    expect(src).toContain("if (this.toneHpState[1] > -1e-20 && this.toneHpState[1] < 1e-20)");
    expect(src).toContain("if (this.popEnvL < 1e-20) this.popEnvL = 0;");
    expect(src).toContain("if (this.crackleLpState[0] > -1e-20 && this.crackleLpState[0] < 1e-20)");
  });

  it("vocoder flushes the 32 biquad y-states and the sibilance chain", () => {
    const src = read("src/audio-worklets/vocoder-processor.js");
    expect(src).toContain("s.y1 = y > -1e-20 && y < 1e-20 ? 0 : y;");
    expect(src).toContain("if (this.sibLp[0] > -1e-20 && this.sibLp[0] < 1e-20)");
  });

  it("granularfreeze and reverseswell flush their wet tone LPs", () => {
    for (const file of [
      "src/audio-worklets/granularfreeze-processor.js",
      "src/audio-worklets/reverseswell-processor.js",
    ]) {
      const src = read(file);
      expect(src).toContain("if (this.toneLpL > -1e-20 && this.toneLpL < 1e-20) this.toneLpL = 0;");
      expect(src).toContain("if (this.toneLpR > -1e-20 && this.toneLpR < 1e-20) this.toneLpR = 0;");
    }
  });

  it("kaskada flushes the DC blocker (slowest decay in the fleet) and character LPs", () => {
    const src = read("src/audio-worklets/kaskada-processor.js");
    expect(src).toContain("if (this.dcyL > -1e-20 && this.dcyL < 1e-20) this.dcyL = 0;");
    expect(src).toContain("if (this.dcyR > -1e-20 && this.dcyR < 1e-20) this.dcyR = 0;");
    expect(src).toContain("if (this.charLpz > -1e-20 && this.charLpz < 1e-20) this.charLpz = 0;");
  });

  it("feedback ring buffers sweep the whole ring once per wrap", () => {
    // The per-block flush only covers the write slot; feedback (≤0.9) parks
    // every other slot in the subnormal range where the cubic read stalls.
    const stock = read("src/audio-worklets/stock-delay-processor.js");
    expect(stock).toContain("if (this.writeIdx === 0) {");
    expect(stock).toContain("for (let i = 0; i < STOCK_DELAY_RING; i++)");
    const chorus = read("src/audio-worklets/chorus-processor.js");
    expect(chorus).toContain("Full-ring sweep once per wrap");
    expect(chorus).toContain("for (const buf of this.bufs) {");
    const flanger = read("src/audio-worklets/flanger-processor.js");
    expect(flanger).toContain("if (this.writeIdx === 0) {");
  });
});

describe("audit 12 — engine lifecycle (context swap hygiene)", () => {
  it("useContext clears the warp caches along with the other buffer caches", () => {
    // warpCache holds context-era AudioBuffers and rate-dependent pre-renders:
    // after a device change a stale entry would play off-pitch. setProject
    // clears them too, but a bare context swap never runs setProject.
    const engine = read("src/audio-engine/AudioEngine.ts");
    const ctxSwap = engine.slice(
      engine.indexOf("useContext(ctx: BaseAudioContext): void"),
      engine.indexOf("useContext(ctx: BaseAudioContext): void") + 16_000,
    );
    expect(ctxSwap).toContain("this.warpCache.clear();");
    expect(ctxSwap).toContain("this.warpInflight.clear();");
    expect(ctxSwap).toContain("this.warpEpoch++;");
  });
});
