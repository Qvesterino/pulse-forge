import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, act } from "@testing-library/react";
import { GestureHintToast, GESTURE_HINT_EVENT, fireGestureHint } from "../../src/ui/gestureHints";

/**
 * First-time gesture hints: the first fire of a key toasts its text once;
 * repeats (and after reload via localStorage) stay silent; unknown keys and
 * dismiss are no-ops.
 */

const readSeen = (): Record<string, boolean> =>
  JSON.parse(localStorage.getItem("pulse-forge.gesture-hints.v1") ?? "{}") as Record<string, boolean>;

describe("GestureHintToast", () => {
  beforeEach(() => {
    localStorage.removeItem("pulse-forge.gesture-hints.v1");
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.removeItem("pulse-forge.gesture-hints.v1");
  });

  it("shows a hint the first time its gesture fires, never again", async () => {
    render(<GestureHintToast />);
    act(() => {
      fireGestureHint("multi-select");
    });
    expect(screen.getByRole("status")).toHaveTextContent(/Range selected/);
    expect(readSeen()["multi-select"]).toBe(true);

    // Repeat fires stay silent.
    act(() => {
      fireGestureHint("multi-select");
      vi.advanceTimersByTime(4600); // toast auto-dismisses
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("each key teaches once — velocity hint still shows after the select hint", () => {
    render(<GestureHintToast />);
    act(() => {
      fireGestureHint("multi-select");
    });
    expect(screen.getByRole("status")).toHaveTextContent(/Range selected/);
    act(() => {
      fireGestureHint("velocity-drag");
    });
    expect(screen.getByRole("status")).toHaveTextContent(/ALT while dragging/);
  });

  it("dismiss hides the toast immediately", () => {
    render(<GestureHintToast />);
    act(() => {
      fireGestureHint("step-editor");
    });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss hint" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("unknown keys never toast", () => {
    render(<GestureHintToast />);
    act(() => {
      window.dispatchEvent(new CustomEvent(GESTURE_HINT_EVENT, { detail: { key: "nope" } }));
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("seen keys persist across remounts (localStorage contract)", () => {
    const first = render(<GestureHintToast />);
    act(() => {
      fireGestureHint("multi-select");
    });
    first.unmount();

    render(<GestureHintToast />);
    act(() => {
      fireGestureHint("multi-select");
    });
    // Synchronous dispatch — a seen key produces no toast at all.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
