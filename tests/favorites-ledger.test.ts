import { describe, it, expect, beforeEach } from "vitest";
import {
  buildFavoritesPack,
  clearFavoriteLedger,
  favoritesToDrumSamples,
  readFavoriteLedger,
  recordFavoriteLedgerEntry,
  type FavoriteLedgerEntry,
} from "../src/intent/favorites";
import { PRIOR_FEATURE_COUNT, PRIOR_STYLE_VOCAB } from "../src/ai/symbolic/prior-features";

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
