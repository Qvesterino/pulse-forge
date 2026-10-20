import { afterEach, describe, expect, it, vi } from "vitest";
import { readStateMatrix, type StateRole } from "../src/ui/stateMatrix";

/**
 * The state matrix's colour reader, pinned against REAL computed strings.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * `readStateMatrix` has to be SELF-CONTAINED — Playwright serialises its
 * source into the page, so it may not call module-scope helpers. That makes it
 * hard to unit-test, and hard to unit-test is exactly how it stayed broken
 * through three measurement runs:
 *
 *   1. "is this colour an accent?" answered "does the channel spread exceed
 *      5/255?" — which passes the neutral dark bevel `rgba(18, 22, 27, 0.28)`
 *      that every `.track-tab` carries.
 *   2. `color(srgb 0.98 0.85 0.63)` — SPACE separated — was split on commas,
 *      produced ONE number, and was silently dropped. The 256 step cells and
 *      the active pattern chip read as UNMARKED while they visibly glowed.
 *   3. `oklab(...)` — Chromium's serialisation of `color-mix(in oklab, ...)`,
 *      192 occurrences including the playhead's own ring — was not parsed at
 *      all, so the ONE mark that says "the transport is running" was invisible.
 *
 * Each of those reported a clean, plausible, wrong number. The strings below
 * are the real computed values, captured from the running shell.
 */

const ROLE: StateRole = { id: "cell", label: "Cell", selector: ".cell", group: "CHROME" };

interface FakeStyle {
  boxShadow?: string;
  borderTopColor?: string;
  borderRightColor?: string;
  borderBottomColor?: string;
  borderLeftColor?: string;
  backgroundColor?: string;
  color?: string;
  fontSize?: string;
  outlineStyle?: string;
  outlineWidth?: string;
  outlineColor?: string;
}

const NEUTRAL_BORDERS = ["rgba(217, 219, 225, 0.16)", "rgba(217, 219, 225, 0.16)", "rgba(217, 219, 225, 0.16)", "rgba(217, 219, 225, 0.16)"];

