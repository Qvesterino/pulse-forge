import { useEffect, useRef, useState } from "react";

/**
 * Bottom dock layout — panel slots, dock height and their persistence.
 *
 * Pure state helpers (testable without a DOM) + a React hook for App.
 * Preferences persist in localStorage (per-user UI prefs, not project data).
 */

export const PANEL_KEYS = ["mixer", "devices", "arr", "mod", "exp", "midi", "dice", "intent", "reference"] as const;
export type BottomPanel = (typeof PANEL_KEYS)[number] | "fx" | "plugin";

export interface DockState {
  /** Dock height in px (applied as --dock-height). */
  height: number;
  /** Primary slot — behaves exactly like the old single bottomPanel. */
  slotA: BottomPanel | null;
  /** Split slot — side-by-side second panel (null = not split). */
  slotB: BottomPanel | null;
}

export const DOCK_MIN_HEIGHT = 160;
// 560: the dock is a support surface — the sequencer/workspace above it keeps
// priority. A 800 px dock (the old ceiling) could cover two thirds of a 900 px
// screen and starve the primary writing area.
export const DOCK_MAX_HEIGHT = 560;
const DOCK_STORAGE_KEY = "pf-dock-v1";

const isPanel = (value: unknown): value is BottomPanel =>
  typeof value === "string" &&
  ((PANEL_KEYS as readonly string[]).includes(value) || value === "fx" || value === "plugin");

const normalizePanel = (value: unknown): BottomPanel | null => {
  if (value === "fx" || value === "plugin") return "devices";
  return isPanel(value) ? value : null;
};

export function clampDockHeight(px: number, maxInner: number): number {
  const ceiling = Math.max(DOCK_MIN_HEIGHT + 40, Math.min(DOCK_MAX_HEIGHT, Math.floor(maxInner)));
  return Math.min(ceiling, Math.max(DOCK_MIN_HEIGHT, Math.round(px)));
}

/** Sensible default: 220 px on big screens, scaled down on short viewports.
 * The sequencer is the primary writing surface and keeps the majority of the
 * vertical space — the dock opens compact and is dragged taller on demand. */
export function defaultDockHeight(maxInner: number): number {
  return clampDockHeight(Math.min(220, Math.round(maxInner * 0.26)), maxInner);
}

export function loadDockLayout(raw: string | null, maxInner: number): DockState {
  const fallback: DockState = { height: defaultDockHeight(maxInner), slotA: "mixer", slotB: null };
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<DockState>;
    const slotA = normalizePanel(parsed.slotA);
    const normalizedSlotB = normalizePanel(parsed.slotB);
    return {
      height: clampDockHeight(
        typeof parsed.height === "number" ? parsed.height : defaultDockHeight(maxInner),
        maxInner,
      ),
      slotA,
      slotB: normalizedSlotB === slotA ? null : normalizedSlotB,
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
  panel = normalizePanel(panel) ?? panel;
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

/**
 * Toggle a panel's VISIBILITY regardless of which slot hosts it
 * (ROADMAP-UI-2027 V0c): a tab click means "hide this panel", never "move it
 * to the primary slot". The old behaviour — clicking a panel that lived only
 * in the split slot migrated it into slot A — read as a broken close button.
 * Opening lands in slot A (standard tab semantics: the primary slot shows
 * the last panel asked for).
 */
export function togglePanelVisible(state: DockState, panel: BottomPanel): DockState {
  panel = normalizePanel(panel) ?? panel;
  if (state.slotA === panel) return { ...state, slotA: null };
  if (state.slotB === panel) return { ...state, slotB: null };
  return { ...state, slotA: panel };
}

/**
 * Reveal `panel` without disturbing a layout that already shows it: a
 * no-op when the panel is docked in either slot, otherwise open it in the
 * primary slot. Used by add-effect flows (Mixer batch bar) where the goal
 * is "the user must SEE the device UI", not a toggle.
 */
export function ensurePanelVisible(state: DockState, panel: BottomPanel): DockState {
  panel = normalizePanel(panel) ?? panel;
  if (state.slotA === panel || state.slotB === panel) return state;
  return toggleSlot(state, panel, 0);
}

/** How long the layout must be still before it is written to storage. */
const PERSIST_DEBOUNCE_MS = 200;

/**
 * React binding: persisted dock state + effect that saves on change.
 *
 * The save is DEBOUNCED (audit 16). `localStorage.setItem` is synchronous and
 * main-thread blocking, and the dock height changes on every `pointermove` of
 * a resize drag — a 120 Hz mouse performed ~120 serialising writes per second
 * on the same thread that renders the DAW. The state itself still updates on
 * every move (the drag must track the pointer with no dropped frames); only
 * the side effect settles.
 *
 * A pending write is flushed on unmount and on `pagehide`, so closing the tab
 * mid-debounce cannot silently drop the user's last layout.
 */
export function useDockLayout(maxInner: number): [DockState, (next: DockState) => void] {
  const [state, setState] = useState<DockState>(() => {
    if (typeof localStorage === "undefined") return loadDockLayout(null, maxInner);
    return loadDockLayout(localStorage.getItem(DOCK_STORAGE_KEY), maxInner);
  });
  const pendingRef = useRef<DockState | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    pendingRef.current = state;
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) persistDockLayout(pending);
    }, PERSIST_DEBOUNCE_MS);
  }, [state]);

  // Never lose the last layout: an unmount (project close, panel teardown) or
  // a tab close during the debounce window must still land the write.
  useEffect(() => {
    const flush = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) persistDockLayout(pending);
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  // A dock persisted on a tall display must not outlive the viewport: the
  // ceiling is a function of `window.innerHeight`, and it only ran at load
  // time, so shrinking the window left a 560 px dock on a 600 px screen and
  // starved the sequencer above it. Re-clamp whenever the ceiling changes.
  // Deliberately one-way: the clamp shrinks to fit, and a later grow does NOT
  // restore the old size (the shrunken value becomes the user's new setting).
  useEffect(() => {
    setState((prev) => {
      const height = clampDockHeight(prev.height, maxInner);
      return height === prev.height ? prev : { ...prev, height };
    });
  }, [maxInner]);

  return [state, setState];
}
