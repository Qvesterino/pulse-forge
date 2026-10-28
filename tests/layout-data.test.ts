import { describe, expect, it } from "vitest";
import { compressToEncodedURIComponent as compress } from "lz-string";
import {
  DENSITY_LEVELS,
  DEFAULT_LAYOUT_STATE,
  DOCK_HEIGHT_SHIFT,
  isCompactDensity,
  isTokenName,
  LAYOUT_BOUNDS,
  LAYOUT_MIGRATIONS,
  LAYOUT_SCHEMA_VERSION,
  LAYOUT_STORAGE_KEY,
  LEGACY_DOCK_KEY,
  LEGACY_THEME_KEY,
  LEGACY_V1_KEY,
  LEGACY_V2_KEY,
  MAX_COLOR_OVERRIDES,
  migrateLegacyLayout,
  normalizeLayoutState,
  normalizePanelId,
  PANEL_KEYS,
  resolveLayoutState,
  sanitizeColorOverrides,
  type Density,
  type LayoutState,
  type LayoutStorageSources,
} from "../src/shared/layout-data";
import { decodeLayoutCode, encodeLayoutCode, LAYOUT_CODE_PREFIX } from "../src/export/layoutCode";

/**
 * ADR 0036 — the unified layout contract.
 *
 * The migration is the risky part: a user who has spent months arranging their
 * dock must not lose it because we introduced a new storage key. These tests
 * pin both directions — the legacy data arrives intact, and the legacy keys are
 * NOT written back to (additive migration, so a downgrade keeps working).
 */

const fullState = (overrides: Partial<LayoutState> = {}): LayoutState => ({
  ...DEFAULT_LAYOUT_STATE,
  preset: "matrix",
  hue: 200,
  uiScale: 1.15,
  typeScale: 1.05,
  density: "dense",
  reduceMotion: true,
  dockHeight: 400,
  dockSplitRatio: 0.65,
  dockCollapsed: true,
  slotA: "devices",
  slotB: "arr",
  inspectorWidth: 340,
  sequencerLabelWidth: 200,
  rackColumns: 12,
  colorOverrides: { "--bg-panel": "#101010" },
  ...overrides,
});

describe("layout-data · panel registry is the single source of truth", () => {
  it("exposes the 14 panels and keeps them unique", () => {
    expect(PANEL_KEYS).toHaveLength(14);
    expect(new Set(PANEL_KEYS).size).toBe(PANEL_KEYS.length);
  });

  it("legacy fx/plugin ids canonicalize to devices", () => {
    expect(normalizePanelId("fx")).toBe("devices");
    expect(normalizePanelId("plugin")).toBe("devices");
    expect(normalizePanelId("devices")).toBe("devices");
    expect(normalizePanelId("hacked")).toBeNull();
    expect(normalizePanelId(null)).toBeNull();
    expect(normalizePanelId(7)).toBeNull();
  });
});

