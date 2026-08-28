import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Slider, DragNumber } from "../../src/ui/controls";

describe("Slider", () => {
  it("renders label and value", () => {
    render(<Slider label="Volume" value={0.5} min={0} max={1} defaultValue={0.5} onCommit={vi.fn()} />);
    expect(screen.getByText("Volume")).toBeInTheDocument();
    expect(screen.getByText("0.50")).toBeInTheDocument();
  });

  it("has correct aria attributes", () => {
    render(<Slider label="Pan" value={0} min={-1} max={1} defaultValue={0} onCommit={vi.fn()} />);
    const slider = screen.getByRole("slider");
    expect(slider).toHaveAttribute("aria-label", "Pan");
    expect(slider).toHaveAttribute("aria-valuemin", "-1");
    expect(slider).toHaveAttribute("aria-valuemax", "1");
    expect(slider).toHaveAttribute("aria-valuenow", "0");
  });

  it("calls onCommit with default on double-click", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Slider label="X" value={0.8} min={0} max={1} defaultValue={0.5} onCommit={onCommit} />);
    await user.dblClick(screen.getByRole("slider"));
    expect(onCommit).toHaveBeenCalledWith(0.5);
  });

  it("formats value with custom format", () => {
    render(
      <Slider
        label="dB"
        value={-6}
        min={-48}
        max={6}
        defaultValue={0}
        format={(v) => `${v.toFixed(1)} dB`}
        onCommit={vi.fn()}
      />,
    );
    expect(screen.getByText("-6.0 dB")).toBeInTheDocument();
  });

  it("disables interaction when disabled prop is true", () => {
    render(<Slider label="X" value={0.5} min={0} max={1} defaultValue={0.5} onCommit={vi.fn()} disabled />);
    const slider = screen.getByRole("slider");
    expect(slider).toHaveAttribute("tabindex", "-1");
  });
});

describe("DragNumber", () => {
  it("renders label and value", () => {
    render(<DragNumber value={120} min={20} max={300} defaultValue={120} label="BPM" onCommit={vi.fn()} />);
    expect(screen.getByText("BPM")).toBeInTheDocument();
    expect(screen.getByText("120.0")).toBeInTheDocument();
  });

  it("has correct aria attributes", () => {
    render(<DragNumber value={120} min={20} max={300} defaultValue={120} label="BPM" onCommit={vi.fn()} />);
    const el = screen.getByRole("spinbutton");
    expect(el).toHaveAttribute("aria-label", "BPM");
    expect(el).toHaveAttribute("aria-valuemin", "20");
    expect(el).toHaveAttribute("aria-valuemax", "300");
    expect(el).toHaveAttribute("aria-valuenow", "120");
  });

  it("calls onCommit with default on double-click", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<DragNumber value={140} min={20} max={300} defaultValue={120} label="BPM" onCommit={onCommit} />);
    await user.dblClick(screen.getByRole("spinbutton"));
    expect(onCommit).toHaveBeenCalledWith(120);
  });

  it("increments on ArrowUp", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<DragNumber value={120} min={20} max={300} defaultValue={120} label="BPM" onCommit={onCommit} />);
    await user.click(screen.getByRole("spinbutton"));
    await user.keyboard("{ArrowUp}");
    expect(onCommit).toHaveBeenCalledWith(121);
  });

  it("decrements on ArrowDown", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<DragNumber value={120} min={20} max={300} defaultValue={120} label="BPM" onCommit={onCommit} />);
    await user.click(screen.getByRole("spinbutton"));
    await user.keyboard("{ArrowDown}");
    expect(onCommit).toHaveBeenCalledWith(119);
  });

  it("clamps to min/max", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<DragNumber value={299} min={20} max={300} defaultValue={120} label="BPM" onCommit={onCommit} />);
    await user.click(screen.getByRole("spinbutton"));
    await user.keyboard("{ArrowUp}");
    expect(onCommit).toHaveBeenCalledWith(300);
  });

  it("formats value with custom format", () => {
    render(
      <DragNumber
        value={120}
        min={20}
        max={300}
        defaultValue={120}
        format={(v) => `${v} BPM`}
        label="BPM"
        onCommit={vi.fn()}
      />,
    );
    expect(screen.getByText("120 BPM")).toBeInTheDocument();
  });
});
