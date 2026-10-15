import { useEffect, useRef, useState } from "react";

/**
 * Bottom dock layout — panel slots, dock height and their persistence.
 *
 * Pure state helpers (testable without a DOM) + a React hook for App.
 * Preferences persist in localStorage (per-user UI prefs, not project data).
 */

// The panel registry moved to shared/layout-data.ts (ADR 0036) so the layout
// state contract and the dock chrome cannot disagree about which panels exist.
// It is re-exported here unchanged — every existing importer of
// `ui/dockLayout` keeps working.
import { PANEL_KEYS, normalizePanelId, type BottomPanel } from "../shared/layout-data";
import { initLayout, setLayout } from "./layout";
export { PANEL_KEYS };
export type { BottomPanel };

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
const DOCK_CHROME_RESERVE = 44;

/**
 * Keep the support dock proportional to the viewport, while letting it grow
 * from 26vh on short windows to 30vh on a standard 900px-high workspace.
 * Above that point the 30vh ceiling remains until the hard 560px panel limit
 * naturally takes over. The 44px reserve covers the mobile dock chrome too.
 *
 * MEASURED 2026-10-15 (scripts/ui-proportion.mjs, 1440x900): the previous
 * 34vh..38vh band produced a 298px dock — 33.0% of the viewport against 22.2%
 * for the step sequencer. The auxiliary panel was half again the height of the
 * instrument the product is named for. 30vh puts the ceiling at ~226px at this
 * viewport, handing ~72px back to the grid.
 */
export function maxDockHeightForViewport(viewportHeight: number): number {
  const height = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 800;
  const growth = Math.min(1, Math.max(0, (height - 820) / 80));
  const dockRatio = 0.26 + 0.04 * growth;
  return Math.min(DOCK_MAX_HEIGHT, Math.floor(height * dockRatio) - DOCK_CHROME_RESERVE);
}

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
  // Bridge: the dock no longer owns a storage key. It writes its fields into
  // the unified layout store (ADR 0036), so a dock height and a palette can no
  // longer drift apart. The DEBOUNCE that wraps this call is unchanged — the
  // write is still synchronous and main-thread blocking.
  setLayout({
    dockHeight: state.height,
    // normalizePanelId (not the local normalizePanel) because the layout store
    // accepts the canonical LayoutPanel union. The local helper still returns
    // the wider BottomPanel type, which would let "fx" leak past normalization.
    slotA: normalizePanelId(state.slotA),
    slotB: normalizePanelId(state.slotB),
  });
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
    // Seed from the unified layout store (ADR 0036). initLayout is idempotent
    // and cheap, and running it here means the dock works even when the hook
    // mounts before main.tsx's boot call — no second storage path to keep in
    // sync.
    const layout = initLayout();
    return {
      height: clampDockHeight(layout.dockHeight, maxInner),
      slotA: layout.slotA,
      slotB: layout.slotB,
    };
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
