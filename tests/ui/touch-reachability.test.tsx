/**
 * Touch/reachability regressions found in the manipulation audit:
 *
 *  - Mixer: + RETURN must be a real button (return creation used to be
 *    right-click-only, i.e. unreachable on touch).
 *  - Slider: right-click AND touch long-press must both open the fader menu
 *    (reset / exact value) and a long-press must NOT commit the touch value.
 *  - ContextMenu: opens focused with an edge-clamped position.
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Mixer } from "../../src/ui/Mixer";
import { Slider } from "../../src/ui/controls";
import { ContextMenu } from "../../src/ui/ContextMenu";
import { SelectionContext } from "../../src/ui/context";
import { SelectionStore } from "../../src/store/SelectionStore";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";

describe("Mixer touch reachability", () => {
  it("exposes return creation as a clickable button per channel", () => {
    const services = mockServices(createProjectFromTemplate("house"));
    renderWithContext(<Mixer />, { services });
    const buttons = screen.getAllByRole("button", { name: "Create return track" });
    expect(buttons.length).toBeGreaterThan(0);
    act(() => buttons[0].click());
    const command = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(command?.type).toBe("createReturnTrack");
  });
});

describe("Slider fader menu — mouse and touch paths", () => {
  it("opens the menu on right-click without committing", () => {
    const onCommit = vi.fn();
    const onMenu = vi.fn();
    render(<Slider label="VOL" value={0.5} min={0} max={1} defaultValue={0.9} onCommit={onCommit} onMenu={onMenu} />);
    const track = screen.getByRole("slider");
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 100,
      height: 10,
      right: 100,
      bottom: 10,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    fireEvent.contextMenu(track, { clientX: 40, clientY: 20 });
    expect(onMenu).toHaveBeenCalledWith(40, 20);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("touch long-press opens the menu and the release does not commit the touched level", async () => {
    const onCommit = vi.fn();
    const onMenu = vi.fn();
    render(<Slider label="VOL" value={0.5} min={0} max={1} defaultValue={0.9} onCommit={onCommit} onMenu={onMenu} />);
    const track = screen.getByRole("slider");
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 100,
      height: 10,
      right: 100,
      bottom: 10,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(track, { button: 0, pointerType: "touch", clientX: 90, clientY: 5, pointerId: 1 });
      await act(async () => {
        vi.advanceTimersByTime(460);
      });
      expect(onMenu).toHaveBeenCalled();
      fireEvent.pointerUp(track, { pointerId: 1 });
      expect(onCommit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still commits a normal touch drag (move cancels the pending hold)", async () => {
    const onCommit = vi.fn();
    const onMenu = vi.fn();
    render(<Slider label="VOL" value={0.5} min={0} max={1} defaultValue={0.9} onCommit={onCommit} onMenu={onMenu} />);
    const track = screen.getByRole("slider");
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 100,
      height: 10,
      right: 100,
      bottom: 10,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(track, { button: 0, pointerType: "touch", clientX: 10, clientY: 5, pointerId: 1 });
      fireEvent.pointerMove(track, { pointerType: "touch", clientX: 80, clientY: 5, pointerId: 1 });
      await act(async () => {
        vi.advanceTimersByTime(460);
      });
      expect(onMenu).not.toHaveBeenCalled();
      fireEvent.pointerUp(track, { pointerId: 1 });
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit.mock.calls[0][0]).toBeCloseTo(0.8, 2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ContextMenu keyboard reachability", () => {
  it("focuses the first item on open and clamps to the viewport", async () => {
    const services = mockServices(createProjectFromTemplate("house"));
    const selectionStore = new SelectionStore();
    selectionStore.setClips(["clip-1"]);
    const { container } = renderWithContext(
      <SelectionContext.Provider value={selectionStore}>
        <ContextMenu
          state={{ x: window.innerWidth - 10, y: window.innerHeight - 10, context: "1 clip" }}
          onClose={() => {}}
        />
      </SelectionContext.Provider>,
      { services },
    );
    const menu = container.querySelector(".context-menu") as HTMLElement;
    expect(menu).not.toBeNull();
    expect(parseInt(menu.style.left, 10)).toBeLessThanOrEqual(window.innerWidth - 220);
    expect(parseInt(menu.style.top, 10)).toBeLessThanOrEqual(window.innerHeight - 160);
    await waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("menuitem"));
  });
});
