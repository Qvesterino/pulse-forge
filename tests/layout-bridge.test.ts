import { beforeEach, describe, expect, it } from "vitest";
import { getLayoutSnapshot, initLayout, resetLayout, setLayout, subscribeLayout } from "../src/ui/layout";
import { initTheme, getThemeSnapshot, resetTheme, setTheme } from "../src/ui/theme";
import {
  DOCK_HEIGHT_SHIFT,
  LAYOUT_SCHEMA_VERSION,
  LAYOUT_STORAGE_KEY,
  LEGACY_DOCK_KEY,
  LEGACY_THEME_KEY,
} from "../src/shared/layout-data";
import { decodeLayoutCode, encodeLayoutCode } from "../src/export/layoutCode";

/**
 * ADR 0036 — the LIVE bridge.
 *
 * `shared/layout-data.test.ts` proves the pure contract. This file proves the
 * part that only exists with a DOM: that the stable layout key is now the
 * single writer, that the older stores are folded in exactly once, and that
 * the old `theme.ts` API still round-trips — because shared packs already
 * carry a `ThemeState` and would be orphaned by a shape change.
 *
 * The failure this guards against is the quiet one: a bridge that compiles and
 * passes its own tests while a user's saved palette silently disappears on the
 * first boot after the update.
 */

const read = (key: string): string | null => localStorage.getItem(key);
const write = (key: string, value: unknown): void => localStorage.setItem(key, JSON.stringify(value));

describe("ui/layout · single writer", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLayout();
  });

  it("writes the merged state to the STABLE key and no longer to the legacy keys", () => {
    setLayout({ dockHeight: 333, inspectorWidth: 300 });
    expect(read(LAYOUT_STORAGE_KEY)).not.toBeNull();
    const stored = JSON.parse(read(LAYOUT_STORAGE_KEY)!);
    expect(stored.dockHeight).toBe(333);
    expect(stored.inspectorWidth).toBe(300);
    // The version travels WITH the blob: the next schema change reads this,
    // migrates it and writes it back under the same key.
    expect(stored.schemaVersion).toBe(LAYOUT_SCHEMA_VERSION);
    // The legacy keys are read for migration but never written back, so a
    // downgrade to an older build still finds the user's old preferences.
    expect(read(LEGACY_THEME_KEY)).toBeNull();
    expect(read(LEGACY_DOCK_KEY)).toBeNull();
  });

  it("applies geometry + density + accent to the document root", () => {
    setLayout({ inspectorWidth: 321, rackColumns: 12, typeScale: 1.1, density: "compact" });
    const root = document.documentElement.style;
    expect(root.getPropertyValue("--inspector-width")).toBe("321px");
    expect(root.getPropertyValue("--rack-columns")).toBe("12");
    expect(root.getPropertyValue("--type-scale")).toBe("1.1");
    expect(document.documentElement.classList.contains("theme-compact")).toBe(true);
    expect(document.documentElement.classList.contains("density-compact")).toBe(true);
    expect(document.documentElement.classList.contains("density-dense")).toBe(false);
  });

  it("applies a custom label width as a CLASS, not an inline custom property", () => {
    // An inline --steps-label on <html> outranks every media query and would
    // permanently kill the 760px phone breakpoint in the stylesheet.
    setLayout({ sequencerLabelWidth: 200 });
    expect(document.documentElement.classList.contains("user-label-width")).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--user-steps-label")).toBe("200px");
    expect(document.documentElement.style.getPropertyValue("--steps-label")).toBe("");
  });

  it("removes the label class again when the user returns to the default", () => {
    setLayout({ sequencerLabelWidth: 200 });
    expect(document.documentElement.classList.contains("user-label-width")).toBe(true);
    setLayout({ sequencerLabelWidth: 168 });
    // A one-way toggle would leave the class behind and keep overriding the
    // stylesheet default forever.
    expect(document.documentElement.classList.contains("user-label-width")).toBe(false);
  });

  it("a preset switch still clears the previous palette (no leak)", () => {
    setLayout({ preset: "molten" });
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#0b0c10");
    setLayout({ preset: "cyan" });
    // Cyan declares only accent vars, so --bg must be removed, not left Molten.
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#22d3ee");
  });

  it("per-token overrides win over the preset", () => {
    setLayout({ preset: "cyan", colorOverrides: { "--bg-panel": "#123456" } });
    expect(document.documentElement.style.getPropertyValue("--bg-panel")).toBe("#123456");
    // A preset switch must NOT wipe the override — the token editor owns it.
    setLayout({ preset: "magenta" });
    expect(document.documentElement.style.getPropertyValue("--bg-panel")).toBe("#123456");
  });

  it("an illegal override name never reaches the style declaration", () => {
    setLayout({ colorOverrides: { background: "red", "--ok": "#000" } });
    expect(document.documentElement.style.background).toBe("");
    expect(document.documentElement.style.getPropertyValue("--ok")).toBe("#000");
  });

  it("resetLayout returns to the built-in look", () => {
    setLayout({ preset: "violet", inspectorWidth: 400, colorOverrides: { "--bg": "#111" }, density: "dense" });
    resetLayout();
    const state = getLayoutSnapshot();
    expect(state.preset).toBe("molten");
    expect(state.inspectorWidth).toBe(280);
    expect(state.density).toBe("comfortable");
    expect(state.colorOverrides).toEqual({});
  });
});

