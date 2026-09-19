import { useSyncExternalStore } from "react";

/**
 * User theme system — colours, accent hue, UI scale, density and motion.
 *
 * The whole app is built on CSS custom properties (`:root` in styles.css),
 * so a theme is just a set of variable overrides applied to
 * `document.documentElement` plus a couple of behaviour classes. Preferences
 * persist in localStorage (per-user/per-browser — deliberately NOT part of
 * the project document).
 */

export interface ThemeState {
  /** Preset id — the base palette. */
  preset: string;
  /** Custom accent hue 0..359 overriding the preset accent (null = preset). */
  hue: number | null;
  /** UI zoom factor (1 = 100 %). */
  scale: number;
  /** Compact density (tighter paddings/gaps). */
  compact: boolean;
  /** Kill transitions/animations (accessibility). */
  reduceMotion: boolean;
}

export interface ThemePreset {
  id: string;
  name: string;
  /** Default accent — also the reset value for the hue slider. */
  accent: string;
  /** Variable overrides this preset applies (unset vars keep the default). */
  vars: Record<string, string>;
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    /**
     * The default identity: near-black glass, deep layered panels, amber
     * molten accent. Mirrors `:root` in styles.css (first-paint parity), so
     * a user with no stored theme sees exactly this and nothing shifts after
     * initTheme() runs.
     */
    id: "molten",
    name: "Molten",
    accent: "#f59e0b",
    vars: {
      "--accent": "#f59e0b",
      "--accent-soft": "rgba(245, 158, 11, 0.14)",
      "--bg": "#0b0c10",
      "--bg-panel": "#12141a",
      "--bg-panel-2": "#181b22",
      "--bg-raise": "#1f232b",
      "--border": "#2a2e37",
      "--border-soft": "#20242c",
      "--text": "#d9dbe1",
      "--text-dim": "#8d94a2",
      "--text-faint": "#7a8290",
    },
  },
  { id: "forge", name: "Forge", accent: "#f59e0b", vars: {} },
  {
    id: "cyan",
    name: "Cyan Studio",
    accent: "#22d3ee",
    vars: { "--accent": "#22d3ee", "--accent-soft": "rgba(34, 211, 238, 0.14)" },
  },
  {
    id: "magenta",
    name: "Magenta",
    accent: "#f472b6",
    vars: { "--accent": "#f472b6", "--accent-soft": "rgba(244, 114, 182, 0.14)" },
  },
  {
    id: "matrix",
    name: "Matrix",
    accent: "#4ade80",
    vars: { "--accent": "#4ade80", "--accent-soft": "rgba(74, 222, 128, 0.14)" },
  },
  {
    id: "violet",
    name: "Violet Lab",
    accent: "#a78bfa",
    vars: { "--accent": "#a78bfa", "--accent-soft": "rgba(167, 139, 250, 0.14)" },
  },
  {
    id: "contrast",
    name: "High Contrast",
    accent: "#ffffff",
    vars: {
      "--accent": "#ffffff",
      "--accent-soft": "rgba(255, 255, 255, 0.18)",
      "--bg": "#050506",
      "--bg-panel": "#0b0c0f",
      "--bg-panel-2": "#101216",
      "--bg-raise": "#17191f",
      "--border": "#4a4f5a",
      "--border-soft": "#33363f",
      "--text": "#ffffff",
      "--text-dim": "#c9cdd5",
      "--text-faint": "#a9aeb9",
    },
  },
];

const STORAGE_KEY = "pf-theme-v1";
const DEFAULT_STATE: ThemeState = { preset: "molten", hue: null, scale: 1, compact: false, reduceMotion: false };

/**
 * Every CSS variable a preset is allowed to override. `applyTheme` clears
 * these before applying the preset, so switching Molten → Forge (vars: {})
 * returns to the :root defaults instead of leaking the previous palette's
 * inline values onto the document root.
 */
const PRESET_OWNED_VARS = [
  "--bg",
  "--bg-panel",
  "--bg-panel-2",
  "--bg-raise",
  "--border",
  "--border-soft",
  "--text",
  "--text-dim",
  "--text-faint",
  "--accent",
  "--accent-soft",
] as const;

let state: ThemeState = { ...DEFAULT_STATE };
const listeners = new Set<() => void>();

function presetById(id: string): ThemePreset {
  return THEME_PRESETS.find((p) => p.id === id) ?? THEME_PRESETS[0];
}

function normalize(partial: Partial<ThemeState>): ThemeState {
  return {
    preset: presetById(typeof partial.preset === "string" ? partial.preset : DEFAULT_STATE.preset).id,
    hue:
      typeof partial.hue === "number" && Number.isFinite(partial.hue)
        ? Math.min(359, Math.max(0, Math.round(partial.hue)))
        : null,
    scale:
      typeof partial.scale === "number" && partial.scale >= 0.8 && partial.scale <= 1.3
        ? partial.scale
        : DEFAULT_STATE.scale,
    compact: partial.compact === true,
    reduceMotion: partial.reduceMotion === true,
  };
}

function load(): ThemeState {
  if (typeof localStorage === "undefined") return { ...DEFAULT_STATE };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    return normalize(JSON.parse(raw) as Partial<ThemeState>);
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private mode / quota — theme is cosmetic, stay silent */
  }
}

/** Accent colour for the current state: custom hue wins over the preset. */
export function accentOf(state: ThemeState): string {
  const hue = state.hue;
  if (hue !== null) return `hsl(${hue}, 85%, 60%)`;
  return presetById(state.preset).accent;
}

/** Apply the state to the document root (CSS variables + classes + zoom). */
export function applyTheme(next: ThemeState): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const preset = presetById(next.preset);
  const accent = accentOf(next);
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

/** Convert an `#rrggbb` or `hsl(h,s%,l%)` accent into its soft translucent form. */
export function hexOrHslToSoft(accent: string): string {
  const hsl = /^hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)$/.exec(accent);
  if (hsl) return `hsla(${hsl[1]}, ${hsl[2]}%, ${hsl[3]}%, 0.14)`;
  const hex = /^#([0-9a-f]{6})$/i.exec(accent);
  if (hex) {
    const int = parseInt(hex[1], 16);
    return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, 0.14)`;
  }
  return "rgba(255, 255, 255, 0.14)";
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
  state = normalize({ ...state, ...patch });
  persist();
  applyTheme(state);
  for (const listener of listeners) listener();
}

export function resetTheme(): void {
  setTheme({ ...DEFAULT_STATE });
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
