import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Vlna B — the CSS half of ADR 0036.
 *
 * The layout store can write a perfect state and the UI still will not move a
 * pixel if the stylesheet ignores the tokens. These tests are the guard that
 * closes that gap: they parse the real cascade and assert the tokens are
 * actually CONSUMED, rather than trusting that a token in TypeScript reached a
 * stylesheet rule.
 *
 * They are source-level on purpose — jsdom does not compute `clamp()` in
 * `grid-template-columns` or resolve custom-property fallbacks in media
 * queries, so a rendered assertion here would silently pass on a rule that does
 * not work in a browser.
 */

const css = (name: string): string => readFileSync(join(__dirname, "../src/styles", name), "utf8");

/** The new sheet under test — read once, shared by every block below. */
const tokens = css("24-layout-tokens.css");

/** Cascade order is load-bearing (src/styles/index.css). */
describe("Vlna B · cascade order", () => {
  it("appends 24-layout-tokens LAST, after every other stylesheet", () => {
    const index = css("index.css");
    const imports = [...index.matchAll(/@import\s+"\.\/([^"]+)"/g)].map((m) => m[1]!);
    expect(imports[imports.length - 1]).toBe("24-layout-tokens.css");
    expect(imports).toContain("24-layout-tokens.css");
  });
});

describe("Vlna B · layout tokens are actually consumed", () => {
  it("the inspector width comes from the layout token, not a fixed literal", () => {
    // The old rule was a hard 280px (01-base.css:532). This asserts the NEW
    // rule reads the token, so a user resize actually moves the inspector.
    expect(tokens).toMatch(/grid-template-columns:[^;]*var\(--inspector-width/);
    // And it must still be clamped so a huge width cannot starve the sequencer.
    expect(tokens).toMatch(/clamp\([^)]*var\(--inspector-width[^)]*\)/);
  });

  it("the rack column count comes from the layout token", () => {
    expect(tokens).toMatch(/repeat\(var\(--rack-columns/);
  });

  it("the body font size is scaled by --type-scale", () => {
    expect(tokens).toMatch(/font-size:\s*calc\(13px \* var\(--type-scale/);
  });

  it("the user label width is applied via a CLASS, never inline", () => {
    // An inline --steps-label on <html> outranks every media query and would
    // kill the 760px phone breakpoint in 12-floating-instrument-plugin-2.css.
    expect(tokens).toContain(".user-label-width");
    expect(tokens).toMatch(/\.user-label-width\s*\{[^}]*--steps-label/);
  });
});

describe("Vlna B · the applier writes the tokens these rules read", () => {
  const applier = readFileSync(join(__dirname, "../src/ui/layout.ts"), "utf8");

  it("sets every custom property 24-layout-tokens.css consumes", () => {
    for (const token of ["--inspector-width", "--rack-columns", "--type-scale", "--user-steps-label"]) {
      expect(applier, `applier must set ${token}`).toContain(`"${token}"`);
    }
  });

  it("toggles the user-label class in lockstep with the override", () => {
    expect(applier).toContain("USER_LABEL_CLASS");
    // Both branches must exist: removing the class at the default and adding it
    // otherwise. A one-way toggle would leave a stale class behind forever.
    expect(applier).toMatch(/classList\.remove\(USER_LABEL_CLASS\)/);
    expect(applier).toMatch(/classList\.add\(USER_LABEL_CLASS\)/);
  });
});

describe("Vlna B · density has three rungs", () => {
  const applier = readFileSync(join(__dirname, "../src/ui/layout.ts"), "utf8");
  const tokens = css("24-layout-tokens.css");

  it("applier exposes comfortable / compact / dense classes", () => {
    for (const cls of ["density-comfortable", "density-compact", "density-dense"]) {
      expect(applier).toContain(cls);
    }
  });

  it("the third rung (dense) actually has rules", () => {
    // A class that nothing styles is a toggle that lies to the user.
    expect(tokens).toMatch(/\.density-dense\s+\.[\w-]+/);
  });

  it("keeps the legacy .theme-compact class for the existing stylesheet", () => {
    expect(applier).toContain("theme-compact");
  });
});

describe("Vlna B · responsive behaviour is not silently broken", () => {
  it("the 760px phone breakpoint for --steps-label still exists", () => {
    // This is the rule the class-based approach deliberately preserves.
    const phone = css("12-floating-instrument-plugin-2.css");
    expect(phone).toMatch(/@media \(max-width: 760px\)/);
    expect(phone).toMatch(/--steps-label:\s*112px/);
  });

  it("the inspector row-switch below 860px is still owned by the base sheet", () => {
    // 24-layout-tokens.css must not re-DECLARE the inspector row-switch; that
    // duplication is how these ladders drift. The base sheet stays the single
    // owner of `grid-template-columns: 1fr` at 860px.
    const base = css("01-base.css");
    expect(base).toMatch(/@media \(max-width: 860px\)[\s\S]*grid-template-columns:\s*1fr/);
    // This sheet may reference 860px only to hide the inspector grip, which is
    // meaningless once the inspector is a row — never to re-own the switch.
    const switchesInTokens = tokens.match(/@media \(max-width: 860px\)[\s\S]*?\n\}/g) ?? [];
    for (const block of switchesInTokens) {
      expect(block).not.toContain("grid-template-columns");
    }
  });

  it("documents the breakpoint ladder so new rules stop inventing values", () => {
    for (const step of ["520px", "640px", "860px", "1100px", "1450px"]) {
      expect(tokens).toContain(step);
    }
  });
});

describe("Vlna B · Sequencer shares ONE label value", () => {
  const sequencer = readFileSync(join(__dirname, "../src/ui/Sequencer.tsx"), "utf8");

  it("reads the label width from the layout store, not a private constant", () => {
    // The old comment said "MUST mirror --steps-label" — the mirror is gone:
    // the component now reads the same value the applier writes.
    expect(sequencer).toContain("useLayout");
    expect(sequencer).toContain("layout.sequencerLabelWidth");
    expect(sequencer).not.toContain("MUST mirror --steps-label");
  });

  it("still respects the phone breakpoint over the user's width", () => {
    // A user width is a BASE, not an override: on a narrow phone the grid would
    // be unusable, so the breakpoint value must win there.
    expect(sequencer).toMatch(/breakpointPx === DEFAULT_LABEL_PX/);
  });
});