describe("layout-data · normalization clamps and rejects", () => {
  it("clamps every finite number into the legal band (one rule, no per-field policy)", () => {
    // A numeric value carries DIRECTION, so the nearest legal reading preserves
    // intent. A 800px dock from a build whose ceiling was 800 lands on today's
    // 560px ceiling — still "a tall dock", not a reset to the 220px default.
    // This is the same rule decodeThemeCode already applies to an imported scale.
    const state = normalizeLayoutState({
      uiScale: 5,
      typeScale: 99,
      dockHeight: 1,
      dockSplitRatio: 5,
      inspectorWidth: 9999,
      sequencerLabelWidth: 40,
      rackColumns: 2,
    });
    expect(state.uiScale).toBe(LAYOUT_BOUNDS.uiScale.max);
    expect(state.typeScale).toBe(LAYOUT_BOUNDS.typeScale.max);
    expect(state.dockHeight).toBe(LAYOUT_BOUNDS.dockHeight.min);
    expect(state.dockSplitRatio).toBe(LAYOUT_BOUNDS.dockSplitRatio.max);
    expect(state.inspectorWidth).toBe(LAYOUT_BOUNDS.inspectorWidth.max);
    expect(state.sequencerLabelWidth).toBe(LAYOUT_BOUNDS.sequencerLabelWidth.min);
    expect(state.rackColumns).toBe(LAYOUT_BOUNDS.rackColumns.min);
  });

  it("leaves an in-band value untouched — clamping must not quantize a legal choice", () => {
    // 1.29 is a legal uiScale the slider can produce; normalizing must return it
    // verbatim, not round it up to the ceiling.
    const state = normalizeLayoutState({ uiScale: 1.29, typeScale: 0.93, inspectorWidth: 311 });
    expect(state.uiScale).toBe(1.29);
    expect(state.typeScale).toBe(0.93);
    expect(state.inspectorWidth).toBe(311);
  });

  it("falls back to the DEFAULT for values that carry no direction at all", () => {
    // No direction to preserve, so inventing one would be a lie.
    const state = normalizeLayoutState({
      uiScale: Number.NaN,
      typeScale: Number.POSITIVE_INFINITY,
      dockHeight: "400" as unknown as number,
      inspectorWidth: null as unknown as number,
    });
    expect(state.uiScale).toBe(DEFAULT_LAYOUT_STATE.uiScale);
    expect(state.typeScale).toBe(DEFAULT_LAYOUT_STATE.typeScale);
    expect(state.dockHeight).toBe(DEFAULT_LAYOUT_STATE.dockHeight);
    expect(state.inspectorWidth).toBe(DEFAULT_LAYOUT_STATE.inspectorWidth);
  });

  it("rejects NaN/Infinity and non-numeric input", () => {
    const state = normalizeLayoutState({
      uiScale: Number.NaN,
      inspectorWidth: Number.POSITIVE_INFINITY,
      dockHeight: "400" as unknown as number,
    });
    expect(state.uiScale).toBe(DEFAULT_LAYOUT_STATE.uiScale);
    expect(state.inspectorWidth).toBe(DEFAULT_LAYOUT_STATE.inspectorWidth);
    expect(state.dockHeight).toBe(DEFAULT_LAYOUT_STATE.dockHeight);
  });

  it("survives a non-object payload without throwing", () => {
    for (const garbage of [null, undefined, "nope", 42, []] as unknown[]) {
      expect(() => normalizeLayoutState(garbage as Partial<LayoutState>)).not.toThrow();
      expect(normalizeLayoutState(garbage as Partial<LayoutState>)).toEqual(DEFAULT_LAYOUT_STATE);
    }
  });

  it("rejects an unknown density and keeps strict booleans", () => {
    expect(normalizeLayoutState({ density: "cosy" as Density }).density).toBe("comfortable");
    expect(normalizeLayoutState({ reduceMotion: "yes" as unknown as boolean }).reduceMotion).toBe(false);
    expect(DENSITY_LEVELS).toContain(normalizeLayoutState({ density: "dense" }).density);
  });

  it("replaces an unknown preset id with the default — the applier and the stored id must agree", () => {
    // presetById() silently maps an unknown id to the first preset. If the
    // stored id were kept as-is, applyLayoutToDocument and getLayoutSnapshot
    // would disagree about which palette is active.
    expect(normalizeLayoutState({ preset: "nope" }).preset).toBe("molten");
    expect(normalizeLayoutState({ preset: "" }).preset).toBe("molten");
    expect(normalizeLayoutState({ preset: "cyan" }).preset).toBe("cyan");
  });

  it("hue rounds, and an out-of-band hue falls back to the preset (null)", () => {
    expect(normalizeLayoutState({ hue: 120.6 }).hue).toBe(121);
    expect(normalizeLayoutState({ hue: 999 }).hue).toBeNull();
    expect(normalizeLayoutState({ hue: -5 }).hue).toBeNull();
    expect(normalizeLayoutState({ hue: Number.NaN }).hue).toBeNull();
  });

  it("never lets one panel occupy both dock slots", () => {
    const state = normalizeLayoutState({ slotA: "arr", slotB: "arr" });
    expect(state.slotA).toBe("arr");
    expect(state.slotB).toBeNull();
  });

  it("rounds rackColumns to a whole number", () => {
    expect(normalizeLayoutState({ rackColumns: 9.6 }).rackColumns).toBe(10);
  });
});

