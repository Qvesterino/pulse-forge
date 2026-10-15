/**
 * LAYOUT DATA — the single owner of KYX's UI appearance + geometry contract
 * (ADR 0036).
 *
 * Before this module the UI's "look and size" lived in three unrelated places:
 * a theme store (`pf-theme-v1`), a dock store (`pf-dock-v1`) and several
 * hundred hard-coded literals in `src/styles/*.css`. Nothing could express "the
 * whole layout", so nothing could be exported or migrated as one thing.
 *
 * This module is the PURE half: types, defaults, normalization and the legacy
 * migration. Zero React, zero DOM, zero storage access — the same contract
 * `shared/theme-data.ts` follows, so `domain-purity.test.ts` can pin it as
 * Node-executable and a future non-browser host can consume it. The reactive
 * half (applying the state to the document root, persisting it) lives in
 * `ui/layout.ts`.
 *
 * Purity rules this file must never break:
 * - no `document` / `window` / `localStorage`
 * - no React imports
 * - every untrusted value clamped or rejected (see normalizeLayoutState)
 */

/** Density is a three-step scale; the legacy boolean maps onto compact. */
export type Density = "comfortable" | "compact" | "dense";

export const DENSITY_LEVELS: readonly Density[] = ["comfortable", "compact", "dense"] as const;

/**
 * Every bottom-dock panel id. This is the single registry: `dockLayout.ts`
 * re-exports it and `DockChrome.tsx` builds its tab row from it, so the state
 * contract and the UI can never disagree about which panels exist.
 */
export const PANEL_KEYS = [
  "mixer",
  "devices",
  "tsar",
  "arr",
  "mod",
  "exp",
  "master",
  "midi",
  "dice",
  "intent",
  "reference",
] as const;

import { presetById } from "./theme-data";

/** Panel id as stored. "fx"/"plugin" are legacy spellings of "devices". */
export type LayoutPanel = (typeof PANEL_KEYS)[number];
export type BottomPanel = LayoutPanel | "fx" | "plugin";

export interface LayoutState {
  // ── Appearance ────────────────────────────────────────────────────────
  /** Palette preset id (see THEME_PRESETS in shared/theme-data). */
  preset: string;
  /** Custom accent hue 0..359 overriding the preset (null = preset). */
  hue: number | null;
  /** Whole-UI zoom factor 0.8..1.3, applied as a document-root zoom. */
  uiScale: number;
  /**
   * Typography scale 0.9..1.15, INDEPENDENT of uiScale. Separating them is what
   * lets the UI stay readable at 125 % without also stretching every panel.
   */
  typeScale: number;
  /** Vertical density of panels and paddings. */
  density: Density;
  /** Kill transitions/animations (accessibility). */
  reduceMotion: boolean;

  // ── Dock geometry ─────────────────────────────────────────────────────
  /** Dock height in px. Absolute bounds here; the viewport ceiling is applied
   *  by the applier, because it is a function of the live window. */
  dockHeight: number;
  /** How the two dock slots divide the width when split (0.2..0.8, slot A). */
  dockSplitRatio: number;
  /** Collapsed dock = the tab row only, no panel area. */
  dockCollapsed: boolean;
  /** Primary slot panel, or null when the slot is empty. */
  slotA: LayoutPanel | null;
  /** Split slot panel, or null when not split. */
  slotB: LayoutPanel | null;

  // ── Workspace geometry ────────────────────────────────────────────────
  /** Inspector column width in px (today a hard-coded 280 in 01-base.css). */
  inspectorWidth: number;
  /** Sequencer label column width in px (mirrors --steps-label). */
  sequencerLabelWidth: number;
  /** Rack pad-grid columns (today a hard-coded repeat(8, 1fr)). */
  rackColumns: number;

