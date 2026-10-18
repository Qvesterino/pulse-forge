import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  VLYX_TARGET_MAX_ADJUSTMENT_DB,
  VLYX_TARGET_THRESHOLD_DB,
  formatVlyxClaim,
  spectralProfileDb,
  tonalCorrectionsDb,
  tonalDeviationDb,
  vlyxTonalClaim,
  type VlyxTonalClaim,
} from "../src/analysis/vlyxClaim";
import { analyzeWithTarget } from "../src/effects/ultina-core/analysis/mixAssistant";

/**
 * VLYX SOUND IDENTITY — the claim pin.
 *
 * The claim: "the target-correction rule moves an analysed track toward its
 * reference curve; the mean absolute deviation across the ten octave bands
 * drops, measurably." Three pins hold it:
 *  1. the committed GOLDEN VECTOR freezes the arithmetic;
 *  2. the REAL core (`analyzeWithTarget`) is run on synthetic audio and its
 *     own spectral profile feeds this module — no copies of the analysis;
 *  3. a monotonicity invariant: the rule can never INCREASE the mean deviation
 *     (for |dev| ≥ 1.5 dB the magnitude halves; below it nothing changes).
 * A claim about taste would be a lie; this is a claim about arithmetic, and the
 * panel's render + LUFS A/B is where "does it sound better" is measured.
 */

interface ClaimFixture {
  format: string;
  ratios: number[];
  targetDb: number[];
  expected: VlyxTonalClaim;
}

function readFixture(): ClaimFixture {
  return JSON.parse(readFileSync("tests/fixtures/vlyx-claim/vlyx-claim-v1.json", "utf8")) as ClaimFixture;
}

/** A low-mid-heavy synthetic mix: the kind of profile the demo template has. */
function muddyAudio(sampleRate = 44_100, seconds = 2.5): Float32Array {
  const length = Math.round(sampleRate * seconds);
  const channel = new Float32Array(length);
  let seed = 987654321;
  for (let index = 0; index < length; index += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = ((seed / 0x7fffffff) * 2 - 1) * 0.01;
    const t = index / sampleRate;
    channel[index] =
      Math.sin(2 * Math.PI * 180 * t) * 0.35 +
      Math.sin(2 * Math.PI * 320 * t) * 0.3 +
      Math.sin(2 * Math.PI * 900 * t) * 0.12 +
      Math.sin(2 * Math.PI * 3200 * t) * 0.05 +
      noise;
  }
  return channel;
}

describe("VLYX claim — the golden vector is frozen", () => {
  it("reproduces the committed numbers exactly", () => {
    const fixture = readFixture();
    expect(fixture.format).toBe("vlyx-tonal-claim.v1");
    expect(vlyxTonalClaim(fixture.ratios, fixture.targetDb)).toEqual(fixture.expected);
  });

  it("states the claim in one line with the before → after and the band count", () => {
    const line = formatVlyxClaim(readFixture().expected);
    expect(line).toContain("2.7 → 1.6 dB");
    expect(line).toContain("−1.1 dB");
    expect(line).toContain("5/10 bands");
  });
});

describe("VLYX claim — the rule is the core's, and it is monotone", () => {
  it("uses the core's constants: 1.5 dB threshold, half correction, ±6 dB cap", () => {
    expect(VLYX_TARGET_THRESHOLD_DB).toBe(1.5);
    expect(VLYX_TARGET_MAX_ADJUSTMENT_DB).toBe(6);
    // Below the threshold nothing is touched…
    expect(tonalCorrectionsDb([1.49, -1.49, 0])).toEqual([0, 0, 0]);
    // …at/above it the deviation halves (capped at ±6)…
    expect(tonalCorrectionsDb([4, -4])).toEqual([-2, 2]);
    // …and a 40 dB deviation can only move 6 dB (the cap).
    expect(tonalCorrectionsDb([40, -40])).toEqual([-6, 6]);
  });

  it("never increases the mean deviation, across 200 deterministic random profiles", () => {
    let seed = 424242;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 200; round += 1) {
      const ratios = Array.from({ length: 10 }, () => Math.max(0.0001, next()));
      const target = Array.from({ length: 10 }, () => (next() - 0.5) * 24);
      const claim = vlyxTonalClaim(ratios, target)!;
      expect(claim.improvementDb, `round ${round} increased the deviation`).toBeGreaterThanOrEqual(0);
      expect(claim.meanDeviationDbAfter).toBeLessThanOrEqual(claim.meanDeviationDbBefore);
    }
  });

  it("treats non-finite targets as flat instead of producing NaN", () => {
    const current = spectralProfileDb([0.1, 0.2]);
    const deviation = tonalDeviationDb(current, [Number.NaN, Number.POSITIVE_INFINITY]);
    expect(deviation.every((value) => Number.isFinite(value))).toBe(true);
  });
});

describe("VLYX claim — measured on the REAL analysis", () => {
  it("feeds the core's own spectral profile into the claim (no copied analysis)", () => {
    const target = [-2, 0, 2, 2.5, 2, 0.5, -1, -3, -6, -9];
    const result = analyzeWithTarget({ channels: [muddyAudio()], sampleRate: 44_100 }, target);
    expect(result.kind).toBe("success");
    const profile = result.kind === "success" ? result.proposal.features.spectralProfile : [];
    expect(profile).toHaveLength(10);

    const claim = vlyxTonalClaim(
      profile.map((band) => band.ratio),
      target,
    );
    expect(claim).not.toBeNull();
    expect(claim!.bands).toBe(10);
    expect(Number.isFinite(claim!.meanDeviationDbBefore)).toBe(true);
    expect(claim!.improvementDb).toBeGreaterThanOrEqual(0);
    // The claim reports how many bands the rule actually touched.
    expect(claim!.correctedBands).toBeGreaterThanOrEqual(0);
    expect(claim!.correctedBands).toBeLessThanOrEqual(10);
  });

  it("returns null when there is nothing to analyse", () => {
    expect(vlyxTonalClaim([], [])).toBeNull();
  });
});
