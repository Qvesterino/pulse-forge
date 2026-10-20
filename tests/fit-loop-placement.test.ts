import { describe, it, expect } from "vitest";
import { fittedLoopPlacement } from "../src/commands/commands";
import { BAR_TICKS } from "../src/project-model/types";

/** 6/8 — a compound bar of three quarter notes. */
const SIX_EIGHT_BAR_TICKS = 1440;

describe("fittedLoopPlacement (drop loop → fit offer)", () => {
  it("derives whole bars from duration + detected tempo", () => {
    // 128 BPM loop, 3.75 s = 8 beats = 2 bars of 4/4.
    expect(fittedLoopPlacement(3.75, 128, 124, BAR_TICKS)).toEqual({ lengthBars: 2, rate: 1.03 });
    // 1-bar 140 BPM loop at project 140 = 1 bar, rate 1.
    expect(fittedLoopPlacement(60 / 140, 140, 140, BAR_TICKS)).toEqual({ lengthBars: 1, rate: 1 });
  });

  it("measures the bar in TICKS, so a 6/8 bar is three quarter notes (ADR 0056)", () => {
    // The same 3.75 s loop at 128 BPM is 8 quarter notes = 3840 ticks:
    //   4/4 → 2 bars (4 quarter notes each)
    //   6/8 → 3 bars (3 quarter notes each)
    // The parameter used to be a BEAT COUNT, and the callers passed the meter's
    // numerator — six for 6/8. That asked for six beats per bar and returned
    // ONE bar for an eight-beat loop: on the 4/4 grid the clip was half the
    // length of the audio it held, so the tail was cut off on every import.
    expect(fittedLoopPlacement(3.75, 128, 124, SIX_EIGHT_BAR_TICKS)).toEqual({ lengthBars: 3, rate: 1.03 });
  });

  it("rate follows fitAudioClipTempo (detected/project, 0.25–4 gate)", () => {
    expect(fittedLoopPlacement(2, 100, 124, BAR_TICKS)?.rate).toBeCloseTo(0.81, 2);
    expect(fittedLoopPlacement(2, 40, 200, BAR_TICKS)?.rate).toBe(0.25);
    expect(fittedLoopPlacement(2, 240, 60, BAR_TICKS)?.rate).toBe(4);
  });

  it("rounds to whole bars, minimum 1", () => {
    expect(fittedLoopPlacement(0.2, 120, 120, BAR_TICKS)?.lengthBars).toBe(1);
    expect(fittedLoopPlacement(7.9, 120, 120, BAR_TICKS)?.lengthBars).toBe(4);
  });

  it("returns null for missing detection or bad numbers", () => {
    expect(fittedLoopPlacement(3.75, undefined, 124, BAR_TICKS)).toBeNull();
    expect(fittedLoopPlacement(3.75, 30, 124, BAR_TICKS)).toBeNull();
    expect(fittedLoopPlacement(3.75, 300, 124, BAR_TICKS)).toBeNull();
    expect(fittedLoopPlacement(0, 128, 124, BAR_TICKS)).toBeNull();
    expect(fittedLoopPlacement(3.75, 128, 0, BAR_TICKS)).toBeNull();
    expect(fittedLoopPlacement(3.75, 128, 124, 0)).toBeNull();
  });
});
