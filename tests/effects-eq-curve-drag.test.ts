import { describe, expect, it } from "vitest";
import {
  EQ_BAND_DEFS,
  EQ_CURVE_MAX_HZ,
  EQ_CURVE_MIN_HZ,
  eqBandResponseDbAt,
  eqBands,
  eqHzToX,
  eqPointToDb,
  eqXToHz,
  hitEqBand,
} from "../src/effects/eqCurve";
import { effectEditorSpec } from "../src/ui/effectEditorRegistry";
import { defaultParamsOf } from "../src/effects/definitions";

/**
 * Hit-testing is what a drag actually does, so these assert which BAND a
 * pointer grabs — not that four bands exist. A hit-test that always returns
 * the first band still passes every "four bands" check.
 */
describe("eqBands — the curve's points are the rack's knobs", () => {
  it("exposes exactly the four gain params the multiview lists", () => {
    const primary = effectEditorSpec("eq").primaryParamIds ?? [];
    const bandIds = EQ_BAND_DEFS.map((b) => b.paramId);
    expect(bandIds.slice().sort()).toEqual(primary.slice().sort());
    // A point that has no matching knob is a control the user cannot reach.
    for (const id of bandIds) expect(primary, `${id} is draggable but has no knob`).toContain(id);
  });

  it("every band is a gain param, never a cut-off", () => {
    // hpFreq used to hold one of these slots. It is a filter corner, not a
    // band: it has no peak to grab, so it cannot be a drag point.
    for (const band of EQ_BAND_DEFS) expect(band.paramId, "drag points must be gains").toMatch(/Gain$/);
  });

  it("reads current gains out of the params", () => {
    const bands = eqBands({ ...defaultParamsOf("eq"), lowMidGain: -4.5, highMidGain: 6 });
    expect(bands.find((b) => b.paramId === "lowMidGain")!.gainDb).toBe(-4.5);
    expect(bands.find((b) => b.paramId === "highMidGain")!.gainDb).toBe(6);
  });

  it("a band at zero gain reads as no band of its own", () => {
    const p = defaultParamsOf("eq");
    expect(Math.abs(eqBandResponseDbAt(EQ_BAND_DEFS[1], p, 400))).toBeLessThan(0.01);
  });

  it("a band at +8 dB reads about +8 dB at its own centre", () => {
    const p = { ...defaultParamsOf("eq"), lowMidGain: 8 };
    expect(eqBandResponseDbAt(EQ_BAND_DEFS[1], p, 400)).toBeCloseTo(8, 0);
  });
});

describe("hitEqBand — which point does the pointer grab", () => {
  const withBoost = { ...defaultParamsOf("eq"), highMidGain: 9 };

  it("grabs the band whose point the pointer is sitting on", () => {
    // Point sits at 2500 Hz / +9 dB, so the pointer there must land on it.
    const hit = hitEqBand(withBoost, 2500, 9);
    expect(hit?.paramId).toBe("highMidGain");
  });

  it("returns nothing when the pointer is far above the curve", () => {
    // A pointer at +18 dB is nowhere near any band; grabbing one anyway would
    // make the dock feel like it edits something the user did not aim at.
    expect(hitEqBand(withBoost, 2500, 18)).toBeNull();
  });

  it("returns nothing when the pointer is far below the curve", () => {
    expect(hitEqBand(withBoost, 2500, -12)).toBeNull();
  });

  it("does not grab a distant band whose gain happens to match", () => {
    // HIGH MID is at +9 dB. A pointer at 120 Hz / +9 dB is horizontally far
    // from it — matching gain is not a match.
    expect(hitEqBand(withBoost, 120, 9)).toBeNull();
  });

  it("picks the band whose centre is nearest when two are in range", () => {
    const p = { ...defaultParamsOf("eq"), lowMidGain: 6, highMidGain: 6 };
    expect(hitEqBand(p, 2500, 6)?.paramId).toBe("highMidGain");
    expect(hitEqBand(p, 400, 6)?.paramId).toBe("lowMidGain");
  });

  it("does not grab a band that is silent at the pointer's frequency", () => {
    // Flat EQ: all four bands read 0 dB, so a pointer at 0 dB anywhere inside
    // the grab radius is legitimately on all of them, but the nearest centre
    // wins rather than an arbitrary one.
    const p = defaultParamsOf("eq");
    const hit = hitEqBand(p, 2500, 0);
    expect(hit?.paramId).toBe("highMidGain");
  });

  it("keeps its distance order when bands overlap in frequency", () => {
    // LOW SHELF at 120 Hz and LOW MID at 400 Hz are a ratio apart; a wide
    // radius must still resolve to the nearer one, not the first declared.
    const p = { ...defaultParamsOf("eq"), lowShelfGain: 5, lowMidGain: 5 };
    expect(hitEqBand(p, 400, 5)?.paramId).toBe("lowMidGain");
    expect(hitEqBand(p, 120, 5)?.paramId).toBe("lowShelfGain");
  });
});

