import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { SelectionContext, ServicesContext } from "../../src/ui/context";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { mockServices } from "../helpers";
import type { Services } from "../../src/services";

/**
 * PROBE — forced layout reads per pointermove in the arrangement clip drag.
 * Answers one question: is the lane rect read every move, and does it ever
 * change during the gesture (i.e. would caching it at pointerdown be safe)?
 */

const domRect = (left: number, width: number) => ({
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

describe("probe · layout reads in the clip drag", () => {
  it("counts getBoundingClientRect per move and whether the rect is stable", () => {
    const doc = createProjectFromTemplate("house");
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
    const lane = document.querySelector(".arr-lane")!;
    const clipEl = document.querySelector(".arr-clip")!;

    // The lane reports a LIVE rect that we can watch for movement.
    let laneLeft = 0;
    const seenLefts = new Set<number>();
    vi.spyOn(lane, "getBoundingClientRect").mockImplementation(() => domRect(laneLeft, 4000));
    vi.spyOn(clipEl, "getBoundingClientRect").mockReturnValue(domRect(0, 100));

    const proto = Element.prototype.getBoundingClientRect;
    let reads = 0;
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      reads++;
      if (this === lane) seenLefts.add(laneLeft);
      return proto.call(this);
    });

    const MOVES = 20;
    fireEvent.pointerDown(clipEl, { button: 0, clientX: 40, pointerId: 1 });
    reads = 0;

    // Simulate the container reflowing mid-drag (a real scenario: the dock
    // resizes, a panel opens, the user scrolls). If the rect changes, a rect
    // cached at pointerdown would go stale.
    for (let i = 1; i <= MOVES; i++) {
      if (i === 11) laneLeft = 12; // one reflow, mid-drag
      act(() => {
        fireEvent.pointerMove(clipEl, { clientX: 40 + i * 10, pointerId: 1 });
      });
    }
    const perMove = reads;
    spy.mockRestore();
    fireEvent.pointerUp(clipEl, { pointerId: 1 });

    // PROOF the gesture actually ran — otherwise "0 reads" would mean
    // "the probe never dragged", not "the drag reads no layout".
    const clipId = project.doc.arrangement.clips[0].id;
    const startBar = project.doc.arrangement.clips.find((c) => c.id === clipId)?.startBar;
    const moved = startBar !== undefined && startBar > 0;

    console.info(
      `[probe] ${perMove} getBoundingClientRect calls over ${MOVES} pointermoves ` +
        `= ${(perMove / MOVES).toFixed(2)}/move; distinct lane rects: ${seenLefts.size}; ` +
        `clip startBar=${String(startBar)} moved=${moved}`,
    );
    // A probe that did not drag proves nothing about drag cost.
    expect(moved, "probe did not actually move the clip — result is meaningless").toBe(true);
  });
});
