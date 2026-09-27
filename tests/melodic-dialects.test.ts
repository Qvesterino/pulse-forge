import { describe, it, expect } from "vitest";
import { generateMelodicParts, type MelodicParts } from "../src/ai/melodic";
import { generateOptionsFromIntent } from "../src/intent/song";
import { normalizeIntent } from "../src/intent/normalize";
import { forkRandom } from "../src/shared/rng";

/**
 * MELODIC DIALECTS (per-style pilot) — amapiano (log drum bass), dembow
 * (chop bass) and metal (gallop bass) get their own melodic reference
 * patterns, selected by `${genre}.${style}` between the production profile
 * and the genre fallback. The lane identity finally reaches the bass,
 * chords and lead — not just the drums.
 */

/** Strip the random per-note uid so comparisons are about music, not ids. */
function musical(parts: MelodicParts) {
  const strip = (notes: { pitch: number; start: number; duration: number; velocity: number }[]) =>
    notes.map((n) => ({ pitch: n.pitch, start: n.start, duration: n.duration, velocity: n.velocity }));
  return { bass: strip(parts.bass), chord: strip(parts.chord), lead: strip(parts.lead) };
}

function partsFor(genre: string, style?: string) {
  const options = generateOptionsFromIntent(
    normalizeIntent({ genre, ...(style ? { style } : {}), seed: "melodic-dialect-fixture", length: 64 }),
  );
  // ONE fixed rand stream across all variants — so alias/fallback tests
  // compare pattern-selection differences, not RNG differences.
  return generateMelodicParts(options, forkRandom("melodic-dialect-fixture", "melody"), "C Natural Minor");
}

describe("melodic dialects", () => {
  it("amapiano style produces a different bass than plain house", () => {
    const amapiano = partsFor("house", "amapiano");
    const house = partsFor("house");
    expect(amapiano.bass.length).toBeGreaterThan(0);
    expect(musical(amapiano).bass).not.toEqual(musical(house).bass);
    // the log drum answers off the grid — the bass carries offbeat notes
    const offbeatSteps = amapiano.bass.filter((note) => (note.start / 120) % 4 !== 0).length;
    expect(offbeatSteps, "log drum lives off the grid").toBeGreaterThan(0);
  });

  it("dembow bass differs from house and from amapiano", () => {
    const dembow = partsFor("house", "dembow");
    const house = partsFor("house");
    const amapiano = partsFor("house", "amapiano");
    expect(dembow.bass.length).toBeGreaterThan(0);
    expect(musical(dembow).bass).not.toEqual(musical(house).bass);
    expect(musical(dembow).bass).not.toEqual(musical(amapiano).bass);
  });

  it("metal gallop drives root-heavy 8ths", () => {
    const metal = partsFor("house", "metal");
    const house = partsFor("house");
    expect(metal.bass.length).toBeGreaterThan(0);
    expect(musical(metal).bass).not.toEqual(musical(house).bass);
    // metal chords are dark sustained power hits — different from house stabs
    expect(metal.chord.length).toBeGreaterThan(0);
    expect(musical(metal).chord).not.toEqual(musical(house).chord);
  });

  it("aliases share the dialect (dembowdom = dembow, thrash = metal)", () => {
    expect(musical(partsFor("house", "dembowdom")).bass).toEqual(musical(partsFor("house", "dembow")).bass);
    expect(musical(partsFor("house", "thrash")).bass).toEqual(musical(partsFor("house", "metal")).bass);
  });

  it("unknown style falls back to the genre patterns (byte-identical)", () => {
    const unknown = musical(partsFor("house", "nonexistentstyle"));
    const plain = musical(partsFor("house"));
    expect(unknown.bass).toEqual(plain.bass);
    expect(unknown.chord).toEqual(plain.chord);
    expect(unknown.lead).toEqual(plain.lead);
  });

  it("deterministic: same seed, same dialect, same output", () => {
    const a = musical(partsFor("house", "amapiano"));
    const b = musical(partsFor("house", "amapiano"));
    expect(a.bass).toEqual(b.bass);
    expect(a.lead).toEqual(b.lead);
  });

  it("key-safe: dialect notes snap to the requested scale", () => {
    const options = generateOptionsFromIntent(
      normalizeIntent({ genre: "house", style: "amapiano", seed: "melodic-dialect-fixture", length: 64 }),
    );
    const parts = generateMelodicParts(options, forkRandom("key-safety", "melody"), "C Natural Minor");
    // C natural minor pitch classes: C D Eb F G Ab Bb (0,2,3,5,7,8,10)
    const allowed = new Set([0, 2, 3, 5, 7, 8, 10]);
    for (const note of parts.bass) {
      expect(allowed.has(((note.pitch % 12) + 12) % 12)).toBe(true);
    }
  });
});
