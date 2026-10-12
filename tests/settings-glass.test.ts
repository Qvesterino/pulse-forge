import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The settings glass (26-settings-glass.css).
 *
 * This sheet has one job beyond looking good: keep the popover LEGIBLE. The
 * panel is translucent over a live DAW, so the text is rendered on a blend of
 * the panel colour and whatever is moving underneath — a lit sequencer step, an
 * accent pad, a bright meter. Glass that reads as premium on a black
 * screenshot can put 8px labels under AA in a real session.
 *
 * So the alpha is not taste, it is a budget: these tests recompute the real
 * contrast from the actual `:root` tokens and fail if it drops below the AA
 * floor. Lowering the fill for a "more glassy" look breaks the build before it
 * breaks the UI.
 */

const css = readFileSync(join(__dirname, "../src/styles/26-settings-glass.css"), "utf8");
const base = readFileSync(join(__dirname, "../src/styles/01-base.css"), "utf8");
const index = readFileSync(join(__dirname, "../src/styles/index.css"), "utf8");

function rootTokens(): Record<string, string> {
  const block = base.slice(base.indexOf(":root"), base.indexOf("}", base.indexOf(":root")));
  const out: Record<string, string> = {};
  // Key WITHOUT the leading dashes, so the map reads `tokens["bg-panel"]` and
  // matches how ux-audit.test.ts names them. Storing "--bg-panel" would make
  // every lookup silently undefined and blend() would emit NaN hex.
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]!] = m[2]!;
  return out;
}

