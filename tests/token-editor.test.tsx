import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TokenEditor } from "../src/ui/TokenEditor";
import {
  COLOR_TOKENS,
  TOKEN_GROUPS,
  buildTokenCatalog,
  isOverridden,
  setTokenOverride,
  toHexInput,
} from "../src/ui/tokenCatalog";
import { getLayoutSnapshot, resetLayout, setLayout } from "../src/ui/layout";

/**
 * The token editor (ADR 0036, confirmed scope).
 *
 * A colour editor has one unforgivable failure mode: it lets the user pin a
 * colour with no way back. They tune one token, later cannot explain why the
 * UI looks off, and the only escape is a global reset that throws away every
 * other setting. These tests pin the per-token reset as a first-class part of
 * the contract, not a nicety.
 *
 * The catalog-integrity test is the other one that matters: a scraped list
 * would silently gain or lose rows on every unrelated CSS edit, so the editable
 * surface would change without anyone deciding it.
 */

describe("tokenCatalog · integrity", () => {
  const base = readFileSync(join(__dirname, "../src/styles/01-base.css"), "utf8");
  const rootBlock = base.slice(base.indexOf(":root"), base.indexOf("}", base.indexOf(":root")));

  it("every catalog token is a real, legal custom property name", () => {
    for (const token of COLOR_TOKENS) {
      expect(token.id, "must be --kebab-case").toMatch(/^--[a-z0-9-]+$/);
      expect(new RegExp(`${token.id}:`), `${token.id} must exist in :root`).toBeTruthy();
    }
  });

  it("has no duplicate ids", () => {
    expect(new Set(COLOR_TOKENS.map((t) => t.id)).size).toBe(COLOR_TOKENS.length);
  });

  it("every token declares a group that exists, and every group has rows", () => {
    for (const token of COLOR_TOKENS) {
      expect(TOKEN_GROUPS).toContain(token.group);
      expect(token.label.length).toBeGreaterThan(0);
      expect(token.hint.length).toBeGreaterThan(0);
    }
    for (const group of TOKEN_GROUPS) {
      expect(COLOR_TOKENS.filter((t) => t.group === group).length).toBeGreaterThan(0);
    }
  });

  it("offers no non-colour tokens — shadows and alpha are not colour inputs", () => {
    // --elev-* are box-shadows and --hairline an alpha; a colour picker for
    // them yields a field the user cannot fill in meaningfully.
    for (const token of COLOR_TOKENS) {
      expect(token.id).not.toMatch(/^--elev-/);
      expect(token.id).not.toBe("--hairline");
    }
  });

  it("does not offer sizing or font tokens", () => {
    const notColours = ["--space-1", "--radius-md", "--ctrl-h", "--fs-md", "--mono", "--sans", "--steps-label"];
    for (const id of notColours) {
      expect(COLOR_TOKENS.map((t) => t.id)).not.toContain(id);
    }
  });

  it("the root block actually declares the tokens the catalog claims (no dead rows)", () => {
    // The mirror of the test above: if someone renames --bg-panel in the CSS,
    // this fails instead of leaving an editor row that edits nothing.
    const declared = [...rootBlock.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => m[1]!);
    for (const token of COLOR_TOKENS) {
      expect(declared, `${token.id} is in the catalog but not in :root`).toContain(token.id);
    }
  });
});

describe("tokenCatalog · colour parsing", () => {
  it("converts the forms a preset or a picker actually produces", () => {
    expect(toHexInput("#f59e0b")).toBe("#f59e0b");
    expect(toHexInput("#ABC")).toBe("#aabbcc");
    expect(toHexInput("rgb(245, 158, 11)")).toBe("#f59e0b");
    expect(toHexInput("rgba(245, 158, 11, 0.14)")).toBe("#f59e0b");
  });

  it("returns null rather than guessing at a value a picker cannot show", () => {
    // A swatch that silently differs from the real value is a lie the user
    // cannot detect; falling back to a text field is honest.
    expect(toHexInput("transparent")).toBeNull();
    expect(toHexInput("currentColor")).toBeNull();
    expect(toHexInput("var(--bg)")).toBeNull();
    expect(toHexInput("linear-gradient(#fff, #000)")).toBeNull();
  });

  it("clamps an out-of-range rgb channel instead of producing an invalid hex", () => {
    expect(toHexInput("rgb(300, 0, 0)")).toBe("#ff0000");
  });
});

