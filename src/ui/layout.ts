import { useSyncExternalStore } from "react";
import {
  accentOfLayout,
  DEFAULT_LAYOUT_STATE,
  isCompactDensity,
  isTokenName,
  LAYOUT_SCHEMA_VERSION,
  LAYOUT_STORAGE_KEY,
  LEGACY_DOCK_KEY,
  LEGACY_THEME_KEY,
  LEGACY_V1_KEY,
  LEGACY_V2_KEY,
  normalizeLayoutState,
  resolveLayoutState,
  type LayoutState,
} from "../shared/layout-data";
import { hexOrHslToSoft, PRESET_OWNED_VARS, presetById } from "../shared/theme-data";

/**
 * UI LAYOUT — the reactive half of the layout contract (ADR 0036).
 *
 * `shared/layout-data.ts` owns the pure data; this module owns everything that
 * needs a browser: reading localStorage, applying the state to the document
 * root, and notifying React. It is the only place that reads or writes the
 * layout key.
 *
 * The bridge keeps the OLD public APIs alive so nothing else has to change in
 * this wave:
 * - `theme.ts` re-exports its own store, but `initTheme()` now delegates here,
 *   so the first paint comes from the merged layout state;
 * - `dockLayout.ts` reads/writes the dock fields of the SAME state, so a dock
 *   height and a palette can no longer drift apart.
 *
 * The legacy keys (`pf-layout-v2`, `pf-layout-v1`, `pf-theme-v1`, `pf-dock-v1`)
 * are read once for migration and never written back — a user on an older
 * build keeps their preferences.
 */

/** Class the applier toggles when the user overrides the label width. */
const USER_LABEL_CLASS = "user-label-width";

let state: LayoutState = { ...DEFAULT_LAYOUT_STATE };
const listeners = new Set<() => void>();

/** Reads are wrapped: a private-mode throw must not break the boot. */
function readKey(key: string): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / quota — the layout is cosmetic, stay silent */
  }
}

/**
 * Apply the state to the document root.
 *
 * Three groups, and the ORDER matters:
 * 1. preset palette vars (cleared first, so a preset without overrides falls
 *    back to :root instead of leaking the previous palette);
 * 2. the user's per-token overrides LAST, so a token editor wins over a preset;
 * 3. behaviour classes + the document zoom.
 *
 * Every property is set on the root element, never on a React node: the layout
 * is global chrome, and a panel that mounts late must see the same values as
 * the shell that mounted first.
 */
export function applyLayoutToDocument(next: LayoutState): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const preset = presetById(next.preset);
  const accent = accentOfLayout(next);
  const apply: Record<string, string> = {
    ...preset.vars,
    "--accent": accent,
    "--accent-soft": hexOrHslToSoft(accent),
  };
  // Clear preset-owned vars first: a preset without overrides (Cyan) must fall
  // back to :root, not to whatever palette was applied before it.
  for (const key of PRESET_OWNED_VARS) {
    if (!(key in apply)) root.style.removeProperty(key);
  }
  for (const [key, value] of Object.entries(apply)) {
    root.style.setProperty(key, value);
  }
  // Per-token overrides win over the preset — the token editor's whole point.
  for (const [key, value] of Object.entries(next.colorOverrides)) {
    if (isTokenName(key)) root.style.setProperty(key, value);
  }

  // Layout geometry tokens.
  //
  // IMPORTANT: these are written as CLASSES, not as inline custom properties.
  // An inline `--steps-label: 280px` on <html> OUTRANKS every stylesheet rule,
  // which would permanently kill the existing 760px media query that narrows
  // the label to 112px on phones. Classes lose to media queries, so the
  // responsive behaviour survives while the user's explicit choice still wins
  // where no breakpoint applies.
  //
  // The exact-width class is only attached when the user has moved OFF the
  // default: at 168px the stylesheet default already applies, so adding a class
  // would be redundant noise in the DOM.
  if (next.sequencerLabelWidth === DEFAULT_LAYOUT_STATE.sequencerLabelWidth) {
    root.classList.remove(USER_LABEL_CLASS);
  } else {
    root.classList.add(USER_LABEL_CLASS);
    root.style.setProperty("--user-steps-label", `${next.sequencerLabelWidth}px`);
  }

  // These geometry values have no competing media query, so inline values keep
  // them exact.
  root.style.setProperty("--inspector-width", `${next.inspectorWidth}px`);
  root.style.setProperty("--dock-split-ratio", String(next.dockSplitRatio));
  root.style.setProperty("--rack-columns", String(next.rackColumns));
  root.style.setProperty("--type-scale", String(next.typeScale));

  // Density + motion behave as classes so CSS can respond without JS layout
  // math. `theme-compact` is the LEGACY class name the current stylesheet
  // already targets; `density-*` is the forward name.
  root.classList.toggle("theme-compact", isCompactDensity(next.density));
  root.classList.toggle("density-comfortable", next.density === "comfortable");
  root.classList.toggle("density-compact", next.density === "compact");
  root.classList.toggle("density-dense", next.density === "dense");
  root.classList.toggle("theme-no-anim", next.reduceMotion);
  (root.style as CSSStyleDeclaration & { zoom: string }).zoom = String(next.uiScale);
}