describe("layout-data · color overrides are a controlled injection point", () => {
  it("accepts legal token names and color syntax", () => {
    const out = sanitizeColorOverrides({
      "--bg-panel": "#101010",
      "--accent": "rgba(245, 158, 11, 0.5)",
      "--text": "hsl(200, 85%, 60%)",
      "--border": "rebeccapurple",
    });
    expect(out).toEqual({
      "--bg-panel": "#101010",
      "--accent": "rgba(245, 158, 11, 0.5)",
      "--text": "hsl(200, 85%, 60%)",
      "--border": "rebeccapurple",
    });
  });

  it("drops malformed names and values — the map is written into a style declaration", () => {
    const out = sanitizeColorOverrides({
      background: "#fff", // no leading dashes
      "--bad name": "#fff",
      "--ok": "url(javascript:alert(1))",
      "--also-ok": "  #abcdef  ",
      "0": "#fff",
    });
    expect(out).toEqual({ "--also-ok": "#abcdef" });
  });

  it("rejects non-object input and caps the map size", () => {
    expect(sanitizeColorOverrides(null)).toEqual({});
    expect(sanitizeColorOverrides("nope")).toEqual({});
    const flood: Record<string, string> = {};
    for (let i = 0; i < MAX_COLOR_OVERRIDES + 40; i++) flood[`--t${i}`] = "#000000";
    expect(Object.keys(sanitizeColorOverrides(flood))).toHaveLength(MAX_COLOR_OVERRIDES);
  });

  it("isTokenName only accepts --kebab-case", () => {
    expect(isTokenName("--bg-panel")).toBe(true);
    expect(isTokenName("bg-panel")).toBe(false);
    expect(isTokenName("--bad name")).toBe(false);
    expect(isTokenName(5)).toBe(false);
  });
});

describe("layout-data · legacy migration (ADR 0036 §3)", () => {
  it("folds both legacy stores into one layout without losing user choices", () => {
    const theme = JSON.stringify({ preset: "violet", hue: 300, scale: 1.2, compact: true, reduceMotion: true });
    const dock = JSON.stringify({ height: 420, slotA: "devices", slotB: "arr" });

    const state = migrateLegacyLayout(theme, dock);
    expect(state.preset).toBe("violet");
    expect(state.hue).toBe(300);
    expect(state.uiScale).toBe(1.2);
    expect(state.reduceMotion).toBe(true);
    expect(state.dockHeight).toBe(420);
    expect(state.slotA).toBe("devices");
    expect(state.slotB).toBe("arr");
  });

  it("maps the legacy boolean compact onto the three-step density scale", () => {
    expect(migrateLegacyLayout(JSON.stringify({ compact: true }), null).density).toBe("compact");
    expect(migrateLegacyLayout(JSON.stringify({ compact: false }), null).density).toBe("comfortable");
    expect(isCompactDensity("compact")).toBe(true);
    expect(isCompactDensity("comfortable")).toBe(false);
    expect(isCompactDensity("dense")).toBe(false);
  });

  it("migrates a theme-only or dock-only user", () => {
    const themeOnly = migrateLegacyLayout(JSON.stringify({ preset: "cyan" }), null);
    expect(themeOnly.preset).toBe("cyan");
    // No dock blob ever existed — the dock keeps its defaults.
    expect(themeOnly.slotA).toBe("mixer");
    expect(themeOnly.slotB).toBeNull();

    const dockOnly = migrateLegacyLayout(null, JSON.stringify({ height: 300, slotA: "midi", slotB: null }));
    expect(dockOnly.slotA).toBe("midi");
    expect(dockOnly.preset).toBe(DEFAULT_LAYOUT_STATE.preset);
  });

  it("clamps a legacy dock height instead of trusting a stale 800px ceiling", () => {
    // A build before the 560px cap could persist 800. The stored intent is
    // clear (tall dock), so clamp rather than reset to the 220px default.
    const state = migrateLegacyLayout(null, JSON.stringify({ height: 800, slotA: "mixer" }));
    expect(state.dockHeight).toBe(LAYOUT_BOUNDS.dockHeight.max);
  });

  it("falls back to defaults on corrupt JSON instead of throwing", () => {
    expect(() => migrateLegacyLayout("{oops", "]oops[")).not.toThrow();
    expect(migrateLegacyLayout("{oops", null).preset).toBe(DEFAULT_LAYOUT_STATE.preset);
    // A non-object JSON body (an array, a bare string) is not a legacy blob.
    expect(migrateLegacyLayout("[1,2,3]", '"hello"').slotA).toBe(DEFAULT_LAYOUT_STATE.slotA);
  });

  it("canonicalizes legacy fx/plugin ids during migration", () => {
    const state = migrateLegacyLayout(null, JSON.stringify({ height: 300, slotA: "fx", slotB: "plugin" }));
    expect(state.slotA).toBe("devices");
    // Both slots resolved to the same panel, so the split is dropped.
    expect(state.slotB).toBeNull();
  });
});

/** No source has anything stored. */
const emptySources = (): LayoutStorageSources => ({
  current: null,
  v2: null,
  v1: null,
  theme: null,
  dock: null,
});