  // ── Per-token color overrides ─────────────────────────────────────────
  /**
   * User overrides for individual CSS variables, keyed by variable name with
   * the leading dashes (`"--bg-panel"`). This is the data half of the token
   * editor; the UI for it arrives in a later wave. Empty = preset decides.
   */
  colorOverrides: Record<string, string>;
}

/**
 * Bumped to v2 with the proportion pass of 2026-10-15.
 *
 * v1 stored `dockHeight: 220` as its default, which gave the always-on dock
 * panel more vertical space than the step sequencer — the primary instrument
 * of a step-based DAW. Measured at 1440x900 with scripts/ui-proportion.mjs:
 * sequencer ~70px (7.8% of the viewport) against dock 220px (24%).
 *
 * KYX has no shipped user base, so the honest migration is a clean one: a new
 * key resets every stored layout to the new defaults instead of leaving
 * machines on the old proportion. The two legacy keys below are deliberately
 * NOT carried into v2 — folding a legacy dock height forward would re-import
 * exactly the 220px this change exists to retire.
 */
export const LAYOUT_STORAGE_KEY = "pf-layout-v2";
export const LEGACY_THEME_KEY = "pf-theme-v1";
export const LEGACY_DOCK_KEY = "pf-dock-v1";

// ── Bounds (one place; the applier and the tests read these) ───────────────

export const LAYOUT_BOUNDS = {
  uiScale: { min: 0.8, max: 1.3 },
  typeScale: { min: 0.9, max: 1.15 },
  hue: { min: 0, max: 359 },
  dockHeight: { min: 160, max: 560 },
  dockSplitRatio: { min: 0.2, max: 0.8 },
  inspectorWidth: { min: 200, max: 420 },
  sequencerLabelWidth: { min: 112, max: 320 },
  rackColumns: { min: 4, max: 16 },
} as const;

export const DEFAULT_LAYOUT_STATE: LayoutState = {
  preset: "molten",
  hue: null,
  uiScale: 1,
  typeScale: 1,
  density: "comfortable",
  reduceMotion: false,
  dockHeight: 220,
  dockSplitRatio: 0.5,
  dockCollapsed: false,
  slotA: "mixer",
  slotB: null,
  inspectorWidth: 280,
  sequencerLabelWidth: 168,
  rackColumns: 8,
  colorOverrides: {},
};

// ── Validation helpers ─────────────────────────────────────────────────────

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A CSS color we are willing to write into a custom property. */
const SAFE_COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d.\s,%/-]+\)|hsla?\(\s*[\d.\s,%/deg-]+\)|[a-zA-Z]{3,20})$/;

export function isLayoutPanel(value: unknown): value is LayoutPanel {
  return typeof value === "string" && (PANEL_KEYS as readonly string[]).includes(value);
}

export function isDensity(value: unknown): value is Density {
  return typeof value === "string" && (DENSITY_LEVELS as readonly string[]).includes(value);
}

/** `--var-name` shape only — this map is written into a style declaration. */
export function isTokenName(value: unknown): value is string {
  return typeof value === "string" && /^--[a-z0-9-]{1,48}$/.test(value);
}

/** Cap the override map so a crafted payload cannot bloat storage. */
export const MAX_COLOR_OVERRIDES = 64;

export function sanitizeColorOverrides(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_COLOR_OVERRIDES) break;
    if (!isTokenName(key)) continue;
    if (typeof value !== "string" || !SAFE_COLOR.test(value.trim())) continue;
    out[key] = value.trim();
  }
  return out;
}

// ── Normalization ─────────────────────────────────────────────────────────

function num(value: unknown, min: number, max: number, fallback: number): number {
  if (!isFiniteNumber(value)) return fallback;
  return clamp(value, min, max);
}

/** Legacy ids ("fx", "plugin") canonicalize to the unified Devices panel. */
export function normalizePanelId(value: unknown): LayoutPanel | null {
  if (value === "fx" || value === "plugin") return "devices";
  return isLayoutPanel(value) ? value : null;
}

