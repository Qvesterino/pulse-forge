import { describe, expect, it } from "vitest";
import { createOversampledSaturation } from "../src/effects/fxeq-core/dsp/oversampledSaturation.js";

function runFactor(quality: "standard" | "high" | "render", mode: number, driveDb: number): number {
  const sr = 48000;
  const block = 256;
  const os = createOversampledSaturation();
  os.prepare(sr, 1, block);
  const freq = 997;
  const amp = 1e-4;
  let peak = 0;
  for (let b = 0; b < 40; b++) {
    const buf = new Float32Array(block);
    for (let i = 0; i < block; i++) {
      const t = (b * block + i) / sr;
      buf[i] = amp * Math.sin(2 * Math.PI * freq * t);
    }
    os.process([buf], block, mode, driveDb, 1, 1, quality);
    if (b > 30) {
      for (let i = 0; i < block; i++) peak = Math.max(peak, Math.abs(buf[i]));
    }
  }
  return 20 * Math.log10(peak / amp);
}

describe("probe", () => {
  it("gain across oversampling factors", () => {
    console.log("factor1 (drive 5.9 standard):", runFactor("standard", 4, 5.9).toFixed(2));
    console.log("factor2 (drive 6.1 standard):", runFactor("standard", 4, 6.1).toFixed(2));
    console.log("factor4 (drive 12.1 high):", runFactor("high", 4, 12.1).toFixed(2));
    console.log("factor8 (drive 6.1 render):", runFactor("render", 4, 6.1).toFixed(2));
    expect(true).toBe(true);
  });
});
