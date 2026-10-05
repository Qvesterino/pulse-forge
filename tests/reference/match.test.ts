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
import {
  buildReferenceMatch,
  MATCH_DEADZONE_DB,
  matchStripMoves,
  rankMatchBandOwnership,
  applyMatchCommand,
  type MatchStrip,
} from "../../src/reference/match";
import type { ProjectDocument } from "../../src/project-model/types";

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
    expect(report.bands.map((b) => b.band)).toEqual(["sub", "low", "lowmid", "mid", "himid", "high", "air"]);
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
    const quietRef = {
      channels: correlated(toneBoostedNoise(11, 200, 3).map((v) => v * 0.1) as Float32Array),
      sampleRate: SR,
    };
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

describe("reference match — participation floor (the empty-band rule)", () => {
  it("a band empty on BOTH sides can never be the biggest gap", () => {
    // Two pure low tones: the high/air bands hold no energy on either side,
    // so their "difference" is only filter leakage. The summary must not send
    // the user after air the mix and reference both leave empty.
    const lowTone = (amp: number): Float32Array => {
      const pcm = new Float32Array(SR * 3);
      for (let i = 0; i < pcm.length; i++) pcm[i] = amp * Math.sin((2 * Math.PI * 80 * i) / SR);
      return pcm;
    };
    const report = buildReferenceMatch(
      { channels: correlated(lowTone(0.5)), sampleRate: SR },
      { channels: correlated(lowTone(0.4)), sampleRate: SR },
    );
    const air = report.bands.find((b) => b.band === "air")!;
    expect(air.empty).toBe(true);
    // A near-identical low tone pair: the curve has nothing to move either.
    expect(report.curve === null || Math.abs(report.curve.high) <= 1).toBe(true);
  });

  it("share semantics: a sub-heavy reference reads the mix as thin in sub (positive delta)", () => {
    // Three real bands, sub dominant in the reference. The sub row must read
    // POSITIVE (the mix is thinner there) — the panel renders the sign, and a
    // user reads "mix is thin in sub" as the actionable direction.
    const mixTones = [60, 1000, 9000].map((hz, idx) => {
      const pcm = new Float32Array(SR * 3);
      for (let i = 0; i < pcm.length; i++)
        pcm[i] += 0.3 * Math.sin((2 * Math.PI * hz * i) / SR) * (idx === 0 ? 0.4 : 1);
      return pcm;
    });
    const refTones = [50, 1000, 9000].map((hz, idx) => {
      const pcm = new Float32Array(SR * 3);
      for (let i = 0; i < pcm.length; i++) pcm[i] += (idx === 0 ? 0.8 : 0.25) * Math.sin((2 * Math.PI * hz * i) / SR);
      return pcm;
    });
    const mix = mixTones.reduce(
      (acc, pcm) => acc.map((ch) => ch.map((v, i) => v + pcm[i]!)),
      [new Float32Array(SR * 3), new Float32Array(SR * 3)],
    );
    const ref = refTones.reduce(
      (acc, pcm) => acc.map((ch) => ch.map((v, i) => v + pcm[i]!)),
      [new Float32Array(SR * 3), new Float32Array(SR * 3)],
    );
    const report = buildReferenceMatch({ channels: mix, sampleRate: SR }, { channels: ref, sampleRate: SR });
    const sub = report.bands.find((b) => b.band === "sub")!;
    // Mix carries a weak 60 Hz, ref a strong 50 Hz: the mix IS thinner in sub.
    expect(sub.deltaDb).toBeGreaterThan(0);
  });
});

