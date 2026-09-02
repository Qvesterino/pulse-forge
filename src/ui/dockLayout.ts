import { useEffect, useState } from "react";

/**
 * Bottom dock layout — panel slots, dock height and their persistence.
 *
 * Pure state helpers (testable without a DOM) + a React hook for App.
 * Preferences persist in localStorage (per-user UI prefs, not project data).
 */

export const PANEL_KEYS = ["mixer", "fx", "arr", "mod", "exp", "midi", "dice"] as const;
export type BottomPanel = (typeof PANEL_KEYS)[number];

export interface DockState {
  /** Dock height in px (applied as --dock-height). */
  height: number;
  /** Primary slot — behaves exactly like the old single bottomPanel. */
  slotA: BottomPanel | null;
  /** Split slot — side-by-side second panel (null = not split). */
  slotB: BottomPanel | null;
}

export const DOCK_MIN_HEIGHT = 160;
export const DOCK_MAX_HEIGHT = 800;
const DOCK_STORAGE_KEY = "pf-dock-v1";

const isPanel = (value: unknown): value is BottomPanel =>
  typeof value === "string" && (PANEL_KEYS as readonly string[]).includes(value);

export function clampDockHeight(px: number, maxInner: number): number {
  const ceiling = Math.max(DOCK_MIN_HEIGHT + 40, Math.min(DOCK_MAX_HEIGHT, Math.floor(maxInner)));
  return Math.min(ceiling, Math.max(DOCK_MIN_HEIGHT, Math.round(px)));
}

/** Sensible default: 300 px on big screens, scaled down on short viewports so the sequencer keeps room. */
export function defaultDockHeight(maxInner: number): number {
  return clampDockHeight(Math.min(300, Math.round(maxInner * 0.32)), maxInner);
}

export function loadDockLayout(raw: string | null, maxInner: number): DockState {
  const fallback: DockState = { height: defaultDockHeight(maxInner), slotA: "mixer", slotB: null };
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<DockState>;
    return {
      height: clampDockHeight(typeof parsed.height === "number" ? parsed.height : defaultDockHeight(maxInner), maxInner),
      slotA: isPanel(parsed.slotA) ? parsed.slotA : null,
      slotB: isPanel(parsed.slotB) ? parsed.slotB : null,
    };
  } catch {
    return fallback;
  }
}

export function persistDockLayout(state: DockState): void {
  try {
    localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* cosmetic preference — quota/private mode stays silent */
  }
}

/**
 * Toggle `panel` in the given slot. A panel can never occupy both slots:
 * toggling it into one slot removes it from the other.
 */
export function toggleSlot(state: DockState, panel: BottomPanel, slot: 0 | 1): DockState {
  if (slot === 0) {
    const slotA = state.slotA === panel ? null : panel;
    return { ...state, slotA, slotB: state.slotB === panel ? null : state.slotB };
  }
  if (state.slotB === panel) return { ...state, slotB: null };
  return {
    ...state,
    slotB: panel,
    slotA: state.slotA === panel ? null : state.slotA,
  };
}

/** Open (or close) `panel` in the primary slot, deduping the split slot. */
export function openInSlotA(state: DockState, panel: BottomPanel): DockState {
  return toggleSlot(state, panel, 0);
}

/** React binding: persisted dock state + effect that saves on change. */
export function useDockLayout(maxInner: number): [DockState, (next: DockState) => void] {
  const [state, setState] = useState<DockState>(() => {
    if (typeof localStorage === "undefined") return loadDockLayout(null, maxInner);
    return loadDockLayout(localStorage.getItem(DOCK_STORAGE_KEY), maxInner);
  });
  useEffect(() => {
    persistDockLayout(state);
  }, [state]);
  return [state, setState];
}
