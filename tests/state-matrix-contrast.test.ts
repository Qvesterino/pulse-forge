/**
 * The CONTRAST declaration is pinned from both sides.
 *
 * Why a test at all: the floor for every role is 4.5:1 (WCAG AA for normal
 * text), and a table of sixteen identical numbers is exactly the kind of
 * table that rots quietly. A row that is dropped, a floor that is edited down
 * to "whatever we measured", a role that is added without a reason — each of
 * those is a silent loosening, and none of them would fail anything else.
 */
import { describe, expect, it } from "vitest";
import {
  CONTRAST_EXPECTATIONS,
  STATE_ROLES,
  evaluateContrast,
  type ContrastExpectation,
  type PixelContrast,
  type StateReading,
} from "../src/ui/stateMatrix";

/** A reading with everything zero — the "nothing is on screen" baseline. */
const blank = (over: Partial<StateReading> = {}): StateReading => ({
  roleId: "x",
  matched: 0,
  visible: 0,
  fontSize: null,
  fontWeight: null,
  letterSpacing: null,
  topLight: null,
  bottomLight: null,
  hasAccent: false,
  accent: null,
  background: null,
  color: null,
  sample: null,
  accentCount: 0,
  accentColors: [],
  accentIndexes: [],
  accentSample: null,
  ringCount: 0,
  outlineCount: 0,
  outlineAccent: null,
  outlineWidth: null,
  borderAccent: null,
  borderAccentCount: 0,
  borderAccentSample: null,
  contrast: null,
  compositedBackground: null,
  backgroundResolved: false,
  backgroundNote: null,
  contrastFloor: 4.5,
  largeText: false,
  onScreen: false,
  pixelContrast: null,
  ...over,
});

/** A pixel measurement with the numbers a test needs to bend. */
const pixels = (over: Partial<PixelContrast> = {}): PixelContrast => ({
  id: "rowIndex",
  minContrast: 6.31,
  meanContrast: 6.3,
  textPixels: 18,
  worstBackground: "rgb(24, 27, 34)",
  worstTextColor: "rgb(156, 162, 175)",
  worstSurfacePixels: 18,
  worstPixel: { x: 0, y: 0 },
  dominantContrast: 6.31,
  dominantBackground: "rgb(24, 27, 34)",
  dominantPixels: 18,
  sliverContrast: null,
  sliverPixels: 0,
  minSurfacePixels: 2,
  textColors: [],
  surfaces: 1,
  belowFloorPixels: 0,
  belowFloorShare: 0,
  ...over,
});

/** The roles that carry text on screen — the ones a contrast rule can apply to. */
const TEXT_ROLES = [
  "channelNameRow",
  "channelNameHeader",
  "rowIndex",
  "rulerTick",
  "trackTab",
  "rowPad",
  "dockTab",
  "patternChip",
  "btn",
  "btnSmall",
  "presetChip",
  "transportBtn",
  "positionReadout",
  "patternBarLabel",
  "panelTitleLocal",
  "statusbar",
];