describe("tokenCatalog · override mechanics", () => {
  it("sets an override and clears it with null — the only way back", () => {
    const set = setTokenOverride({}, "--bg-panel", "#123456");
    expect(set["--bg-panel"]).toBe("#123456");
    const cleared = setTokenOverride(set, "--bg-panel", null);
    expect(cleared["--bg-panel"]).toBeUndefined();
    expect(isOverridden(cleared, "--bg-panel")).toBe(false);
  });

  it("refuses an illegal variable name — the map is written into a style declaration", () => {
    const next = setTokenOverride({}, "background", "red");
    expect(Object.keys(next)).toHaveLength(0);
  });

  it("trims input so a pasted colour with spaces still applies", () => {
    expect(setTokenOverride({}, "--accent", "  #22d3ee  ")["--accent"]).toBe("#22d3ee");
  });

  it("does not disturb the other overrides when one is cleared", () => {
    let state = setTokenOverride({}, "--bg", "#000000");
    state = setTokenOverride(state, "--text", "#ffffff");
    state = setTokenOverride(state, "--bg", null);
    expect(state["--text"]).toBe("#ffffff");
    expect(state["--bg"]).toBeUndefined();
  });
});

describe("tokenCatalog · building rows", () => {
  it("reads the live value from the document and flags the overridden ones", () => {
    const fakeRoot = { style: { getPropertyValue: (n: string) => (n === "--bg" ? "#010203" : "") } };
    const rows = buildTokenCatalog(fakeRoot, { "--text": "#ffffff" });
    const bg = rows.find((r) => r.id === "--bg")!;
    const text = rows.find((r) => r.id === "--text")!;
    expect(bg.current).toBe("#010203");
    expect(bg.overridden).toBe(false);
    expect(text.current).toBe("#ffffff");
    expect(text.overridden).toBe(true);
  });

  it("survives a null document (non-browser host / SSR)", () => {
    expect(() => buildTokenCatalog(null, {})).not.toThrow();
    expect(buildTokenCatalog(null, {})).toHaveLength(COLOR_TOKENS.length);
  });
});