/**
 * Boot-time: load the merged layout and apply it before the first paint.
 *
 * Order is load → apply → persist-if-migrated. Persisting the migrated copy is
 * what makes the migration a ONE-TIME fold: the next boot reads the stable key
 * directly and the legacy keys are never consulted again.
 *
 * The legacy keys are still READ, because the stable key is new: a machine
 * that has been running the pre-envelope release has its layout under
 * `pf-layout-v2`, and that layout must survive the upgrade.
 */
export function initLayout(): LayoutState {
  const resolved = resolveLayoutState({
    current: readKey(LAYOUT_STORAGE_KEY),
    v2: readKey(LEGACY_V2_KEY),
    v1: readKey(LEGACY_V1_KEY),
    theme: readKey(LEGACY_THEME_KEY),
    dock: readKey(LEGACY_DOCK_KEY),
  });
  state = resolved.state;
  applyLayoutToDocument(state);
  if (resolved.migrated) persist();
  return state;
}

/**
 * Write the state under the stable key, together with the schema version it
 * was written with.
 *
 * The version is part of the blob, NOT part of the key name. That is the whole
 * point: the next schema change reads this blob, migrates it, and writes it
 * back under the SAME key, so the user's choices survive instead of being
 * wiped by a rename.
 */
function persist(): void {
  writeKey(LAYOUT_STORAGE_KEY, JSON.stringify({ ...state, schemaVersion: LAYOUT_SCHEMA_VERSION }));
}

/** Apply a patch and notify. Normalized on the way in, like the theme store. */
export function setLayout(patch: Partial<LayoutState>): void {
  state = normalizeLayoutState({ ...state, ...patch });
  persist();
  applyLayoutToDocument(state);
  for (const listener of listeners) listener();
}

export function resetLayout(): void {
  setLayout({ ...DEFAULT_LAYOUT_STATE });
}

/** Current state (stable reference — changes only on setLayout). */
export function getLayoutSnapshot(): LayoutState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Raw subscription for non-hook consumers (theme.ts bridge, tests). */
export function subscribeLayout(listener: () => void): () => void {
  return subscribe(listener);
}

/** Reactive layout state for components. */
export function useLayout(): LayoutState {
  return useSyncExternalStore(subscribe, getLayoutSnapshot);
}

// ── Storage epilogue ────────────────────────────────────────────────────────

/**
 * Flush a pending write on tab close. The layout store writes synchronously on
 * every setLayout (unlike the dock's debounced writer), so this is belt-and-
 * braces for the rare case where the page is torn down mid-persist.
 */
export function flushLayout(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ ...state, schemaVersion: LAYOUT_SCHEMA_VERSION }));
  } catch {
    /* stay silent */
  }
}
