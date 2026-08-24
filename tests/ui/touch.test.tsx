import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLongPress } from "../../src/ui/useLongPress";
import { AudioUnlock } from "../../src/ui/AudioUnlock";
import { renderWithContext, mockServices } from "../helpers";

function Harness({ fire, ms }: { fire: () => void; ms?: number }) {
  const lp = useLongPress(fire, ms);
  return (
    <div
      data-testid="cell"
      onPointerDown={lp.onPointerDown}
      onPointerMove={lp.onPointerMove}
      onPointerUp={lp.onPointerUp}
      onPointerLeave={lp.onPointerLeave}
      onPointerCancel={lp.onPointerCancel}
      onContextMenu={lp.wrapContextMenu((e) => {
        e.preventDefault();
        fire();
      })}
    />
  );
}

const touchDown = (el: Element) =>
  fireEvent.pointerDown(el, { pointerType: "touch", buttons: 1, clientX: 10, clientY: 10 });
const mouseDown = (el: Element) =>
  fireEvent.pointerDown(el, { pointerType: "mouse", buttons: 1, clientX: 10, clientY: 10 });

describe("useLongPress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires after the hold time for touch pointers", () => {
    const fire = vi.fn();
    render(<Harness fire={fire} />);
    const cell = screen.getByTestId("cell");
    touchDown(cell);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("never fires for mouse pointers (right-click is the mouse path)", () => {
    const fire = vi.fn();
    render(<Harness fire={fire} />);
    const cell = screen.getByTestId("cell");
    mouseDown(cell);
    vi.advanceTimersByTime(1000);
    expect(fire).not.toHaveBeenCalled();
  });

  it("cancels when the finger moves, lifts or leaves", () => {
    for (const gesture of ["move", "up", "leave", "cancel"] as const) {
      const fire = vi.fn();
      const { unmount } = render(<Harness fire={fire} />);
      const cell = screen.getByTestId("cell");
      touchDown(cell);
      if (gesture === "move") fireEvent.pointerMove(cell, { pointerType: "touch" });
      if (gesture === "up") fireEvent.pointerUp(cell, { pointerType: "touch" });
      if (gesture === "leave") fireEvent.pointerLeave(cell);
      if (gesture === "cancel") fireEvent.pointerCancel(cell);
      vi.advanceTimersByTime(1000);
      expect(fire).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("swallows the synthetic context menu right after a long-press (no double trigger)", () => {
    const fire = vi.fn();
    render(<Harness fire={fire} />);
    const cell = screen.getByTestId("cell");
    touchDown(cell);
    vi.advanceTimersByTime(500);
    expect(fire).toHaveBeenCalledTimes(1);
    // Mobile browsers fire contextmenu right after the long-press…
    fireEvent.contextMenu(cell);
    expect(fire).toHaveBeenCalledTimes(1); // …must not double-trigger.
  });

  it("a browser-fired context menu cancels the pending timer and runs the original once", () => {
    const fire = vi.fn();
    render(<Harness fire={fire} />);
    const cell = screen.getByTestId("cell");
    touchDown(cell);
    vi.advanceTimersByTime(200);
    fireEvent.contextMenu(cell); // browser's menu wins the race
    expect(fire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(fire).toHaveBeenCalledTimes(1); // our timer was cancelled
  });
});

describe("AudioUnlock", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders nothing when the context is running (or absent)", () => {
    renderWithContext(<AudioUnlock />);
    expect(screen.queryByText(/TAP TO ENABLE AUDIO/i)).toBeNull();
  });

  it("shows the banner on suspended touch devices and unlocks on tap", async () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    Object.defineProperty(window, "matchMedia", { value: matchMedia, configurable: true });
    const services = mockServices();
    let state = "suspended";
    Object.defineProperty(services.engine, "context", {
      get: () => ({ state, decodeAudioData: async () => ({}) }),
      configurable: true,
    });
    const ensure = vi.fn(() => {
      state = "running";
    });
    (services.engine as { ensureContext: () => void }).ensureContext = ensure;

    renderWithContext(<AudioUnlock />, { services });
    const banner = await screen.findByText(/TAP TO ENABLE AUDIO/i);
    expect(banner).toBeInTheDocument();

    fireEvent.click(banner);
    await waitFor(() => expect(ensure).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/TAP TO ENABLE AUDIO/i)).toBeNull());
  });
});
