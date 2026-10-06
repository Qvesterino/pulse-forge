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
 * The arrangement lane must render the VISIBLE window, not the whole song.
 *
 * Pre-fix, `ArrangementPanel` mapped every clip in the document on every render
 * (two full maps over `clips`/`audioClips`, plus `Array.from({length: totalBars})`
 * for the bar grid). The measured cost is O(n) per React commit and — because
 * `compSourceTakeNumber` rebuilds a `Set` over every audio clip, and
 * `arrangementSecondsBetweenTicks` walks `clips` — the audio map is O(n²).
 *
 * The panel re-renders on pointermove while dragging, so with 200 clips a single
 * mouse move reconciles hundreds of nodes while audio is playing. Commit COUNT
 * measured a perfect 1.00 per pointermove at 1, 50 and 200 clips: the count is
 * O(1) and the COST is O(n). A gate on commit count alone is green and useless.
 *
 * The invariant under test: DOM nodes must be bounded by the viewport, so the
 * per-commit cost is O(visible) regardless of song length.
 *
 * Each measurement below carries a positive control, because "rendered 36 clips"
 * is indistinguishable from "rendered 36 of 300 by accident, or of 36 total".
 */
const CLIPS = 300;
const VIEWPORT_PX = 800;

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

/**
 * 300 one-bar clips every 4th bar: a ~1200-bar song at BASE_BAR_WIDTH 30.
 *
 * The spacing is not cosmetic. A fixture that packs a clip on EVERY bar makes
 * every drag collide with its neighbour, and the move command then refuses the
 * commit — which reads exactly like "the drag does not work" and is a property
 * of the fixture, not of the product. Gaps are also what a real arrangement has.
 */
function longDoc(): ProjectDocument {
  const doc = createProjectFromTemplate("house");
  const base = doc.arrangement.clips[0]!;
  doc.arrangement.clips = Array.from({ length: CLIPS }, (_, i) => ({
    ...base,
    id: `clip-${i}`,
    startBar: i * 4,
    lengthBars: 1,
  }));
  return doc;
}

function mount(): { project: ProjectStore; scrollEl: HTMLElement } {
  cleanup();
  const doc = longDoc();
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
  // jsdom performs no layout, so clientWidth is 0 and every window would be
  // empty. A viewport of 0px is the classic way a windowing change turns into
  // "nothing renders at all" — pin it so the test cannot silently pass that way.
  Object.defineProperty(scrollEl, "clientWidth", { value: VIEWPORT_PX, configurable: true });
  const lane = document.querySelector(".arr-lane");
  if (lane) vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(domRect(0, 300 * 30));
  vi.spyOn(scrollEl, "getBoundingClientRect").mockReturnValue(domRect(0, VIEWPORT_PX));
  // Re-run the measurement now that clientWidth exists.
  fireEvent.scroll(scrollEl);
  return { project, scrollEl };
}

const sceneClipCount = () => document.querySelectorAll(".arr-clip").length;
const barGridCount = () => document.querySelectorAll(".arr-bar-grid").length;

/** Which startBars are currently in the DOM, read off the inline `left`. */
function renderedStartBars(): number[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".arr-clip"))
    .map((el) => Number.parseFloat(el.style.left) / 30)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

describe("arrangement lane renders the visible window, not the whole song", () => {
  it("POSITIVE CONTROL: the document really holds 300 clips over ~1200 bars", () => {
    const { project } = mount();
    const clips = project.getDoc().arrangement.clips;
    expect(clips.length, "the document under test must actually be long").toBe(CLIPS);
    expect(clips[CLIPS - 1]!.startBar).toBe((CLIPS - 1) * 4);
  });

  it("renders a bounded number of scene clips, not all 300", () => {
    mount();
    const rendered = sceneClipCount();

    // THE DEFECT (pre-fix): all 300 nodes are in the DOM.
    expect(rendered).toBeGreaterThan(0);
    expect(
      rendered,
      `rendered ${rendered} clips for a ${VIEWPORT_PX}px viewport — the whole song is being mounted`,
    ).toBeLessThan(CLIPS);
    // 800px at BASE_BAR_WIDTH 30 = ~27 bars. Allow generous overscan, but a
    // window must never approach the song length.
    expect(rendered).toBeLessThan(120);
  });

  it("renders a bounded number of bar-grid cells, not one per bar", () => {
    mount();
    const cells = barGridCount();
    expect(cells).toBeGreaterThan(0);
    expect(cells, `${cells} grid cells for ~27 visible bars`).toBeLessThan(120);
  });

  it("mounts the clips that scroll into the window and drops the ones that leave", () => {
    const { scrollEl } = mount();
    const before = renderedStartBars();
    expect(before[0]).toBe(0);

    // Clip 150 sits at bar 600; at 30px that is 18000px into the content.
    act(() => {
      scrollEl.scrollLeft = 600 * 30;
      fireEvent.scroll(scrollEl);
    });

    const after = renderedStartBars();
    expect(after.length, "the window must still be populated after scrolling").toBeGreaterThan(0);
    expect(
      after.some((bar) => bar >= 560 && bar <= 660),
      `rendered bars: ${after.join(",")}`,
    ).toBe(true);
    expect(after.includes(0), "bar 0 left the window and must not still be mounted").toBe(false);
  });

  it("never unmounts a clip while it is being dragged", () => {
    const { scrollEl, project } = mount();
    const clipEl = document.querySelector(".arr-clip") as HTMLElement;
    vi.spyOn(clipEl, "getBoundingClientRect").mockReturnValue(domRect(0, 200));

    fireEvent.pointerDown(clipEl, { button: 0, clientX: 10, pointerId: 1 });
    // Push the clip far to the right — well past the window edge, so a naive
    // window would unmount the very element the gesture is captured on.
    act(() => {
      scrollEl.scrollLeft = 60 * 30;
      fireEvent.scroll(scrollEl);
    });
    fireEvent.pointerMove(clipEl, { clientX: 2200, pointerId: 1 });

    // FALSIFIED: with the forced-inclusion union removed, the clip is dropped
    // the moment it leaves the window and the commit is SILENTLY LOST — the
    // drag produces no error and no move. The clip count alone does not catch
    // it (the window still holds other clips); only the committed position does.
    // So the assertion below, not the count above, is the load-bearing one.
    expect(
      document.querySelectorAll(".arr-clip").length,
      "the dragged clip was unmounted by its own movement",
    ).toBeGreaterThan(0);

    act(() => {
      fireEvent.pointerUp(clipEl, { pointerId: 1 });
    });
    // The commit is driven by the gesture ref, not by the DOM node — so a clip
    // dragged far across the song must land where it was dropped. Asserted BY
    // ID: the move command re-sorts the array, so index 0 is a different clip
    // after a drag that moved past the first neighbour.
    const dragged = project.getDoc().arrangement.clips.find((c) => c.id === "clip-0");
    expect(dragged?.startBar ?? -1).toBeGreaterThan(10);
  });
});
