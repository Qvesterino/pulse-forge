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
  "choral",
  "kopa",
  "arr",
  "live",
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
 * THE STORAGE KEY. Stable — its NAME carries no version.
 *
 * WHAT WAS WRONG (and what the plan says about it)
 * -------------------------------------------------
 * The layout used to live under a key that carried its own version:
 * `pf-layout-v1`, then `pf-layout-v2`. Every schema change therefore needed a
 * NEW KEY, and a new key means a RESET: the old blob is not read at all, so
 * the user's palette, zoom, density and dock height are gone. The v1 -> v2
 * commit (e5109496) said so out loud: "KYX has no shipped user base, so the
 * honest migration is a clean one".
 *
 * That is a defensible choice at zero users. It is not a choice that can be
 * made again after the first release, which is why
 * docs/STUDIO-OPTIMIZATION-PLAN.md §5.1 lists it as the first thing that must
 * change before a real deployment: "treba verziu schémy a číselný posun, nie
 * výmaz" — a schema version and a numeric shift, not a wipe.
 *
 * THE SHAPE NOW
 * -------------
 * One stable key holding the state PLUS the schema version it was written
 * with:
 *
 *   { schemaVersion: 2, preset: "molten", dockHeight: 168, ... }
 *
 * The version travels with the state, so the next schema change reads the old
 * blob, runs the migration chain, and writes the new shape back under the same
 * key. The user keeps every choice they made.
 */
export const LAYOUT_STORAGE_KEY = "pf-layout";

/**
 * The schema version of the blob stored under LAYOUT_STORAGE_KEY.
 *
 * Bump it TOGETHER WITH a step in LAYOUT_MIGRATIONS. tests/layout-data.test.ts
 * asserts the chain has no holes, so a bump without a step fails the suite
 * instead of silently skipping a migration.
 */
export const LAYOUT_SCHEMA_VERSION = 2;

/**
 * `pf-layout-v2` — the key the pre-envelope release wrote. Read-only: its
 * blobs are bare states (no schema version) already on the v2 scale, so they
 * are read as-is and copied into the envelope.
 */
export const LEGACY_V2_KEY = "pf-layout-v2";

/**
 * `pf-layout-v1` — the oldest key. Read-only: its blobs are bare states on
 * the v1 scale, so the dock height needs the numeric shift.
 */
export const LEGACY_V1_KEY = "pf-layout-v1";

/** `pf-theme-v1` / `pf-dock-v1` — the two stores that predate the layout. */
export const LEGACY_THEME_KEY = "pf-theme-v1";
export const LEGACY_DOCK_KEY = "pf-dock-v1";

/**
 * The dock default schema v1 stored, and the one schema v2 stores. The ratio
 * between them IS the numeric shift.
 */
export const LAYOUT_V1_DOCK_HEIGHT = 220;

// ── Bounds (one place; the applier and the tests read these) ───────────────