describe("contrast declaration", () => {
  it("declares every role that carries text, and no role that does not", () => {
    const declared = CONTRAST_EXPECTATIONS.map((e) => e.role).sort();
    expect(declared).toEqual([...TEXT_ROLES].sort());
    // The roles that hold no text (a step cell, a playhead cell) have nothing
    // for WCAG 1.4.3 to say about them.
    for (const role of ["stepCell", "stepPlayhead"]) {
      expect(declared).not.toContain(role);
    }
  });

  it("names a role that actually exists in the catalogue", () => {
    const known = new Set(STATE_ROLES.map((r) => r.id));
    for (const e of CONTRAST_EXPECTATIONS) {
      expect(known.has(e.role), `${e.role} is not a role in STATE_ROLES`).toBe(true);
    }
  });

  it("keeps every floor at the WCAG AA level — never lower", () => {
    // 4.5:1 is AA for normal text; 3:1 is AA for large text (>=24px, or
    // >=18.66px bold). A floor BELOW either is a rule that lets an unreadable
    // colour through, and a floor that was "just what we measured" is the
    // same thing wearing a disguise.
    for (const e of CONTRAST_EXPECTATIONS) {
      expect(e.min, `${e.role} has a floor below WCAG AA`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("says why every row exists", () => {
    for (const e of CONTRAST_EXPECTATIONS) {
      expect(e.because.length, `${e.role} has no reason`).toBeGreaterThan(40);
    }
  });
});

describe("contrast evaluation", () => {
  const rule: ContrastExpectation = { role: "rowIndex", min: 4.5, because: "because" };

  it("passes a reading that reaches the floor", () => {
    const r = evaluateContrast(rule, blank({ contrast: 4.5, visible: 1 }), "idle");
    expect(r.ok).toBe(true);
    expect(r.measured).toBe(4.5);
    expect(r.source).toBe("static");
  });

  it("fails a reading that is under the floor, and says by how much", () => {
    const r = evaluateContrast(rule, blank({ contrast: 4.45, visible: 1 }), "idle");
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain("4.45:1 measured");
    expect(r.failures[0]).toContain("4.5:1 required");
  });

  it("reports the PIXEL measurement as the number", () => {
    // The static reading composites solid backgrounds only; the pixel reading
    // is the real surface under the glyphs. Where both exist they agree —
    // and where they disagree the pixel one is the truth.
    const r = evaluateContrast(rule, blank({ contrast: 6.4, visible: 1, pixelContrast: pixels() }), "idle");
    expect(r.ok).toBe(true);
    expect(r.measured).toBe(6.31);
    expect(r.source).toBe("pixel");
  });

  it("does not let a good pixel reading EXCUSE a bad static one", () => {
    // Both checks have to hold. The static reading is the one the Diagnostics
    // panel can make on its own, so a rule that only the gate could check
    // would be a rule that is only half enforced.
    const r = evaluateContrast(rule, blank({ contrast: 4.45, visible: 1, pixelContrast: pixels() }), "idle");
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain("static 4.45:1");
  });

  it("fails a DOMINANT surface that is under the floor", () => {
    // The whole index on one 4.45:1 surface: the surface the text is read
    // against, and it is under AA.
    const r = evaluateContrast(
      rule,
      blank({ visible: 1, pixelContrast: pixels({ dominantContrast: 4.45, dominantPixels: 8, textPixels: 8 }) }),
      "idle",
    );
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain("dominant surface reads 4.45:1");
  });

  it("fails when too much of the text is under the floor, even if the dominant surface is fine", () => {
    const r = evaluateContrast(
      rule,
      blank({
        visible: 1,
        pixelContrast: pixels({ dominantContrast: 6.31, belowFloorPixels: 23, belowFloorShare: 0.18, textPixels: 125 }),
      }),
      "idle",
    );
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain("18% of the text is below");
  });

  it("tolerates the measured noise floor — a glyph edge grazing a 1px highlight", () => {
    // 2.5% is what the status bar and the pattern chip measure, and both
    // read perfectly well.
    const r = evaluateContrast(
      rule,
      blank({
        visible: 1,
        pixelContrast: pixels({
          dominantContrast: 4.75,
          belowFloorPixels: 25,
          belowFloorShare: 0.025,
          textPixels: 1020,
        }),
      }),
      "idle",
    );
    expect(r.ok).toBe(true);
  });

  it("treats an UNMEASURABLE surface as a failure, not as a pass", () => {
    // The whole point of the phase: a surface nobody measured is not a
    // surface that passed.
    const r = evaluateContrast(rule, blank({ visible: 1, contrast: null }), "idle");
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain("could not be measured");
    expect(r.source).toBe("none");
  });

  it("treats a role that was not read as a failure", () => {
    const r = evaluateContrast(rule, undefined, "idle");
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain("not read");
  });
});
