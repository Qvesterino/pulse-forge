/**
 * ADR 0057 Stage 2d — the PINNED models' feature frame is metrical.
 *
 * The pinned ONNX priors and the melodic model were trained on sixteen-step
 * bars. Their feature rows carry a note's position inside the bar, and the
 * drum row carries two flags that name 4/4's downbeat and 4/4's backbeat.
 * That was fine while every project was 4/4 and wrong everywhere else: in
 * 6/8 the last eighth of the bar was called "10/16" — a position that does
 * not exist in a twelve-step bar — the bar was folded at sixteen (so a 6/8
 * bar looked like the first three quarters of a 4/4 one), the second bar's
 * downbeat was not a downbeat, and the backbeat sat on 4/4's beat 2 and 4
 * (a beat 4 that a 3/4 bar does not have).
 *
 * The fix does NOT re-train the models. It changes what the five position
 * values MEAN: the note's position in the bar, divided by the bar's own
 * length. The feature COUNT and the pinned manifests are untouched.
 *
 * The 4/4 case is the negative control and it is not optional: in 4/4 the
 * phase IS the legacy `s16/16`, so every value is byte-identical. The
 * legacy formula is re-implemented HERE, in the test, and compared against
 * the production row — so the control cannot be satisfied by the production
 * code agreeing with itself.
 */
import { describe, expect, it } from "vitest";
import { aiMeterFor, DEFAULT_AI_METER } from "../src/ai/meter";
import { buildPriorFeatureRow, PRIOR_FEATURE_COUNT } from "../src/ai/symbolic/prior-features";
import { buildPriorV2FeatureRow, V2_FEATURE_COUNT } from "../src/ai/symbolic/prior-features-v2";
import { buildPriorV3FeatureRow, V3_FEATURE_COUNT } from "../src/ai/symbolic/prior-features-v3";
import { buildMelodicFeatureRow } from "../src/ai/symbolic/melodic-features";
import { buildMelodicV2FeatureRow } from "../src/ai/symbolic/melodic-features-v2";
import { barPhase, stepInBarFeatures } from "../src/ai/symbolic/step-position";
import type { TimeSignature } from "../src/project-model/types";

const FOUR_FOUR: TimeSignature = { numerator: 4, denominator: 4 };
const SIX_EIGHT: TimeSignature = { numerator: 6, denominator: 8 };
const THREE_FOUR: TimeSignature = { numerator: 3, denominator: 4 };

/** The legacy encoding, re-implemented here so the control is independent. */
function legacyPosition(step: number): number[] {
  const s16 = ((step % 16) + 16) % 16;
  return [
    s16 / 16,
    Math.sin((2 * Math.PI * s16) / 16),
    Math.cos((2 * Math.PI * s16) / 16),
    Math.sin((4 * Math.PI * s16) / 16),
    Math.cos((4 * Math.PI * s16) / 16),
  ];
}

/** The legacy tail of the drum row: position(5) + frame(3) + flags(2). */
function legacyDrumTail(step: number, stepCount: number): number[] {
  const s16 = ((step % 16) + 16) % 16;
  const frame = Math.max(16, stepCount);
  return [
    ...legacyPosition(step),
    step / frame,
    Math.sin((2 * Math.PI * step) / frame),
    Math.cos((2 * Math.PI * step) / frame),
    s16 === 0 ? 1 : 0,
    s16 === 4 || s16 === 12 ? 1 : 0,
  ];
}

