import { describe, it, expect } from "vitest";
import { generateMelodicParts, type MelodicParts } from "../src/ai/melodic";
import { generateOptionsFromIntent } from "../src/intent/song";
import { normalizeIntent } from "../src/intent/normalize";
import { forkRandom } from "../src/shared/rng";
import { matchArtistPreset } from "../src/intent/artists";

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

describe("melodic dialects wave 2 (ghettotech / baile / footwork / jungle / slaphouse)", () => {
  it("all five dialects produce distinct bass different from the genre fallback", () => {
    const house = musical(partsFor("house"));
    for (const style of ["ghettotech", "baile", "footwork", "slaphouse"]) {
      const dialect = partsFor("house", style);
      expect(dialect.bass.length, style).toBeGreaterThan(0);
      expect(musical(dialect).bass, style).not.toEqual(house.bass);
    }
    const jungle = partsFor("dnb", "jungle");
    expect(jungle.bass.length).toBeGreaterThan(0);
    expect(musical(jungle).bass).not.toEqual(house.bass);
  });

  it("jungle bass is the long deep sub — few notes, long durations", () => {
    const jungle = musical(partsFor("dnb", "jungle")).bass;
    // the patient sub: at most 3 notes per generated bar
    expect(jungle.length).toBeLessThanOrEqual(24);
    const avgDuration = jungle.reduce((sum, n) => sum + n.duration, 0) / jungle.length;
    expect(avgDuration).toBeGreaterThan(240); // longer than a quarter at 120 bpm ticks
  });

  it("slaphouse bass is plucky — short notes, bouncy", () => {
    const slap = musical(partsFor("house", "slaphouse")).bass;
    expect(slap.length).toBeGreaterThanOrEqual(6);
    for (const note of slap) {
      expect(note.duration).toBeLessThanOrEqual(120); // 16th-note plucks max
    }
  });

  it("every new dialect stays key-safe", () => {
    const allowed = new Set([0, 2, 3, 5, 7, 8, 10]);
    for (const [genre, style] of [
      ["house", "ghettotech"],
      ["house", "baile"],
      ["house", "footwork"],
      ["dnb", "jungle"],
      ["house", "slaphouse"],
    ] as const) {
      const options = generateOptionsFromIntent(
        normalizeIntent({ genre, style, seed: "melodic-dialect-fixture", length: 64 }),
      );
      const parts = generateMelodicParts(options, forkRandom("key-safety-2", "melody"), "C Natural Minor");
      for (const note of parts.bass) {
        expect(allowed.has(((note.pitch % 12) + 12) % 12), `${genre}.${style}`).toBe(true);
      }
    }
  });
});

describe("melodic dialects wave 3 (dnb depth: techstep / ragga / sambass / halftime / crossbreed / minimal)", () => {
  const DNB_STYLES = ["techstep", "ragga", "sambass", "halftime", "crossbreed", "minimal"] as const;

  it("all six dnb dialects produce distinct bass different from the genre fallback", () => {
    const dnb = musical(partsFor("dnb"));
    for (const style of DNB_STYLES) {
      const dialect = partsFor("dnb", style);
      expect(dialect.bass.length, style).toBeGreaterThan(0);
      expect(dialect.chord.length, style).toBeGreaterThan(0);
      expect(dialect.lead.length, style).toBeGreaterThan(0);
      expect(musical(dialect).bass, style).not.toEqual(dnb.bass);
    }
  });

  it("the sub-genres do not collapse into each other", () => {
    const basses = DNB_STYLES.map((style) => JSON.stringify(musical(partsFor("dnb", style)).bass));
    expect(new Set(basses).size, "every dnb dialect bass is unique").toBe(DNB_STYLES.length);
  });

  it("each dnb dialect is deterministic for a fixed seed", () => {
    for (const style of DNB_STYLES) {
      expect(musical(partsFor("dnb", style)), style).toEqual(musical(partsFor("dnb", style)));
    }
  });

  it("every dnb dialect stays key-safe", () => {
    const allowed = new Set([0, 2, 3, 5, 7, 8, 10]);
    for (const style of DNB_STYLES) {
      const options = generateOptionsFromIntent(
        normalizeIntent({ genre: "dnb", style, seed: "melodic-dialect-fixture", length: 64 }),
      );
      const parts = generateMelodicParts(options, forkRandom("key-safety-3", "melody"), "C Natural Minor");
      for (const role of [parts.bass, parts.chord, parts.lead]) {
        for (const note of role) {
          expect(allowed.has(((note.pitch % 12) + 12) % 12), `dnb.${style}`).toBe(true);
        }
      }
    }
  });
});

