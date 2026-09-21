import { useSyncExternalStore } from "react";
import {
  accentOf as accentOfPure,
  DEFAULT_THEME_STATE,
  hexOrHslToSoft,
  normalizeThemeState,
  PRESET_OWNED_VARS,
  presetById,
  type ThemeState,
} from "../shared/theme-data";

/**
 * User theme system — colours, accent hue, UI scale, density and motion.
 *
 * The whole app is built on CSS custom properties (`:root` in src/styles/01-base.css),
 * so a theme is just a set of variable overrides applied to
 * `document.documentElement` plus a couple of behaviour classes. Preferences
 * persist in localStorage (per-user/per-browser — deliberately NOT part of
 * the project document).
 *
 * The pure data half (presets, types, normalization, accent math) lives in
 * `shared/theme-data.ts` so share-code encoders never pull React; this
 * module re-exports it for backward compatibility.
 */

export { DEFAULT_THEME_STATE, hexOrHslToSoft, normalizeThemeState, THEME_PRESETS } from "../shared/theme-data";
export { accentOf } from "../shared/theme-data";
export type { ThemePreset, ThemeState } from "../shared/theme-data";

const STORAGE_KEY = "pf-theme-v1";

let state: ThemeState = { ...DEFAULT_THEME_STATE };
const listeners = new Set<() => void>();

function load(): ThemeState {
  if (typeof localStorage === "undefined") return { ...DEFAULT_THEME_STATE };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_THEME_STATE };
    return normalizeThemeState(JSON.parse(raw) as Partial<ThemeState>);
  } catch {
    return { ...DEFAULT_THEME_STATE };
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private mode / quota — theme is cosmetic, stay silent */
  }
}

/** Apply the state to the document root (CSS variables + classes + zoom). */
export function applyTheme(next: ThemeState): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const preset = presetById(next.preset);
  const accent = accentOfPure(next);
  const apply: Record<string, string> = {
    ...preset.vars,
    "--accent": accent,
    "--accent-soft": hexOrHslToSoft(accent),
  };
  // Clear preset-owned vars first: a preset without overrides (Forge) must
  // fall back to :root, not to whatever palette was applied before it.
  for (const key of PRESET_OWNED_VARS) {
    if (!(key in apply)) root.style.removeProperty(key);
  }
  for (const [key, value] of Object.entries(apply)) {
    root.style.setProperty(key, value);
  }
  root.classList.toggle("theme-compact", next.compact);
  root.classList.toggle("theme-no-anim", next.reduceMotion);
  (root.style as CSSStyleDeclaration & { zoom: string }).zoom = String(next.scale);
}

/** Boot-time: load persisted prefs and apply them before the first paint. */
export function initTheme(): ThemeState {
  state = load();
  applyTheme(state);
  return state;
}

export function setTheme(patch: Partial<ThemeState>): void {
  // Normalize every patch through the same clamp/validate path as load() so
  // in-session state can never drift outside the legal ranges.
  state = normalizeThemeState({ ...state, ...patch });
  persist();
  applyTheme(state);
  for (const listener of listeners) listener();
}

export function resetTheme(): void {
  setTheme({ ...DEFAULT_THEME_STATE });
}

/** Current state (stable reference — changes only on setTheme). */
export function getThemeSnapshot(): ThemeState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive theme state for components. */
export function useTheme(): ThemeState {
  return useSyncExternalStore(subscribe, getThemeSnapshot);
}
