import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { ServicesContext, SelectionContext } from "../../src/ui/context";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { addArrangementClip, deleteArrangementClip } from "../../src/commands/commands";
import { mockServices } from "../helpers";
import type { Services } from "../../src/services";

/**
 * ARRANGEMENT DOM CENSUS GATE (D: scale — virtualization, 2026-10-17)
 *
 * The project's own cap `MAX_ARRANGEMENT_CLIP_BARS` existed because the grid
 * once rendered ONE div per bar ("one div per bar was O(totalBars)" — the
 * windowing comment in ArrangementPanel). Measured with this harness:
 *
 *   unmeasured viewport (jsdom default, the fallback path):
 *     2 clips at bars 0 & 1000 → 887 elements, 512 .arr-bar-grid divs
 *   measured viewport (clientWidth 800 + scroll):
 *     the same project      → 408 elements, 40 .arr-bar-grid divs
 *   520 packed clips        → 7621 elements (~14.7 per clip)
 *
 * The invariant that matters is not the absolute count but the WINDOW: the
 * rendered grid must not follow the project's length. These specs pin that,
 * plus a per-clip budget, so a future change that drops windowing — or makes a
 * strip render per bar again — fails here instead of at 4000 bars.
 *
 * THE PER-CLIP BUDGET MOVED WITH THE SCENE PICTURE (2026-10-28). A scene
 * region draws what it PLAYS inside the region (ScenePatternMarks), and the
 * house template's scene carries 40 notes + 44 drum hits per region: 87
 * elements of picture on top of the ~15 of clip chrome. Measured with this
 * harness: 520 packed clips → 53 259 elements (~102.4 per clip), of which
 * 43 680 are the picture's own marks.
 *
 * The budget is re-pinned to the MEASURED number, not to a round guess, and it
 * stays a tripwire: one element more per clip fails here, so the picture
 * cannot grow without someone re-pinning it on purpose and reviewing the
 * diff. The window specs above are the invariant that must never move.
 */

function docWithClips(bars: number[]) {
  let doc = createProjectFromTemplate("house");
  for (const clip of [...doc.arrangement.clips]) doc = deleteArrangementClip(doc, clip.id).execute(doc);
  const sceneId = doc.scenes[0]!.id;
  for (const bar of bars) doc = addArrangementClip(doc, sceneId, bar, 4).execute(doc);
  return doc;
}

function renderPanel(doc: ReturnType<typeof docWithClips>) {
  const project = new ProjectStore(doc);
  const services = { ...mockServices(doc), store: project } as unknown as Services;
  const selection = new SelectionStore();
  return render(
    createElement(
      ServicesContext.Provider,
      { value: services },
      createElement(SelectionContext.Provider, { value: selection }, createElement(ArrangementPanel)),
    ),
  );
}

/** Give the scroller a real width and let the panel measure its window. */
async function measureWindow(container: HTMLElement, clientWidth = 800) {
  const scroller = container.querySelector(".arr-lane-scroll") as HTMLElement | null;
  expect(scroller, "the scrolling lane container did not render").not.toBeNull();
  Object.defineProperty(scroller!, "clientWidth", { value: clientWidth, configurable: true });
  fireEvent.scroll(scroller!);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return scroller!;
}

afterEach(() => cleanup());

describe("arrangement DOM census gate (D: scale)", () => {
  it("the rendered grid does not follow the project's length (windowed)", async () => {
    const utils1000 = renderPanel(docWithClips([0, 1000]));
    await measureWindow(utils1000.container);
    const grids1000 = utils1000.container.querySelectorAll(".arr-bar-grid").length;
    const total1000 = utils1000.container.querySelectorAll("*").length;
    utils1000.unmount();
    cleanup();

    const utils4000 = renderPanel(docWithClips([0, 4000]));
    await measureWindow(utils4000.container);
    const grids4000 = utils4000.container.querySelectorAll(".arr-bar-grid").length;
    const total4000 = utils4000.container.querySelectorAll("*").length;

    // 4× the project length, same window: a 1000-bar increase must add ~0 nodes.
    expect(grids4000, "grid cells must follow the VIEWPORT, not the project").toBe(grids1000);
    expect(total4000, "element count must not grow with project length").toBe(total1000);
    // And the window itself stays bounded (window 800px / 30px per bar + overscan).
    expect(grids1000).toBeLessThanOrEqual(60);
    expect(total1000).toBeLessThanOrEqual(600);
  });

  it("the unmeasured-viewport fallback stays bounded at 1000 bars", async () => {
    // Before the viewport is measured (hidden panel, jsdom) the grid falls back
    // to every bar. That fallback must stay linear-but-bounded — this pins the
    // ceiling so it cannot silently become the default for huge projects.
    const utils = renderPanel(docWithClips([0, 1000]));
    const total = utils.container.querySelectorAll("*").length;
    expect(total, "the unmeasured fallback exploded for a 1000-bar project").toBeLessThanOrEqual(1200);
  });

  it("per-clip DOM cost stays within budget (520 clips ≤ 53 259 elements)", () => {
    const bars = Array.from({ length: 520 }, (_, index) => index * 4);
    const utils = renderPanel(docWithClips(bars));
    const clipEls = utils.container.querySelectorAll(".arr-clip").length;
    const total = utils.container.querySelectorAll("*").length;
    expect(clipEls, "not every clip rendered — the cost measurement would be vacuous").toBe(520);
    expect(total, "per-clip DOM cost grew past its measured ~102.4 elements").toBeLessThanOrEqual(53_259);
  });
});
