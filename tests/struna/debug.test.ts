import { describe, expect, it } from "vitest";
import { StrunaProcessor } from "../../src/struna/dsp/strunaProcessor";

const SR = 48000;
const BLOCK = 128;

describe("struna debug", () => {
  it("dumps the loop state", () => {
    const proc = new StrunaProcessor({ sampleRate: SR });
    proc.applyParams({ level: 0.85, decay: 4 });
    proc.postEvent({ type: "noteOn", when: 0, pitch: 45, velocity: 0.9 });
    const inner = proc as unknown as {
      voices: Array<{
        active: boolean;
        lineLen: number;
        rho: number;
        muteRho: number;
        lpCoef: number;
        line: Float32Array;
        read: number;
      }>;
    };
    const frames = 9600;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let f = 0; f < frames; f += BLOCK) proc.process(left.subarray(f, f + BLOCK), right.subarray(f, f + BLOCK), f);
    const v = inner.voices[0]!;
    let crossings = 0;
    let maxAbs = 0;
    let firstNonZero = -1;
    for (let i = 0; i < frames; i++) {
      if (Math.abs(left[i]!) > 0 && firstNonZero < 0) firstNonZero = i;
      if (i > 500 && left[i - 1]! <= 0 && left[i]! > 0) crossings += 1;
      maxAbs = Math.max(maxAbs, Math.abs(left[i]!));
    }
    console.log(
      `lineLen=${v.lineLen} rho=${v.rho.toFixed(6)} mute=${v.muteRho} lpCoef=${v.lpCoef.toFixed(3)} active=${v.active} firstNZ=${firstNonZero} crossings/s=${((crossings / (frames - 500)) * 1).toFixed(1)} max=${maxAbs.toFixed(4)}`,
    );
    console.log("line[0..8]:", [...v.line.slice(0, 8)].map((x) => x.toFixed(3)).join(","));
    expect(true).toBe(true);
  });
});
