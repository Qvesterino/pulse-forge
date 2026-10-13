import { describe, expect, it } from "vitest";
import { EQ_CURVE_MAX_HZ, EQ_CURVE_MIN_DB, EQ_CURVE_MIN_HZ, eqCurve, eqResponseDbAt } from "../src/effects/eqCurve";
import { defaultParamsOf } from "../src/effects/definitions";

/**
 * These assert the CURVE agrees with the DSP, not that it is smooth. A wrong
 * but pretty curve on a level display is the worst outcome available: it
 * invites the user to dial in a setting the processor will not deliver.
 */
describe("eqCurve — flat equalizer is a flat line", () => {
  // NOT "0 dB everywhere": factory hpFreq is 20 Hz and lpFreq is 20 kHz, so a
  // 2-pole highpass sits 3 dB down at its own corner and the lowpass does the
  // same at Nyquist. That is correct 2-pole behaviour, and a curve that claimed
  // 0 dB at 20 Hz would be the lie.
  it("passes the passband flat and rolls off exactly 3 dB at each corner", () => {
    const p = defaultParamsOf("eq");
    for (const hz of [100, 400, 1000, 2500, 6000]) {
      expect(Math.abs(eqResponseDbAt(p, hz)), `${hz} Hz`).toBeLessThan(0.01);
    }
    expect(eqResponseDbAt(p, 20)).toBeCloseTo(-3.01, 1);
    expect(eqResponseDbAt(p, 20000)).toBeCloseTo(-3.01, 1);
  });

  it("stays flat when every gain is zeroed explicitly", () => {
    const p = { ...defaultParamsOf("eq"), lowShelfGain: 0, highShelfGain: 0, lowMidGain: 0, highMidGain: 0 };
    expect(Math.abs(eqResponseDbAt(p, 100))).toBeLessThan(0.01);
    expect(Math.abs(eqResponseDbAt(p, 1000))).toBeLessThan(0.01);
    expect(Math.abs(eqResponseDbAt(p, 6000))).toBeLessThan(0.01);
  });
});

describe("eqCurve — the parallel shelf reaches its gain exactly", () => {
  // This is the whole reason eq-processor.js uses parallel form instead of
  // textbook RBJ. If the curve drooped at the edges, the transcription drifted
  // from the worklet and the drawing would now be lying.
  //
  // Measured as the DIFFERENCE against the same curve without the shelf: HP and
  // LP are always in the cascade, so the absolute reading at DC is not the
  // shelf's gain. The difference is the shelf's own contribution, and that is
  // what the parallel topology guarantees to be exactly ±G.
  const shelfGain = (patch: Record<string, number>, hz: number) =>
    eqResponseDbAt({ ...defaultParamsOf("eq"), ...patch }, hz) - eqResponseDbAt(defaultParamsOf("eq"), hz);

  it("low shelf reaches its full gain at DC", () => {
    expect(shelfGain({ lowShelfGain: 12 }, 1)).toBeCloseTo(12, 1);
  });

  it("low shelf returns to unity well above its corner", () => {
    expect(shelfGain({ lowShelfGain: 12 }, 20000)).toBeCloseTo(0, 1);
  });

  it("high shelf approaches its full gain by the top of the drawn axis", () => {
    // NOT at Nyquist: lpFreq tops out at 20 kHz, so a 2-pole lowpass is fully
    // closed by 24 kHz and BOTH the patched and the unpatched response floor out
    // — their difference measures nothing. The shelf reaches ±G only past
    // Nyquist, which is off any axis, so the honest claim is convergence: the
    // further up the spectrum, the closer it gets.
    const at = (hz: number) => shelfGain({ highShelfGain: -9 }, hz);
    expect(at(EQ_CURVE_MAX_HZ)).toBeCloseTo(-9, 0);
    expect(at(12000)).toBeLessThan(at(EQ_CURVE_MAX_HZ));
    expect(Math.abs(at(EQ_CURVE_MAX_HZ) + 9)).toBeLessThan(0.6);
  });

  it("high shelf returns to unity well below its corner", () => {
    expect(shelfGain({ highShelfGain: -9 }, EQ_CURVE_MIN_HZ)).toBeCloseTo(0, 1);
  });

  it("a +12 dB air shelf is not the RBJ droop — this is the bug the parallel form exists to prevent", () => {
    // The worklet comment names the exact failure: "a +12 dB air shelf reading
    // +7 dB at 20 kHz cannot happen". Assert the corner that RBJ would miss.
    expect(shelfGain({ highShelfGain: 12, highShelfFreq: 6000 }, EQ_CURVE_MAX_HZ)).toBeGreaterThan(11.5);
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
    // Compared against the curve with no free-band params at all, not against
    // zero dB: the HP and LP in the same cascade are never at unity at the
    // ends of the axis.
    const base = defaultParamsOf("eq");
    const withZero = { ...base, free1Gain: 0, free2Gain: 0 };
    const flat = eqCurve(withZero, 48);
    const bare = eqCurve(base, 48);
    expect(flat.every((pt, i) => Math.abs(pt.db - bare[i].db) < 0.01)).toBe(true);
    // The band must actually change the response somewhere.
    const withCut = eqCurve({ ...withZero, free2Gain: -18, free2Freq: 3000, free2Q: 8 }, 96);
    expect(Math.min(...withCut.map((pt) => pt.db))).toBeLessThan(Math.min(...flat.map((pt) => pt.db)) - 5);
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
    const p = {
      ...defaultParamsOf("eq"),
      free1Gain: -24,
      free1Q: 24,
      free2Gain: -24,
      free2Q: 24,
      lowMidGain: -15,
      highMidGain: -15,
      lowShelfGain: -15,
      highShelfGain: -15,
    };
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
