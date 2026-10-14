import { useCallback, useEffect, useRef, useState } from "react";
import { LAYOUT_BOUNDS, DEFAULT_LAYOUT_STATE } from "../shared/layout-data";
import { getLayoutSnapshot, setLayout, subscribeLayout } from "./layout";

/**
 * LAYOUT GRIP — the reusable drag handle for user-resizable layout regions
 * (ADR 0036, Vlna C).
 *
 * The dock grip (`DockChrome.tsx`) proved the interaction: drag to resize,
 * double-click to reset, arrow keys when focused. This extracts the same
 * contract into one reusable component so the inspector column and the A/B
 * dock split can adopt it without each re-implementing (and mis-implementing)
 * the pointer lifecycle.
 *
 * Why it exists: a slider is a poor fit for a panel edge. A DAW user resizes
 * panels by dragging the boundary, with the content visible while they do it.
 * A number input or slider hides the thing being resized behind a dialog.
 *
 * The value is written straight to the layout store, so a resize is persisted,
 * shareable via PFLYT1:, and identical on Web and Studio — no local component
 * state that could disagree with the store.
 */

/** Snap a drag to the legal band for this region, so a fling can never leave
 * the inspector invisible or wider than the workspace. */
function clampRegion(value: number, min: number, max: number, fractional = false): number {
  const normalized = fractional ? value : Math.round(value);
  return Math.min(max, Math.max(min, normalized));
}

/**
 * Reset targets come from DEFAULT_LAYOUT_STATE, not a literal. A hard-coded
 * "280" here would be a second source of truth that silently rots the day the
 * default changes — exactly the class of bug ADR 0036 exists to prevent.
 */

export interface ResizeGripProps {
  /** Which layout field this grip drives. */
  region: "inspectorWidth" | "dockSplitRatio";
  /** Accessible name (e2e specs and screen readers target this). */
  ariaLabel: string;
  /** Tooltip describing the interaction contract. */
  title: string;
  /** Orientation: horizontal drag along the x axis, vertical along y. */
  axis?: "x" | "y";
  /**
   * Pixels moved per arrow-key press. 16 matches the dock grip.
   */
  keyboardStep?: number;
  /** Optional class on the wrapper for CSS positioning. */
  className?: string;
}

