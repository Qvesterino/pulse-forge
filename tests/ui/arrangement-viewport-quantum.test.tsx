import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { SelectionContext, ServicesContext } from "../../src/ui/context";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import {
  VIEWPORT_COMMIT_QUANTUM_PX,
  viewportDecision,
  viewportWindow,
  type CommittedViewport,
} from "../../src/ui/arrangement/viewport";
import { mockServices } from "../helpers";
import type { Services } from "../../src/services";
import type { ProjectDocument } from "../../src/project-model/types";

/**
 * THE VIEWPORT QUANTUM IS IN PIXELS, NOT IN BARS (performance-cliff audit C-2).
 *
 * The defect: the viewport was quantized to whole bars. A bar is 1.5 px at min
 * zoom and 1200 px at max zoom, so one bar of scroll cost up to 800× more
 * renders at min zoom — and every one of those renders paid the arrangement's
 * super-linear per-clip cost (C-3/C-4). Zooming out is how a user surveys a
 * whole song, which is exactly when the arrangement is most expensive.
 *
 * The fix: the commit cadence is governed by a pixel quantum, and the bar
 * bounds are derived from it. The window carries a margin so a deferred commit
 * never leaves the visible area unrendered.
 *
 * The gate below is a COUNT, not a millisecond — it does not care how busy the
 * machine is, and it does not need a browser. Every count assertion is paired
 * with a positive control that proves the simulation is live.
 */

const BASE_BAR_WIDTH = 30;
const OVERSCAN_BARS = 12;
const VIEWPORT_PX = 800;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 40;

/** Replays a scroll through the decision, counting the commits. */
function simulateScroll(opts: {
  positions: readonly number[];
  width: number;
  pxPerBar: number;
  overscanBars: number;
  quantumPx: number;
}): { commits: number; committed: CommittedViewport | null } {
  let committed: CommittedViewport | null = null;
  let commits = 0;
  for (const scrollLeft of opts.positions) {
    const decision = viewportDecision({
      scrollLeft,
      width: opts.width,
      pxPerBar: opts.pxPerBar,
      overscanBars: opts.overscanBars,
      quantumPx: opts.quantumPx,
      committed,
    });
    committed = decision.committed;
    if (decision.changed) commits++;
  }
  return { commits, committed };
}

/**
 * POSITIVE CONTROL — the PRE-FIX implementation, verbatim: the window was
 * quantized to whole bars and re-rendered whenever the bar bounds moved.
 */
function barQuantumCommits(
  positions: readonly number[],
  width: number,
  pxPerBar: number,
  overscanBars: number,
): number {
  let prev: { firstBar: number; lastBar: number } | null = null;
  let commits = 0;
  for (const scrollLeft of positions) {
    const first = Math.floor(scrollLeft / pxPerBar) - overscanBars;
    const last = Math.ceil((scrollLeft + width) / pxPerBar) + overscanBars;
    if (!prev || prev.firstBar !== first || prev.lastBar !== last) {
      commits++;
      prev = { firstBar: first, lastBar: last };
    }
  }
  return commits;
}

/** A scroll of `distance` px in 1 px steps — the finest a wheel event can be. */
function scrollPositions(distance: number): number[] {
  return Array.from({ length: distance + 1 }, (_, i) => i);
}

