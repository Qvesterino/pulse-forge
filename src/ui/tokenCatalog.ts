import { DEFAULT_LAYOUT_STATE, isTokenName, sanitizeColorOverrides } from "../shared/layout-data";

/**
 * TOKEN CATALOG — the authorized list of user-editable colour tokens
 * (ADR 0036, confirmed scope: "a token editor, per-variable colour fields").
 *
 * WHY AN AUTHORIZED LIST AND NOT A CSS SCRAPE. A user picker needs to know
 * three things per token: a human label, a group, and — critically — whether
 * the value is a COLOUR. `--elev-1..3` and `--hairline` are box-shadows and
 * alpha, not colours; offering them in a colour picker produces a field the
 * user cannot fill in meaningfully and a value the eye cannot verify. Worse, a
 * scraped list silently grows every time someone adds a token, so the editor
 * would present a different surface area after every unrelated CSS change.
 * An explicit catalog makes the set a product decision, not a side effect.
 *
 * The list is pinned by a test against the real `:root` in 01-base.css: a token
 * that no longer exists must be removed here (dead row), and a new colour
 * token must be added here (invisible row) — the test fails either way.
 */

export interface ColorTokenDef {
  /** The CSS custom property name, WITH leading dashes. */
  id: string;
  /** Short human label for the editor row. */
  label: string;
  /** Group heading in the editor. */
  group: "SURFACES" | "TEXT" | "ACCENT + STATUS" | "GLASS";
  /** One-line explanation of what the token paints, for the row tooltip. */
  hint: string;
}

/**
 * The editable set, ordered the way a user reasons about a UI: background
 * first, then what sits on it, then accents and status, then the glass
 * overlays. Presets override the first eleven (PRESET_OWNED_VARS); the glass
 * tokens and the rest are preset-independent, which is exactly why a token
 * editor is valuable for them.
 */
export const COLOR_TOKENS: readonly ColorTokenDef[] = [
  { id: "--bg", label: "App background", group: "SURFACES", hint: "The darkest layer — behind everything" },
  { id: "--bg-panel", label: "Panel", group: "SURFACES", hint: "Primary panel surface" },
  { id: "--bg-panel-2", label: "Panel raised", group: "SURFACES", hint: "Cards and rows inside a panel" },
  { id: "--bg-raise", label: "Raised", group: "SURFACES", hint: "Controls, buttons, inputs" },
  { id: "--border", label: "Border", group: "SURFACES", hint: "Default border and divider" },
  { id: "--border-soft", label: "Border soft", group: "SURFACES", hint: "Faint separators" },
  { id: "--text", label: "Text", group: "TEXT", hint: "Primary text" },
  { id: "--text-dim", label: "Text dim", group: "TEXT", hint: "Secondary text" },
  { id: "--text-faint", label: "Text faint", group: "TEXT", hint: "Metadata, labels, disabled text" },
  { id: "--accent", label: "Accent", group: "ACCENT + STATUS", hint: "Interactive highlights, active states" },
  { id: "--accent-soft", label: "Accent soft", group: "ACCENT + STATUS", hint: "Accent at low opacity (fills, glow)" },
  { id: "--play", label: "Play", group: "ACCENT + STATUS", hint: "Transport play / recording level" },
  { id: "--stop", label: "Stop", group: "ACCENT + STATUS", hint: "Stop, destructive actions" },
  { id: "--glass-scene", label: "Glass base", group: "GLASS", hint: "Frosted overlay fill" },
  { id: "--glass-scene-strong", label: "Glass strong", group: "GLASS", hint: "Brighter frosted fill" },
  { id: "--glass-scene-stroke", label: "Glass edge", group: "GLASS", hint: "Frosted overlay border" },
];

export const TOKEN_GROUPS: readonly ColorTokenDef["group"][] = ["SURFACES", "TEXT", "ACCENT + STATUS", "GLASS"];

/**
 * Parse a colour into `#rrggbb` for a native `<input type="color">`, which
 * only accepts that form. Returns null for values it cannot represent (alpha
 * colours, gradients, CSS-wide keywords) so the UI can fall back to a text
 * field instead of showing a swatch that lies about the value.
 */
export function toHexInput(value: string): string | null {
  const trimmed = value.trim();
  const shortHex = /^#([0-9a-fA-F]{3})$/.exec(trimmed);
  if (shortHex) {
    const [r, g, b] = shortHex[1]!.split("");
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const hex = /^#([0-9a-fA-F]{6})$/.exec(trimmed);
  if (hex) return trimmed.toLowerCase();
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(trimmed);
  if (rgb) {
    const toHex = (n: string) => Math.min(255, Number(n)).toString(16).padStart(2, "0");
    return `#${toHex(rgb[1]!)}${toHex(rgb[2]!)}${toHex(rgb[3]!)}`;
  }
  return null;
}

export interface TokenCatalogEntry extends ColorTokenDef {
  /** The value the preset / :root currently yields, or null if unresolvable. */
  current: string | null;
  /** True when the user has pinned their own value for this token. */
  overridden: boolean;
}

/**
 * Build the editor rows from the LIVE document, so a row always shows what
 * the user is actually looking at — including a preset's value and an existing
 * override — rather than a value re-derived from a table that can drift.
 *
 * `root` is injectable so tests do not depend on jsdom's CSS engine.
 */
export function buildTokenCatalog(
  root: { style: { getPropertyValue(name: string): string } } | null,
  overrides: Record<string, string>,
  fallback: Record<string, string> = {},
): TokenCatalogEntry[] {
  return COLOR_TOKENS.map((token) => {
    const overridden = Object.prototype.hasOwnProperty.call(overrides, token.id);
    let current: string | null = null;
    if (root) {
      const inline = root.style.getPropertyValue(token.id).trim();
      current = inline || fallback[token.id]?.trim() || null;
    }
    if (!current && overridden) current = overrides[token.id]!.trim();
    return { ...token, current, overridden };
  });
}

/**
 * Set one token. Passing `null` removes the override, which is the ONLY way
 * back to the preset value — an override that cannot be cleared becomes
 * permanent and invisible, which ADR 0036 calls out as the failure mode that
 * the editor must not have.
 */
export function setTokenOverride(
  overrides: Record<string, string>,
  id: string,
  value: string | null,
): Record<string, string> {
  const next = { ...overrides };
  if (value === null) {
    delete next[id];
    return sanitizeColorOverrides(next);
  }
  if (!isTokenName(id)) return next;
  next[id] = value.trim();
  return sanitizeColorOverrides(next);
}

/** Does this token have an override? Kept tiny so the row component reads clearly. */
export function isOverridden(overrides: Record<string, string>, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(overrides, id);
}

/** The editor starts clean: overrides empty, defaults untouched. */
export const NO_OVERRIDES: Record<string, string> = { ...DEFAULT_LAYOUT_STATE.colorOverrides };
