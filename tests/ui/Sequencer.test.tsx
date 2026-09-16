import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { Sequencer } from "../../src/ui/Sequencer";
import { renderWithContext, mockServices } from "../helpers";

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

  it("toggles Beat Focus without changing the pattern editor state", () => {
    const { container } = renderWithContext(<Sequencer {...defaultProps} />);
    const enter = screen.getByRole("button", { name: "Enter Beat Focus" });

    expect(container.querySelector(".sequencer.beat-focus")).toBeNull();
    fireEvent.click(enter);
    expect(container.querySelector(".sequencer.beat-focus")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Step Sequencer — Beat Focus" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Exit Beat Focus" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector(".sequencer.beat-focus")).toBeNull();
    expect(screen.getByRole("button", { name: "Enter Beat Focus" })).toBeInTheDocument();
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

describe("step drag-paint and hover audition", () => {
  function firstRowSteps(container: HTMLElement) {
    const row = container.querySelector(".sequencer-row")!;
    return {
      row,
      step: (i: number) => row.querySelector<HTMLElement>(`.step[data-step="${i}"]`)!,
      firstActive: () => row.querySelector<HTMLElement>(".step.active")!,
    };
  }

  function activePatternOf(services: ReturnType<typeof mockServices>) {
    const doc = services.store.doc;
    return doc.patterns.find((p) => p.id === doc.activePatternId)!;
  }

  /** The mock store never applies commands — run the captured one for real. */
  function appliedRowsOf(services: ReturnType<typeof mockServices>, callIndex: number) {
    const cmd = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls[callIndex][0];
    const next = cmd.execute(services.store.getDoc());
    return next.patterns.find((p: { id: string }) => p.id === next.activePatternId)!.rows;
  }

  function stubElementFromPoint(target: Element) {
    const original = document.elementFromPoint;
    document.elementFromPoint = () => target;
    return () => {
      document.elementFromPoint = original;
    };
  }

  it("drag-paints a horizontal stroke across empty cells as one command", () => {
    const { services, container } = renderWithContext(<Sequencer {...defaultProps} />);
    const { step } = firstRowSteps(container);
    const a = step(1);
    const b = step(2);
    const c = step(3);
    const padId = a.dataset.pad!;

    const restore = stubElementFromPoint(c);
    // First move lands on b, second on c — both must join one stroke.
    const firstMove = stubElementFromPoint(b);
    const executeSpy = vi.spyOn(services.store, "execute");

    fireEvent.pointerDown(a, { button: 0, clientX: 0, clientY: 100, pointerId: 1, pointerType: "mouse" });
    fireEvent.pointerMove(a, { clientX: 12, clientY: 100, pointerId: 1, pointerType: "mouse" });
    firstMove();
    fireEvent.pointerMove(a, { clientX: 50, clientY: 100, pointerId: 1, pointerType: "mouse" });
    fireEvent.pointerUp(a, { clientX: 50, clientY: 100 });
    restore();

    expect(executeSpy).toHaveBeenCalledTimes(1);
    const rows = appliedRowsOf(services, 0);
    expect(rows[padId][1]).toBe(0.8);
    expect(rows[padId][2]).toBe(0.8);
    expect(rows[padId][3]).toBe(0.8);
  });

  it("drag-paints an erase stroke across placed steps", () => {
    const { services, container } = renderWithContext(<Sequencer {...defaultProps} />);
    const { firstActive, step } = firstRowSteps(container);
    const on = firstActive();
    const padId = on.dataset.pad!;
    const placedStep = Number(on.dataset.step);
    const next = step(placedStep === 4 ? 5 : 4);
    const placedVelocity = activePatternOf(services).rows[padId][placedStep];
    expect(placedVelocity).toBeGreaterThan(0);

    const restore = stubElementFromPoint(next);
    const executeSpy = vi.spyOn(services.store, "execute");

    fireEvent.pointerDown(on, { button: 0, clientX: 0, clientY: 100, pointerId: 1, pointerType: "mouse" });
    fireEvent.pointerMove(on, { clientX: 15, clientY: 100, pointerId: 1, pointerType: "mouse" });
    fireEvent.pointerUp(on, { clientX: 15, clientY: 100 });
    restore();

    expect(executeSpy).toHaveBeenCalledTimes(1);
    const rows = appliedRowsOf(services, 0);
    expect(rows[padId][placedStep]).toBe(0);
    expect(rows[padId][Number(next.dataset.step)]).toBe(0);
  });

  it("keeps vertical drags on velocity editing instead of painting", () => {
    const { services, container } = renderWithContext(<Sequencer {...defaultProps} />);
    const { step } = firstRowSteps(container);
    const a = step(2);
    const padId = a.dataset.pad!;

    const executeSpy = vi.spyOn(services.store, "execute");
    fireEvent.pointerDown(a, { button: 0, clientX: 100, clientY: 200, pointerId: 1, pointerType: "mouse" });
    fireEvent.pointerMove(a, { clientX: 100, clientY: 140, pointerId: 1, pointerType: "mouse" });
    fireEvent.pointerUp(a, { clientX: 100, clientY: 140 });

    expect(executeSpy).toHaveBeenCalledTimes(1);
    const rows = appliedRowsOf(services, 0);
    expect(rows[padId][2]).toBeGreaterThan(0);
    expect(rows[padId][2]).toBeLessThan(0.8);
  });

  it("auditions placed steps on hover, gated while sweeping", () => {
    const { services, container } = renderWithContext(<Sequencer {...defaultProps} />);
    const { firstActive } = firstRowSteps(container);
    const active = firstActive();
    const empty = active.parentElement!.querySelector<HTMLElement>(".step:not(.active)")!;

    fireEvent.pointerEnter(empty, { pointerType: "mouse" });
    expect(services.engine.preview).not.toHaveBeenCalled();

    fireEvent.pointerEnter(active, { pointerType: "mouse" });
    expect(services.engine.preview).toHaveBeenCalledTimes(1);
    expect(services.engine.preview).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.any(Number));

    // A different cell within the 70 ms gate stays silent.
    fireEvent.pointerEnter(empty, { pointerType: "mouse" });
    fireEvent.pointerEnter(active, { pointerType: "mouse" });
    expect(services.engine.preview).toHaveBeenCalledTimes(1);
  });
});