/**
 * Clamp/validate ANY partial layout — a freshly stored object, a migrated
 * legacy blob, or an untrusted PFLYT1 payload — into a legal `LayoutState`.
 *
 * The rule for numbers is deliberately ONE rule, not a per-field policy:
 *
 * - a finite number is CLAMPED into the legal band, because the closest legal
 *   reading preserves the user's intent. A dock persisted as 800px by a build
 *   whose ceiling was 800 lands on today's 560px ceiling — still "a tall dock",
 *   not a reset to the 220px default. This matches `decodeThemeCode`, which
 *   clamps a scale from an imported code for the same reason;
 * - a non-number (string, NaN, Infinity, null) falls back to the DEFAULT,
 *   because there is no direction to preserve and inventing one would be a lie.
 *
 * The trade is accepted knowingly: a corrupt-but-numeric value (uiScale 5)
 * becomes the band's edge (1.3) rather than 1.0. The alternative — snapping
 * every out-of-band number to the default — silently discards a legitimate old
 * dock height, which is a worse regression than a visible, adjustable extreme.
 */
export function normalizeLayoutState(partial: Partial<LayoutState>): LayoutState {
  const src = (typeof partial === "object" && partial !== null ? partial : {}) as Partial<LayoutState>;
  const b = LAYOUT_BOUNDS;
  // An ABSENT slot key means "never configured" and takes the default, while an
  // explicit `null` is a real user choice — the slot was closed — and must
  // survive normalization. Without this distinction a corrupt payload silently
  // opened the dock on an empty slot instead of the default mixer.
  const slotA = src.slotA === undefined ? DEFAULT_LAYOUT_STATE.slotA : normalizePanelId(src.slotA);
  const slotB = src.slotB === undefined ? DEFAULT_LAYOUT_STATE.slotB : normalizePanelId(src.slotB);
  return {
    // An unknown preset id must NOT survive: presetById() would silently map it
    // to the first preset while the stored id still said something else, so the
    // applier and the stored state would disagree about the active palette.
    preset: typeof src.preset === "string" ? presetById(src.preset).id : DEFAULT_LAYOUT_STATE.preset,
    hue: isFiniteNumber(src.hue) && src.hue >= b.hue.min && src.hue <= b.hue.max ? Math.round(src.hue) : null,
    uiScale: num(src.uiScale, b.uiScale.min, b.uiScale.max, DEFAULT_LAYOUT_STATE.uiScale),
    typeScale: num(src.typeScale, b.typeScale.min, b.typeScale.max, DEFAULT_LAYOUT_STATE.typeScale),
    density: isDensity(src.density) ? src.density : DEFAULT_LAYOUT_STATE.density,
    reduceMotion: src.reduceMotion === true,
    dockHeight: num(src.dockHeight, b.dockHeight.min, b.dockHeight.max, DEFAULT_LAYOUT_STATE.dockHeight),
    dockSplitRatio: num(
      src.dockSplitRatio,
      b.dockSplitRatio.min,
      b.dockSplitRatio.max,
      DEFAULT_LAYOUT_STATE.dockSplitRatio,
    ),
    dockCollapsed: src.dockCollapsed === true,
    // A panel can never occupy both slots — the split is one of them or neither.
    slotA,
    slotB: slotB === slotA ? null : slotB,
    inspectorWidth: num(
      src.inspectorWidth,
      b.inspectorWidth.min,
      b.inspectorWidth.max,
      DEFAULT_LAYOUT_STATE.inspectorWidth,
    ),
    sequencerLabelWidth: num(
      src.sequencerLabelWidth,
      b.sequencerLabelWidth.min,
      b.sequencerLabelWidth.max,
      DEFAULT_LAYOUT_STATE.sequencerLabelWidth,
    ),
    rackColumns: Math.round(
      num(src.rackColumns, b.rackColumns.min, b.rackColumns.max, DEFAULT_LAYOUT_STATE.rackColumns),
    ),
    colorOverrides: sanitizeColorOverrides(src.colorOverrides),
  };
}

