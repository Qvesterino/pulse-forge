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
import userEvent from "@testing-library/user-event";
import { Mixer } from "../../src/ui/Mixer";
import { Slider, DragNumber } from "../../src/ui/controls";
import { ContextMenu } from "../../src/ui/ContextMenu";
import { SelectionContext } from "../../src/ui/context";
import { SelectionStore } from "../../src/store/SelectionStore";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";

const domRect = (left: number, top: number, width: number, height: number) =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

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

describe("built-in value menu (no host onMenu)", () => {
  it("Slider: right-click opens Reset/Type and Reset commits the default", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Slider label="MIX" value={0.7} min={0} max={1} defaultValue={0.5} onCommit={onCommit} />);
    const track = screen.getByRole("slider");
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue(domRect(0, 0, 100, 10));

    fireEvent.contextMenu(track, { clientX: 40, clientY: 20 });
    expect(screen.getByRole("menu", { name: "Value options" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: /Reset to default/ }));
    expect(onCommit).toHaveBeenCalledWith(0.5);
    expect(screen.queryByRole("menu", { name: "Value options" })).toBeNull();
  });

  it("Slider: long-press opens the built-in menu and Type value applies the typed number", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Slider label="MIX" value={0.7} min={0} max={1} defaultValue={0.5} onCommit={onCommit} />);
    const track = screen.getByRole("slider");
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue(domRect(0, 0, 100, 10));

    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(track, { button: 0, pointerType: "touch", clientX: 50, clientY: 5, pointerId: 1 });
      await act(async () => {
        vi.advanceTimersByTime(460);
      });
      fireEvent.pointerUp(track, { pointerId: 1 });
      expect(screen.getByRole("menu", { name: "Value options" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }

    await user.click(screen.getByRole("menuitem", { name: "Type value…" }));
    const input = screen.getByRole("textbox", { name: "MIX value" });
    await user.clear(input);
    await user.type(input, "0,25");
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledWith(0.25);
  });

  it("DragNumber: right-click opens the built-in menu; Reset restores the default", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<DragNumber label="BPM" value={140} min={20} max={300} defaultValue={124} onCommit={onCommit} />);
    const el = screen.getByRole("spinbutton");
    fireEvent.contextMenu(el, { clientX: 10, clientY: 10 });
    expect(screen.getByRole("menu", { name: "Value options" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: /Reset to default/ }));
    expect(onCommit).toHaveBeenCalledWith(124);
  });

  it("DragNumber: long-press opens the menu and the release does not commit a drag", async () => {
    const onCommit = vi.fn();
    render(<DragNumber label="BPM" value={140} min={20} max={300} defaultValue={124} onCommit={onCommit} />);
    const el = screen.getByRole("spinbutton");

    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(el, { button: 0, pointerType: "touch", clientX: 10, clientY: 100, pointerId: 1 });
      await act(async () => {
        vi.advanceTimersByTime(460);
      });
      fireEvent.pointerUp(el, { pointerId: 1 });
      expect(screen.getByRole("menu", { name: "Value options" })).toBeInTheDocument();
      expect(onCommit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("DragNumber: a normal touch drag still commits (movement cancels the hold)", async () => {
    const onCommit = vi.fn();
    render(<DragNumber label="BPM" value={140} min={20} max={300} defaultValue={124} onCommit={onCommit} />);
    const el = screen.getByRole("spinbutton");

    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(el, { button: 0, pointerType: "touch", clientX: 10, clientY: 100, pointerId: 1 });
      fireEvent.pointerMove(el, { pointerType: "touch", clientX: 10, clientY: 75, pointerId: 1 });
      await act(async () => {
        vi.advanceTimersByTime(460);
      });
      expect(screen.queryByRole("menu", { name: "Value options" })).toBeNull();
      fireEvent.pointerUp(el, { pointerId: 1 });
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit.mock.calls[0][0]).toBeCloseTo(150, 1);
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
