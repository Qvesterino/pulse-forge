import { describe, expect, it } from "vitest";
import { StrunaProcessor } from "../../src/struna/dsp/strunaProcessor";

const SR = 48000;
const BLOCK = 128;

describe("struna debug 2", () => {
  it("dumps the early waveform", () => {
    const proc = new StrunaProcessor({ sampleRate: SR });
    proc.applyParams({ level: 0.85, decay: 4 });
    proc.postEvent({ type: "noteOn", when: 0, pitch: 45, velocity: 0.9 });
    const frames = Math.floor(0.1 * SR);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let f = 0; f < frames; f += BLOCK) proc.process(left.subarray(f, f + BLOCK), right.subarray(f, f + BLOCK), f);
    let crossings = 0;
    for (let i = 1; i < frames; i++) if (left[i - 1]! <= 0 && left[i]! > 0) crossings += 1;
    console.log("crossings/s:", (crossings / 0.1).toFixed(1));
    console.log("samples 0..20:", [...left.slice(0, 20)].map((v) => v.toFixed(3)).join(","));
    console.log("samples 100..120:", [...left.slice(100, 120)].map((v) => v.toFixed(3)).join(","));
    console.log("samples 400..420:", [...left.slice(400, 420)].map((v) => v.toFixed(3)).join(","));
    expect(true).toBe(true);
  });
});