// ── Legacy migration (ADR 0036 §3) ────────────────────────────────────────

/** Parse a legacy JSON blob; null on anything unparseable. */
function parseBlob(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Fold the two legacy stores into one layout.
 *
 * Only the legacy fields that HAVE a place in the new shape are read — the
 * viewport-dependent dock height is taken as-is and clamped to its absolute
 * bounds; the live-viewport ceiling is the applier's job because it depends on
 * the current window, not on stored data.
 *
 * Additive and idempotent: callers keep the legacy keys untouched, so a user
 * who downgrades to an older build keeps their old look.
 */
export function migrateLegacyLayout(themeRaw: string | null, dockRaw: string | null): LayoutState {
  const theme = parseBlob(themeRaw);
  const dock = parseBlob(dockRaw);

  const partial: Partial<LayoutState> = { ...DEFAULT_LAYOUT_STATE };

  if (theme) {
    if (typeof theme.preset === "string") partial.preset = theme.preset;
    if (isFiniteNumber(theme.hue)) partial.hue = theme.hue;
    if (isFiniteNumber(theme.scale)) partial.uiScale = theme.scale;
    // The binary flag becomes the middle rung of the three-step scale.
    if (theme.compact === true) partial.density = "compact";
    if (theme.reduceMotion === true) partial.reduceMotion = true;
  }

  if (dock) {
    if (isFiniteNumber(dock.height)) partial.dockHeight = dock.height;
    partial.slotA = normalizePanelId(dock.slotA);
    partial.slotB = normalizePanelId(dock.slotB);
  } else if (!theme) {
    // Neither legacy store exists: keep the built-in defaults, including the
    // default slotA ("mixer"). The explicit nulls above only apply when a dock
    // blob really existed.
    partial.slotA = DEFAULT_LAYOUT_STATE.slotA;
    partial.slotB = DEFAULT_LAYOUT_STATE.slotB;
  }

  return normalizeLayoutState(partial);
}

/**
 * Resolve the stored layout: prefer `pf-layout-v1`; otherwise migrate the two
 * legacy stores; otherwise defaults. Returns the state plus whether the
 * migration path ran, so the applier can decide to persist a copy.
 *
 * `storedRaw` is passed in rather than read here — this module never touches
 * storage.
 */
export function resolveLayoutState(
  storedRaw: string | null,
  themeRaw: string | null,
  dockRaw: string | null,
): {
  state: LayoutState;
  migrated: boolean;
} {
  const stored = parseBlob(storedRaw);
  if (stored) return { state: normalizeLayoutState(stored as Partial<LayoutState>), migrated: false };
  if (storedRaw !== null) {
    // Present but corrupt: fall through to the legacy/default path rather than
    // trusting a half-parsed object.
    return { state: migrateLegacyLayout(themeRaw, dockRaw), migrated: true };
  }
  if (themeRaw !== null || dockRaw !== null) return { state: migrateLegacyLayout(themeRaw, dockRaw), migrated: true };
  return { state: { ...DEFAULT_LAYOUT_STATE }, migrated: false };
}

// ── Derived reads ─────────────────────────────────────────────────────────

/**
 * The legacy `.theme-compact` class is derived from density so Vlna A changes
 * no pixel: "comfortable" and "dense" keep the pre-existing non-compact
 * rendering until the applier in the next wave differentiates them.
 */
export function isCompactDensity(density: Density): boolean {
  return density === "compact";
}

/**
 * Effective accent for a layout: a custom hue wins over the preset accent.
 * Reads only the two fields it needs, so callers never have to fabricate a
 * whole ThemeState just to resolve a colour.
 */
export function accentOfLayout(state: Pick<LayoutState, "preset" | "hue">): string {
  if (state.hue !== null) return `hsl(${state.hue}, 85%, 60%)`;
  return presetById(state.preset).accent;
}
