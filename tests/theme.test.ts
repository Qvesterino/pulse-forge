import { beforeEach, describe, expect, it } from "vitest";
import {
  accentOf,
  getThemeSnapshot,
  hexOrHslToSoft,
  initTheme,
  resetTheme,
  setTheme,
  THEME_PRESETS,
} from "../src/ui/theme";

describe("theme", () => {
  beforeEach(() => {
    localStorage.clear();
    resetTheme();
  });

  it("starts on the Forge preset with no overrides", () => {
    initTheme();
    const state = getThemeSnapshot();
    expect(state.preset).toBe("forge");
    expect(state.hue).toBeNull();
    expect(state.scale).toBe(1);
    // The default preset applies its accent explicitly (identical to :root).
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#f59e0b");
  });

  it("applies a preset palette to the document root", () => {
    setTheme({ preset: "cyan" });
    const cyan = THEME_PRESETS.find((p) => p.id === "cyan")!;
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe(cyan.vars["--accent"]);
    expect(document.documentElement.classList.contains("theme-compact")).toBe(false);
  });

  it("persists preferences across initTheme (simulated reload)", () => {
    setTheme({ preset: "matrix", hue: 200, scale: 1.15, compact: true, reduceMotion: true });
    const fresh = initTheme();
    expect(fresh.preset).toBe("matrix");
    expect(fresh.hue).toBe(200);
    expect(fresh.scale).toBe(1.15);
    expect(fresh.compact).toBe(true);
    expect(fresh.reduceMotion).toBe(true);
    expect(document.documentElement.classList.contains("theme-compact")).toBe(true);
    expect(document.documentElement.classList.contains("theme-no-anim")).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("hsl(200, 85%, 60%)");
  });

  it("an invalid persisted state falls back to defaults", () => {
    localStorage.setItem("pf-theme-v1", "{not json");
    const state = initTheme();
    expect(state.preset).toBe("forge");
    // Unknown preset ids fall back to the default preset.
    localStorage.setItem("pf-theme-v1", JSON.stringify({ preset: "nope" }));
    expect(initTheme().preset).toBe("forge");
  });

  it("clamps scale and hue into their ranges", () => {
    setTheme({ scale: 5, hue: 999 });
    const state = getThemeSnapshot();
    expect(state.scale).toBe(1);
    expect(state.hue).toBe(359);
  });

  it("accent helpers", () => {
    expect(accentOf({ preset: "forge", hue: null } as never)).toBe("#f59e0b");
    expect(accentOf({ preset: "forge", hue: 200 } as never)).toBe("hsl(200, 85%, 60%)");
    expect(hexOrHslToSoft("#f59e0b")).toBe("rgba(245, 158, 11, 0.14)");
    expect(hexOrHslToSoft("hsl(200, 85%, 60%)")).toBe("hsla(200, 85%, 60%, 0.14)");
  });

  it("every preset has a legal id and accent", () => {
    const ids = new Set(THEME_PRESETS.map((p) => p.id));
    expect(ids.size).toBe(THEME_PRESETS.length);
    for (const preset of THEME_PRESETS) {
      expect(preset.accent).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
