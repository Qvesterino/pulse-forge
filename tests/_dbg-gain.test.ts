import { describe, it } from "vitest";
import { createFxEqProcessor } from "../src/effects/fxeq-core/core/fxEqProcessor";

const SR = 48000;
const BLOCK = 128;
function tone(freq: number, blocks: number, amp: number, startBlock = 0): Float32Array {
  const out = new Float32Array(blocks * BLOCK);
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * (startBlock * BLOCK + i)) / SR) * amp;
  return out;
}
function run(proc: any, buf: Float32Array): void {
  for (let off = 0; off < buf.length; off += BLOCK) {
    proc.process([buf.subarray(off, off + BLOCK), Float32Array.from(buf.subarray(off, off + BLOCK))], BLOCK);
  }
}

describe("dbg gain", () => {
  it("band gain target trajectory", () => {
    const mod = createFxEqProcessor();
    mod.prepare(SR, 2, BLOCK);
    mod.loadParameters({
      bandCount: 6,
      "band1.envModTarget": 9,
      "band1.envModDepth": 100,
      limiterEnabled: 0,
      globalMix: 100,
    });
    console.log(
      "[dbgG] target:",
      mod.getParameter("band1.envModTarget"),
      "depth:",
      mod.getParameter("band1.envModDepth"),
    );
    run(mod, tone(80, 20, 0.9));
    const out = tone(80, 10, 0.9);
    for (let off = 0; off < out.length; off += BLOCK) {
      const view = [out.subarray(off, off + BLOCK), Float32Array.from(out.subarray(off, off + BLOCK))];
      mod.process(view as any, BLOCK);
      let sum = 0;
      for (let i = 0; i < BLOCK; i++) sum += view[0][i] * view[0][i];
      const rms = Math.sqrt(sum / BLOCK);
      console.log(
        `[dbgG] blk ${off / BLOCK}: rms=${rms.toFixed(3)} peaks=`,
        Array.from(mod.getBandPeaks(), (p) => p.toFixed(2)).join(","),
      );
    }
  });
});
