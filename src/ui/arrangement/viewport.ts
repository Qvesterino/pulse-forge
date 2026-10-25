/**
 * THE ARRANGEMENT VIEWPORT — which bars the lane renders, and WHEN it moves.
 *
 * THE DEFECT (performance-cliff audit, finding C-2)
 * -------------------------------------------------
 * The viewport was QUANTIZED TO WHOLE BARS. `scrollLeft` changes on every pixel
 * of a wheel event, so the range was stored as integer bar bounds: one render
 * per BAR of travel, at every zoom.
 *
 * A bar is not a fixed number of pixels. `px per bar = BASE_BAR_WIDTH * zoom`,
 * and the zoom range is 0.05× (1.5 px/bar) to 40× (1200 px/bar). So one bar of
 * travel was **1.5 px at min zoom and 1200 px at max zoom** — the same gesture
 * cost up to **800× more renders** at min zoom, and every one of those renders
 * paid the super-linear per-clip terms the audit found in the arrangement
 * (C-3/C-4). Zooming out is how a user surveys a whole song, which is exactly
 * when the arrangement is most expensive to render.
 *
 * WHY A QUANTUM AT ALL
 * --------------------
 * Storing the raw pixel offset would re-render the panel at pixel frequency.
 * The quantization is right; the **UNIT** is wrong. Bars are a musical unit and
 * the viewport is a visual one — the same number means 1.5 px at one end of the
 * zoom range and 1200 px at the other.
 *
 * THE DECISION
 * ------------
 * The commit cadence is now governed by a **PIXEL** quantum, and the bar bounds
 * are derived from it:
 *
 * 1. The number of renders per pixel of scroll is the same at every zoom (up to
 *    the quantum), instead of being 800× worse at min zoom.
 * 2. Deferring a commit must never leave the visible area unrendered, so the
 *    window carries a **margin**: the number of bars the scroll can travel
 *    inside one quantum. The margin is only as large as it needs to be — where
 *    the existing overscan already covers the drift, no extra margin is added,
 *    so the DOM does not grow at the zooms where the problem is not.
 *
 * ZOOM AND RESIZE ARE NOT DEFERRABLE
 * ----------------------------------
 * A zoom change makes the same scroll position a different window, and a resize
 * changes the visible range. Both commit immediately: deferring them would show
 * the wrong clips, which is the one failure this module must never allow.
 */

/** The bar range the lane renders. */
export interface ArrangementViewport {
  firstBar: number;
  lastBar: number;
}

/** What was committed, and the geometry it was committed against. */
export interface CommittedViewport {
  viewport: ArrangementViewport;
  /** The scrollLeft the window was computed from. */
  scrollLeft: number;
  /** The pane width the window was computed for. */
  width: number;
  /** The px-per-bar the window was computed with. */
  pxPerBar: number;
}

export interface ViewportInput {
  /** Current horizontal scroll offset, in pixels. */
  scrollLeft: number;
  /** Current pane width, in pixels. */
  width: number;
  /** Current px per bar (`BASE_BAR_WIDTH * zoom`). */
  pxPerBar: number;
  /** Extra bars rendered either side of the visible range. */
  overscanBars: number;
  /** Pixels of scroll between commits. */
  quantumPx: number;
  /** The last committed state, or null before the first measurement. */
  committed: CommittedViewport | null;
}

export interface ViewportDecision {
  /** The window to render. */
  viewport: ArrangementViewport | null;
  /** Whether the window CHANGED — i.e. whether a render is needed. */
  changed: boolean;
  /** The state to remember for the next measurement. */
  committed: CommittedViewport | null;
}

/**
 * Pixels of scroll between viewport commits.
 *
 * 64 px is roughly four ruler marks at the default zoom (a bar is 30 px), so a
 * commit still happens several times per screen width — the window never feels
 * stuck — while the commit count per pixel of scroll stops depending on the
 * zoom.
 */
export const VIEWPORT_COMMIT_QUANTUM_PX = 64;

/**
 * The bar range to render for a scroll position.
 *
 * The margin is `max(0, ceil(quantum / pxPerBar) - overscan)`: the extra bars
 * the scroll can travel inside one quantum, MINUS the bars the overscan
 * already covers. Where the overscan is already generous (every zoom above
 * ~0.6×), the margin is zero and the window is exactly as wide as it was.
 */
export function viewportWindow(
  scrollLeft: number,
  width: number,
  pxPerBar: number,
  overscanBars: number,
  quantumPx: number,
): ArrangementViewport {
  const lagBars = Math.max(0, Math.ceil(quantumPx / pxPerBar) - overscanBars);
  return {
    firstBar: Math.floor(scrollLeft / pxPerBar) - overscanBars - lagBars,
    lastBar: Math.ceil((scrollLeft + width) / pxPerBar) + overscanBars + lagBars,
  };
}

/**
 * Decide whether the window moves, and to where.
 *
 * Pure: the whole decision is a function of the inputs and the last committed
 * state, so it can be counted, replayed and asserted without a browser.
 */
export function viewportDecision(input: ViewportInput): ViewportDecision {
  const { scrollLeft, width, pxPerBar, overscanBars, quantumPx, committed } = input;

  if (!committed) {
    const viewport = viewportWindow(scrollLeft, width, pxPerBar, overscanBars, quantumPx);
    return { viewport, changed: true, committed: { viewport, scrollLeft, width, pxPerBar } };
  }

  // A zoom change or a resize makes the same scroll position a DIFFERENT
  // window. Deferring those would show the wrong clips.
  const forced = committed.pxPerBar !== pxPerBar || committed.width !== width;

  const viewport = viewportWindow(scrollLeft, width, pxPerBar, overscanBars, quantumPx);
  const boundsChanged =
    committed.viewport.firstBar !== viewport.firstBar || committed.viewport.lastBar !== viewport.lastBar;
  if (!forced && !boundsChanged) {
    return { viewport: committed.viewport, changed: false, committed };
  }

  // The scroll has not travelled a full quantum since the last commit: defer.
  // The committed window still COVERS the visible area — that is what the
  // margin in `viewportWindow` is for.
  if (!forced && Math.abs(scrollLeft - committed.scrollLeft) < quantumPx) {
    return { viewport: committed.viewport, changed: false, committed };
  }

  return { viewport, changed: true, committed: { viewport, scrollLeft, width, pxPerBar } };
}