/** Mount N fake elements and make the browser report `styles` for them. */
function mount(styles: FakeStyle[]): void {
  const app = document.createElement("div");
  app.className = "app";
  for (let i = 0; i < styles.length; i += 1) {
    const el = document.createElement("div");
    el.className = "cell";
    app.appendChild(el);
  }
  document.body.appendChild(app);

  vi.stubGlobal("getComputedStyle", (el: Element) => {
    const index = Array.prototype.indexOf.call(app.children, el);
    const s = styles[index] ?? styles[0] ?? {};
    return {
      boxShadow: s.boxShadow ?? "none",
      borderTopColor: s.borderTopColor ?? NEUTRAL_BORDERS[0],
      borderRightColor: s.borderRightColor ?? NEUTRAL_BORDERS[1],
      borderBottomColor: s.borderBottomColor ?? NEUTRAL_BORDERS[2],
      borderLeftColor: s.borderLeftColor ?? NEUTRAL_BORDERS[3],
      backgroundColor: s.backgroundColor ?? "rgba(0, 0, 0, 0)",
      color: s.color ?? "rgb(217, 219, 225)",
      fontSize: s.fontSize ?? "13px",
      fontWeight: "600",
      letterSpacing: "normal",
      outlineStyle: s.outlineStyle ?? "none",
      outlineWidth: s.outlineWidth ?? "0px",
      outlineColor: s.outlineColor ?? "rgba(245, 158, 11, 0.84)",
      display: "block",
      visibility: "visible",
    };
  });

  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    height: 20,
    width: 20,
    top: 0,
    left: 0,
    right: 20,
    bottom: 20,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

function readOne(styles: FakeStyle[]) {
  mount(styles);
  const readings = readStateMatrix([ROLE]);
  return readings[0];
}

const channelsOf = (color: string | null): number[] => {
  if (!color) return [];
  const m = /rgba?\(([^)]+)\)/i.exec(color);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((x) => parseFloat(x.trim()))
    .filter((n) => Number.isFinite(n));
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("state matrix colour reader", () => {
  it("reads an oklab ring as a chromatic accent (the playhead's own mark)", () => {
    const r = readOne([
      {
        boxShadow:
          "oklab(0.768595 0.0561345 0.154817 / 0.424728) 0px 0px 0px 0.816785px inset, " +
          "oklab(0.768595 0.0561344 0.154817 / 0.261371) 0px 0px 5.71749px 0px",
      },
    ]);
    expect(r.ringCount).toBe(1);
    expect(r.accentCount).toBe(1);
    expect(r.hasAccent).toBe(true);
    // The oklab value is the amber of the playhead once converted to sRGB.
    const [rr, gg, bb] = channelsOf(r.accent);
    expect(rr).toBeGreaterThan(235);
    expect(gg).toBeGreaterThan(140);
    expect(gg).toBeLessThan(195);
    expect(bb).toBeLessThan(35);
  });

  it("reads a SPACE-separated color(srgb ...) inset as a top light and an accent", () => {
    const r = readOne([{ boxShadow: "color(srgb 0.985098 0.855451 0.636392) 0px 1px 0px 0px inset" }]);
    expect(r.topLight).toBe(1);
    expect(r.accentCount).toBe(1);
    expect(r.hasAccent).toBe(true);
  });

  it("does NOT call the neutral dark bevel an accent", () => {
    const r = readOne([{ boxShadow: "rgba(18, 22, 27, 0.28) 0px -1px 0px 0px inset" }]);
    expect(r.bottomLight).toBe(0.28);
    expect(r.accentCount).toBe(0);
    expect(r.hasAccent).toBe(false);
  });

  it("does NOT call the white bevel an accent", () => {
    const r = readOne([{ boxShadow: "rgba(255, 255, 255, 0.1) 0px 1px 0px 0px inset" }]);
    expect(r.topLight).toBe(0.1);
    expect(r.accentCount).toBe(0);
  });

  it("reads the amber selection underline (y = -2) as an accent, not a bottom light", () => {
    const r = readOne([
      { boxShadow: "rgba(255, 255, 255, 0.08) 0px 1px 0px 0px inset, rgb(245, 158, 11) 0px -2px 0px 0px inset" },
    ]);
    expect(r.accent).toBe("rgb(245, 158, 11)");
    expect(r.bottomLight).toBeNull();
    expect(r.accentCount).toBe(1);
  });

  it("keeps a BORDER mark separate from an INSET mark", () => {
    const r = readOne([
      {
        boxShadow: "rgba(255, 255, 255, 0.2) 0px 1px 0px 0px inset",
        borderTopColor: "rgba(245, 158, 11, 0.5)",
      },
    ]);
    // The inset is white — not a mark. The border is amber — a different gesture.
    expect(r.hasAccent).toBe(false);
    expect(r.accentCount).toBe(0);
    expect(r.borderAccentCount).toBe(1);
    expect(r.borderAccent).not.toBeNull();
  });

  it("does NOT call a fully transparent colour an accent", () => {
    const r = readOne([{ boxShadow: "rgba(245, 158, 11, 0) 0px 1px 0px 0px inset" }]);
    expect(r.accentCount).toBe(0);
  });

  it("counts the distribution over all visible matches, not just the first", () => {
    const r = readOne([
      { boxShadow: "none" },
      { boxShadow: "rgb(245, 158, 11) 0px -2px 0px 0px inset" },
      { boxShadow: "rgb(245, 158, 11) 0px -2px 0px 0px inset" },
    ]);
    expect(r.accentCount).toBe(2);
    expect(r.accentIndexes).toEqual([1, 2]);
  });

  it("reads a focus OUTLINE — the focus ring in this shell is not a shadow", () => {
    const r = readOne([
      { boxShadow: "none" },
      { boxShadow: "none", outlineStyle: "solid", outlineWidth: "2px" },
    ]);
    expect(r.outlineCount).toBe(1);
    expect(r.outlineWidth).toBe(2);
    expect(r.outlineAccent).not.toBeNull();
  });

  it("reports no focus ring when nothing is outlined", () => {
    const r = readOne([{ boxShadow: "none" }]);
    expect(r.outlineCount).toBe(0);
    expect(r.outlineAccent).toBeNull();
  });
});
