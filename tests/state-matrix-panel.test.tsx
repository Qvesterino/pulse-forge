import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { screen, waitFor } from "@testing-library/react";
import { renderWithContext } from "./helpers";
import { StateMatrixPanel } from "../src/ui/StateMatrixPanel";
import {
  CONTRAST_EXPECTATIONS,
  STATE_EXPECTATIONS,
  buildMatrixChecks,
  colourName,
  detectMatrixState,
  formatContrastFloor,
  formatContrastReading,
  formatExpectation,
  formatReading,
  roleLabel,
  type StateReading,
} from "../src/ui/stateMatrix";

/**
 * THE PANEL, PINNED.
 *
 * The panel is the second reader of the state matrix declaration. The gate
 * asks "do you comply?" and can fail; the panel asks "what should happen?" and
 * needs a person.
 *
 * The tests here are not about pixels. They are about the four promises the
 * plan makes for the tab:
 *
 *   1. it reads the SAME declaration the gate reads,
 *   2. it says a mismatch OUT LOUD,
 *   3. it never paints "the app cannot measure this" as a failure, and
 *   4. it costs the studio nothing while it is closed.
 *
 * (3) is the one that matters most. Nine of the nineteen roles paint a
 * gradient, and the app has no pixels - so the panel CANNOT settle those
 * rows. A panel that coloured them red would cry wolf on nine rows, and the
 * real failures would stop being visible.
 */

/** A reading with everything zero — the "nothing is marked" baseline. */
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

describe("state matrix · plain language", () => {
  it("names the shell's colours the way a person would", () => {
    expect(colourName("rgb(245, 158, 11)")).toBe("amber");
    expect(colourName("rgb(74, 222, 128)")).toBe("green");
    expect(colourName("rgb(217, 219, 225)")).toBe("grey");
    expect(colourName(null)).toBe("unknown");
  });

  it("says the rule in words, with the number after them", () => {
    expect(formatExpectation({ insetMarks: { min: 1, max: 1 }, insetColour: "rgb(245, 158, 11)" })).toBe(
      "exactly one amber inset mark",
    );
    expect(formatExpectation({ visible: 0 })).toBe("nothing on screen");
    expect(formatExpectation({ rings: { min: 1 } })).toBe("at least one ring");
    expect(formatExpectation({ markMovedFromIdle: true })).toBe("the mark moves to another element");
  });

  it("says the live value in words", () => {
    const reading = blank({
      roleId: "rowPad",
      visible: 1,
      fontSize: 13,
      accentCount: 1,
      accent: "rgb(245, 158, 11)",
      contrast: 12.45,
      backgroundResolved: true,
    });
    // The STATE reading is about the marks — that is all the state
    // declaration declares (inset marks, border marks, rings, outlines).
    expect(formatReading(reading)).toBe("one amber inset mark");
    // The typography and the ratio belong to the contrast row, where the
    // size decides which WCAG threshold applies.
    expect(formatContrastReading(reading)).toContain("12.45:1");
    expect(formatContrastReading(reading)).toContain("13 px");
    expect(formatContrastReading(reading)).toContain("one element");
  });

  it("says 'no marks' rather than nothing at all", () => {
    // A rule like "at most 0 rings" is satisfied by an empty answer — but an
    // empty answer with no evidence reads like a broken row.
    const reading = blank({ roleId: "rulerTick", visible: 16, fontSize: 10 });
    expect(formatReading(reading)).toBe("no marks · 16 elements");
  });

  it("says 'unresolved' rather than a number it does not have", () => {
    const reading = blank({
      roleId: "rowPad",
      visible: 1,
      backgroundResolved: false,
      backgroundNote: "row-pad paints a gradient",
    });
    // The reading NAMES THE REASON, once. It used to say "unresolved" here
    // and repeat the whole reason in a separate note.
    expect(formatContrastReading(reading)).toBe("unresolved (row-pad paints a gradient)");
    expect(formatReading(reading)).not.toContain("background-image");
  });

  it("labels a role and a floor", () => {
    expect(roleLabel("rowPad")).toBe("Channel row");
    expect(formatContrastFloor(4.5)).toBe("at least 4.5:1 (WCAG AA)");
  });
});

describe("state matrix · which state is the shell in", () => {
  it("claims the state it can PROVE, and says how", () => {
    const playing = detectMatrixState([blank()], { playing: true, armed: false, baseline: null });
    expect(playing.id).toBe("playing");
    expect(playing.how).toContain("transport");

    const armed = detectMatrixState([blank()], { playing: false, armed: true, baseline: null });
    expect(armed.id).toBe("recording");

    const focused = detectMatrixState([blank({ outlineCount: 1 })], { playing: false, armed: false, baseline: null });
    expect(focused.id).toBe("focus");
  });

  it("claims 'selected' only when the mark MOVED", () => {
    const rowPad = blank({ roleId: "rowPad", accentSample: "2Kick Punch" });
    const moved = detectMatrixState([rowPad], { playing: false, armed: false, baseline: "1Kick Deep" });
    expect(moved.id).toBe("selected");
    expect(moved.how).toContain("moved");

    const still = detectMatrixState([rowPad], { playing: false, armed: false, baseline: "2Kick Punch" });
    expect(still.id).toBe("idle");
    expect(still.unobserved.map((u) => u.id)).toContain("selected");
  });

  it("NEVER claims 'hover' — the app cannot see the pointer", () => {
    const state = detectMatrixState([blank()], { playing: false, armed: false, baseline: null });
    expect(state.id).not.toBe("hover");
    expect(state.unobserved.map((u) => u.id)).toContain("hover");
    expect(state.unobserved.find((u) => u.id === "hover")?.why).toMatch(/pointer/i);
  });
});

