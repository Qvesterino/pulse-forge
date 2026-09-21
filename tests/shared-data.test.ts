import { describe, expect, it } from "vitest";
import {
  accentOf,
  DEFAULT_THEME_STATE,
  hexOrHslToSoft,
  normalizeThemeState,
  THEME_PRESETS,
} from "../src/shared/theme-data";
import { DEFAULT_PAD_KEYS, normalizePadKeyMap } from "../src/shared/pad-keys-data";
import {
  dedupeAndCapLedger,
  isValidLedgerEntry,
  roleForTrack,
  LEDGER_CAP,
  type FavoriteLedgerEntry,
} from "../src/intent/favorites-core";

/**
 * GOAL 02 — pure behavior of the extracted shared data modules
 * (theme data, pad-key data, favorites ledger core).
 */

function makeEntry(overrides: Partial<FavoriteLedgerEntry> = {}): FavoriteLedgerEntry {
  return {
    savedAt: 1,
    seed: "seed-a",
    genre: "house",
    grooveId: "house.deep",
    energy: 0.5,
    density: 0.5,
    complexity: 0.5,
    variation: 0.5,
    padIds: ["kick"],
    padNames: ["Kick"],
    rows: { kick: [1, 0, 0, 0] },
    ...overrides,
  };
}

describe("theme-data (pure)", () => {
  it("presets have unique ids with molten first (first-paint parity)", () => {
    const ids = THEME_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe(DEFAULT_THEME_STATE.preset);
  });

  it("normalizeThemeState clamps hue/scale and falls back to the default preset", () => {
    expect(normalizeThemeState({})).toEqual(DEFAULT_THEME_STATE);
    expect(normalizeThemeState({ preset: "no-such-preset" }).preset).toBe(DEFAULT_THEME_STATE.preset);
    expect(normalizeThemeState({ hue: 400 }).hue).toBe(359);
    expect(normalizeThemeState({ hue: -5 }).hue).toBe(0);
    expect(normalizeThemeState({ hue: 120.6 }).hue).toBe(121);
    expect(normalizeThemeState({ hue: Number.NaN }).hue).toBeNull();
    expect(normalizeThemeState({ scale: 2 }).scale).toBe(DEFAULT_THEME_STATE.scale);
    expect(normalizeThemeState({ scale: 1.15 }).scale).toBe(1.15);
    // strict booleans — truthy non-true values do not enable
    expect(normalizeThemeState({ compact: true }).compact).toBe(true);
    expect(normalizeThemeState({ compact: "yes" as unknown as boolean }).compact).toBe(false);
  });

  it("accentOf prefers the custom hue over the preset accent", () => {
    expect(accentOf({ ...DEFAULT_THEME_STATE, hue: 200 })).toBe("hsl(200, 85%, 60%)");
    expect(accentOf(DEFAULT_THEME_STATE)).toBe("#f59e0b");
    expect(accentOf({ ...DEFAULT_THEME_STATE, preset: "contrast" })).toBe("#ffffff");
  });

  it("hexOrHslToSoft converts hex and hsl accents, falling back safely", () => {
    expect(hexOrHslToSoft("#ff8800")).toBe("rgba(255, 136, 0, 0.14)");
    expect(hexOrHslToSoft("hsl(10, 20%, 30%)")).toBe("hsla(10, 20%, 30%, 0.14)");
    expect(hexOrHslToSoft("not-a-colour")).toBe("rgba(255, 255, 255, 0.14)");
  });
});

describe("pad-keys-data (pure)", () => {
  it("accepts a valid 16-key map untouched (lowercased)", () => {
    const map = [..."qwertyuiasdfghjk"];
    expect(normalizePadKeyMap(map)).toEqual(map);
  });

  it("rejects duplicates, reserved and malformed entries via default fallback", () => {
    const out = normalizePadKeyMap(["q", "q", "escape", "ab", 5, ...Array(11).fill("z")]);
    expect(out[0]).toBe("q");
    expect(out[1]).toBe("w"); // duplicate q falls back to the slot default
    expect(out[2]).toBe("e"); // reserved key falls back
    expect(out[3]).toBe("r"); // multi-char falls back
    expect(out[4]).toBe("t"); // non-string falls back
    expect(out).toHaveLength(16);
    expect(out.every((k) => typeof k === "string")).toBe(true);
  });

  it("non-array input yields the default grid", () => {
    expect(normalizePadKeyMap(null)).toEqual([...DEFAULT_PAD_KEYS]);
    expect(normalizePadKeyMap("qwerty")).toEqual([...DEFAULT_PAD_KEYS]);
  });
});

describe("favorites-core (pure ledger policy)", () => {
  it("isValidLedgerEntry accepts minimal v1 entries and rejects garbage", () => {
    expect(isValidLedgerEntry(makeEntry())).toBe(true);
    expect(isValidLedgerEntry({ seed: "s", grooveId: "g", padIds: [] })).toBe(true);
    expect(isValidLedgerEntry(null)).toBe(false);
    expect(isValidLedgerEntry("entry")).toBe(false);
    expect(isValidLedgerEntry({ seed: 5, grooveId: "g", padIds: [] })).toBe(false);
    expect(isValidLedgerEntry({ seed: "s", grooveId: "g" })).toBe(false);
  });

  it("dedupeAndCapLedger replaces same seed+grooveId and caps FIFO to the newest", () => {
    const first = makeEntry({ seed: "s1" });
    const ledger = dedupeAndCapLedger([], first);
    expect(ledger).toHaveLength(1);
    const replacement = makeEntry({ seed: "s1", savedAt: 99 });
    expect(dedupeAndCapLedger(ledger, replacement)).toEqual([replacement]);

    const flooded = dedupeAndCapLedger(
      Array.from({ length: LEDGER_CAP }, (_, i) => makeEntry({ seed: `old-${i}`, savedAt: i })),
      makeEntry({ seed: "new" }),
    );
    expect(flooded).toHaveLength(LEDGER_CAP);
    expect(flooded.at(-1)?.seed).toBe("new");
    expect(flooded[0]!.seed).toBe("old-1"); // oldest entry evicted
  });

  it("roleForTrack matches by name first, then falls back positionally", () => {
    expect(roleForTrack("Deep Bass", 2)).toBe("bass");
    expect(roleForTrack("Chords", 0)).toBe("chord");
    expect(roleForTrack("Lead Synth", 1)).toBe("lead");
    expect(roleForTrack("Pad Thing", 0)).toBe("bass");
    expect(roleForTrack("Pad Thing", 2)).toBe("lead");
    expect(roleForTrack("Pad Thing", 7)).toBeNull();
  });
});