describe("ui/layout · legacy migration runs exactly once", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLayout();
  });

  it("folds both legacy stores into the merged state", () => {
    localStorage.clear();
    write(LEGACY_THEME_KEY, { preset: "matrix", hue: 210, scale: 1.15, compact: true, reduceMotion: true });
    write(LEGACY_DOCK_KEY, { height: 420, slotA: "devices", slotB: "arr" });

    const state = initLayout();
    expect(state.preset).toBe("matrix");
    expect(state.hue).toBe(210);
    expect(state.uiScale).toBe(1.15);
    expect(state.density).toBe("compact");
    expect(state.reduceMotion).toBe(true);
    // The legacy dock height is on the v1 scale (its default was 220), so it
    // gets the NUMERIC SHIFT instead of being carried over as it is: 420 on
    // the old scale is proportionally the same "tall dock" as 321 on the new
    // one (420/220 == 321/168 == 1.91x the default). Carrying 420 over raw
    // would have re-imported exactly the height the proportion pass retires —
    // and a WIPE would have thrown away the palette and the panels too.
    expect(state.dockHeight).toBe(Math.round(420 * DOCK_HEIGHT_SHIFT));
    expect(state.dockHeight).toBe(321);
    expect(state.slotA).toBe("devices");
    expect(state.slotB).toBe("arr");
  });

  it("the migrated copy is persisted, and the legacy keys are left untouched", () => {
    localStorage.clear();
    const legacyTheme = { preset: "cyan", hue: null, scale: 1, compact: false, reduceMotion: false };
    write(LEGACY_THEME_KEY, legacyTheme);
    write(LEGACY_DOCK_KEY, { height: 300, slotA: "mixer", slotB: null });

    initLayout();
    expect(read(LAYOUT_STORAGE_KEY)).not.toBeNull();
    expect(JSON.parse(read(LAYOUT_STORAGE_KEY)!).preset).toBe("cyan");
    // Untouched — a downgrade keeps working, and re-reading them cannot clobber
    // a layout the user has since changed.
    expect(JSON.parse(read(LEGACY_THEME_KEY)!)).toEqual(legacyTheme);
  });

  it("a second boot reads the merged key and ignores the legacy stores", () => {
    localStorage.clear();
    write(LEGACY_THEME_KEY, { preset: "cyan", scale: 1.3 });
    initLayout();
    // The user changes their mind AFTER the migration.
    setLayout({ preset: "violet" });
    // Legacy data still says cyan — it must not win on the next boot.
    setLayout({ preset: "matrix" });
    expect(initLayout().preset).toBe("matrix");
  });

  it("a corrupt legacy store degrades to defaults instead of throwing", () => {
    localStorage.clear();
    localStorage.setItem(LEGACY_THEME_KEY, "{oops");
    localStorage.setItem(LEGACY_DOCK_KEY, "]also[");
    expect(() => initLayout()).not.toThrow();
    expect(initLayout().preset).toBe("molten");
  });
});

describe("ui/theme · the legacy API still round-trips over the new store", () => {
  beforeEach(() => {
    localStorage.clear();
    resetTheme();
  });

  it("setTheme writes through to the single store", () => {
    setTheme({ preset: "matrix", hue: 200, scale: 1.15, compact: true, reduceMotion: true });
    const layout = getLayoutSnapshot();
    expect(layout.preset).toBe("matrix");
    expect(layout.hue).toBe(200);
    expect(layout.uiScale).toBe(1.15);
    expect(layout.density).toBe("compact");
    expect(layout.reduceMotion).toBe(true);
    // The legacy theme key is no longer written.
    expect(read(LEGACY_THEME_KEY)).toBeNull();
  });

  it("exposes the legacy ThemeState shape for shared packs", () => {
    setTheme({ preset: "violet", hue: null, scale: 1, compact: false, reduceMotion: false });
    // Exactly the five legacy keys — packCode serializes this object.
    expect(Object.keys(getThemeSnapshot()).sort()).toEqual(["compact", "hue", "preset", "reduceMotion", "scale"]);
  });

  it("initTheme seeds the view from the merged state", () => {
    setLayout({ preset: "cyan", hue: 300, uiScale: 1.2, density: "compact", reduceMotion: true });
    const view = initTheme();
    expect(view.preset).toBe("cyan");
    expect(view.hue).toBe(300);
    expect(view.scale).toBe(1.2);
    expect(view.compact).toBe(true);
    expect(view.reduceMotion).toBe(true);
  });

  it("a layout-side write is visible through the theme view (no stale snapshot)", () => {
    setTheme({ preset: "molten" });
    // Simulate a future token editor / PFLYT1 install writing the store directly.
    setLayout({ preset: "magenta" });
    expect(getThemeSnapshot().preset).toBe("magenta");
  });

  it("subscribers are notified when the store changes", () => {
    let calls = 0;
    const off = subscribeLayout(() => {
      calls++;
    });
    setLayout({ inspectorWidth: 250 });
    off();
    setLayout({ inspectorWidth: 260 });
    expect(calls).toBe(1);
  });

  it("resetTheme clears colour overrides too", () => {
    setLayout({ colorOverrides: { "--bg-panel": "#111" } });
    resetTheme();
    expect(getLayoutSnapshot().colorOverrides).toEqual({});
  });
});

describe("PFLYT1 install through the live store", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLayout();
  });

  it("decoding and applying a code updates both the store and the document", () => {
    const code = encodeLayoutCode({
      ...getLayoutSnapshot(),
      preset: "violet",
      density: "dense",
      inspectorWidth: 350,
      colorOverrides: { "--text": "#ffffff" },
    });
    const decoded = decodeLayoutCode(code)!;
    setLayout(decoded);
    expect(getLayoutSnapshot().density).toBe("dense");
    expect(document.documentElement.style.getPropertyValue("--inspector-width")).toBe("350px");
    expect(document.documentElement.style.getPropertyValue("--text")).toBe("#ffffff");
  });
});
