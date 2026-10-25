import { describe, expect, it } from "vitest";
import { StrunaProcessor } from "../../src/struna/dsp/strunaProcessor";

const SR = 48000;
const BLOCK = 128;

describe("struna debug 3", () => {
  it("dumps crossing intervals", () => {
    const proc = new StrunaProcessor({ sampleRate: SR });
    proc.applyParams({ level: 0.85, decay: 4 });
    proc.postEvent({ type: "noteOn", when: 0, pitch: 45, velocity: 0.9 });
    const frames = Math.floor(0.1 * SR);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let f = 0; f < frames; f += BLOCK) proc.process(left.subarray(f, f + BLOCK), right.subarray(f, f + BLOCK), f);
    const intervals: number[] = [];
    let last = -1;
    for (let i = 1; i < frames; i++) {
      if (left[i - 1]! <= 0 && left[i]! > 0) {
        if (last >= 0) intervals.push(i - last);
        last = i;
      }
    }
    console.log("crossings:", crossings(0), "intervals[0..12]:", intervals.slice(0, 12).join(","));
    console.log("left[0..12]:", [...left.slice(0, 13)].map((v) => v.toFixed(2)).join(","));
    function crossings(from: number): number {
      let c = 0;
      for (let i = from + 1; i < frames; i++) if (left[i - 1]! <= 0 && left[i]! > 0) c += 1;
      return c;
    }
    expect(true).toBe(true);
  });
});
