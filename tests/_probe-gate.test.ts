import { describe, expect, it } from "vitest";
import { UltinaProcessor } from "../src/effects/ultina-core/dsp/ultinaProcessor.js";
import { registerCoreModules } from "../src/effects/ultina-core/dsp/moduleFactories.js";

const SR = 48000;
const BLOCK = 128;

function makeProcessor(): UltinaProcessor {
  const proc = new UltinaProcessor();
  registerCoreModules(proc);
  proc.prepare(SR, 2, BLOCK);
  return proc;
}
function enableInGraph(proc: UltinaProcessor, moduleType: string): void {
  proc.getGraphRuntime().setModuleEnabled(moduleType as never, true);
  proc.setParameter(`${moduleType}.enabled`, 1);
}
function sine(chans: Float32Array[], blockIndex: number, freq: number, amp: number): void {
  for (let i = 0; i < BLOCK; i++) {
    const t = (blockIndex * BLOCK + i) / SR;
    const v = amp * Math.sin(2 * Math.PI * freq * t);
    chans[0][i] = v;
    chans[1][i] = v;
  }
}

describe("gate probe", () => {
  it("single-band hysteresis: states over a decaying tone", () => {
    for (const h of [0, 24]) {
      const proc = makeProcessor();
      enableInGraph(proc, "gate");
      proc.setParameters({
        "gate.hysteresisDb": h,
        "gate.rangeDb": -20,
        "gate.attackMs": 1,
        "gate.holdMs": 0,
        "gate.releaseMs": 5,
        "gate.mix": 100,
        "gate.bandCount": 1,
        "gate.band0.openThresholdDb": -40,
      });
      const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      const states: number[] = [];
      for (let b = 0; b < 80; b++) {
        const amp = 0.03 * Math.exp(-b * 0.08);
        sine(chans, b, 440, amp);
        proc.process(chans, BLOCK);
        const m = proc.getMeters().modules.gate as { bandState: number[] };
        states.push(m.bandState[0]);
      }
      console.log(`hyst=${h}:`, states.join(","));
    }
    expect(true).toBe(true);
  });

  it("multiband: states with different per-band close thresholds", () => {
    const proc = makeProcessor();
    enableInGraph(proc, "gate");
    proc.setParameters({
      "gate.hysteresisDb": 24,
      "gate.rangeDb": -20,
      "gate.attackMs": 1,
      "gate.holdMs": 0,
      "gate.releaseMs": 5,
      "gate.mix": 100,
      "gate.bandCount": 2,
      "gate.band0.openThresholdDb": -40,
      "gate.band0.closeThresholdDb": -60,
      "gate.band1.openThresholdDb": -40,
      "gate.band1.closeThresholdDb": -40,
    });
    const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    const b0: number[] = [];
    const b1: number[] = [];
    for (let b = 0; b < 80; b++) {
      const amp = 0.03 * Math.exp(-b * 0.08);
      sine(chans, b, 440, amp);
      proc.process(chans, BLOCK);
      const m = proc.getMeters().modules.gate as { bandState: number[] };
      b0.push(m.bandState[0]);
      b1.push(m.bandState[1]);
    }
    console.log("multiband band0:", b0.join(","));
    console.log("multiband band1:", b1.join(","));
    expect(true).toBe(true);
  });
});
