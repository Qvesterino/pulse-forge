import { describe, expect, it } from "vitest";
import { ratioToTaper, taperToRatio } from "../src/ui/controls";
import { EFFECT_DEFS } from "../src/effects/registry";
import { INSTRUMENT_DEFS } from "../src/instruments/registry";
import { defaultParamsOf } from "../src/effects/registry";

/**
 * Slider taper + insert-defaults quality.
 *
 * All-linear sliders bunched every Hz-domain knob (cutoff, EQ bands, tone)
 * at the left end of its travel. The taper contract below pins the rule:
 * every Hz param with min > 0 drags logarithmically (midpoint = geometric
 * mean); bipolar/min-≤0 params (split, mono-bass, freq-shift, OFF-at-0 LFO
 * rates) stay linear by construction of the helpers.
 */

describe("taper math", () => {
  it("linear is identity with round-trip", () => {
    expect(ratioToTaper(20, 20000, 0.5)).toBeCloseTo(10010, 8);
    expect(taperToRatio(20, 20000, 10010)).toBeCloseTo(0.5, 8);
    expect(ratioToTaper(20, 20000, 0)).toBe(20);
    expect(ratioToTaper(20, 20000, 1)).toBe(20000);
  });

  it("log midpoint is the geometric mean (632 Hz, not 10 kHz)", () => {
    expect(ratioToTaper(20, 20000, 0.5, "log")).toBeCloseTo(Math.sqrt(20 * 20000), 6);
    expect(taperToRatio(20, 20000, Math.sqrt(20 * 20000), "log")).toBeCloseTo(0.5, 8);
    expect(ratioToTaper(20, 20000, 0, "log")).toBe(20);
    expect(ratioToTaper(20, 20000, 1, "log")).toBe(20000);
  });

  it("log endpoints and clamping hold", () => {
    expect(ratioToTaper(80, 16000, -0.5, "log")).toBe(80);
    expect(ratioToTaper(80, 16000, 1.5, "log")).toBe(16000);
    expect(taperToRatio(80, 16000, 80, "log")).toBe(0);
    expect(taperToRatio(80, 16000, 16000, "log")).toBe(1);
  });

  it("falls back to linear when log is undefined (min ≤ 0, max ≤ min)", () => {
    expect(ratioToTaper(0, 500, 0.5, "log")).toBe(250);
    expect(ratioToTaper(-1000, 1000, 0.5, "log")).toBe(0);
    expect(ratioToTaper(100, 100, 0.5, "log")).toBe(100);
    expect(taperToRatio(0, 500, 250, "log")).toBe(0.5);
  });

  it("default taper is linear (back-compat for unmarked knobs)", () => {
    expect(ratioToTaper(0, 1, 0.5)).toBe(0.5);
    expect(taperToRatio(0, 1, 0.5)).toBe(0.5);
  });
});

describe("taper contract", () => {
  it("every Hz effect param with min > 0 drags logarithmically", () => {
    const offenders: string[] = [];
    for (const [type, def] of Object.entries(EFFECT_DEFS)) {
      for (const p of def.params) {
        if (p.unit === "Hz" && p.min > 0 && p.taper !== "log") offenders.push(`${type}.${p.id}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every Hz instrument param with min > 0 drags logarithmically", () => {
    const offenders: string[] = [];
    for (const [kind, def] of Object.entries(INSTRUMENT_DEFS)) {
      for (const p of def.params as { id: string; unit?: string; min: number; taper?: string }[]) {
        if (p.unit === "Hz" && p.min > 0 && p.taper !== "log") offenders.push(`${kind}.${p.id}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("bipolar and OFF-at-0 params stay linear", () => {
    const linear = [
      EFFECT_DEFS.sidechain.params.find((p) => p.id === "splitFreq")!,
      EFFECT_DEFS.utility.params.find((p) => p.id === "monoBassFrequency")!,
      EFFECT_DEFS.freqShifter.params.find((p) => p.id === "shift")!,
    ];
    for (const p of linear) expect(p.taper ?? "linear").toBe("linear");
  });
});

describe("insert defaults audit", () => {
  it("VØID inserts at a musical MIX, not full-wet", () => {
    expect(defaultParamsOf("ozvena")["global.dryWet"]).toBe(25);
  });

  it("time-based stock inserts keep musical mixes", () => {
    expect(defaultParamsOf("reverb").mix).toBeLessThanOrEqual(0.5);
    expect(defaultParamsOf("delay").mix).toBeLessThanOrEqual(0.5);
    expect(defaultParamsOf("duckDelay").mix).toBeLessThanOrEqual(0.5);
  });
});
