import { describe, it, expect, beforeEach } from "vitest";
import {
  buildFavoritesPack,
  clearFavoriteLedger,
  favoritesToDrumSamples,
  favoritesToMelodicSamples,
  readFavoriteLedger,
  recordFavoriteLedgerEntry,
  roleForTrack,
  type FavoriteLedgerEntry,
} from "../src/intent/favorites";
import { PRIOR_FEATURE_COUNT, PRIOR_STYLE_VOCAB } from "../src/ai/symbolic/prior-features";
import { MELODIC_FEATURE_COUNT } from "../src/ai/symbolic/melodic-features";
import { degreeToPitch } from "../src/ai/melodic";
import { SCALE_INTERVALS } from "../src/project-model/scales";
import { STEP_TICKS } from "../src/project-model/types";

function makeEntry(overrides: Partial<FavoriteLedgerEntry> = {}): FavoriteLedgerEntry {
  const padIds = ["pad-a", "pad-b", "pad-c", "pad-d"];
  return {
    savedAt: 1_700_000_000_000,
    seed: "seed-1",
    genre: "house",
    grooveId: "house.deep",
    energy: 0.7,
    density: 0.5,
    complexity: 0.5,
    variation: 0.3,
    padIds,
    padNames: ["Kick Deep", "Snare", "Hat Closed", "Rim"],
    rows: {
      "pad-a": [0.9, 0, 0, 0, 0.8, 0, 0, 0],
      "pad-b": [0, 0, 0.6, 0, 0, 0, 0.6, 0],
      "pad-c": [0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4],
      "pad-d": [0, 0, 0, 0, 0, 0, 0, 0],
    },
    ...overrides,
  };
}

beforeEach(() => {
  clearFavoriteLedger();
});

describe("favorites ledger", () => {
  it("records and reads entries", () => {
    recordFavoriteLedgerEntry(makeEntry());
    expect(readFavoriteLedger().length).toBe(1);
    expect(readFavoriteLedger()[0].grooveId).toBe("house.deep");
  });

  it("dedupes on seed+grooveId", () => {
    recordFavoriteLedgerEntry(makeEntry());
    recordFavoriteLedgerEntry(makeEntry({ savedAt: 2_000 }));
    expect(readFavoriteLedger().length).toBe(1);
    expect(readFavoriteLedger()[0].savedAt).toBe(2_000);
  });

  it("caps the ledger at 200 entries FIFO", () => {
    for (let index = 0; index < 210; index++) {
      recordFavoriteLedgerEntry(makeEntry({ seed: `seed-${index}` }));
    }
    const ledger = readFavoriteLedger();
    expect(ledger.length).toBe(200);
    expect(ledger[0].seed).toBe("seed-10"); // oldest trimmed
    expect(ledger[199].seed).toBe("seed-209");
  });

  it("builds a versioned pack", () => {
    recordFavoriteLedgerEntry(makeEntry());
    const pack = buildFavoritesPack();
    expect(pack.version).toBe(1);
    expect(pack.entries.length).toBe(1);
    expect(typeof pack.exportedAt).toBe("number");
  });
});

describe("favorites → training samples", () => {
  it("converts every (pad, step) into a weighted labeled sample", () => {
    const entry = makeEntry();
    const samples = favoritesToDrumSamples([entry]);
    const totalCells = entry.padIds.reduce((sum, id) => sum + entry.rows[id].length, 0);
    expect(samples.length).toBe(totalCells);
    for (const sample of samples) {
      expect(sample.x.length).toBe(PRIOR_FEATURE_COUNT);
      expect(sample.weight).toBe(3);
      expect([0, 1]).toContain(sample.y);
    }
    const hits = samples.filter((sample) => sample.y === 1).length;
    // kick(2) + snare(2) + hat(8) = 12 hits across the stub rows
    expect(hits).toBe(12);
  });

  it("maps pad names to roles via the vocabulary position", () => {
    const samples = favoritesToDrumSamples([makeEntry()]);
    // Kick Deep rows (pad index 0) — genre house one-hot at index 0
    const kickSample = samples[0];
    expect(kickSample.x[0]).toBe(1);
    // house.deep is index 3 in PRIOR_STYLE_VOCAB
    expect(kickSample.x[4 + PRIOR_STYLE_VOCAB.indexOf("house.deep")]).toBe(1);
    // first row labeled 0.9 → hit
    expect(kickSample.y).toBe(1);
    // rim row is all zeros → no hit in that range
    const rimStart = 3 * 8;
    expect(samples.slice(rimStart, rimStart + 8).every((sample) => sample.y === 0)).toBe(true);
  });

  it("skips entries outside the prior vocabulary or with mismatched pads", () => {
    const samples = favoritesToDrumSamples([
      makeEntry({ grooveId: "unknown.style" }),
      makeEntry({ padNames: ["only-one-name"] }),
    ]);
    expect(samples).toEqual([]);
  });
});

