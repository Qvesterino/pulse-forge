import { useSyncExternalStore } from "react";
import { normalizeThemeState, type ThemeState } from "../shared/theme-data";
import { isCompactDensity, type LayoutState } from "../shared/layout-data";
import { getLayoutSnapshot, initLayout, setLayout, subscribeLayout as layoutSubscribe } from "./layout";

/**
 * Theme panel binding — a TRANSPARENT view over the unified layout store
 * (ADR 0036).
 *
 * This module used to own `pf-theme-v1` and the document application. It no
 * longer owns either: `ui/layout.ts` is the single writer of `pf-layout-v1` and
 * the only thing that touches the document root. What remains here is the old
 * public API, so `ThemePanel`, `RackStrip` (pack export) and every existing
 * test keep working against the same `ThemeState` shape they always used.
 *
 * Why keep the old shape at all: a theme travels inside shared packs
 * (`packCode.ts` carries `theme: ThemeState`), and those packs are already on
 * other people's machines. Changing the shape would orphan them. The mapping
 * between the two shapes lives in exactly two places — `toTheme` and
 * `fromTheme` — so the compatibility cost is visible instead of scattered.
 *
 * Persistence moved: there is no longer a `pf-theme-v1` key. `initTheme()`
 * delegates to `initLayout()`, which reads `pf-layout-v1` and folds the legacy
 * keys in once. `PFTHM1:` codes still decode through `themeCode.ts`.
 */

export { DEFAULT_THEME_STATE, hexOrHslToSoft, normalizeThemeState, THEME_PRESETS } from "../shared/theme-data";
export { accentOf } from "../shared/theme-data";
export type { ThemePreset, ThemeState } from "../shared/theme-data";

// Imported for `resetTheme`, which must clear both the theme fields AND any
// colour overrides so RESET really means the built-in look.
import { DEFAULT_THEME_STATE } from "../shared/theme-data";

let state: ThemeState = { ...DEFAULT_THEME_STATE };
let subscribed = false;
const listeners = new Set<() => void>();

/** LayoutState → ThemeState (what the legacy API exposes). */
function toTheme(layout: LayoutState): ThemeState {
  return {
    preset: layout.preset,
    hue: layout.hue,
    scale: layout.uiScale,
    compact: isCompactDensity(layout.density),
    reduceMotion: layout.reduceMotion,
  };
}

/** ThemeState patch → LayoutState patch (what the legacy API accepts). */
function fromTheme(patch: Partial<ThemeState>): Partial<LayoutState> {
  const out: Partial<LayoutState> = {};
  if (patch.preset !== undefined) out.preset = patch.preset;
  if (patch.hue !== undefined) out.hue = patch.hue;
  if (patch.scale !== undefined) out.uiScale = patch.scale;
  if (patch.compact !== undefined) out.density = patch.compact ? "compact" : "comfortable";
  if (patch.reduceMotion !== undefined) out.reduceMotion = patch.reduceMotion;
  return out;
}

/**
 * Re-derive this module's snapshot from the layout store and wake its own
 * subscribers. Called from a layout subscription so a change made anywhere —
 * the theme panel, a future token editor, a PFLYT1 install — is visible here
 * too. Without this the theme view would go stale after the first write from
 * any other entry point.
 */
function syncFromLayout(): void {
  const next = toTheme(getLayoutSnapshot());
  const changed =
    next.preset !== state.preset ||
    next.hue !== state.hue ||
    next.scale !== state.scale ||
    next.compact !== state.compact ||
    next.reduceMotion !== state.reduceMotion;
  if (!changed) return;
  state = next;
  for (const listener of listeners) listener();
}

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  // useSyncExternalStore needs a stable subscribe fn for the layout store;
  // the exported `subscribeLayout` in ui/layout is exactly that.
  subscribeLayoutTo(syncFromLayout);
}

/** Boot-time: delegate to the unified layout init, then seed this view. */
export function initTheme(): ThemeState {
  const layout = initLayout();
  ensureSubscribed();
  state = toTheme(layout);
  return state;
}

/** Subscribe to the layout store so this view never goes stale. */
function subscribeLayoutTo(listener: () => void): void {
  layoutSubscribe(listener);
}

/**
 * Apply a theme patch. Normalized through the LEGACY normalizer first (so the
 * clamp ranges and preset fallback stay identical), then translated into a
 * layout patch and written to the single store.
 */
export function setTheme(patch: Partial<ThemeState>): void {
  // Validate against the legacy contract so an out-of-range hue/scale or an
  // unknown preset behaves exactly as it always did, then map forward.
  const validated = normalizeThemeState({ ...state, ...patch });
  setLayout(fromTheme(validated));
  syncFromLayout();
}

export function resetTheme(): void {
  setTheme({ ...DEFAULT_THEME_STATE });
  // Also clear any colour overrides so RESET really means the built-in look.
  setLayout({ colorOverrides: {} });
  syncFromLayout();
}

/** Current theme view (stable reference — changes only on setTheme/apply). */
export function getThemeSnapshot(): ThemeState {
  return state;
}

function subscribe(listener: () => void): () => void {
  ensureSubscribed();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive theme state for components. */
export function useTheme(): ThemeState {
  return useSyncExternalStore(subscribe, getThemeSnapshot);
}

/** Re-exported for callers that want the layout view of the same state. */
export { getLayoutSnapshot as getLayout, useLayout } from "./layout";