describe("ADR 0057 Stage 2d — the pinned feature frame is the document's metre", () => {
  it("NEGATIVE CONTROL: in 4/4 the drum row is byte-identical to the legacy row", () => {
    const meter = aiMeterFor(FOUR_FOUR);
    for (const stepCount of [16, 32, 48]) {
      for (let step = 0; step < stepCount; step++) {
        const row = buildPriorFeatureRow({
          genre: "house",
          styleId: "house.deep",
          role: "kick",
          step,
          stepCount,
          meter,
        });
        expect(row.length).toBe(PRIOR_FEATURE_COUNT);
        // The last ten values are position(5) + frame(3) + flags(2).
        expect(row.slice(PRIOR_FEATURE_COUNT - 10)).toEqual(legacyDrumTail(step, stepCount));
      }
    }
  });

  it("NEGATIVE CONTROL: in 4/4 the melodic row is byte-identical to the legacy row", () => {
    const meter = aiMeterFor(FOUR_FOUR);
    for (let step = 0; step < 16; step++) {
      const row = buildMelodicFeatureRow({
        genre: "house",
        role: "bass",
        startStep: step,
        prevDegree: 0,
        prevDuration: 2,
        prevPrevDegree: 1,
        meter,
      });
      const offset = row.length - 5 - 8 - 4 - 5 - 3; // position(5) sits before the degree/duration classes
      expect(row.slice(offset, offset + 5)).toEqual(legacyPosition(step));
    }
  });

  it("NEGATIVE CONTROL: the training frame (4/4) leaves the corpus rows untouched", () => {
    // The corpus IS 4/4 material and the shipped models were trained on its
    // rows, so the corpus declares the training frame and those rows must not
    // move (ADR 0057 Stage 2d).
    const corpusRow = buildMelodicFeatureRow({
      genre: "techno",
      role: "bass",
      startStep: 6,
      prevDegree: 2,
      prevDuration: 4,
      prevPrevDegree: 0,
      meter: DEFAULT_AI_METER,
    });
    const offset = corpusRow.length - 5 - 8 - 4 - 5 - 3;
    expect(corpusRow.slice(offset, offset + 5)).toEqual(legacyPosition(6));
  });

  it("the model's frame is unchanged — the feature COUNT is the contract", () => {
    // The manifests pin the feature count; a retrain would be needed to
    // change it, and this change does not.
    expect(PRIOR_FEATURE_COUNT).toBe(44);
    expect(V2_FEATURE_COUNT).toBe(35);
    expect(V3_FEATURE_COUNT).toBe(60);
  });

  it("in 6/8 the downbeat is the downbeat and the half-bar is the half-bar", () => {
    const meter = aiMeterFor(SIX_EIGHT);
    expect(meter.stepsPerBar).toBe(12);
    // The metrical landmarks carry the SAME numbers the model learned in 4/4:
    // the downbeat at phase 0, the half-bar at phase 0.5.
    const fourFour = aiMeterFor(FOUR_FOUR);
    expect(stepInBarFeatures(meter, 0)).toEqual(stepInBarFeatures(fourFour, 0));
    expect(stepInBarFeatures(meter, 6)).toEqual(stepInBarFeatures(fourFour, 8));
    // …and the values are the legacy 4/4 landmark values, byte for byte.
    expect(stepInBarFeatures(meter, 0)).toEqual(legacyPosition(0));
    expect(stepInBarFeatures(meter, 6)).toEqual(legacyPosition(8));
  });

  it("in 6/8 the bar is twelve steps long, and the second bar's downbeat is a downbeat", () => {
    const meter = aiMeterFor(SIX_EIGHT);
    const row = (step: number, stepCount = 12) =>
      buildPriorFeatureRow({
        genre: "house",
        styleId: "house.deep",
        role: "snare",
        step,
        stepCount,
        meter,
      });
    const flags = (step: number) => row(step).slice(PRIOR_FEATURE_COUNT - 2);
    // The first bar's downbeat.
    expect(flags(0)).toEqual([1, 0]);
    // The SECOND bar's downbeat — the old encoding called it step 12, which
    // is not a downbeat at all.
    expect(flags(12)).toEqual([1, 0]);
    // The shuffle's "2 & 5" — the metre's backbeat, not 4/4's beat 2 and 4.
    expect(flags(2)).toEqual([0, 1]);
    expect(flags(8)).toEqual([0, 1]);
    // 4/4's beat 4 has no meaning in 6/8.
    expect(flags(4)).toEqual([0, 0]);
  });

  it("in 6/8 the frame is the bar, not sixteen steps", () => {
    const meter = aiMeterFor(SIX_EIGHT);
    const row = buildPriorFeatureRow({
      genre: "house",
      styleId: "house.deep",
      role: "closedHat",
      step: 6,
      stepCount: 12,
      meter,
    });
    const frameOffset = PRIOR_FEATURE_COUNT - 5;
    // The frame position is 6/12 — the bar's halfway — not 6/16.
    expect(row[frameOffset]).toBeCloseTo(0.5);
  });

  it("in 3/4 there is no beat 4, so there is no backbeat to name", () => {
    const meter = aiMeterFor(THREE_FOUR);
    expect(meter.stepsPerBar).toBe(12);
    const row = (step: number) =>
      buildPriorFeatureRow({
        genre: "house",
        styleId: "house.deep",
        role: "snare",
        step,
        stepCount: 12,
        meter,
      }).slice(PRIOR_FEATURE_COUNT - 2);
    expect(row(0)).toEqual([1, 0]); // the downbeat
    expect(row(4)).toEqual([0, 1]); // beat 2 — the backbeat
    expect(row(8)).toEqual([0, 0]); // beat 3 is not a backbeat
  });

  it("the phase is the position in the bar, on the bar's own length", () => {
    const sixEight = aiMeterFor(SIX_EIGHT);
    expect(barPhase(sixEight, 0)).toBe(0);
    expect(barPhase(sixEight, 3)).toBeCloseTo(0.25);
    expect(barPhase(sixEight, 6)).toBeCloseTo(0.5);
    expect(barPhase(sixEight, 12)).toBe(0); // the next bar's downbeat
    // A 4/2 bar is thirty-two steps: its half-bar is the model's half too.
    const fourTwo = aiMeterFor({ numerator: 4, denominator: 2 });
    expect(barPhase(fourTwo, 16)).toBeCloseTo(0.5);
  });

  it("every contract reads the same metre (the v1 row is the v3 row's base)", () => {
    const meter = aiMeterFor(SIX_EIGHT);
    const v1 = buildPriorFeatureRow({
      genre: "house",
      styleId: "house.deep",
      role: "kick",
      step: 3,
      stepCount: 12,
      meter,
    });
    const v3 = buildPriorV3FeatureRow({
      semantic: new Array(16).fill(0.1),
      genre: "house",
      styleId: "house.deep",
      role: "kick",
      step: 3,
      stepCount: 12,
      meter,
    });
    const v3Base = v3.slice(v3.length - v1.length);
    expect(v3Base).toEqual(v1);
    // …and the v2 contract carries the same metrical tail.
    const v2 = buildPriorV2FeatureRow({
      semantic: new Array(16).fill(0.1),
      role: "kick",
      step: 3,
      stepCount: 12,
      meter,
    });
    expect(v2.slice(v2.length - 10)).toEqual(v1.slice(v1.length - 10));
  });
});