describe("melodic favorites → next-note samples (C1)", () => {
  // house bass: octaveOffset 0, root C=0, natural minor intervals
  const minorIntervals = SCALE_INTERVALS.natural_minor;
  const bassPitch = (degree: number) => degreeToPitch(degree, 0, 0, minorIntervals);
  const stepTicks = STEP_TICKS;

  function makeMelodicEntry(overrides: Partial<FavoriteLedgerEntry> = {}): FavoriteLedgerEntry {
    return makeEntry({
      key: "C Natural Minor",
      length: 16,
      style: "deep",
      melodic: [
        {
          role: "bass" as const,
          trackName: "Bass",
          notes: [
            { pitch: bassPitch(0), start: 0, duration: 2 * stepTicks, velocity: 0.8 },
            { pitch: bassPitch(4), start: 2 * stepTicks, duration: 2 * stepTicks, velocity: 0.7 },
          ],
        },
      ],
      ...overrides,
    });
  }

  it("inverts pitches to in-key degrees through the recorded key", () => {
    const samples = favoritesToMelodicSamples([makeMelodicEntry()]);
    expect(samples.length).toBe(2);
    expect(samples[0].degree).toBe(1); // degree 0 → class 1
    expect(samples[1].degree).toBe(5); // degree 4 → class 5
    expect(samples[0].duration).toBe(1); // 2 steps → class 1
    expect(samples[0].weight).toBe(3);
    expect(samples[0].x.length).toBe(MELODIC_FEATURE_COUNT);
    // walk context: second sample's prevDegree was the first's degree (0 → class 1)
    expect(samples[1].x[12 + 1]).toBe(1);
  });

  it("collapses chord voicings to their root (lowest pitch per start)", () => {
    const root = bassPitch(0);
    const third = root + 3;
    const fifth = root + 7;
    const entry = makeMelodicEntry({
      melodic: [
        {
          role: "chord" as const,
          trackName: "Chords",
          notes: [
            { pitch: fifth, start: 0, duration: 4 * stepTicks, velocity: 0.5 },
            { pitch: root, start: 0, duration: 4 * stepTicks, velocity: 0.6 },
            { pitch: third, start: 0, duration: 4 * stepTicks, velocity: 0.5 },
          ],
        },
      ],
    });
    const samples = favoritesToMelodicSamples([entry]);
    expect(samples.length).toBe(1); // 3 voicing notes → 1 root event
    expect(samples[0].degree).toBe(1); // root degree 0
    expect(samples[0].duration).toBe(2); // 4 steps → class 2
  });

  it("skips entries without a recorded key (pitch inversion impossible)", () => {
    const entry = makeMelodicEntry({ key: null, melodic: makeMelodicEntry().melodic });
    expect(favoritesToMelodicSamples([entry])).toEqual([]);
  });

  it("resolves track roles by name, then positionally", () => {
    expect(roleForTrack("Deep Bass", 2)).toBe("bass");
    expect(roleForTrack("Pad Chords", 0)).toBe("chord");
    expect(roleForTrack("Synth Lead", 1)).toBe("lead");
    expect(roleForTrack("Instrument 1", 0)).toBe("bass");
    expect(roleForTrack("Instrument 2", 1)).toBe("chord");
    expect(roleForTrack("Instrument 3", 2)).toBe("lead");
    expect(roleForTrack("Instrument 4", 3)).toBeNull();
  });
});
