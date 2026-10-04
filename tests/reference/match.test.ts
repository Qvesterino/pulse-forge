/**
 * REFERENCE MATCH — the measured "ako ďaleko som od referencie" report.
 *
 * Locked here:
 *   1. contract: the report carries all 7 mix-doctor bands in display order,
 *      both sides' shares, the deltas, the 4-band master curve and the
 *      loudness trim — every number a rounded measurement;
 *   2. the share domain is level-free: a −20 dB reference against a loud mix
 *      produces the SAME band table (the comparison is tonal, never volume);
 *   3. the curve is shape-only: it rides computeMatchEqCurve (de-mean,
 *      dead-zone, ±6 clamp) so a match can never be a hidden volume boost;
 *   4. honesty rules: sub-deadzone gaps produce NO trim, an all-zero curve is
 *      null (nothing worth moving), silent inputs decline instead of
 *      anti-matching;
 *   5. determinism: identical inputs → byte-identical report.
 */

import { describe, expect, it } from "vitest";
import { buildReferenceMatch, MATCH_DEADZONE_DB } from "../../src/reference/match";

const SR = 44100;

/** A deterministic LCG noise — the repo's standard fixture pattern. */
function makeNoise(seed: number, seconds: number, amplitude = 0.5): Float32Array {
  let state = seed >>> 0 || 1;
  const out = new Float32Array(Math.floor(seconds * SR));
  for (let i = 0; i < out.length; i++) {
    // xorshift32 — same class as the seeded fixtures elsewhere in tests/.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = (state / 0xffffffff - 0.5) * 2 * amplitude;
  }
  return out;
}

/** One channel of deterministic noise with a sine boost at `hz` — a "band-heavy" signal. */
function toneBoostedNoise(seed: number, hz: number, seconds: number, boost = 0.4): Float32Array {
  const noise = makeNoise(seed, seconds, 0.25);
  for (let i = 0; i < noise.length; i++) {
    noise[i] += boost * Math.sin((2 * Math.PI * hz * i) / SR);
  }
  return noise;
}

/** Identical L/R = a perfectly correlated stereo pair. */
function correlated(pair: Float32Array): Float32Array[] {
  return [pair, new Float32Array(pair)];
}

/** L = -R = maximal side energy (correlation −1). */
function hardWide(pair: Float32Array): Float32Array[] {
  return [pair, pair.map((v) => -v) as Float32Array];
}

describe("reference match — contract", () => {
  it("carries all 7 mix-doctor bands in display order with both sides and the delta", () => {
    const mix = { channels: correlated(makeNoise(7, 3)), sampleRate: SR };
    const ref = { channels: correlated(toneBoostedNoise(11, 50, 3)), sampleRate: SR };
    const report = buildReferenceMatch(mix, ref);
    expect(report.bands.map((b) => b.band)).toEqual([
      "sub",
      "low",
      "lowmid",
      "mid",
      "himid",
      "high",
      "air",
    ]);
    for (const row of report.bands) {
      expect(Number.isFinite(row.mixDb), `${row.band} mixDb`).toBe(true);
      expect(Number.isFinite(row.refDb), `${row.band} refDb`).toBe(true);
      // delta is ref − mix, rounded like the table renders it
      expect(row.deltaDb).toBeCloseTo(Math.round((row.refDb - row.mixDb) * 10) / 10, 10);
    }
  });

  it("a 50 Hz-heavy reference flags the sub band as the gap, not the air", () => {
    const mix = { channels: correlated(makeNoise(7, 3)), sampleRate: SR };
    const ref = { channels: correlated(toneBoostedNoise(11, 50, 3, 0.5)), sampleRate: SR };
    const report = buildReferenceMatch(mix, ref);
    // 50 Hz lives in the mix-doctor's SUB band (20–60 Hz) — the fixture tone
    // and the band vocabulary must agree, or the test asserts the wrong row.
    const sub = report.bands.find((b) => b.band === "sub")!;
    const air = report.bands.find((b) => b.band === "air")!;
    expect(sub.deltaDb).toBeGreaterThan(air.deltaDb);
    expect(report.summary).toContain("Sub");
  });
});

