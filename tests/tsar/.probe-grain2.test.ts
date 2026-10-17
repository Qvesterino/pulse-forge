import { describe, expect, it } from "vitest";
import { TsarProcessor } from "../../src/tsar/dsp/tsarProcessor";

describe("grain bus probe 2", () => {
  it("bisects the gain", () => {
    const SR = 48000, BLOCK = 128;
    const pcm = new Float32Array(SR);
    let lcg = 1234567;
    for (let i = 0; i < pcm.length; i++) { lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0; pcm[i] = (lcg / 0x80000000 - 1) * 0.9; }
    const proc = new TsarProcessor({ sampleRate: SR });
    for (const cutoff of [18000, 12000, 8000, 5000]) {
      proc.applyParams({ level: 0.8, srcALevel: 0.9, srcAEngine: 2, srcAGrainJitter: 1, srcAGrainDensity: 32, srcAGrainSize: 120, srcACutoff: cutoff });
      // reset voice state per cutoff
      (proc as unknown as { applyEvent: (e: unknown) => void }).applyEvent({ type: "panic", when: 0 });
      proc.postEvent({ type: "noteOn", when: 0, pitch: 60, velocity: 0.9 });
    proc.setSample(0, pcm, 261.63);
    proc.postEvent({ type: "noteOn", when: 0, pitch: 60, velocity: 0.9 });
    const proto = TsarProcessor.prototype as unknown as Record<string, (...a: unknown[]) => number>;
    const origSvf = proto.runSvf;
    let svfMax = 0, svfInMax = 0;
    proto.runSvf = function (input: number, ...rest: unknown[]) {
      svfInMax = Math.max(svfInMax, Math.abs(input));
      const out = origSvf.call(this, input, ...rest);
      svfMax = Math.max(svfMax, Math.abs(out as number));
      return out;
    };
    const origSource = proto.sourceSample;
    let srcMax = 0;
    proto.sourceSample = function (...a: unknown[]) {
      const v = origSource.apply(this, a);
      srcMax = Math.max(srcMax, Math.abs(v as number));
      return v;
    };
    const left = new Float32Array(SR);
    for (let f = 0; f < SR; f += BLOCK) proc.process(left.subarray(f, f + BLOCK), new Float32Array(BLOCK), f);
    let outMax = 0;
    for (const v of left) outMax = Math.max(outMax, Math.abs(v));
    console.log(`cutoff ${cutoff}: srcMax ${srcMax.toFixed(3)} svfInMax ${svfInMax.toFixed(3)} svfMax ${svfMax.toFixed(3)} outMax ${outMax.toFixed(3)}`);
      svfMax = 0; svfInMax = 0; srcMax = 0;
    }
    expect(srcMax).toBeGreaterThanOrEqual(0);
  });
});
