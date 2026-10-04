import { describe, expect, it } from "vitest";
import {
  bassNoteMetrics,
  chordBarAccuracy,
  keyMatch,
  onsetMatch,
  stepF1,
  tempoFoldError,
} from "../../src/reference/unsuno-metrics";

/**
 * U0 — the metrics ARE the KPI definitions, so they get self-tests before
 * any transcription exists. If one of these fails, a KPI number is lying.
 */

describe("stepF1", () => {
  it("perfect match → f1 1", () => {
    expect(stepF1([0, 4, 8, 12], [0, 4, 8, 12]).f1).toBe(1);
  });
  it("tolerance ±1 absorbs off-by-one, consumed slots don't double-match", () => {
    const report = stepF1([1, 5, 9, 13], [0, 4, 8, 12], { tolerance: 1 });
    expect(report.tp).toBe(4);
    expect(report.fp).toBe(0);
    expect(report.fn).toBe(0);
  });
  it("extra detections hurt precision, misses hurt recall", () => {
    const noisy = stepF1([0, 4, 8, 12, 2, 6], [0, 4, 8, 12], { tolerance: 0 });
    expect(noisy.precision).toBeCloseTo(4 / 6);
    expect(noisy.recall).toBe(1);
    const sparse = stepF1([0], [0, 4, 8, 12], { tolerance: 0 });
    expect(sparse.precision).toBe(1);
    expect(sparse.recall).toBe(0.25);
  });
  it("empty inputs → zeros, never NaN", () => {
    expect(stepF1([], []).f1).toBe(0);
    expect(stepF1([1], []).recall).toBe(0);
    expect(stepF1([], [1]).precision).toBe(0);
  });
});

describe("onsetMatch", () => {
  it("matches inside the window, greedy nearest", () => {
    const report = onsetMatch([0.004, 0.51, 0.99], [0, 0.5, 1.0], 0.02);
    expect(report.matched).toBe(3);
    expect(report.f1).toBe(1);
    expect(report.medianErrorSec).toBeLessThan(0.02);
  });
  it("detections outside every truth window count as false positives", () => {
    const report = onsetMatch([0, 0.5, 3.7], [0, 0.5, 1.0], 0.02);
    expect(report.matched).toBe(2);
    expect(report.precision).toBeCloseTo(2 / 3);
    expect(report.recall).toBeCloseTo(2 / 3);
  });
});

describe("bassNoteMetrics", () => {
  it("scores onset + pitch independently — right time, wrong note is visible", () => {
    const report = bassNoteMetrics(
      [
        { startSec: 0.0, midi: 33 },
        { startSec: 0.5, midi: 45 }, // octave error
      ],
      [
        { startSec: 0.0, midi: 33 },
        { startSec: 0.5, midi: 33 },
      ],
      0.05,
    );
    expect(report.onset.f1).toBe(1);
    expect(report.pitchAccuracy).toBeCloseTo(0.5);
    expect(report.pitchClassAccuracy).toBe(1); // octave-blind view still perfect
  });
  it("unmatched truth drags recall", () => {
    const report = bassNoteMetrics(
      [{ startSec: 0, midi: 33 }],
      [
        { startSec: 0, midi: 33 },
        { startSec: 1, midi: 35 },
      ],
      0.05,
    );
    expect(report.onset.recall).toBeCloseTo(0.5);
  });
});

describe("chordBarAccuracy", () => {
  const truth = [
    { bar: 0, rootPc: 9, quality: "min" },
    { bar: 1, rootPc: 5, quality: "maj" },
    { bar: 2, rootPc: 0, quality: "maj" },
  ];
  it("exact requires root AND quality; root-only is reported separately", () => {
    const report = chordBarAccuracy(
      [
        { bar: 0, rootPc: 9, quality: "min" },
        { bar: 1, rootPc: 5, quality: "min" }, // right root, wrong quality
      ],
      truth,
    );
    expect(report.exactCorrect).toBe(1);
    expect(report.rootCorrect).toBe(2);
    expect(report.exactAccuracy).toBeCloseTo(1 / 3);
    expect(report.rootAccuracy).toBeCloseTo(2 / 3);
  });
  it("a detected bar with no truth counterpart never inflates accuracy", () => {
    const report = chordBarAccuracy([{ bar: 7, rootPc: 9, quality: "min" }], truth);
    expect(report.exactCorrect).toBe(0);
    expect(report.total).toBe(3);
  });
});

describe("tempoFoldError", () => {
  it("direct hit, half/double and quarter folds all count", () => {
    expect(tempoFoldError(126, 126)).toBe(0);
    expect(tempoFoldError(63, 126)).toBe(0);
    expect(tempoFoldError(252, 126)).toBe(0);
    expect(tempoFoldError(87, 90)).toBe(3);
  });
  it("null detection → null error, never a number", () => {
    expect(tempoFoldError(null, 120)).toBeNull();
  });
});

describe("keyMatch", () => {
  it("parses estimator strings ('A Natural Minor' | 'C Major')", () => {
    expect(keyMatch("A Natural Minor", { tonicPc: 9, mode: "minor" }).exact).toBe(true);
    expect(keyMatch("C Major", { tonicPc: 0, mode: "major" }).exact).toBe(true);
  });
  it("mode miss still credits tonicOnly", () => {
    const report = keyMatch("A Major", { tonicPc: 9, mode: "minor" });
    expect(report.exact).toBe(false);
    expect(report.tonicOnly).toBe(true);
  });
  it("wrong tonic is a full miss; garbage/null never throw", () => {
    expect(keyMatch("B Minor", { tonicPc: 9, mode: "minor" }).tonicOnly).toBe(false);
    expect(keyMatch("Heligoland", { tonicPc: 9, mode: "minor" }).exact).toBe(false);
    expect(keyMatch(null, { tonicPc: 9, mode: "minor" }).exact).toBe(false);
  });
});
