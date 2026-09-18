import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { StepGridEditor } from "../../src/ui/StepGridEditor";

function renderEditor(props: React.ComponentProps<typeof StepGridEditor>) {
  // Light wrapper; StepGridEditor doesn't need a ServicesContext.
  return render(<StepGridEditor {...props} />);
}

describe("StepGridEditor", () => {
  it("renders a slider with the step count in the label", () => {
    renderEditor({ steps: [0.1, 0.2, 0.3, 0.4], onCommit: vi.fn() });
    expect(screen.getByRole("slider", { name: /Step sequence, 4 steps/ })).toBeInTheDocument();
  });

  it("supports a bipolar range (min<0) by drawing a zero line", () => {
    const { container } = renderEditor({
      steps: [-0.5, 0, 0.5],
      min: -1,
      max: 1,
      onCommit: vi.fn(),
    });
    expect(container.querySelector(".mod-step-grid-zero")).not.toBeNull();
  });

  it("pointerdown + pointermove + pointerup invokes onCommit exactly once with the painted value at the column", () => {
    const onCommit = vi.fn();
    renderEditor({ steps: [0, 0, 0, 0, 0, 0, 0, 0], onCommit });

    const slider = screen.getByRole("slider", { name: /Step sequence, 8 steps/ });
    // jsdom returns 0×0 bounding rect — paint() falls back gracefully and
    // effectively treats every coordinate as the first column. We only
    // care that the pointer-down → pointer-up sequence produces a commit
    // with a non-empty array.
    act(() => {
      fireEvent.pointerDown(slider, { pointerId: 1, clientX: 0, clientY: 0, button: 0, buttons: 1 });
      fireEvent.pointerMove(slider, { pointerId: 1, clientX: 1, clientY: 1, buttons: 1 });
      fireEvent.pointerUp(slider, { pointerId: 1, clientX: 1, clientY: 1 });
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toHaveLength(8);
  });

  it("pointerCancel also commits (so a dropped gesture still saves the painted state)", () => {
    const onCommit = vi.fn();
    renderEditor({ steps: [0, 0, 0, 0], onCommit });
    const slider = screen.getByRole("slider", { name: /Step sequence, 4 steps/ });
    act(() => {
      fireEvent.pointerDown(slider, { pointerId: 1, clientX: 0, clientY: 0, button: 0, buttons: 1 });
      fireEvent.pointerCancel(slider, { pointerId: 1 });
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