describe("layout-data · the storage schema is VERSIONED, not a reset", () => {
  it("uses defaults when nothing is stored", () => {
    const { state, migrated } = resolveLayoutState(emptySources());
    expect(state).toEqual(DEFAULT_LAYOUT_STATE);
    expect(migrated).toBe(false);
  });

  it("names a STABLE key and a schema version — a renamed key IS a reset", () => {
    // The key must not carry a version. Renaming the key is exactly what the
    // plan §5.1 forbids before the first real deployment: the old blob stops
    // being read, so the user's choices are gone.
    expect(LAYOUT_STORAGE_KEY).toBe("pf-layout");
    expect(LAYOUT_STORAGE_KEY).not.toMatch(/v\d/);
    expect(LAYOUT_SCHEMA_VERSION).toBe(2);
    expect(LEGACY_V2_KEY).toBe("pf-layout-v2");
    expect(LEGACY_V1_KEY).toBe("pf-layout-v1");
    expect(LEGACY_THEME_KEY).toBe("pf-theme-v1");
    expect(LEGACY_DOCK_KEY).toBe("pf-dock-v1");
  });

  it("reads a blob that carries the current schema version and does NOT re-migrate", () => {
    const { state, migrated } = resolveLayoutState({
      ...emptySources(),
      current: JSON.stringify({ ...fullState(), schemaVersion: LAYOUT_SCHEMA_VERSION }),
    });
    expect(state.rackColumns).toBe(12);
    expect(state.inspectorWidth).toBe(340);
    expect(state.dockHeight).toBe(400);
    expect(migrated).toBe(false);
  });

  it("SHIFTS a v1 dock height instead of wiping the layout", () => {
    // The v1 default (220) maps onto the v2 default (168) — the numeric shift
    // the plan asks for. A wipe would have thrown away the user's palette,
    // zoom and panels along with the number.
    const { state, migrated } = resolveLayoutState({
      ...emptySources(),
      v1: JSON.stringify({ ...fullState(), dockHeight: 220 }),
    });
    expect(state.dockHeight).toBe(DEFAULT_LAYOUT_STATE.dockHeight);
    expect(state.preset).toBe("matrix");
    expect(state.hue).toBe(200);
    expect(state.slotA).toBe("devices");
    expect(migrated).toBe(true);
  });

  it("keeps a taller dock proportionally taller", () => {
    const { state } = resolveLayoutState({
      ...emptySources(),
      v1: JSON.stringify({ ...fullState(), dockHeight: 350 }),
    });
    expect(state.dockHeight).toBe(Math.round(350 * DOCK_HEIGHT_SHIFT));
    expect(state.dockHeight).toBeGreaterThan(DEFAULT_LAYOUT_STATE.dockHeight);
    expect(state.dockHeight).toBeLessThan(350);
  });

  it("does NOT shift a v2 blob — that number is already on today's scale", () => {
    const { state } = resolveLayoutState({
      ...emptySources(),
      v2: JSON.stringify({ ...fullState(), dockHeight: 350 }),
    });
    expect(state.dockHeight).toBe(350);
  });

  it("folds the two pre-layout stores AND shifts their dock height", () => {
    // The legacy dock's default was Math.min(220, ...) — the v1 scale — so the
    // folded result is a v1 state and gets the same shift.
    const { state, migrated } = resolveLayoutState({
      ...emptySources(),
      theme: JSON.stringify({ preset: "matrix", scale: 1.1 }),
      dock: JSON.stringify({ height: 220, slotA: "dice" }),
    });
    expect(migrated).toBe(true);
    expect(state.preset).toBe("matrix");
    expect(state.uiScale).toBe(1.1);
    expect(state.slotA).toBe("dice");
    expect(state.dockHeight).toBe(DEFAULT_LAYOUT_STATE.dockHeight);
  });

  it("prefers the stable key over every older source", () => {
    const { state } = resolveLayoutState({
      current: JSON.stringify({ ...fullState({ preset: "cyan" }), schemaVersion: LAYOUT_SCHEMA_VERSION }),
      v2: JSON.stringify({ ...fullState({ preset: "violet" }) }),
      v1: JSON.stringify({ ...fullState({ preset: "forge" }) }),
      theme: JSON.stringify({ preset: "matrix" }),
      dock: null,
    });
    expect(state.preset).toBe("cyan");
  });

  it("does NOT overwrite a blob written by a NEWER build", () => {
    // A future version cannot be understood here, and writing over it would
    // destroy data we cannot read. migrated=false is what stops the applier
    // from persisting over the newer build's state.
    const { state, migrated } = resolveLayoutState({
      ...emptySources(),
      current: JSON.stringify({ ...fullState(), schemaVersion: LAYOUT_SCHEMA_VERSION + 1 }),
    });
    expect(migrated).toBe(false);
    expect(state).toEqual(DEFAULT_LAYOUT_STATE);
  });

  it("reads a bare blob under the stable key as the CURRENT version", () => {
    // Foreign data with no declared version. Reading it as it was written is
    // better than shifting a number we cannot place — a shift would CHANGE a
    // value the user never asked to change.
    const { state, migrated } = resolveLayoutState({
      ...emptySources(),
      current: JSON.stringify(fullState({ dockHeight: 333 })),
    });
    expect(state.dockHeight).toBe(333);
    expect(migrated).toBe(false);
  });

  it("a corrupt stable key falls through to the older sources instead of a half-parsed object", () => {
    const { state, migrated } = resolveLayoutState({
      ...emptySources(),
      current: "{broken",
      v2: JSON.stringify({ preset: "cyan" }),
    });
    expect(state.preset).toBe("cyan");
    expect(migrated).toBe(true);
  });

  it("normalizes a stored blob, so an out-of-band value can never come back", () => {
    const { state } = resolveLayoutState({
      ...emptySources(),
      current: JSON.stringify({ inspectorWidth: 9999, rackColumns: 2, schemaVersion: LAYOUT_SCHEMA_VERSION }),
    });
    expect(state.inspectorWidth).toBe(LAYOUT_BOUNDS.inspectorWidth.max);
    expect(state.rackColumns).toBe(LAYOUT_BOUNDS.rackColumns.min);
  });
});

