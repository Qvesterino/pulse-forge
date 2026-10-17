import { describe, expect, it } from "vitest";
import { TsarProcessor } from "../../src/tsar/dsp/tsarProcessor";

describe("grain bus probe", () => {
  it("locates the peak", () => {
    const SR = 48000, BLOCK = 128;
    const pcm = new Float32Array(SR);
    let lcg = 1234567;
    for (let i = 0; i < pcm.length; i++) { lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0; pcm[i] = (lcg / 0x80000000 - 1) * 0.9; }
    const proc = new TsarProcessor({ sampleRate: SR });
    proc.applyParams({ level: 0.8, srcALevel: 0.9, srcAEngine: 2, srcAGrainJitter: 1, srcAGrainDensity: 32, srcAGrainSize: 120 });
    proc.setSample(0, pcm, 261.63);
    proc.postEvent({ type: "noteOn", when: 0, pitch: 60, velocity: 0.9 });
    const proto = TsarProcessor.prototype as unknown as { grainSample: (...a: unknown[]) => number };
    const orig = proto.grainSample;
    let grainMax = 0, grainCalls = 0;
    proto.grainSample = function (...args: unknown[]) {
      const v = orig.apply(this, args);
      grainMax = Math.max(grainMax, Math.abs(v as number));
      grainCalls += 1;
      return v;
    };
    let outMax = 0, outIdx = 0;
    const frames = SR;
    const left = new Float32Array(frames);
    for (let f = 0; f < frames; f += BLOCK) {
      proc.process(left.subarray(f, f + BLOCK), new Float32Array(BLOCK), f);
    }
    for (let i = 0; i < left.length; i++) if (Math.abs(left[i]!) > outMax) { outMax = Math.abs(left[i]!); outIdx = i; }
    console.log("grainMax:", grainMax.toFixed(3), "calls:", grainCalls, "outMax:", outMax.toFixed(3), "at", outIdx, "out[0..4]:", [...left.slice(0, 5)].map((v) => v.toFixed(3)).join(","));
    expect(grainCalls).toBeGreaterThan(0);
  });
});
