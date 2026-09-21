import { describe, expect, it } from "vitest";
import { createSafetyLimiter } from "../src/effects/ozvena-core/modules/safetyLimiter.js";

const SR = 48000;
const BLOCK = 128;

describe("limiter switch debug", () => {
  it("dumps signal around factor switch", () => {
    const lim = createSafetyLimiter();
    lim.prepare(SR, 2, BLOCK, 2);
    console.log("latency factor2:", lim.getLatencySamples());
    const blocks = 40;
    const out: number[] = [];
    let prev = 0;
    let maxStep = 0;
    let maxStepAt = -1;
    for (let b = 0; b < blocks; b++) {
      if (b === 20) lim.setOversampleFactor(4);
      if (b === 20) console.log("latency factor4:", lim.getLatencySamples());
      const inL = new Float32Array(BLOCK);
      const inR = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        const s = b * BLOCK + i;
        inL[i] = 0.4 * Math.sin((2 * Math.PI * 200 * s) / SR);
        inR[i] = inL[i];
      }
      lim.process([inL, inR], BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        const step = Math.abs(inL[i] - prev);
        if (step > maxStep) {
          maxStep = step;
          maxStepAt = b * BLOCK + i;
        }
        prev = inL[i];
        if (b * BLOCK + i >= 20 * BLOCK - 4 && b * BLOCK + i <= 20 * BLOCK + 140) {
          out.push(inL[i]);
        }
      }
    }
    console.log("maxStep:", maxStep.toFixed(5), "at sample", maxStepAt);
    console.log(
      "window:",
      out
        .slice(0, 150)
        .map((v) => v.toFixed(4))
        .join(" "),
    );
    expect(true).toBe(true);
  });
});