describe("the arrangement viewport commits on a PIXEL quantum", () => {
  it("cuts the commit count at min zoom, where the bar quantum was 800× worse", () => {
    const distance = 500;
    const positions = scrollPositions(distance);
    const pxPerBar = BASE_BAR_WIDTH * MIN_ZOOM;

    const { commits } = simulateScroll({
      positions,
      width: VIEWPORT_PX,
      pxPerBar,
      overscanBars: OVERSCAN_BARS,
      quantumPx: VIEWPORT_COMMIT_QUANTUM_PX,
    });

    // POSITIVE CONTROL: the pre-fix implementation really did commit that
    // often. Without this, the assertion below could pass because the
    // simulation never ran.
    const preFix = barQuantumCommits(positions, VIEWPORT_PX, pxPerBar, OVERSCAN_BARS);
    expect(preFix, "the pre-fix bar quantum must be the loud baseline").toBeGreaterThan(300);

    const bound = Math.ceil(distance / VIEWPORT_COMMIT_QUANTUM_PX) + 1;
    expect(commits, `the commit count must be bounded by the PIXEL quantum`).toBeLessThanOrEqual(bound);
    expect(commits, "the pixel quantum must cut the commits by at least 20×").toBeLessThanOrEqual(preFix / 20);
  });

  it("bounds the commit count by the PIXEL quantum at EVERY zoom", () => {
    const distance = 500;
    const positions = scrollPositions(distance);
    const bound = Math.ceil(distance / VIEWPORT_COMMIT_QUANTUM_PX) + 1;

    // The bound holds at every zoom. It does NOT mean the count is IDENTICAL
    // at every zoom — at max zoom the bar bounds themselves rarely move (a bar
    // is 1200 px), so fewer commits happen. What the fix guarantees is that
    // the count can never exceed the pixel quantum's bound, which is what the
    // bar quantum could not do: it made the count depend on the zoom.
    for (const zoom of [MIN_ZOOM, 0.1, 0.5, 1, 2, 10, MAX_ZOOM]) {
      const { commits } = simulateScroll({
        positions,
        width: VIEWPORT_PX,
        pxPerBar: BASE_BAR_WIDTH * zoom,
        overscanBars: OVERSCAN_BARS,
        quantumPx: VIEWPORT_COMMIT_QUANTUM_PX,
      });
      expect(commits, `zoom ${zoom} must be bounded by the pixel quantum`).toBeLessThanOrEqual(bound);
    }
  });

  it("never leaves the visible area unrendered, at any zoom and any scroll position", () => {
    for (const zoom of [MIN_ZOOM, 0.1, 0.5, 1, 2, 10, MAX_ZOOM]) {
      const pxPerBar = BASE_BAR_WIDTH * zoom;
      let committed: CommittedViewport | null = null;
      for (const scrollLeft of scrollPositions(600)) {
        const decision = viewportDecision({
          scrollLeft,
          width: VIEWPORT_PX,
          pxPerBar,
          overscanBars: OVERSCAN_BARS,
          quantumPx: VIEWPORT_COMMIT_QUANTUM_PX,
          committed,
        });
        committed = decision.committed;
        // The COMMITTED window must cover what the user can see RIGHT NOW —
        // including the steps where the commit was deferred.
        expect(committed!.viewport.firstBar, `zoom ${zoom} at ${scrollLeft}px`).toBeLessThanOrEqual(
          Math.floor(scrollLeft / pxPerBar),
        );
        expect(committed!.viewport.lastBar, `zoom ${zoom} at ${scrollLeft}px`).toBeGreaterThanOrEqual(
          Math.ceil((scrollLeft + VIEWPORT_PX) / pxPerBar),
        );
      }
    }
  });

  it("commits immediately when the zoom changes — a deferred window would show the wrong clips", () => {
    const before = viewportDecision({
      scrollLeft: 0,
      width: VIEWPORT_PX,
      pxPerBar: BASE_BAR_WIDTH,
      overscanBars: OVERSCAN_BARS,
      quantumPx: VIEWPORT_COMMIT_QUANTUM_PX,
      committed: null,
    });
    const after = viewportDecision({
      scrollLeft: 0,
      width: VIEWPORT_PX,
      pxPerBar: BASE_BAR_WIDTH * 2,
      overscanBars: OVERSCAN_BARS,
      quantumPx: VIEWPORT_COMMIT_QUANTUM_PX,
      committed: before.committed,
    });
    expect(after.changed, "a zoom change must not be deferred").toBe(true);
    // At scrollLeft 0 the window's FIRST bar is the same at any zoom (it is
    // the overscan below bar 0); the visible range is what changes.
    expect(after.viewport!.lastBar, "the zoomed window must cover fewer bars").toBeLessThan(before.viewport!.lastBar);
  });

  it("commits immediately when the pane is resized", () => {
    const before = viewportDecision({
      scrollLeft: 0,
      width: VIEWPORT_PX,
      pxPerBar: BASE_BAR_WIDTH,
      overscanBars: OVERSCAN_BARS,
      quantumPx: VIEWPORT_COMMIT_QUANTUM_PX,
      committed: null,
    });
    const after = viewportDecision({
      scrollLeft: 0,
      width: VIEWPORT_PX * 2,
      pxPerBar: BASE_BAR_WIDTH,
      overscanBars: OVERSCAN_BARS,
      quantumPx: VIEWPORT_COMMIT_QUANTUM_PX,
      committed: before.committed,
    });
    expect(after.changed, "a resize must not be deferred").toBe(true);
    expect(after.viewport!.lastBar).toBeGreaterThan(before.viewport!.lastBar);
  });

  it("does NOT widen the window at the zooms where the overscan already covers the drift", () => {
    // The DOM cost of the fix must land only where the problem is. At zoom 1 a
    // bar is 30 px, so the existing 12-bar overscan already covers a 64 px
    // quantum — the window must be exactly as wide as it was before.
    for (const zoom of [1, 2, 10, MAX_ZOOM]) {
      const pxPerBar = BASE_BAR_WIDTH * zoom;
      const preFix = {
        firstBar: Math.floor(0 / pxPerBar) - OVERSCAN_BARS,
        lastBar: Math.ceil(VIEWPORT_PX / pxPerBar) + OVERSCAN_BARS,
      };
      const now = viewportWindow(0, VIEWPORT_PX, pxPerBar, OVERSCAN_BARS, VIEWPORT_COMMIT_QUANTUM_PX);
      expect(now.firstBar, `zoom ${zoom}`).toBe(preFix.firstBar);
      expect(now.lastBar, `zoom ${zoom}`).toBe(preFix.lastBar);
    }
  });
});