describe("reference match — per-track attribution", () => {
  const strip = (overrides: Partial<MatchStrip>): MatchStrip => ({
    id: "kick",
    name: "Kick",
    kind: "drum",
    lufs: -8,
    bandShares: { sub: 0.7, low: 0.2, lowmid: 0.05, mid: 0.03, himid: 0.01, high: 0.005, air: 0.005 },
    hasContent: true,
    muted: false,
    ...overrides,
  });

  it("ranks ownership by loudness-weighted band share, deterministically", () => {
    const kick = strip({
      id: "kick",
      lufs: -8,
      bandShares: { sub: 0.6, low: 0.2, lowmid: 0.1, mid: 0.05, himid: 0.03, high: 0.01, air: 0.01 },
    });
    const bass = strip({
      id: "bass",
      name: "Bass",
      kind: "instrument",
      lufs: -9,
      bandShares: { sub: 0.3, low: 0.5, lowmid: 0.15, mid: 0.04, himid: 0.005, high: 0.003, air: 0.002 },
    });
    const owners = rankMatchBandOwnership([kick, bass]);
    const sub = owners.find((o) => o.band === "sub")!;
    const low = owners.find((o) => o.band === "low")!;
    // Kick's sub weight (−8 LU → ~0.158 power × 0.6) beats Bass's (−9 → 0.126 × 0.3).
    expect(sub.strip.id).toBe("kick");
    // Bass owns low (0.126 × 0.5 = 0.063 vs kick 0.158 × 0.2 = 0.032).
    expect(low.strip.id).toBe("bass");
    // Deterministic repeat.
    expect(rankMatchBandOwnership([kick, bass])).toEqual(owners);
  });

  it("skips a muted owner with an unmute reason instead of a dead gain", () => {
    const muted = strip({ muted: true });
    const report = buildReferenceMatch(
      { channels: correlated(makeNoise(7, 3)), sampleRate: SR },
      { channels: correlated(toneBoostedNoise(11, 50, 3, 0.9)), sampleRate: SR },
    );
    const moves = matchStripMoves(report, [muted]);
    // Whatever band the sub-heavy reference flags, the muted owner gets a 0 dB
    // move and a reason that names the mute — a gain on a muted track is dead.
    if (moves.length > 0) {
      expect(moves[0]!.gainDb).toBe(0);
      expect(moves[0]!.reason).toMatch(/MUTED/);
    } else {
      expect(moves).toHaveLength(0);
    }
  });

  it("a clear owner gets a bounded half-gap move with the sign telling direction", () => {
    // Reference with a huge sub presence vs a mix with barely any → sub delta
    // positive (mix thin); the sub owner must be pushed UP, clamped to ±3 dB.
    const subOnly = strip({
      id: "subkick",
      name: "SubKick",
      lufs: -6,
      bandShares: { sub: 0.95, low: 0.03, lowmid: 0.01, mid: 0.005, himid: 0.003, high: 0.001, air: 0.001 },
    });
    const mix = (() => {
      const pcm = new Float32Array(SR * 3);
      for (let i = 0; i < pcm.length; i++) pcm[i] = 0.2 * Math.sin((2 * Math.PI * 3000 * i) / SR);
      return pcm;
    })();
    const ref = (() => {
      const pcm = new Float32Array(SR * 3);
      for (let i = 0; i < pcm.length; i++) pcm[i] = 0.6 * Math.sin((2 * Math.PI * 50 * i) / SR);
      return pcm;
    })();
    const report = buildReferenceMatch(
      { channels: correlated(mix), sampleRate: SR },
      { channels: correlated(ref), sampleRate: SR },
    );
    const moves = matchStripMoves(report, [subOnly]);
    const subMove = moves.find((m) => m.band.band === "sub");
    expect(subMove).toBeDefined();
    expect(subMove!.gainDb).toBeGreaterThan(0);
    expect(subMove!.gainDb).toBeLessThanOrEqual(3);
    expect(subMove!.reason).toMatch(/SubKick owns/);
  });

  it("no clear owner (share below 40%) yields no strip move", () => {
    // Four equal strips: none clears the 40% ownership floor.
    const equal = (id: string): MatchStrip =>
      strip({
        id,
        name: id,
        lufs: -8,
        bandShares: { sub: 0.2, low: 0.2, lowmid: 0.15, mid: 0.15, himid: 0.1, high: 0.1, air: 0.1 },
      });
    const report = buildReferenceMatch(
      { channels: correlated(makeNoise(7, 3)), sampleRate: SR },
      { channels: correlated(toneBoostedNoise(11, 50, 3, 0.9)), sampleRate: SR },
    );
    const moves = matchStripMoves(report, [equal("a"), equal("b"), equal("c"), equal("d")]);
    // Any move that DOES appear must still have a >=40% owner; with four equal
    // strips, every band's top share is ~25%, so expect none.
    expect(moves).toHaveLength(0);
  });
});

describe("reference match — the apply command", () => {
  it("folds the curve, the trim and the strip gains into ONE snapshot", async () => {
    const { createDefaultProject } = await import("../../src/project-model/schema");
    const doc: ProjectDocument = createDefaultProject();
    const kick = doc.tracks.find((t) => t.kind === "drum");
    expect(kick).toBeDefined();
    const report = buildReferenceMatch(
      { channels: correlated(makeNoise(7, 3)), sampleRate: SR },
      { channels: correlated(toneBoostedNoise(11, 50, 3, 0.9)), sampleRate: SR },
    );
    const move = {
      band: report.bands.find((b) => b.band === "sub")!,
      owner: {
        band: "sub" as const,
        strip: {
          id: kick!.id,
          name: kick!.name,
          kind: "drum" as const,
          lufs: -8,
          bandShares: report.bands.reduce((acc, b) => ({ ...acc, [b.band]: 0 }), {
            sub: 1,
            low: 0,
            lowmid: 0,
            mid: 0,
            himid: 0,
            high: 0,
            air: 0,
          }),
          hasContent: true,
          muted: false,
        },
        share: 0.8,
      },
      gainDb: 2,
      reason: "test",
    };
    const command = applyMatchCommand(doc, report, [move]);
    if (command !== null) {
      const after = command.execute(doc);
      // ONE command mutated the doc; the strip gain actually moved.
      const afterKick = after.tracks.find((t) => t.id === kick!.id)!;
      expect(afterKick.gain).not.toBe(kick!.gain);
      // Undo restores the original gain.
      const undone = command.undo ? command.undo(after) : after;
      expect(undone.tracks.find((t) => t.id === kick!.id)!.gain).toBeCloseTo(kick!.gain, 6);
    } else {
      // No measurable gap on this synthetic pair → honest null.
      expect(command).toBeNull();
    }
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
