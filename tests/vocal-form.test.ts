import { describe, expect, it } from "vitest";
import { testDoc } from "./fixtures/doc";
import { normalizeIntent } from "../src/intent/normalize";
import { buildSong } from "../src/intent/song";
import { vocalSectionAdjust, vocalSpanEnergy } from "../src/vocal/form";
import type { VocalProfile } from "../src/vocal/types";

/**
 * V2 VOCAL-DRIVEN FORM — the singer's phrasing bends section energy/density.
 *
 * The genre form stays in charge; the voice only NUDGES (peaks lift, pauses
 * breathe). No profile (or flat 0.5 coverage) = zero adjust = legacy build.
 */

function makeProfile(curve: number[]): VocalProfile {
  return {
    version: 1,
    key: null,
    keyConfidence: 0,
    keyMeasured: false,
    tempoBpm: null,
    tempoConfidence: 0,
    tempoMeasured: false,
    energyCurve: curve,
    phrases: [],
    silenceRatio: 0,
    snrDb: 20,
    durationSec: curve.length * 2,
    bars: curve.length,
    bpm: 120,
    measured: true,
    profileHash: "vocalform1",
  };
}

describe("vocalSpanEnergy / vocalSectionAdjust (pure)", () => {
  it("returns null/zero without coverage", () => {
    expect(vocalSpanEnergy(null, 0, 8)).toBeNull();
    expect(vocalSpanEnergy(makeProfile([]), 0, 8)).toBeNull();
    expect(vocalSpanEnergy(makeProfile([0.9, 0.9]), 10, 4)).toBeNull();
    expect(vocalSectionAdjust(null, 0, 8)).toEqual({ energy: 0, density: 0 });
  });

  it("means the span and centers adjustments at 0.5", () => {
    const profile = makeProfile([0.9, 0.9, 0.9, 0.9]);
    expect(vocalSpanEnergy(profile, 0, 4)).toBeCloseTo(0.9, 6);
    const lifted = vocalSectionAdjust(profile, 0, 4);
    expect(lifted.energy).toBeCloseTo(0.24, 6);
    expect(lifted.density).toBeCloseTo(0.16, 6);
    const flat = makeProfile([0.5, 0.5, 0.5, 0.5]);
    expect(vocalSectionAdjust(flat, 0, 4)).toEqual({ energy: 0, density: 0 });
    const quiet = makeProfile([0.2, 0.2, 0.2, 0.2]);
    const adjust = vocalSectionAdjust(quiet, 0, 4);
    expect(adjust.energy).toBeCloseTo(-0.18, 6);
    expect(adjust.density).toBeCloseTo(-0.12, 6);
  });
});

describe("buildSong with a vocal profile", () => {
  const INTENT = normalizeIntent({ genre: "house", seed: "vocal-form" });
  // First 20 bars sung hard, the rest breathes.
  const PROFILE = makeProfile([...Array<number>(20).fill(0.9), ...Array<number>(24).fill(0.2)]);

  it("bends section content toward the take (hashes move)", async () => {
    const plain = await buildSong(testDoc(), INTENT, { yieldBetweenSections: false });
    const sung = await buildSong(testDoc(), INTENT, { yieldBetweenSections: false, vocalProfile: PROFILE });
    const hashes = (b: typeof plain) => b.sections.map((s) => s.pattern.generation?.outputContentHash);
    expect(hashes(sung)).not.toEqual(hashes(plain));
  }, 60_000);

  it("is deterministic with the same profile", async () => {
    const first = await buildSong(testDoc(), INTENT, { yieldBetweenSections: false, vocalProfile: PROFILE });
    const second = await buildSong(testDoc(), INTENT, { yieldBetweenSections: false, vocalProfile: PROFILE });
    const hashes = (b: typeof first) => b.sections.map((s) => s.pattern.generation?.outputContentHash);
    expect(hashes(second)).toEqual(hashes(first));
  }, 60_000);
});
