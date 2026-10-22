import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { SelectionContext, ServicesContext } from "../../src/ui/context";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { addAudioClip } from "../../src/commands/commands";
import { mockServices } from "../helpers";
import type { ProjectDocument } from "../../src/project-model/types";
import type { Services } from "../../src/services";

/**
 * THE TIMELINE MUST REACH EVERY BAR THE DOCUMENT CONTAINS.
 *
 * THE DEFECT (P1 — content in the document is unreachable).
 *
 *   `timelineExtentBars` capped the timeline's extent at `UNMEASURED_GRID_BAR_CAP`
 *   (512 bars). That constant was introduced to bound the number of grid cells
 *   the UNMEASURED fallback allocates (`Array.from({ length: totalBars })` —
 *   the `RangeError: Invalid array length` crash on a `1e308` clip position),
 *   but it was applied to the EXTENT itself — and the extent is the lane's
 *   scrollable width.
 *
 *   The lane is `totalBars * barWidth` wide, so the document's scrollable area
 *   stopped at bar 512. A browser clamps `scrollLeft` to
 *   `scrollWidth - clientWidth`, so the furthest reachable bar was 512 minus
 *   one viewport — about bar 485 at an 800 px viewport. Every clip past that
 *   was unreachable: the windowing filter dropped it from the DOM (so it could
 *   not be clicked) and the scroll range never reached it (so it could not be
 *   scrolled to). Two conditions reinforcing each other.
 *
 *   The document model allows this: `MAX_ARRANGEMENT_CLIP_BARS` (8192) bounds
 *   a clip's LENGTH, but a clip's `startBar` is only required to be finite and
 *   ≥ 0 — an imported or collab-merged project can legitimately hold content
 *   past bar 512.
 *
 *   jsdom does not clamp `scrollLeft`, which is why the existing windowing
 *   test (`arrangement-viewport-windowing.test.tsx`) scrolls to bar 600 and
 *   passes: the probe reaches a position no real browser allows.
 *
 * THE FIX.
 *
 *   The extent is the timeline's REACH and is no longer capped at 512; it has
 *   its own pixel-safety ceiling (`MAX_TIMELINE_BARS`). The node budget stays
 *   where it belongs — on the two allocation sites — so the unmeasured frame
 *   still cannot ask the browser for a million nodes.
 *
 * WHAT THIS TEST PINS.
 *
 *   The lane's scrollable width covers the document's extent. That is the
 *   browser-clamp-independent form of "the user can reach the content": if the
 *   width is short, `scrollLeft` is clamped and the tail of the song is
 *   permanently out of reach.
 */

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

const BASE_BAR_WIDTH = 30;

function docWithClipAt(startBar: number): ProjectDocument {
  const base = createProjectFromTemplate("house");
  return addAudioClip(base, base.tracks[0].id, "factory.kick", startBar, 4).execute(base);
}

function mount(doc: ProjectDocument): ProjectStore {
  const project = new ProjectStore(doc);
  const selectionStore = new SelectionStore();
  const services = { ...mockServices(doc), store: project } as unknown as Services;
  render(
    createElement(
      ServicesContext.Provider,
      { value: services },
      createElement(
        SelectionContext.Provider,
        { value: selectionStore },
        createElement(ArrangementPanel) as ReactElement,
      ),
    ),
  );
  const scrollEl = document.querySelector(".arr-lane-scroll") as HTMLElement;
  Object.defineProperty(scrollEl, "clientWidth", { value: 800, configurable: true });
  const lane = document.querySelector(".arr-lane");
  if (lane) vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(domRect(0, 300 * BASE_BAR_WIDTH));
  vi.spyOn(scrollEl, "getBoundingClientRect").mockReturnValue(domRect(0, 800));
  act(() => {
    scrollEl.dispatchEvent(new Event("scroll"));
  });
  return project;
}

const laneWidthPx = (): number => {
  const lane = document.querySelector(".arr-lane") as HTMLElement | null;
  return lane ? Number.parseFloat(lane.style.width) : Number.NaN;
};

describe("the arrangement timeline reaches every bar the document holds", () => {
  it("the scrollable lane covers a clip at bar 600", () => {
    cleanup();
    mount(docWithClipAt(600));
    const width = laneWidthPx();
    // 600 bars + 4 bars of clip + 4 bars of tail, at 30 px per bar.
    expect(width, `lane width ${width}px does not reach bar 600`).toBeGreaterThanOrEqual(600 * BASE_BAR_WIDTH);
  });

  it("the scrollable lane covers a clip at bar 2000", () => {
    cleanup();
    mount(docWithClipAt(2000));
    const width = laneWidthPx();
    expect(width, `lane width ${width}px does not reach bar 2000`).toBeGreaterThanOrEqual(2000 * BASE_BAR_WIDTH);
  });

  it("the unmeasured frame still allocates a bounded number of grid cells", () => {
    cleanup();
    // No viewport measurement: the fallback path runs.
    const project = new ProjectStore(docWithClipAt(2000));
    const selectionStore = new SelectionStore();
    const services = { ...mockServices(project.getDoc()), store: project } as unknown as Services;
    render(
      createElement(
        ServicesContext.Provider,
        { value: services },
        createElement(
          SelectionContext.Provider,
          { value: selectionStore },
          createElement(ArrangementPanel) as ReactElement,
        ),
      ),
    );
    const cells = document.querySelectorAll(".arr-bar-grid").length;
    expect(cells, "the unmeasured fallback must not allocate one cell per bar").toBeLessThanOrEqual(512);
  });

  it("the ruler's mark count stays bounded on a pathological document", () => {
    cleanup();
    const base = createProjectFromTemplate("house");
    const doc = addAudioClip(base, base.tracks[0].id, "factory.kick", 6000, 4).execute(base);
    mount(doc);
    const marks = document.querySelectorAll(".arr-ruler-mark").length;
    expect(marks, "the ruler must not allocate a mark per bar of a pathological document").toBeLessThanOrEqual(1024);
  });
});