describe("pointer <-> curve coordinate mapping", () => {
  it("maps the vertical centre to 0 dB and both ends to the range", () => {
    expect(eqPointToDb(50, 100)).toBeCloseTo(0, 6);
    expect(eqPointToDb(0, 100)).toBeCloseTo(24, 6);
    expect(eqPointToDb(100, 100)).toBeCloseTo(-24, 6);
  });

  it("clamps a pointer dragged past the canvas rather than reading nonsense", () => {
    expect(eqPointToDb(-40, 100)).toBeCloseTo(24, 6);
    expect(eqPointToDb(400, 100)).toBeCloseTo(-24, 6);
    expect(eqPointToDb(20, 0)).toBe(0);
  });

  it("round-trips a pointer position through hz and back", () => {
    for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
      const hz = eqXToHz(frac * 240, 240);
      expect(hz).toBeGreaterThanOrEqual(EQ_CURVE_MIN_HZ - 1);
      expect(hz).toBeLessThanOrEqual(EQ_CURVE_MAX_HZ + 1);
      expect(eqHzToX(hz, 240)).toBeCloseTo(frac * 240, 3);
    }
  });

  it("puts a known frequency in the expected place on a log axis", () => {
    const w = 240;
    expect(eqXToHz(0, w)).toBeCloseTo(EQ_CURVE_MIN_HZ, 3);
    expect(eqXToHz(w, w)).toBeCloseTo(EQ_CURVE_MAX_HZ, 3);
    // The MIDDLE of a 20 Hz–20 kHz log axis is the geometric mean, 632 Hz —
    // not 1 kHz. The axis spans three decades (20 / 200 / 2k / 20k), so 1 kHz
    // lands 0.566 of the way across; a 0.75 assumption would put every
    // hit-test frequency in the wrong place on screen.
    expect(eqXToHz(w * 0.5, w)).toBeCloseTo(632, 0);
    expect(eqXToHz(w * 0.333, w)).toBeCloseTo(200, 0);
    expect(eqXToHz(w * 0.566, w) / 1000).toBeCloseTo(1, 2);
  });

  // The two positions the browser gate probes, pinned so the same wrong
  // constant cannot come back. HIGH MID lives at 2500 Hz, which is 0.699 of
  // the way across — the gate once probed 0.566 (1 kHz), grabbed nothing, and
  // the Ctrl+Z that followed undid the kit load instead of the gesture it
  // thought it had made. This is the arithmetic half of that; the gesture half
  // is in tests/eq-curve-gesture.test.tsx.
  it("places each grabbable band at a known fraction of the axis", () => {
    const w = 240;
    const frac = (hz: number) => Math.log(hz / EQ_CURVE_MIN_HZ) / Math.log(EQ_CURVE_MAX_HZ / EQ_CURVE_MIN_HZ);
    for (const band of EQ_BAND_DEFS) {
      expect(eqXToHz(w * frac(band.freqHz), w) / band.freqHz).toBeCloseTo(1, 2);
    }
    // Spelled out, because the failure mode was a plausible-looking 0.566:
    expect(frac(2500)).toBeCloseTo(0.699, 3);
    expect(frac(1000)).toBeCloseTo(0.566, 3);
  });
});
