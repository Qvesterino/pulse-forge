/**
 * UX audit gates — keyboard shortcuts table + design-token contrast.
 *
 * The shortcuts table had two real collisions before (bare 1–5 bound by both
 * tracks and panels; Alt+5 computing a bogus panel id). These tests keep the
 * table collision-free and the documented verbs covered. The contrast test
 * parses the :root tokens out of styles.css and enforces WCAG ratios so a
 * theme tweak cannot silently dim the UI below readability.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PANEL_IDS_BY_SHORTCUT,
  SHORTCUTS,
  matchShortcut,
  panelIdOfShortcut,
  shortcutSignatures,
  type ShortcutKey,
} from "../src/ui/shortcuts";

const ALL_KEYS: ShortcutKey[] = [
  "playPause",
  "stop",
  "undo",
  "redo",
  "save",
  "toggleLoop",
  "duplicatePattern",
  "deleteNote",
  "nextTrack",
  "prevTrack",
  "selectTrack1",
  "selectTrack2",
  "selectTrack3",
  "selectTrack4",
  "selectTrack5",
  "selectTrack6",
  "selectTrack7",
  "selectTrack8",
  "selectTrack9",
  "toggleMuteTrack",
  "toggleSoloTrack",
  "panelMix",
  "panelFx",
  "panelArr",
  "panelMod",
  "panelExport",
  "panelDice",
  "nextPattern",
  "prevPattern",
  "seekHome",
  "seekBack",
  "seekForward",
  "toggleHelp",
];

describe("keyboard shortcut table", () => {
  it("covers every documented verb exactly once", () => {
    const keys = SHORTCUTS.map((sc) => sc.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...ALL_KEYS].sort());
  });

  it("has no signature collisions (primary keys and alternatives)", () => {
    const owner = new Map<string, ShortcutKey>();
    for (const sc of SHORTCUTS) {
      for (const sig of shortcutSignatures(sc)) {
        const clash = owner.get(sig);
        // The same shortcut may list the same chord twice (e.g. "S" ctrl with
        // an "s" ctrl alternative) — only cross-shortcut clashes are bugs.
        if (clash !== undefined && clash !== sc.key) {
          expect.soft(`${sig} is bound by both "${clash}" and "${sc.key}"`).toBe(null);
        }
        owner.set(sig, sc.key);
      }
    }
    expect(owner.size).toBeGreaterThan(30);
  });

  it("matches the headline interactions correctly", () => {
    const ev = (init: Partial<KeyboardEvent>): KeyboardEvent =>
      new KeyboardEvent("keydown", { key: " ", ctrlKey: false, shiftKey: false, altKey: false, ...init });
    expect(matchShortcut(ev({ key: " " }))).toBe("playPause");
    expect(matchShortcut(ev({ key: "1" }))).toBe("selectTrack1");
    expect(matchShortcut(ev({ key: "1", altKey: true }))).toBe("panelMix");
    expect(matchShortcut(ev({ key: "6", altKey: true }))).toBe("panelDice");
    expect(matchShortcut(ev({ key: "?", shiftKey: true }))).toBe("toggleHelp");
    expect(matchShortcut(ev({ key: "z", ctrlKey: true }))).toBe("undo");
    expect(matchShortcut(ev({ key: "z", ctrlKey: true, shiftKey: true }))).toBe("redo");
  });

  it("maps every panel shortcut to a real bottom-panel id", () => {
    const realPanelIds = new Set(["mixer", "fx", "arr", "mod", "exp", "midi", "dice"]);
    for (const sc of SHORTCUTS) {
      const panel = panelIdOfShortcut(sc.key);
      if (panel) expect(realPanelIds.has(panel), `${sc.key} → unknown panel "${panel}"`).toBe(true);
    }
    expect(Object.keys(PANEL_IDS_BY_SHORTCUT)).toHaveLength(6);
  });
});

// ── Design token contrast ───────────────────────────────────────────────────

function readRootTokens(): Record<string, string> {
  const css = readFileSync(join(__dirname, "../src/styles.css"), "utf-8");
  const root = css.slice(css.indexOf(":root"), css.indexOf("}", css.indexOf(":root")));
  const tokens: Record<string, string> = {};
  for (const match of root.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    tokens[match[1]] = match[2];
  }
  return tokens;
}

function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const channel = (i: number) => {
    const srgb = parseInt(value.slice(i * 2, i * 2 + 2), 16) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe("design tokens meet readability floors", () => {
  const tokens = readRootTokens();

  it("parses the core text/background tokens", () => {
    for (const name of ["bg", "bg-panel", "text", "text-dim", "text-faint", "accent"]) {
      expect(tokens[name], `--${name} missing or not a #rrggbb token`).toBeTruthy();
    }
  });

  it("keeps primary text at AA on both panel shades", () => {
    expect(contrast(tokens["text"], tokens["bg"])).toBeGreaterThanOrEqual(7);
    expect(contrast(tokens["text"], tokens["bg-panel"])).toBeGreaterThanOrEqual(7);
  });

  it("keeps secondary text at AA on the app background", () => {
    expect(contrast(tokens["text-dim"], tokens["bg"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["text-dim"], tokens["bg-panel"])).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps faint text and accent at usable visibility", () => {
    // Faint text is metadata/decoration — but it must still be legible (AA large).
    expect(contrast(tokens["text-faint"], tokens["bg"])).toBeGreaterThanOrEqual(3);
    expect(contrast(tokens["text-faint"], tokens["bg-panel"])).toBeGreaterThanOrEqual(3);
    // Accent carries labels and active states.
    expect(contrast(tokens["accent"], tokens["bg"])).toBeGreaterThanOrEqual(3);
  });
});
