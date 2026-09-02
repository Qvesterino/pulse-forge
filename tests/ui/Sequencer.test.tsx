import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { Sequencer } from "../../src/ui/Sequencer";
import { renderWithContext } from "../helpers";

const defaultProps = {
  selectedPadId: "",
  selectedTrackId: "t1",
  onSelectTrack: vi.fn(),
  onSelectPad: vi.fn(),
  selectedNote: null,
  onSelectNote: vi.fn(),
  stepSelection: null,
  onSelectSteps: vi.fn(),
  scaleSnap: false,
};

describe("Sequencer", () => {
  it("renders step ruler", () => {
    renderWithContext(<Sequencer {...defaultProps} />);
    expect(screen.getByRole("row", { name: /Step ruler/ })).toBeInTheDocument();
  });

  it("renders step numbers in ruler", () => {
    renderWithContext(<Sequencer {...defaultProps} />);
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("renders dots for non-beat steps", () => {
    renderWithContext(<Sequencer {...defaultProps} />);
    const dots = screen.getAllByText("·");
    expect(dots.length).toBeGreaterThan(0);
  });

  it("renders track header rows", () => {
    const { container } = renderWithContext(<Sequencer {...defaultProps} />);
    const rows = container.querySelectorAll(".track-header-row");
    expect(rows.length).toBeGreaterThan(0);
  });

  it("has step sequencer aria label", () => {
    renderWithContext(<Sequencer {...defaultProps} />);
    expect(screen.getByRole("region", { name: /Step Sequencer/ })).toBeInTheDocument();
  });
});

describe("step amount drag (window-level listeners)", () => {
  const domRect = (left: number, width: number) =>
    ({
      left,
      top: 0,
      width,
      height: 8,
      right: left + width,
      bottom: 8,
      x: left,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;

  /** Start an amount drag: 10px on a 100px track = 0.1, dragged to 80px = 0.8 (default 1 → changes). */
  function beginAmountDrag() {
    const utils = renderWithContext(<Sequencer {...defaultProps} />);
    const track = document.querySelector(".step-amount-track") as HTMLElement;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue(domRect(0, 100));
    fireEvent.pointerDown(track, { button: 0, clientX: 10, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 80, pointerId: 1 });
    return utils;
  }

  it("commits the dragged amount on pointerup", () => {
    const { services } = beginAmountDrag();
    fireEvent.pointerUp(window, { clientX: 80, pointerId: 1 });
    expect(services.store.execute).toHaveBeenCalledTimes(1);
  });

  it("aborts on pointercancel without committing, even on a stale pointerup", () => {
    const { services } = beginAmountDrag();
    fireEvent.pointerCancel(window, { pointerId: 1 });
    expect(services.store.execute).not.toHaveBeenCalled();
    // Listeners must be gone: a later pointerup anywhere commits nothing.
    fireEvent.pointerUp(window, { clientX: 80, pointerId: 1 });
    expect(services.store.execute).not.toHaveBeenCalled();
  });
});