describe("the arrangement panel defers a small scroll without losing content", () => {
  const domRect = (left: number, width: number) =>
    ({
      left,
      top: 0,
      width,
      height: 40,
      right: left + width,
      bottom: 40,
      x: left,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;

  /** A clip on EVERY bar, so any move of the window changes the DOM. */
  function denseDoc(): ProjectDocument {
    const doc = createProjectFromTemplate("house");
    const base = doc.arrangement.clips[0]!;
    doc.arrangement.clips = Array.from({ length: 120 }, (_, i) => ({
      ...base,
      id: `clip-${i}`,
      startBar: i,
      lengthBars: 1,
    }));
    return doc;
  }

  function mount(): { scrollEl: HTMLElement } {
    cleanup();
    const doc = denseDoc();
    const project = new ProjectStore(doc);
    const services = { ...mockServices(doc), store: project } as unknown as Services;
    render(
      createElement(
        ServicesContext.Provider,
        { value: services },
        createElement(
          SelectionContext.Provider,
          { value: new SelectionStore() },
          createElement(ArrangementPanel) as ReactElement,
        ),
      ),
    );
    const scrollEl = document.querySelector(".arr-lane-scroll") as HTMLElement;
    Object.defineProperty(scrollEl, "clientWidth", { value: VIEWPORT_PX, configurable: true });
    const lane = document.querySelector(".arr-lane");
    if (lane) vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(domRect(0, 120 * BASE_BAR_WIDTH));
    vi.spyOn(scrollEl, "getBoundingClientRect").mockReturnValue(domRect(0, VIEWPORT_PX));
    // Re-run the measurement now that clientWidth exists.
    act(() => {
      fireEvent.scroll(scrollEl);
    });
    return { scrollEl };
  }

  const renderedBars = (): number[] =>
    Array.from(document.querySelectorAll<HTMLElement>(".arr-clip"))
      .map((el) => Number.parseFloat(el.style.left) / BASE_BAR_WIDTH)
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);

  it("does not re-render for a scroll smaller than the quantum, and keeps the visible area populated", () => {
    const { scrollEl } = mount();
    const before = renderedBars();
    expect(before.length, "the window must be populated").toBeGreaterThan(0);

    // 30 px is ONE BAR at zoom 1 — under the 64 px quantum.
    act(() => {
      scrollEl.scrollLeft = 30;
      fireEvent.scroll(scrollEl);
    });

    expect(renderedBars(), "a sub-quantum scroll must not move the window").toEqual(before);

    // ...and the content that is now visible must still be mounted: the clip
    // under the right edge of the viewport has to be there.
    const visibleRightBar = Math.ceil((scrollEl.scrollLeft + VIEWPORT_PX) / BASE_BAR_WIDTH);
    const last = renderedBars()[renderedBars().length - 1]!;
    expect(last, "the visible right edge must still be rendered").toBeGreaterThanOrEqual(visibleRightBar);
  });

  it("moves the window once the scroll passes the quantum", () => {
    const { scrollEl } = mount();
    const before = renderedBars();

    act(() => {
      scrollEl.scrollLeft = 30;
      fireEvent.scroll(scrollEl);
    });
    act(() => {
      scrollEl.scrollLeft = 70;
      fireEvent.scroll(scrollEl);
    });

    const after = renderedBars();
    expect(after, "a scroll past the quantum must move the window").not.toEqual(before);
    expect(after.length, "the window must still be populated").toBeGreaterThan(0);
  });
});
