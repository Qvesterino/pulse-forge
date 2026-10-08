import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { SelectionContext, ServicesContext } from "../../src/ui/context";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { addArrangementClip, deleteArrangementClip } from "../../src/commands/commands";
import { mockServices } from "../helpers";
import type { ProjectDocument } from "../../src/project-model/types";
import type { Services } from "../../src/services";

/**
 * SCENE CLIP LEFT-TRIM (edit parity): dragging the LEFT 10 px zone of a scene
 * clip trims its start (move right, end pinned) — the arrangement twin of the
 * audio clip's left trim handle. The gesture reuses the shared scene drag
 * machine, so Escape/pointercancel/unmount inherit the established cancel
 * contract.
 *
 * Geometry (30 px/bar harness): the mock clip rect spans 400..520 (4 bars);
 * x = clientX − rect.left must be < 10 to enter the trim zone, while the BAR
 * is read against the LANE rect (0..2000) — pointer at clientX 75 = bar 2.5
 * → the command floors to bar 2.
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

function docWithSceneClip(): ProjectDocument {
  let doc = createProjectFromTemplate("house");
  for (const c of doc.arrangement.clips) doc = deleteArrangementClip(doc, c.id).execute(doc);
  return addArrangementClip(doc, doc.scenes[0]!.id, 0, 4).execute(doc);
}

function trimLeftEdge(doc: ProjectDocument, upClientX: number): ProjectDocument {
  cleanup();
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
  const lane = document.querySelector(".arr-lane");
  if (lane) vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(domRect(0, 2000));
  const target = document.querySelector(".arr-clip") as HTMLElement;
  expect(target, "scene clip rendered").not.toBeNull();
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue(domRect(400, 120)); // 4 bars @30px

  act(() => {
    // 405 − 400 = 5 px → inside the left 10 px trim zone.
    target.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 405, pointerId: 1, bubbles: true }));
  });
  act(() => {
    target.dispatchEvent(new PointerEvent("pointermove", { clientX: upClientX, pointerId: 1, bubbles: true }));
  });
  act(() => {
    target.dispatchEvent(new PointerEvent("pointerup", { clientX: upClientX, pointerId: 1, bubbles: true }));
  });
  return project.getDoc();
}

describe("scene clip left-trim gesture", () => {
  afterEach(() => cleanup());

  it("dragging the left zone right trims the start; the end edge stays", () => {
    const after = trimLeftEdge(docWithSceneClip(), 75); // bar 2.5 → floors to 2
    const clip = after.arrangement.clips[0]!;
    expect(clip.startBar).toBe(2);
    expect(clip.lengthBars).toBe(2);
    expect(clip.startBar + clip.lengthBars).toBe(4);
  });

  it("the trim cannot cross the clip (minimum one whole bar remains)", () => {
    const after = trimLeftEdge(docWithSceneClip(), 105); // bar 3.5 → floors to 3
    const clip = after.arrangement.clips[0]!;
    expect(clip.startBar).toBe(3);
    expect(clip.lengthBars).toBe(1);
  });

  it("a press in the BODY still moves the clip instead of trimming", () => {
    cleanup();
    const doc = docWithSceneClip();
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
    const lane = document.querySelector(".arr-lane");
    if (lane) vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(domRect(0, 2000));
    const target = document.querySelector(".arr-clip") as HTMLElement;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(domRect(400, 120));

    // Body press (x = 60): grab at bar 16 (500/30), drag +60 px = +2 bars.
    act(() => {
      target.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 500, pointerId: 1, bubbles: true }));
    });
    act(() => {
      target.dispatchEvent(new PointerEvent("pointermove", { clientX: 560, pointerId: 1, bubbles: true }));
    });
    act(() => {
      target.dispatchEvent(new PointerEvent("pointerup", { clientX: 560, pointerId: 1, bubbles: true }));
    });

    const clip = project.getDoc().arrangement.clips[0]!;
    // Move proof: position shifted (+2 bars from origStart 0) with geometry
    // untouched — a trim would have changed lengthBars instead.
    expect(clip.lengthBars).toBe(4);
    expect(clip.startBar).toBe(2);
  });
});
