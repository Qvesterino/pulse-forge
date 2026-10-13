import { describe, expect, it } from "vitest";
import {
  EQ_CURVE_MAX_HZ,
  EQ_CURVE_MIN_DB,
  EQ_CURVE_MIN_HZ,
  EQ_CURVE_SAMPLE_RATE,
  eqCurve,
  eqResponseDbAt,
} from "../src/effects/eqCurve";
import { defaultParamsOf } from "../src/effects/definitions";

/**
 * These assert the CURVE agrees with the DSP, not that it is smooth. A wrong
 * but pretty curve on a level display is the worst outcome available: it
 * invites the user to dial in a setting the processor will not deliver.
 */
describe("eqCurve — flat equalizer is a flat line", () => {
  it("reads 0 dB everywhere at factory defaults", () => {
    const p = defaultParamsOf("eq");
    for (const hz of [20, 40, 100, 400, 1000, 2500, 6000, 12000, 20000]) {
      expect(Math.abs(eqResponseDbAt(p, hz)), `${hz} Hz`).toBeLessThan(0.01);
    }
  });

  it("stays flat when every gain is zeroed explicitly", () => {
    const p = { ...defaultParamsOf("eq"), lowShelfGain: 0, highShelfGain: 0, lowMidGain: 0, highMidGain: 0 };
    expect(eqCurve(p, 64).every((pt) => Math.abs(pt.db) < 0.01)).toBe(true);
  });
});

describe("eqCurve — the parallel shelf reaches its gain exactly", () => {
  // This is the whole reason eq-processor.js uses parallel form instead of
  // textbook RBJ. If the curve here droops at the edges, the transcription
  // drifted from the worklet and the drawing is now lying.
  it("low shelf reads exactly its gain at DC", () => {
    const p = { ...defaultParamsOf("eq"), lowShelfGain: 12 };
    expect(eqResponseDbAt(p, 1)).toBeCloseTo(12, 1);
  });

  it("low shelf returns to 0 dB well above its corner", () => {
    const p = { ...defaultParamsOf("eq"), lowShelfGain: 12 };
    expect(eqResponseDbAt(p, 20000)).toBeCloseTo(0, 1);
  });

  it("high shelf reads exactly its gain at Nyquist", () => {
    const p = { ...defaultParamsOf("eq"), highShelfGain: -9 };
    expect(eqResponseDbAt(p, EQ_CURVE_SAMPLE_RATE / 2)).toBeCloseTo(-9, 1);
  });

  it("high shelf returns to 0 dB well below its corner", () => {
    const p = { ...defaultParamsOf("eq"), highShelfGain: -9 };
    expect(eqResponseDbAt(p, EQ_CURVE_MIN_HZ)).toBeCloseTo(0, 1);
  });

  it("a +12 dB air shelf is not the RBJ droop — this is the bug the parallel form exists to prevent", () => {
    const p = { ...defaultParamsOf("eq"), highShelfGain: 12, highShelfFreq: 6000 };
    const at20k = eqResponseDbAt(p, EQ_CURVE_MAX_HZ);
    expect(at20k, "a +12 shelf must not read +7 dB at 20 kHz").toBeGreaterThan(11.5);
  });
});

describe("eqCurve — filter shapes land where the worklet puts them", () => {
  it("highpass attenuates below its corner and passes above it", () => {
    const p = { ...defaultParamsOf("eq"), hpFreq: 200 };
    expect(eqResponseDbAt(p, 25)).toBeLessThan(-6);
    expect(eqResponseDbAt(p, 5000)).toBeCloseTo(0, 1);
  });

  it("lowpass attenuates above its corner", () => {
    const p = { ...defaultParamsOf("eq"), lpFreq: 4000 };
    expect(eqResponseDbAt(p, 16000)).toBeLessThan(-6);
  });

  it("a peaking band hits its gain at its own centre frequency", () => {
    const p = { ...defaultParamsOf("eq"), lowMidFreq: 800, lowMidGain: 6, lowMidQ: 2 };
    expect(eqResponseDbAt(p, 800)).toBeGreaterThan(5.5);
  });

  it("a cut peaks negatively at its centre", () => {
    const p = { ...defaultParamsOf("eq"), highMidFreq: 3000, highMidGain: -8, highMidQ: 2 };
    expect(eqResponseDbAt(p, 3000)).toBeLessThan(-7.5);
  });

  it("a free band at zero gain is transparent", () => {
    const withZero = { ...defaultParamsOf("eq"), free1Gain: 0, free2Gain: 0 };
    const flat = eqCurve(withZero, 48).map((pt) => pt.db);
    const withCut = eqCurve({ ...withZero, free2Gain: -18, free2Freq: 3000, free2Q: 8 }, 48).map((pt) => pt.db);
    expect(flat.every((db) => Math.abs(db) < 0.01)).toBe(true);
    // The band must actually change the response somewhere.
    expect(withCut.some((db) => db < flat[withCut.indexOf(Math.min(...withCut))] - 5)).toBe(true);
  });
});

describe("eqCurve — shape of the sample list", () => {
  it("is log-spaced from 20 Hz to 20 kHz and monotonically rising in hz", () => {
    const pts = eqCurve(defaultParamsOf("eq"), 24);
    expect(pts).toHaveLength(24);
    expect(pts[0].hz).toBeCloseTo(EQ_CURVE_MIN_HZ, 3);
    expect(pts[23].hz).toBeCloseTo(EQ_CURVE_MAX_HZ, 1);
    for (let i = 1; i < pts.length; i++) expect(pts[i].hz).toBeGreaterThan(pts[i - 1].hz);
  });

  it("clamps every sample into the drawable range", () => {
    // A pathological gain must not produce a NaN or an off-canvas value.
    const p = { ...defaultParamsOf("eq"), free1Gain: -24, free1Q: 24, free2Gain: -24, free2Q: 24, lowMidGain: -15, highMidGain: -15, lowShelfGain: -15, highShelfGain: -15 };
    for (const pt of eqCurve(p, 96)) {
      expect(Number.isFinite(pt.db)).toBe(true);
      expect(pt.db).toBeGreaterThanOrEqual(EQ_CURVE_MIN_DB);
      expect(pt.db).toBeLessThanOrEqual(24);
    }
  });

  it("returns a flat line for a single point without dividing by zero", () => {
    expect(eqCurve(defaultParamsOf("eq"), 1)).toHaveLength(1);
  });
});