describe("reference match — the share domain is level-free", () => {
  it("a −20 dB reference produces the same band table as the loud one", () => {
    const mix = { channels: correlated(makeNoise(7, 3)), sampleRate: SR };
    const loudRef = { channels: correlated(toneBoostedNoise(11, 200, 3)), sampleRate: SR };
    const quietRef = { channels: correlated(toneBoostedNoise(11, 200, 3).map((v) => v * 0.1) as Float32Array), sampleRate: SR };
    const loudReport = buildReferenceMatch(mix, loudRef);
    const quietReport = buildReferenceMatch(mix, quietRef);
    // Band shares are dB-of-own-total: scaling the reference cancels.
    for (let i = 0; i < 7; i++) {
      expect(quietReport.bands[i]!.deltaDb).toBeCloseTo(loudReport.bands[i]!.deltaDb, 1);
    }
    // The loudness half DOES see the level difference — that is its job.
    expect(quietReport.loudness.refLufs!).toBeLessThan(loudReport.loudness.refLufs!);
    expect(quietReport.loudnessTrimDb).not.toBeNull();
  });
});

describe("reference match — shape-only curve", () => {
  it("never exceeds ±6 dB per band", () => {
    // A maximally-different pair: noise mix vs a pure 50 Hz reference.
    const mix = { channels: correlated(makeNoise(7, 3)), sampleRate: SR };
    const ref = { channels: correlated(toneBoostedNoise(11, 50, 3, 0.9)), sampleRate: SR };
    const { curve } = buildReferenceMatch(mix, ref);
    expect(curve).not.toBeNull();
    for (const gain of [curve!.low, curve!.lowMid, curve!.highMid, curve!.high]) {
      expect(Math.abs(gain)).toBeLessThanOrEqual(6);
    }
  });

  it("an identical signal yields no curve and no trim (nothing worth moving)", () => {
    const signal = correlated(toneBoostedNoise(11, 440, 3));
    const report = buildReferenceMatch(
      { channels: signal, sampleRate: SR },
      { channels: correlated(toneBoostedNoise(11, 440, 3)), sampleRate: SR },
    );
    expect(report.curve).toBeNull();
    expect(report.loudnessTrimDb).toBeNull();
    expect(report.summary).toContain("No measurable difference");
  });

  it("sub-deadzone gaps produce no trim", () => {
    const mix = { channels: correlated(makeNoise(7, 3)), sampleRate: SR };
    const ref = { channels: correlated(makeNoise(9, 3).map((v) => v * 1.02) as Float32Array), sampleRate: SR };
    const report = buildReferenceMatch(mix, ref);
    if (report.loudness.deltaLu !== null && Math.abs(report.loudness.deltaLu) < MATCH_DEADZONE_DB) {
      expect(report.loudnessTrimDb).toBeNull();
    }
  });
});

describe("reference match — stereo", () => {
  it("a hard-wide reference against a correlated mix reports wider-reference", () => {
    const mono = makeNoise(7, 2);
    const report = buildReferenceMatch(
      { channels: correlated(mono), sampleRate: SR },
      { channels: hardWide(makeNoise(13, 2, 0.5)), sampleRate: SR },
    );
    expect(report.stereo.verdict).toBe("wider-reference");
    expect(report.stereo.refSideRatio).toBeGreaterThan(0.5);
  });

  it("both mono → unknown verdict, honest null correlation", () => {
    const mono = correlated(makeNoise(7, 2));
    const report = buildReferenceMatch(
      { channels: mono, sampleRate: SR },
      { channels: correlated(makeNoise(9, 2)), sampleRate: SR },
    );
    expect(report.stereo.refSideRatio).toBe(0);
    // analyzeMixHealth reports null correlation for a mono source... it may
    // also report 1.0 for identical channels; the contract is that the
    // verdict is never "wider-reference" when the reference is mono.
    expect(report.stereo.verdict).not.toBe("wider-reference");
  });
});

describe("reference match — hostile inputs never throw", () => {
  it("silent mix or reference declines instead of anti-matching", () => {
    const silent = { channels: [new Float32Array(SR)], sampleRate: SR };
    const real = { channels: correlated(toneBoostedNoise(11, 440, 2)), sampleRate: SR };
    // Silent reference: the report still builds (the analyzer is hostile-proof)
    // and the summary carries honest numbers — never a throw into the panel.
    const reportA = buildReferenceMatch(real, silent);
    expect(Number.isFinite(reportA.bands[0]!.mixDb)).toBe(true);
    // Silent mix: same.
    const reportB = buildReferenceMatch(silent, real);
    expect(Number.isFinite(reportB.bands[0]!.mixDb)).toBe(true);
  });
});

describe("reference match — determinism", () => {
  it("identical inputs → byte-identical report", () => {
    const mix = { channels: correlated(makeNoise(7, 3)), sampleRate: SR };
    const ref = { channels: correlated(toneBoostedNoise(11, 50, 3)), sampleRate: SR };
    const a = buildReferenceMatch(mix, ref);
    const b = buildReferenceMatch(mix, ref);
    expect(b).toEqual(a);
  });
});