function luminance(hex: string): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = channel(parseInt(hex.slice(1, 3), 16));
  const g = channel(parseInt(hex.slice(3, 5), 16));
  const b = channel(parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Composite a translucent foreground over an opaque backdrop. */
function blend(fg: string, bg: string, alpha: number): string {
  const mix = (i: number) =>
    Math.round(
      parseInt(fg.slice(1 + i * 2, 3 + i * 2), 16) * alpha + parseInt(bg.slice(1 + i * 2, 3 + i * 2), 16) * (1 - alpha),
    );
  return `#${[mix(0), mix(1), mix(2)].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/** The alpha declared by the panel fill, as a number in 0..1. */
function declaredAlpha(): number {
  // Tolerant of line wrapping: prettier splits the color-mix() across lines, so
  // match the declaration itself rather than assuming one line.
  const match = /color-mix\(in srgb,\s*var\(--bg-panel\)\s+(\d+)%/.exec(css.replace(/\s+/g, " "));
  expect(match, "the panel fill must declare its own alpha — an unmeasurable one is not auditable").toBeTruthy();
  return Number(match![1]) / 100;
}

describe("settings glass · legibility budget", () => {
  const tokens = rootTokens();

  it("clears AA against the app background at the declared alpha", () => {
    const alpha = declaredAlpha();
    for (const name of ["text", "text-dim", "text-faint"]) {
      const composited = blend(tokens["bg-panel"]!, tokens["bg"]!, alpha);
      const ratio = contrast(tokens[name]!, composited);
      const floor = name === "text" ? 7 : 4.5;
      expect(
        ratio,
        `--${name} at ${(alpha * 100).toFixed(0)}% panel alpha is ${ratio.toFixed(2)}:1, needs ${floor}:1`,
      ).toBeGreaterThanOrEqual(floor);
    }
  });

  it("carries the text shadow that covers what the alpha cannot", () => {
    // Measured honestly: against a LIGHT backdrop the composite alone drops
    // below AA. The alpha fixes the common case; the shadow is what keeps the
    // panel readable over a lit step or a bright meter. Both halves are asserted
    // — claiming the alpha alone suffices would be a measurement made only on a
    // black backdrop, which is exactly the case a screenshot never shows.
    const bright = "#e8eaef";
    const compositeOnly = contrast(tokens["text-faint"]!, blend(tokens["bg-panel"]!, bright, declaredAlpha()));
    expect(compositeOnly, "documented: alpha alone is NOT enough over a light backdrop").toBeLessThan(4.5);
    expect(css, "the shadow that closes the gap must actually be declared").toMatch(
      /\.scale-popover\s*\{[^}]*text-shadow:/s,
    );
  });

  it("the alpha is high because a BRIGHT backdrop is the real danger, not the dark one", () => {
    // Over the dark app background a more transparent panel DARKENS the
    // composite, so contrast goes UP. The folk rule "transparency always hurts
    // contrast" is false here — which is why the value had to be measured
    // against both backdrops instead of reasoned about.
    const bright = "#e8eaef";
    const at = (alpha: number, backdrop: string) => blend(tokens["bg-panel"]!, backdrop, alpha);
    expect(contrast(tokens["text-faint"]!, at(0.5, tokens["bg"]!))).toBeGreaterThan(
      contrast(tokens["text-faint"]!, at(declaredAlpha(), tokens["bg"]!)),
    );
    expect(contrast(tokens["text-faint"]!, at(declaredAlpha(), bright))).toBeGreaterThan(
      contrast(tokens["text-faint"]!, at(0.5, bright)),
    );
  });

  it("keeps the panel opaque where backdrop-filter is unsupported", () => {
    // Without this, a browser that ignores the blur renders the panel at the
    // fill alpha over raw sequencer pixels — unreadable, and no warning.
    expect(css).toMatch(/@supports not[^{]*\{\s*\.scale-popover\s*\{[^}]*background:\s*var\(--bg-panel\)/s);
  });

  it("includes the -webkit- prefix, or Safari gets no blur at all", () => {
    expect(css).toContain("-webkit-backdrop-filter");
    expect(css).toContain("backdrop-filter");
  });
});

describe("settings glass · surface quality", () => {
  it("blurs and saturates — blur alone reads as grey plastic, not glass", () => {
    expect(css).toMatch(/backdrop-filter:\s*blur\([^)]*\)\s*saturate\(/);
  });

  it("carries an inner top highlight — the light-catching edge that reads as glass", () => {
    expect(css).toMatch(/inset 0 1px 0 rgba\(255,\s*255,\s*255/);
  });

  it("has both an ambient and a contact shadow, so it sits above the content", () => {
    const shadow = /box-shadow:([^;]+);/s.exec(css)?.[1] ?? "";
    expect(shadow).toMatch(/0 1[0-9]px/); // ambient
    expect(shadow).toMatch(/inset/); // inner edge
  });

  it("moves on entry, and Calm Motion disables it", () => {
    expect(css).toContain("@keyframes popover-in");
    expect(css).toMatch(/theme-no-anim \.scale-popover[\s\S]*animation:\s*none/);
  });

  it("Calm Motion also cuts the blur radius — a large blur costs a compositing pass per frame", () => {
    expect(css).toMatch(/theme-no-anim[\s\S]*backdrop-filter:\s*blur\(12px\)/);
  });

  it("is scrollable with a themed scrollbar — the token editor can exceed the panel", () => {
    expect(css).toMatch(/\.scale-popover\s*\{[^}]*overflow-y:\s*auto/s);
    expect(css).toContain("scrollbar-color");
    expect(css).toContain("::-webkit-scrollbar-thumb");
  });

  it("gives every control a visible focus ring — translucent glass hides a faint one", () => {
    expect(css).toMatch(/\.theme-panel :focus-visible[\s\S]*outline: 2px solid var\(--accent\)/);
  });
});

describe("settings glass · cascade order", () => {
  it("imports last, after every other sheet", () => {
    const imports = [...index.matchAll(/@import\s+"\.\/([^"]+)"/g)].map((m) => m[1]!);
    expect(imports[imports.length - 1]).toBe("26-settings-glass.css");
  });

  it("has no duplicated imports — a double @import silently doubles the cascade", () => {
    const imports = [...index.matchAll(/@import\s+"\.\/([^"]+)"/g)].map((m) => m[1]!);
    expect(new Set(imports).size, "duplicated: " + imports.join(", ")).toBe(imports.length);
  });
});