describe("state matrix · the panel's rows", () => {
  const idleState = detectMatrixState([blank()], { playing: false, armed: false, baseline: null });

  it("covers the rules of the current state AND every contrast floor", () => {
    const checks = buildMatrixChecks([blank()], null, idleState);
    const expected = STATE_EXPECTATIONS.filter((e) => e.state === idleState.id).length + CONTRAST_EXPECTATIONS.length;
    expect(checks.length).toBe(expected);
  });

  it("calls a role on a gradient UNMEASURED, not failed", () => {
    const reading = blank({
      roleId: "rowPad",
      visible: 1,
      backgroundResolved: false,
      backgroundNote: "row-pad paints a gradient",
    });
    const checks = buildMatrixChecks([reading], null, idleState);
    // The CONTRAST row — the same role also carries a state rule, and the two
    // are different rows.
    const row = checks.find((check) => check.kind === "contrast" && check.role === "rowPad");
    expect(row?.verdict).toBe("unmeasured");
    expect(row?.now).toContain("gradient");
  });

  it("does not say WHY a row is unresolved twice", () => {
    // The reason used to appear in the reading AND in a separate note, so one
    // line read "... contrast unresolved (row-pad paints a gradient)
    // (row-pad paints a gradient — only the pixel measurement can
    // settle this)". The reason is read once, in the reading.
    const reading = blank({
      roleId: "rowPad",
      visible: 1,
      backgroundResolved: false,
      backgroundNote: "row-pad paints a gradient",
    });
    const checks = buildMatrixChecks([reading], null, idleState);
    const row = checks.find((check) => check.kind === "contrast" && check.role === "rowPad");
    expect(row?.now).toBe("unresolved (row-pad paints a gradient)");
    expect(row?.now.match(/gradient/g)?.length ?? 0).toBe(1);
  });

  it("calls a role that is not on screen UNMEASURED, not failed", () => {
    const checks = buildMatrixChecks([blank()], null, idleState);
    for (const check of checks) {
      if (check.kind !== "contrast") continue;
      expect(check.verdict).toBe("unmeasured");
      expect(check.now).toContain("not on screen");
    }
  });

  it("keeps a role's state rule and its contrast floor apart", () => {
    // Two rows with the same role and no way to tell them apart is a table
    // nobody can read.
    const checks = buildMatrixChecks([blank()], null, idleState);
    const rowPad = checks.filter((check) => check.role === "rowPad");
    expect(rowPad.length).toBeGreaterThan(1);
    expect(new Set(rowPad.map((check) => check.kind)).size).toBe(rowPad.length);
  });

  it("reports a real disagreement as a FAILURE, with the reason", () => {
    // The idle rule for `rowPad` is "exactly one amber inset mark". A reading
    // with two inset marks disagrees.
    const reading = blank({
      roleId: "rowPad",
      visible: 1,
      accentCount: 2,
      accent: "rgb(245, 158, 11)",
      accentSample: "1Kick Deep",
      contrast: 12.45,
      backgroundResolved: true,
    });
    const checks = buildMatrixChecks([reading], null, idleState);
    const row = checks.find((check) => check.kind === "state" && check.role === "rowPad");
    expect(row?.verdict).toBe("fail");
    expect(row?.failures.length).toBeGreaterThan(0);
    expect(row?.why.length).toBeGreaterThan(20);
  });
});

describe("state matrix · the tab itself", () => {
  it("renders the self-naming title, the state and the catalogue", async () => {
    renderWithContext(<StateMatrixPanel />);
    await waitFor(() => expect(screen.getByText("STATE MATRIX")).toBeInTheDocument());
    expect(screen.getByText(/how the shell is supposed to look/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("NOW")).toBeInTheDocument());
    // Every declared state is listed — none is silently dropped. "Idle" also
    // appears in the NOW line, so this is a "contains" check, not a "one".
    for (const state of ["Idle", "Selected", "Playing", "Hover", "Keyboard focus"]) {
      expect(screen.getAllByText(state).length).toBeGreaterThan(0);
    }
    // The two kinds of rule are in their own sections, so a row is never
    // ambiguous.
    expect(screen.getByText(/THIS STATE'S RULES/)).toBeInTheDocument();
    expect(screen.getByText(/CONTRAST FLOORS/)).toBeInTheDocument();
  });

  it("does NOT poll", () => {
    const source = readFileSync(join(__dirname, "../src/ui/StateMatrixPanel.tsx"), "utf8");
    expect(source, "the panel must not poll the shell").not.toMatch(/setInterval/);
  });

  it("keeps the measuring module out of the studio boot graph", () => {
    const diagnostics = readFileSync(join(__dirname, "../src/ui/Diagnostics.tsx"), "utf8");
    expect(diagnostics).toContain('import("./StateMatrixPanel")');
    // A STATIC import would put the panel in the boot graph.
    expect(diagnostics).not.toMatch(/^import \{[^}]*\} from "\.\/StateMatrixPanel"/m);

    const panel = readFileSync(join(__dirname, "../src/ui/StateMatrixPanel.tsx"), "utf8");
    expect(panel).toContain('import("./stateMatrix")');
    // A type-only import is erased at build time and costs nothing; a VALUE
    // import would park the whole measurement harness in the boot graph.
    expect(panel).not.toMatch(/^import \{[^}]*\} from "\.\/stateMatrix"/m);
    expect(panel).toMatch(/^import type \{/m);
  });
});
