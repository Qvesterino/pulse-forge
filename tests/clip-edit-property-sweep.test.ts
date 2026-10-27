/**
 * THE PROPERTY SWEEP — the runner.
 *
 * The harness itself lives in `tests/helpers/clip-verb-harness.ts`, so that
 * the verb registry can be READ by the coverage guard
 * (`tests/clip-verb-coverage.test.ts`) — a clip verb that is not exercised
 * by the harness is a verb nobody proved anything about.
 *
 * WHAT THIS SWEEPS. Every verb × every argument variant, exhaustively, over
 * a FIXTURE whose geometry is random; then a random pass: a random geometry,
 * a random verb, a random argument.
 *
 * WHY A TABLE CANNOT DO THIS. The hand-written matrices are one row per verb,
 * one geometry per row. A table cannot enumerate the geometry space, so it
 * cannot find a floor that only bites at an unusual size — which is exactly
 * where the "creation floor leaked into the edit verbs" defect (D1) lived,
 * and where the resize that teleported a clip to tick 0 lived.
 */
import { describe, expect, it } from "vitest";
import {
  LANES,
  RANDOM_CASES_PER_LANE,
  SEED,
  audioLane,
  automationLane,
  changedFields,
  makeRng,
  midiLane,
  sceneLane,
  sweepExhaustive,
  sweepRandom,
  type ClipRecord,
} from "./helpers/clip-verb-harness";

describe("the property sweep — random geometries × random verbs", () => {
  it("the audio lane survives every generated edit", () => {
    sweepExhaustive(audioLane, SEED);
    sweepRandom(audioLane, RANDOM_CASES_PER_LANE, SEED + 10);
  });

  it("the MIDI lane survives every generated edit", () => {
    sweepExhaustive(midiLane, SEED + 1);
    sweepRandom(midiLane, RANDOM_CASES_PER_LANE, SEED + 11);
  });

  it("the automation lane survives every generated edit", () => {
    sweepExhaustive(automationLane, SEED + 2);
    sweepRandom(automationLane, RANDOM_CASES_PER_LANE, SEED + 12);
  });

  it("the scene lane survives every generated edit", () => {
    sweepExhaustive(sceneLane, SEED + 3);
    sweepRandom(sceneLane, RANDOM_CASES_PER_LANE, SEED + 13);
  });
});

describe("the property sweep — the properties themselves", () => {
  it("the generator is deterministic: the same seed produces the same cases", () => {
    const first = makeRng(SEED);
    const second = makeRng(SEED);
    const draw = (rng: () => number): number[] => Array.from({ length: 16 }, () => rng());
    expect(draw(first)).toEqual(draw(second));
    expect(draw(makeRng(SEED + 1)), "a different seed must produce a different stream").not.toEqual(
      draw(makeRng(SEED)),
    );
  });

  it("the isolation checker catches a verb that touches a field it does not own", () => {
    // A guard that has never been seen red is not a guard: feed the checker a
    // move that ALSO rewrote the gain, and require it to be reported.
    const before: ClipRecord = { startBar: 0, gain: 1 };
    const after: ClipRecord = { startBar: 2, gain: 0.5 };
    const changed = changedFields(before, after, ["startBar", "gain"]);
    expect(changed, "the checker must see both fields change").toEqual(["startBar", "gain"]);
    expect(
      changed.filter((field) => !["startBar"].includes(field)),
      "the checker must report the field the verb does not own",
    ).toEqual(["gain"]);
  });

  it("the sweep's allow-lists are the ones the hand-written matrices use", () => {
    // The sweep is only as good as its allow-lists. They must agree with the
    // matrices' lists — a sweep with a wider allow-list would let a real
    // leak through silently.
    expect(audioLane.verbs.find((verb) => verb.name === "move")?.allow).toEqual(["startBar"]);
    expect(audioLane.verbs.find((verb) => verb.name === "resize")?.allow).toEqual(["lengthBars", "fadeIn", "fadeOut"]);
    expect(audioLane.verbs.find((verb) => verb.name === "slip")?.allow).toEqual(["offsetSec"]);
    expect(audioLane.verbs.find((verb) => verb.name === "mute")?.allow).toEqual(["muted"]);
    expect(midiLane.verbs.find((verb) => verb.name === "move")?.allow).toEqual(["startTick"]);
    expect(midiLane.verbs.find((verb) => verb.name === "resize")?.allow).toEqual(["lengthTicks"]);
    expect(sceneLane.verbs.find((verb) => verb.name === "move")?.allow).toEqual(["startBar"]);
    expect(sceneLane.verbs.find((verb) => verb.name === "resize")?.allow).toEqual(["lengthBars"]);
  });

  it("every lane's verb list is non-empty and every verb has an allow-list", () => {
    for (const lane of LANES) {
      expect(lane.verbs.length, `${lane.name}: the lane must have verbs`).toBeGreaterThan(0);
      for (const verb of lane.verbs) {
        expect(Array.isArray(verb.allow), `${lane.name}/${verb.name}: the allow-list must be a list`).toBe(true);
        expect(verb.variants.length, `${lane.name}/${verb.name}: the verb must have variants`).toBeGreaterThan(0);
      }
    }
  });
});