describe("TokenEditor · the reset that must exist", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLayout();
  });

  function open() {
    render(<TokenEditor />);
    fireEvent.click(screen.getByRole("button", { name: /COLOURS/i }));
  }

  it("is collapsed by default and expands on click", () => {
    render(<TokenEditor />);
    expect(screen.getByRole("button", { name: /COLOURS/i })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: /COLOURS/i }));
    expect(screen.getByLabelText(/App background hex value/i)).toBeInTheDocument();
  });

  it("typing a hex pins that one token and leaves the others alone", () => {
    open();
    const field = screen.getByLabelText("Panel hex value");
    fireEvent.change(field, { target: { value: "#123456" } });
    fireEvent.keyDown(field, { key: "Enter" });

    const state = getLayoutSnapshot();
    expect(state.colorOverrides["--bg-panel"]).toBe("#123456");
    // Exactly one token is pinned — editing one must not capture the palette.
    expect(Object.keys(state.colorOverrides)).toHaveLength(1);
  });

  it("the native colour picker writes the same store", () => {
    open();
    fireEvent.change(screen.getByLabelText("Accent colour picker"), { target: { value: "#22d3ee" } });
    expect(getLayoutSnapshot().colorOverrides["--accent"]).toBe("#22d3ee");
  });

  it("shows a per-token reset ONLY for a token the user changed", () => {
    open();
    expect(screen.queryByLabelText("Reset Panel")).not.toBeInTheDocument();
    const field = screen.getByLabelText("Panel hex value");
    fireEvent.change(field, { target: { value: "#123456" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.getByLabelText("Reset Panel")).toBeInTheDocument();
    // An untouched token still offers no reset — it would be a no-op button.
    expect(screen.queryByLabelText("Reset App background")).not.toBeInTheDocument();
  });

  it("the per-token reset returns THAT token to the palette and keeps the others", () => {
    open();
    const panel = screen.getByLabelText("Panel hex value");
    fireEvent.change(panel, { target: { value: "#123456" } });
    fireEvent.keyDown(panel, { key: "Enter" });
    const text = screen.getByLabelText("Text hex value");
    fireEvent.change(text, { target: { value: "#ffffff" } });
    fireEvent.keyDown(text, { key: "Enter" });

    fireEvent.click(screen.getByLabelText("Reset Panel"));

    const state = getLayoutSnapshot();
    expect(state.colorOverrides["--bg-panel"]).toBeUndefined();
    expect(state.colorOverrides["--text"]).toBe("#ffffff");
  });

  it("an unparseable colour is refused rather than silently swallowed", () => {
    open();
    const field = screen.getByLabelText("Panel hex value");
    fireEvent.change(field, { target: { value: "not-a-colour" } });
    fireEvent.keyDown(field, { key: "Enter" });
    // A field that swallows input is worse than one that keeps the old value:
    // the user would believe the colour was applied.
    expect(getLayoutSnapshot().colorOverrides["--bg-panel"]).toBeUndefined();
  });

  it("Escape abandons an edit without writing anything", () => {
    open();
    const field = screen.getByLabelText("Panel hex value");
    fireEvent.change(field, { target: { value: "#654321" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(getLayoutSnapshot().colorOverrides["--bg-panel"]).toBeUndefined();
  });

  it("the badge counts pinned tokens, and RESET ALL clears them", () => {
    open();
    expect(screen.queryByText(/RESET ALL/)).not.toBeInTheDocument();
    const field = screen.getByLabelText("Panel hex value");
    fireEvent.change(field, { target: { value: "#123456" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(screen.getByRole("button", { name: /RESET ALL 1/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /RESET ALL 1/i }));
    expect(getLayoutSnapshot().colorOverrides).toEqual({});
  });

  it("overrides survive a preset switch — a pinned token outranks the palette", () => {
    open();
    const field = screen.getByLabelText("Panel hex value");
    fireEvent.change(field, { target: { value: "#123456" } });
    fireEvent.keyDown(field, { key: "Enter" });

    act(() => setLayout({ preset: "cyan" }));
    expect(getLayoutSnapshot().colorOverrides["--bg-panel"]).toBe("#123456");
    expect(getLayoutSnapshot().preset).toBe("cyan");
  });

  it("renders every catalog token so no authorized colour is unreachable", () => {
    open();
    for (const token of COLOR_TOKENS) {
      expect(screen.getByLabelText(`${token.label} hex value`), `${token.id} must have a field`).toBeInTheDocument();
    }
  });

  it("persists overrides to the layout store, so they survive a reload", () => {
    open();
    const field = screen.getByLabelText("Panel hex value");
    fireEvent.change(field, { target: { value: "#123456" } });
    fireEvent.keyDown(field, { key: "Enter" });

    const stored = JSON.parse(localStorage.getItem("pf-layout-v1")!);
    expect(stored.colorOverrides["--bg-panel"]).toBe("#123456");
  });
});

describe("TokenEditor · wiring", () => {
  const panel = readFileSync(join(__dirname, "../src/ui/ThemePanel.tsx"), "utf8");
  const css = readFileSync(join(__dirname, "../src/styles/24-layout-tokens.css"), "utf8");

  it("the theme panel hosts the editor", () => {
    expect(panel).toContain("TokenEditor");
  });

  it("is styled (a raw unstyled row is a shipped defect)", () => {
    expect(css).toContain(".token-row");
    expect(css).toContain(".token-editor-reset-all");
    expect(css).toMatch(/\.token-row-reset/);
  });
});
