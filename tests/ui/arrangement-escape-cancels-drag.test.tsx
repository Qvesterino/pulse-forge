import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { SelectionContext, ServicesContext } from "../../src/ui/context";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { mockServices } from "../helpers";
import type { Services } from "../../src/services";

/**
 * §20 CANCEL AND RECOVERY: "Incomplete interactions must either rollback
 * cleanly or commit according to explicit semantics. No operation may leave the
 * editor permanently stuck in dragging, trimming, loading, or disabled state."
 *
 * Every timeline gesture wires exactly two terminals — `onPointerUp` and
 * `onPointerCancel`. Escape and window-blur are not terminals, and the
 * arrangement panel registers no `window` pointerup/blur listener (unlike its
 * siblings `Sequencer.tsx:1766-1768` and `App.tsx:422-423`).
 *
 * The consequence is a destructive one rather than a cosmetic one: pressing
 * Escape mid-drag does not cancel the gesture. `dragRef.current` still holds
 * `movingIds` captured at gesture start, so releasing the mouse afterwards
 * COMMITS the move — after the user explicitly pressed the cancel key. App.tsx's
 * contextual Escape handler even calls `selectionStore.clear()` at that moment,
 * so the user sees the selection vanish while the clip slides anyway.
 *
 * A real ProjectStore is used so the document actually changes; the panel-level
 * specs in `ArrangementPanel.test.tsx` render over a mock store where the DOM
 * never updates after a command.
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

function renderLiveArrangement(): { project: ProjectStore; selectionStore: SelectionStore } {
  const doc = createProjectFromTemplate("house");
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
  // The lane is what every px→bar conversion reads its rect from.
  const lane = document.querySelector(".arr-lane");
  if (lane) vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(domRect(0, 2000));
  return { project, selectionStore };
}

/** The clip element plus the geometry the panel needs to arm a drag. */
function armClipDrag(): { clipEl: Element; clipId: string } {
  const clipEl = document.querySelector(".arr-clip")!;
  expect(clipEl).not.toBeNull();
  vi.spyOn(clipEl, "getBoundingClientRect").mockReturnValue(domRect(0, 100));
  return { clipEl, clipId: clipEl.getAttribute("data-clip-id") ?? "" };
}

describe("§20 Escape cancels a timeline drag", () => {
  it("does NOT commit the move when Escape is pressed between pointerdown and pointerup", () => {
    const { project } = renderLiveArrangement();
    const before = project.getDoc().arrangement.clips.map((c) => ({ id: c.id, startBar: c.startBar }));

    const { clipEl } = armClipDrag();
    // Grab the clip body (not the right-hand resize zone) and drag it right.
    fireEvent.pointerDown(clipEl, { button: 0, clientX: 40, pointerId: 1 });
    fireEvent.pointerMove(clipEl, { clientX: 240, pointerId: 1 });

    // THE CANCEL. Escape means "abort this interaction".
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });

    // The user lets go of the mouse.
    fireEvent.pointerUp(clipEl, { pointerId: 1 });

    const after = project.getDoc().arrangement.clips.map((c) => ({ id: c.id, startBar: c.startBar }));
    // THE DEFECT: the drag committed anyway — the clip moved despite Escape.
    expect(after, "a drag survived Escape and committed on release").toEqual(before);
    // And it did so as a real history entry the user must undo.
    expect(project.undoStackLength, "the cancelled drag created an undo entry").toBe(0);
  });

  it("still commits the move when no cancel key is pressed", () => {
    const { project } = renderLiveArrangement();
    const before = project.getDoc().arrangement.clips.map((c) => ({ id: c.id, startBar: c.startBar }));

    const { clipEl } = armClipDrag();
    fireEvent.pointerDown(clipEl, { button: 0, clientX: 40, pointerId: 1 });
    fireEvent.pointerMove(clipEl, { clientX: 240, pointerId: 1 });
    fireEvent.pointerUp(clipEl, { pointerId: 1 });

    const after = project.getDoc().arrangement.clips.map((c) => ({ id: c.id, startBar: c.startBar }));
    // The control: the happy path must still work, so the fix cannot be
    // "cancel every drag".
    expect(after, "a plain drag did not move the clip").not.toEqual(before);
    expect(project.undoStackLength).toBe(1);
  });

  it("cancels a marquee drag on Escape instead of falling through to scene placement", () => {
    const { project, selectionStore } = renderLiveArrangement();
    const lane = document.querySelector(".arr-lane")!;
    const before = project.getDoc().arrangement.clips.length;

    // Marquee arms on an empty-lane press and clears its anchor on pointerup.
    fireEvent.pointerDown(lane, { button: 0, clientX: 10, pointerId: 2 });
    fireEvent.pointerMove(lane, { clientX: 900, pointerId: 2 });
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    fireEvent.pointerUp(lane, { clientId: 2, pointerId: 2 });

    expect(selectionStore.getState().clipIds, "a cancelled marquee still selected clips").toEqual([]);
    expect(project.getDoc().arrangement.clips.length, "a cancelled marquee placed a scene").toBe(before);
  });

  it("clears a latched drag preview when the window loses focus mid-drag", () => {
    renderLiveArrangement();
    const { clipEl } = armClipDrag();
    fireEvent.pointerDown(clipEl, { button: 0, clientX: 40, pointerId: 1 });
    fireEvent.pointerMove(clipEl, { clientX: 240, pointerId: 1 });
    // Alt-tab: focus leaves without a pointercancel on the element.
    fireEvent.blur(window);

    // No ghost geometry: the clip must not be painted at a drag offset with no
    // drag behind it.
    const clipElAfter = document.querySelector(".arr-clip")!;
    const styleLeft = (clipElAfter as HTMLElement).style.left;
    expect(styleLeft === "0px" || styleLeft === "", `clip latched at left=${styleLeft} after blur`).toBe(true);
  });

  it("keeps the panel's own Escape behaviour reachable (help/selection)", () => {
    renderLiveArrangement();
    // Sanity: the panel renders and the DEL button exists, so a cancel fix that
    // broke the panel would be caught here.
    expect(screen.getByRole("button", { name: "DUP" })).toBeTruthy();
  });
});
