import { describe, expect, it } from "vitest";
import { createFxEqProcessor } from "../src/effects/fxeq-core/core/fxEqProcessor";

describe("PRISM constructor bandCount", () => {
  it("honours a constructor bandCount for the crossover and bands", () => {
    const p2 = createFxEqProcessor({ bandCount: 2 });
    p2.prepare(48000, 1, 128);
    expect(p2.getParameter("bandCount")).toBe(2);
    expect(p2.getBandPeaks().length).toBe(2);

    const p4 = createFxEqProcessor({ bandCount: 4 });
    p4.prepare(48000, 1, 128);
    expect(p4.getParameter("bandCount")).toBe(4);
    expect(p4.getBandPeaks().length).toBe(4);

    const p6 = createFxEqProcessor();
    p6.prepare(48000, 1, 128);
    expect(p6.getParameter("bandCount")).toBe(6);
    expect(p6.getBandPeaks().length).toBe(6);
  });

  it("a 2-band document actually renders 2 bands (band 2 low-passed, band 1 flat)", () => {
    // Band 2 covers everything above crossoverFreq2; gain -24 dB must kill
    // the 5 kHz content. With the pre-fix default-6 layout the 5 kHz tone
    // sat in a different band and passed flat.
    const render = (params: Record<string, number>) => {
      const proc = createFxEqProcessor({ ...params, bandCount: 2, crossoverFreq2: 400, limiterEnabled: 0 });
      proc.prepare(48000, 1, 256);
      const blocks = 20;
      const out: number[] = [];
      for (let b = 0; b < blocks; b++) {
        const buf = new Float32Array(256);
        for (let i = 0; i < 256; i++) {
          buf[i] = 0.3 * Math.sin((2 * Math.PI * 5000 * (b * 256 + i)) / 48000);
        }
        proc.process([buf], 256);
        for (let i = 0; i < 256; i++) out.push(buf[i]);
      }
      let peak = 0;
      for (let i = out.length - 512; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
      return 20 * Math.log10(peak / 0.3);
    };
    const flat = render({ "band2.gainDb": 0 });
    const cut = render({ "band2.gainDb": -24 });
    console.log("flat:", flat.toFixed(2), "cut:", cut.toFixed(2));
    expect(flat).toBeGreaterThan(-1);
    expect(cut).toBeLessThan(-15);
  });
});
