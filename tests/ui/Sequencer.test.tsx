import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { Sequencer } from "../../src/ui/Sequencer";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";

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
  it("keeps Space free for transport: a focused step ignores it, Enter still toggles", () => {
    const { services, container } = renderWithContext(<Sequencer {...defaultProps} />);
    const step = container.querySelector('button[data-step="0"]') as HTMLElement;
    // Space must reach the global play/pause handler, never toggle the step
    // (even with the step focused after a click or Tab).
    fireEvent.keyDown(step, { key: " " });
    expect(services.store.execute).not.toHaveBeenCalled();
    fireEvent.keyDown(step, { key: "Enter" });
    expect(services.store.execute).toHaveBeenCalledTimes(1);
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

describe("Sequencer — velocity actions must be honest about an all-silence selection (defect 20)", () => {
  const selection = { padIds: ["pad-a"], from: 0, to: 7 };
  // The step toolbar's HUMAN and the note lane's HUMAN carry the same visible
  // label, so they are told apart by title — "selected step" vs "selected note".
  const STEP_RND = "Randomize velocities of the selected active steps (silence stays silent)";
  const STEP_HUMAN = "Humanize — nudge selected step velocities ±12% so the groove breathes";

  function docWithRows(row: number[]) {
    const doc = createProjectFromTemplate("house");
    doc.patterns[0].rows = { "pad-a": row };
    return doc;
  }

  it("disables RND VEL and HUMAN when the selection holds only silence, and enables them once a step is active", () => {
    // Both handlers built their target list from the selection and returned
    // early when it was empty, with no `disabled` to match — so the buttons
    // accepted clicks that produced no command, no error and no visual
    // change. PASTE LOCKS in the same toolbar already carries that contract
    // (`disabled={!lockClipboard || …}`), so these two were the odd ones out.
    const silent = renderWithContext(<Sequencer {...defaultProps} stepSelection={selection} />, {
      services: mockServices(docWithRows(new Array(16).fill(0))),
    });
    expect(within(silent.container).getByTitle(STEP_RND)).toBeDisabled();
    expect(within(silent.container).getByTitle(STEP_HUMAN)).toBeDisabled();
    silent.unmount();

    // Positive control: one active step inside the same selection makes both
    // actionable again. Without this, an always-disabled button would pass.
    const row = new Array(16).fill(0);
    row[3] = 0.8;
    const active = renderWithContext(<Sequencer {...defaultProps} stepSelection={selection} />, {
      services: mockServices(docWithRows(row)),
    });
    expect(within(active.container).getByTitle(STEP_RND)).toBeEnabled();
    expect(within(active.container).getByTitle(STEP_HUMAN)).toBeEnabled();
  });

  it("renders and does not throw when nothing is selected at all", () => {
    // The memo that feeds `disabled` runs on every render, while the buttons
    // themselves sit behind `{stepSelection && …}`. A null selection must not
    // reach `.padIds`.
    expect(() =>
      renderWithContext(<Sequencer {...defaultProps} stepSelection={null} />, {
        services: mockServices(docWithRows(new Array(16).fill(0))),
      }),
    ).not.toThrow();
  });
});
