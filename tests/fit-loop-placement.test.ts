import { describe, it, expect } from "vitest";
import { fittedLoopPlacement } from "../src/commands/commands";

describe("fittedLoopPlacement (drop loop → fit offer)", () => {
  it("derives whole bars from duration + detected tempo", () => {
    // 128 BPM loop, 3.75 s = 8 beats = 2 bars of 4/4.
    expect(fittedLoopPlacement(3.75, 128, 124)).toEqual({ lengthBars: 2, rate: 1.03 });
    // 1-bar 140 BPM loop at project 140 = 1 bar, rate 1.
    expect(fittedLoopPlacement(60 / 140, 140, 140, 4)).toEqual({ lengthBars: 1, rate: 1 });
  });

  it("rate follows fitAudioClipTempo (detected/project, 0.25–4 gate)", () => {
    expect(fittedLoopPlacement(2, 100, 124)?.rate).toBeCloseTo(0.81, 2);
    expect(fittedLoopPlacement(2, 40, 200)?.rate).toBe(0.25);
    expect(fittedLoopPlacement(2, 240, 60)?.rate).toBe(4);
  });

  it("rounds to whole bars, minimum 1", () => {
    expect(fittedLoopPlacement(0.2, 120, 120)?.lengthBars).toBe(1);
    expect(fittedLoopPlacement(7.9, 120, 120)?.lengthBars).toBe(4);
  });

  it("returns null for missing detection or bad numbers", () => {
    expect(fittedLoopPlacement(3.75, undefined, 124)).toBeNull();
    expect(fittedLoopPlacement(3.75, 30, 124)).toBeNull();
    expect(fittedLoopPlacement(3.75, 300, 124)).toBeNull();
    expect(fittedLoopPlacement(0, 128, 124)).toBeNull();
    expect(fittedLoopPlacement(3.75, 128, 0)).toBeNull();
    expect(fittedLoopPlacement(3.75, 128, 124, 0)).toBeNull();
  });
});