describe("layout-data · the migration chain has no holes", () => {
  it("has a step for every version between 1 and the current one", () => {
    // A hole would silently skip a migration for every user who has data at
    // that version. The chain's contiguity is what makes a version bump safe.
    for (let version = 1; version < LAYOUT_SCHEMA_VERSION; version++) {
      expect(typeof LAYOUT_MIGRATIONS[version]).toBe("function");
    }
  });

  it("shifts the dock height by the measured ratio", () => {
    expect(DOCK_HEIGHT_SHIFT).toBeCloseTo(DEFAULT_LAYOUT_STATE.dockHeight / 220, 10);
  });
});

describe("PFLYT1 layout share codes", () => {
  it("round-trips the whole look AND geometry", () => {
    const original = fullState();
    const code = encodeLayoutCode(original);
    expect(code.startsWith(LAYOUT_CODE_PREFIX)).toBe(true);
    expect(decodeLayoutCode(code)).toEqual(original);
  });

  it("normalizes on encode, so a dirty in-memory state cannot smuggle illegal values", () => {
    const code = encodeLayoutCode(fullState({ inspectorWidth: 9999, slotA: "arr", slotB: "arr" }));
    const decoded = decodeLayoutCode(code)!;
    expect(decoded.inspectorWidth).toBe(LAYOUT_BOUNDS.inspectorWidth.max);
    expect(decoded.slotB).toBeNull();
  });

  it("clamps and drops hostile payloads — a tampered token yields a legal layout", () => {
    const decoded = decodeLayoutCode(
      encodeLayoutCode(
        fullState({
          uiScale: 99,
          dockHeight: -5,
          colorOverrides: { "--ok": "#000", background: "red" },
        }) as LayoutState,
      ),
    )!;
    expect(decoded.uiScale).toBe(LAYOUT_BOUNDS.uiScale.max);
    expect(decoded.dockHeight).toBe(LAYOUT_BOUNDS.dockHeight.min);
    expect(decoded.colorOverrides).toEqual({ "--ok": "#000" });
  });

  it("rejects garbage and a non-PFLYT string", () => {
    expect(decodeLayoutCode("hello")).toBeNull();
    expect(decodeLayoutCode(LAYOUT_CODE_PREFIX + btoa("garbage"))).toBeNull();
    expect(decodeLayoutCode(LAYOUT_CODE_PREFIX)).toBeNull();
    expect(decodeLayoutCode("")).toBeNull();
  });

  it("rejects a compressed non-object body (array / bare string)", () => {
    // A legal prefix with a legal compression of the wrong shape must not
    // produce a state — otherwise `decode` would return a default layout for a
    // token that never described one, silently overwriting the user's look.
    expect(decodeLayoutCode(LAYOUT_CODE_PREFIX + compress(JSON.stringify([1, 2, 3])))).toBeNull();
    expect(decodeLayoutCode(LAYOUT_CODE_PREFIX + compress('"hello"'))).toBeNull();
    expect(decodeLayoutCode(LAYOUT_CODE_PREFIX + compress("null"))).toBeNull();
  });
});