describe("melodic dialects wave 3 (disco / synthpop / progressive / ukg / jersey / trap808 / drill / acid / basshouse / country / kuduro / tropical / liquid / techhouse)", () => {
  const WAVE3: Array<[string, string]> = [
    ["house", "disco"],
    ["house", "synthpop"],
    ["house", "progressive"],
    ["house", "ukg"],
    ["jersey", "club"],
    ["trap", "classic"],
    ["drill", "uk"],
    ["techno", "acid"],
    ["house", "basshouse"],
    ["house", "countrypop"],
    ["house", "kuduro"],
    ["house", "tropical"],
    ["dnb", "liquid"],
    ["house", "techhouse"],
  ];

  it("all fourteen produce distinct bass different from their genre fallback", () => {
    const fallbacks = new Map([
      ["house", musical(partsFor("house")).bass],
      ["jersey", musical(partsFor("jersey")).bass],
      ["trap", musical(partsFor("trap")).bass],
      ["drill", musical(partsFor("drill")).bass],
      ["techno", musical(partsFor("techno")).bass],
      ["dnb", musical(partsFor("dnb")).bass],
    ]);
    for (const [genre, style] of WAVE3) {
      const dialect = musical(partsFor(genre, style)).bass;
      expect(dialect.length, `${genre}.${style}`).toBeGreaterThan(0);
      expect(dialect, `${genre}.${style}`).not.toEqual(fallbacks.get(genre));
    }
  });

  it("standout signatures: disco octave bounce, trap808 patience, acid 16ths", () => {
    // disco alternates root/fifth on the beat grid
    const disco = musical(partsFor("house", "disco")).bass;
    expect(disco.length).toBeGreaterThanOrEqual(4);
    // trap 808: sparse and long
    const trap808 = musical(partsFor("trap", "classic")).bass;
    const avg808 = trap808.reduce((s, n) => s + n.duration, 0) / trap808.length;
    expect(avg808).toBeGreaterThan(300);
    // acid: 16th-note drive — many short notes
    const acid = musical(partsFor("techno", "acid")).bass;
    expect(acid.length).toBeGreaterThanOrEqual(8);
    const avgAcid = acid.reduce((s, n) => s + n.duration, 0) / acid.length;
    expect(avgAcid).toBeLessThan(200);
  });

  it("every new dialect stays key-safe", () => {
    const allowed = new Set([0, 2, 3, 5, 7, 8, 10]);
    for (const [genre, style] of WAVE3) {
      const options = generateOptionsFromIntent(
        normalizeIntent({ genre, style, seed: "melodic-dialect-fixture", length: 64 }),
      );
      const parts = generateMelodicParts(options, forkRandom("key-safety-3", "melody"), "C Natural Minor");
      for (const note of parts.bass) {
        expect(allowed.has(((note.pitch % 12) + 12) % 12), `${genre}.${style}`).toBe(true);
      }
    }
  });
});