export const LAYOUT_BOUNDS = {
  uiScale: { min: 0.8, max: 1.3 },
  typeScale: { min: 0.9, max: 1.15 },
  hue: { min: 0, max: 359 },
  dockHeight: { min: 140, max: 560 },
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
  /* 220 -> 168. Measured 2026-10-15 (scripts/ui-proportion.mjs): the dock
     panel took 297px / 33% of a 1440x900 viewport against 192px / 21% for the
     step sequencer — the auxiliary panel was half again the height of the
     instrument. 168px still shows the mixer macro row and fader heads; the
     dock stays user-resizable, so a taller mixer is a drag away, not a
     config edit. */
  dockHeight: 168,
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

// ── The migration chain (plan §5.1) ────────────────────────────────────────

/**
 * The numeric shift between the v1 and the v2 dock scale.
 *
 * Proportional, not absolute: the v1 default (220px) maps onto the v2 default
 * (168px), and a user's taller dock (350px) stays proportionally taller
 * (267px) instead of being flattened to the default. A wipe would have thrown
 * away the fact that this user wanted a tall dock at all.
 */
export const DOCK_HEIGHT_SHIFT = DEFAULT_LAYOUT_STATE.dockHeight / LAYOUT_V1_DOCK_HEIGHT;

/**
 * LAYOUT_MIGRATIONS[v] upgrades a state stored under schema version v to v+1.
 *
 * The chain must be CONTIGUOUS from 1 to LAYOUT_SCHEMA_VERSION: a hole would
 * silently skip a migration. The test asserts that, so a hole is a red suite
 * rather than a runtime surprise.
 *
 * The steps work on a PARTIAL state on purpose — the stored value is shifted
 * BEFORE it is clamped, so a dock persisted at 800px (v1's ceiling) becomes
 * 611px and is then clamped to today's 560px, instead of being clamped to
 * 560px first and then shifted down to 427px.
 */
export const LAYOUT_MIGRATIONS: Record<number, (state: Partial<LayoutState>) => Partial<LayoutState>> = {
  // v1 -> v2 (the proportion pass of 2026-10-15): the dock's default height
  // fell from 220px to 168px, because the dock was taking a third of the
  // viewport while the sequencer took a seventh. The dock height is the ONLY
  // field whose scale changed — every other v1 default was already v2's
  // default (verified against e5109496^).
  1: (state) => ({
    ...state,
    dockHeight: isFiniteNumber(state.dockHeight) ? Math.round(state.dockHeight * DOCK_HEIGHT_SHIFT) : state.dockHeight,
  }),
};

/**
 * Run the migration chain from `fromVersion` up to the current schema version.
 *
 * A HOLE in the chain stops the walk instead of skipping ahead: skipping would
 * apply a later step to a shape it does not understand. The chain's
 * contiguity is asserted by tests/layout-data.test.ts, so a hole is a red
 * suite rather than a runtime surprise.
 */
export function migrateLayoutState(partial: Partial<LayoutState>, fromVersion: number): LayoutState {
  let state: Partial<LayoutState> = { ...partial };
  for (let version = fromVersion; version < LAYOUT_SCHEMA_VERSION; version++) {
    const step = LAYOUT_MIGRATIONS[version];
    if (!step) break;
    state = step(state);
  }
  return normalizeLayoutState(state);
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
 * The schema version a stored blob declares, or null when it declares none.
 *
 * A blob without a version is a BARE state — the shape the pre-envelope
 * releases wrote. Which version it is comes from the KEY it was found under,
 * because the bare era covered two schemas.
 */
function readSchemaVersion(blob: Record<string, unknown>): number | null {
  const value = blob.schemaVersion;
  if (!isFiniteNumber(value)) return null;
  const version = Math.trunc(value);
  return version >= 1 ? version : null;
}

/**
 * Every place a stored layout can come from. Each is a raw localStorage
 * string — this module never touches storage itself.
 */
export interface LayoutStorageSources {
  /** `pf-layout` — the stable key. Carries `schemaVersion`. */
  current: string | null;
  /** `pf-layout-v2` — a bare state from the pre-envelope release. */
  v2: string | null;
  /** `pf-layout-v1` — the oldest bare state (dock on the 220px scale). */
  v1: string | null;
  /** `pf-theme-v1` — the theme store that predates the layout. */
  theme: string | null;
  /** `pf-dock-v1` — the dock store that predates the layout. */
  dock: string | null;
}

export interface ResolvedLayout {
  state: LayoutState;
  /**
   * True when the stored data was not already in the current shape, so the
   * applier should write the migrated copy back.
   */
  migrated: boolean;
}

/**
 * Resolve the stored layout from every source, in the order the plan §5.1
 * demands: a schema version and a numeric shift, never a wipe.
 *
 * THE ORDER
 * ---------
 * 1. `pf-layout` — the stable key. Its `schemaVersion` decides what happens:
 *    - the current version -> read as it is;
 *    - an older version -> run the migration chain and shift the numbers;
 *    - a NEWER version -> do not touch it (see below);
 *    - no version -> foreign data, read as the current version.
 * 2. `pf-layout-v2` — a bare state already on the v2 scale. Copied as it is.
 * 3. `pf-layout-v1` — a bare state on the v1 scale. The dock height is
 *    shifted.
 * 4. `pf-theme-v1` + `pf-dock-v1` — the two stores that predate the layout.
 *    The legacy dock height was `Math.min(220, ...)`, i.e. the v1 scale, so
 *    the folded result is shifted too.
 *
 * WHY A NEWER VERSION IS NOT TOUCHED
 * -----------------------------------
 * A blob written by a future build cannot be understood here, and writing over
 * it would destroy data we cannot read. So the future version falls back to
 * the older sources WITHOUT claiming a migration — `migrated: false` is what
 * stops the applier from persisting over the newer build's state. The same
 * rule the project schema follows: reject an unknown future version.
 */
export function resolveLayoutState(sources: LayoutStorageSources): ResolvedLayout {
  const current = parseBlob(sources.current);
  if (current) {
    const version = readSchemaVersion(current);
    if (version === null) {
      // A bare object under the stable key: the stable key has only ever been
      // written as a versioned blob, so this is foreign data with no declared
      // version. Read it as the CURRENT version — shifting a value we cannot
      // place would CHANGE a number the user never asked to change, and that
      // is worse than reading it as it was written.
      return { state: normalizeLayoutState(current as Partial<LayoutState>), migrated: false };
    }
    if (version > LAYOUT_SCHEMA_VERSION) {
      const older = readOlderSources(sources);
      return { state: older ?? { ...DEFAULT_LAYOUT_STATE }, migrated: false };
    }
    if (version === LAYOUT_SCHEMA_VERSION) {
      return { state: normalizeLayoutState(current as Partial<LayoutState>), migrated: false };
    }
    return { state: migrateLayoutState(current as Partial<LayoutState>, version), migrated: true };
  }

  const older = readOlderSources(sources);
  if (older) return { state: older, migrated: true };
  if (sources.current !== null) {
    // Present but corrupt, and there is nothing older to fall back to: the
    // fallback is a REPAIR, so the applier writes it back.
    return { state: { ...DEFAULT_LAYOUT_STATE }, migrated: true };
  }
  return { state: { ...DEFAULT_LAYOUT_STATE }, migrated: false };
}

/**
 * The older sources, in order: the v2 mirror, the v1 key, the two legacy
 * stores. Null when none of them exists.
 */
function readOlderSources(sources: LayoutStorageSources): LayoutState | null {
  const v2 = parseBlob(sources.v2);
  if (v2) return normalizeLayoutState(v2 as Partial<LayoutState>);
  const v1 = parseBlob(sources.v1);
  if (v1) return migrateLayoutState(v1 as Partial<LayoutState>, 1);
  if (sources.theme !== null || sources.dock !== null) {
    return migrateLayoutState(migrateLegacyLayout(sources.theme, sources.dock), 1);
  }
  return null;
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
