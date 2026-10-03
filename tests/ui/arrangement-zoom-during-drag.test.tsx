import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { SelectionContext, ServicesContext } from "../../src/ui/context";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { mockServices } from "../helpers";
import type { ProjectDocument } from "../../src/project-model/types";
import type { Services } from "../../src/services";

/**
 * A live gesture must keep ONE unit system for its whole lifetime.
 *
 * `beginClipDrag` captures `grabBar` through `barFromEvent`, which divides by
 * the `barWidth` in scope at pointerdown. `onClipPointerMove` recomputes `bar`
 * through the same helper, dividing by the `barWidth` in scope at THAT render.
 *
 * The Ctrl+wheel zoom handler (ArrangementPanel.tsx:634-645) is registered on
 * `scrollRef` with `[]` deps and gates only on `event.ctrlKey` — it never
 * checks whether a gesture is live. So zooming mid-drag changes `barWidth`,
 * React re-renders, and the next `pointermove` computes a bar in the NEW unit
 * while `grabBar` still holds the OLD one. `delta = bar - grabBar` is then a
 * difference of two incompatible scales, and the clip lands somewhere the user
 * never pointed at.
 *
 * The invariant under test: the gesture means the same thing with or without a
 * zoom step inside it. A delta of the same pixels must move the clip by the
 * same number of bars.
 *
 * A real ProjectStore is used so the committed document actually changes.
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

function newDoc(): ProjectDocument {
  return createProjectFromTemplate("house");
}

function mount(): { project: ProjectStore; clipEl: Element; scrollEl: Element } {
  cleanup();
  const doc = newDoc();
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
  const clipEl = document.querySelector(".arr-clip")!;
  const scrollEl = document.querySelector(".arr-lane-scroll")!;
  // The lane supplies the rect every px→bar conversion reads.
  const lane = document.querySelector(".arr-lane");
  if (lane) vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(domRect(0, 4000));
  vi.spyOn(scrollEl, "getBoundingClientRect").mockReturnValue(domRect(0, 800));
  vi.spyOn(clipEl, "getBoundingClientRect").mockReturnValue(domRect(0, 200));
  return { project, clipEl, scrollEl };
}

/** Current px-per-bar, read straight off the rendered lane width. */
function currentBarWidth(): number {
  const lane = document.querySelector(".arr-lane") as HTMLElement;
  const totalBars = Number(lane.getAttribute("data-bars") ?? "0");
  return totalBars > 0 ? lane.getBoundingClientRect().width / totalBars : Number.NaN;
}

/** Drag the first clip from clientX 40 to 240, optionally zooming mid-drag. */
function drag(zoomMidGesture: boolean): { moved: number; barWidthStart: number; barWidthEnd: number } {
  const { project, clipEl, scrollEl } = mount();
  const before = project.getDoc().arrangement.clips[0]!.startBar;

  // The zoom changes px-per-bar, which is what makes the mixed-scale commit
  // observable. Reading it off the lane proves the wheel handler is live here.
  const barWidthStart = currentBarWidth();

  fireEvent.pointerDown(clipEl, { button: 0, clientX: 40, pointerId: 1 });

  if (zoomMidGesture) {
    fireEvent.wheel(scrollEl, { ctrlKey: true, deltaY: -240, clientX: 400 });
    act(() => {});
  }

  fireEvent.pointerMove(clipEl, { clientX: 240, pointerId: 1 });
  fireEvent.pointerUp(clipEl, { pointerId: 1 });

  return {
    moved: project.getDoc().arrangement.clips[0]!.startBar - before,
    barWidthStart,
    barWidthEnd: currentBarWidth(),
  };
}

describe("a gesture keeps one unit system for its lifetime", () => {
  it("BASELINE: the drag moves the clip and Ctrl+wheel really changes the zoom", () => {
    const control = drag(false);
    expect(control.moved, "the control drag actually moved the clip").toBeGreaterThan(0);

    const zoomed = drag(true);
    // Guard: if the wheel did nothing, the second test proves nothing.
    expect(zoomed.barWidthEnd, "Ctrl+wheel must actually change px-per-bar").not.toBeCloseTo(zoomed.barWidthStart, 2);
  });

  it("moves the clip by the same number of bars when zoom changes mid-drag", () => {
    const control = drag(false);
    const withZoom = drag(true);

    // THE DEFECT (pre-fix): the same 200px gesture lands somewhere different
    // because grabBar was captured in the pre-zoom scale and bar in the
    // post-zoom one.
    expect(withZoom.moved).toBe(control.moved);
  });
});