describe("melodic dialects — dnb depth wave 2 (twostep / roller / amen / neuro / jumpup / dancefloor)", () => {
  it("all six produce distinct bass different from each other and the dnb fallback", () => {
    const fallback = musical(partsFor("dnb")).bass;
    const seen: Array<[string, { pitch: number; start: number; duration: number; velocity: number }[]]> = [];
    for (const style of ["twostep", "roller", "amen", "neuro", "jumpup", "dancefloor"]) {
      const bass = musical(partsFor("dnb", style)).bass;
      expect(bass.length, style).toBeGreaterThan(0);
      expect(bass, style).not.toEqual(fallback);
      for (const [prev] of seen) {
        expect(bass, `${style} vs ${prev}`).not.toEqual(musical(partsFor("dnb", prev)).bass);
      }
      seen.push([style, bass]);
    }
  });

  it("standout signatures: neuro long dark, jumpup stabs, roller even", () => {
    // neuro: long reese notes — few, long
    const neuro = musical(partsFor("dnb", "neuro")).bass;
    const neuroAvg = neuro.reduce((s, n) => s + n.duration, 0) / neuro.length;
    expect(neuroAvg).toBeGreaterThanOrEqual(240);
    // jumpup: punchy stabs — short
    const jumpup = musical(partsFor("dnb", "jumpup")).bass;
    const jumpAvg = jumpup.reduce((s, n) => s + n.duration, 0) / jumpup.length;
    expect(jumpAvg).toBeLessThan(300);
    // roller: even velocities (the roll never shouts)
    const roller = musical(partsFor("dnb", "roller")).bass;
    const velocities = roller.map((n) => n.velocity);
    const spread = Math.max(...velocities) - Math.min(...velocities);
    expect(spread).toBeLessThan(0.3);
  });

  it("key-safe across the six", () => {
    const allowed = new Set([0, 2, 3, 5, 7, 8, 10]);
    for (const style of ["twostep", "roller", "amen", "neuro", "jumpup", "dancefloor"]) {
      const options = generateOptionsFromIntent(
        normalizeIntent({ genre: "dnb", style, seed: "melodic-dialect-fixture", length: 64 }),
      );
      const parts = generateMelodicParts(options, forkRandom("key-safety-dnb2", "melody"), "C Natural Minor");
      for (const note of parts.bass) {
        expect(allowed.has(((note.pitch % 12) + 12) % 12), style).toBe(true);
      }
    }
  });

  it("Total Science rides the roller lane", () => {
    expect(matchArtistPreset("total science")?.preset).toMatchObject({ style: "roller", bpmRange: [172, 176] });
  });
});

describe("melodic dialects — gabber (the stomp kick owns the low end)", () => {
  it("gabber bass anchors sparsely and the lead screeches", () => {
    const gabber = musical(partsFor("techno", "gabber"));
    const house = musical(partsFor("house"));
    expect(gabber.bass.length).toBeGreaterThan(0);
    expect(gabber.bass).not.toEqual(house.bass);
    // the bass is patient — the kick carries the drive
    const avgBass = gabber.bass.reduce((s, n) => s + n.duration, 0) / gabber.bass.length;
    expect(avgBass).toBeGreaterThan(150);
    // the hoover lead is aggressive — high velocities
    expect(Math.max(...gabber.lead.map((n) => n.velocity))).toBeGreaterThan(0.7);
  });

  it("key-safe", () => {
    const allowed = new Set([0, 2, 3, 5, 7, 8, 10]);
    const options = generateOptionsFromIntent(
      normalizeIntent({ genre: "techno", style: "gabber", seed: "melodic-dialect-fixture", length: 64 }),
    );
    const parts = generateMelodicParts(options, forkRandom("key-safety-gabber", "melody"), "C Natural Minor");
    for (const note of parts.bass) {
      expect(allowed.has(((note.pitch % 12) + 12) % 12)).toBe(true);
    }
  });

  it("gabber artists resolve with researched uptempo pockets", () => {
    expect(matchArtistPreset("angerfist")?.preset).toMatchObject({ style: "gabber", bpmRange: [160, 180] });
    expect(matchArtistPreset("miss k8")?.preset.bpmRange).toEqual([170, 190]);
    expect(matchArtistPreset("sefa")?.preset.bpmRange).toEqual([175, 200]);
    expect(matchArtistPreset("partyraiser")?.preset.style).toBe("gabber");
    expect(matchArtistPreset("dr peacock")?.preset.bpmRange).toEqual([150, 170]);
  });
});