export function ResizeGrip({ region, ariaLabel, title, axis = "x", keyboardStep = 16, className }: ResizeGripProps) {
  // Read the live value from the store so the grip never shows a stale width
  // after an external change (reset, PFLYT1 install, another window).
  const [value, setValue] = useState(() => readRegion(region));
  useEffect(() => subscribeRegion(region, setValue), [region]);

  const draggingRef = useRef(false);
  const startRef = useRef({ pos: 0, value: 0 });

  // During a drag the value is LOCAL: writing to the store on every pointermove
  // would re-apply the whole document (vars + classes + zoom) at pointer rate
  // on the thread that renders the DAW — the exact hazard the dock grip's
  // debounce was added to avoid. The store is written once, on release.
  const liveRef = useRef(0);

  const commit = useCallback(
    (next: number) => {
      liveRef.current = next;
      setValue(next);
      setLayout({ [region]: next } as Partial<ReturnType<typeof getLayoutSnapshot>>);
    },
    [region],
  );

  /** Update only the local readout — no store write, no document work. */
  const preview = useCallback((next: number) => {
    liveRef.current = next;
    setValue(next);
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    draggingRef.current = true;
    const startPos = axis === "x" ? event.clientX : event.clientY;
    const currentValue = readRegion(region);
    startRef.current = { pos: startPos, value: currentValue };
    liveRef.current = currentValue;

    const onMove = (move: PointerEvent) => {
      if (!draggingRef.current) return;
      const delta = (axis === "x" ? move.clientX : move.clientY) - startPos;
      // Dragging the boundary LEFT gives the space on its RIGHT more room, for both
      // regions: the inspector sits right of the grip, and in the A/B split slot B
      // sits right of the divider (so slot A's share — the ratio — grows as slot A
      // takes the space slot B gives up). One rule for both, so a grip cannot be
      // "the right way round" in one panel and backwards in the other.
      const signed = -delta;
      // A ratio is a FRACTION: a pointer delta must be DIVIDED by the dock's
      // approximate width to sweep the ratio smoothly. Multiplying (the earlier
      // bug) sent a 100px drag to ±80000 and slammed the clamp.
      const next = clampRegion(
        startRef.current.value + (axisRatio(region) ? signed / spanFor(region) : signed),
        boundsFor(region).min,
        boundsFor(region).max,
        axisRatio(region),
      );
      preview(next);
    };
    const stop = () => {
      draggingRef.current = false;
      // One write, on release: the store and the persisted copy settle here.
      if (liveRef.current !== startRef.current.value) commit(liveRef.current);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? keyboardStep * 3 : keyboardStep;
    const regionStep = region === "dockSplitRatio" ? (event.shiftKey ? 0.06 : 0.02) : step;
    // ArrowLeft means "move the boundary LEFT". For the right-hand inspector
    // that GROWS the column; for the split, slot A is on the left so it also
    // grows. Both regions therefore share one rule — mirroring the drag, which
    // is the invariant that keeps keyboard and mouse agreeing.
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      commit(
        clampRegion(readRegion(region) + regionStep, boundsFor(region).min, boundsFor(region).max, axisRatio(region)),
      );
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      commit(
        clampRegion(readRegion(region) - regionStep, boundsFor(region).min, boundsFor(region).max, axisRatio(region)),
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      commit(defaultsFor(region));
    }
  };

  return (
    <button
      type="button"
      className={`resize-grip resize-grip--${axis}${className ? ` ${className}` : ""}`}
      aria-label={ariaLabel}
      aria-valuemin={Math.round(boundsFor(region).min * (axisRatio(region) ? 100 : 1))}
      aria-valuemax={Math.round(boundsFor(region).max * (axisRatio(region) ? 100 : 1))}
      aria-valuenow={Math.round(value * (axisRatio(region) ? 100 : 1))}
      role="separator"
      aria-orientation="vertical"
      title={title}
      onPointerDown={handlePointerDown}
      onDoubleClick={() => commit(defaultsFor(region))}
      onKeyDown={handleKeyDown}
    >
      <span aria-hidden="true" />
      <span aria-hidden="true" />
      <span aria-hidden="true" />
    </button>
  );
}

// ---- Store plumbing -------------------------------------------------------

function readRegion(region: ResizeGripProps["region"]): number {
  return getLayoutSnapshot()[region];
}

function boundsFor(region: ResizeGripProps["region"]): { min: number; max: number } {
  return region === "inspectorWidth" ? LAYOUT_BOUNDS.inspectorWidth : LAYOUT_BOUNDS.dockSplitRatio;
}

/**
 * Reset targets come from DEFAULT_LAYOUT_STATE, not a literal. A hard-coded
 * "280" here would be a second source of truth that silently rots the day the
 * default changes — exactly the class of bug ADR 0036 exists to prevent.
 */
function defaultsFor(region: ResizeGripProps["region"]): number {
  return DEFAULT_LAYOUT_STATE[region];
}

/** Subscribe to layout changes, scoped to the field this grip renders. */
function subscribeRegion(region: ResizeGripProps["region"], cb: (v: number) => void): () => void {
  return subscribeLayout(() => cb(readRegion(region)));
}

/** A ratio is a FRACTION of a container, not a pixel count: dragging across
 * the full dock width sweeps the ratio across its whole band. */
function axisRatio(region: ResizeGripProps["region"]): boolean {
  return region === "dockSplitRatio";
}

/** Approximate drag span for a ratio so the drag feels 1:1 at typical widths. */
function spanFor(region: ResizeGripProps["region"]): number {
  // A dock is ~800px wide in practice; dividing by 800 makes a 100px drag move
  // the ratio by ~0.125, which tracks the pointer closely.
  return region === "dockSplitRatio" ? 800 : 1;
}
