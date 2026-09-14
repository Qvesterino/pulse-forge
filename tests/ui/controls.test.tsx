import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("allows precise typed entry, including decimal comma, and clamps it", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<DragNumber value={120} min={20} max={300} defaultValue={120} label="BPM" onCommit={onCommit} />);
    fireEvent.keyDown(screen.getByRole("spinbutton"), { key: "Enter" });
    const input = screen.getByRole("textbox", { name: "BPM value" });
    await user.clear(input);
    await user.type(input, "301,5");
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledWith(300);
  });

  it("cancels typed entry with Escape without committing", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<DragNumber value={120} min={20} max={300} defaultValue={120} label="BPM" onCommit={onCommit} />);
    fireEvent.keyDown(screen.getByRole("spinbutton"), { key: "Enter" });
    const input = screen.getByRole("textbox", { name: "BPM value" });
    await user.clear(input);
    await user.type(input, "180");
    await user.keyboard("{Escape}");
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText("120.0")).toBeInTheDocument();
  });
});

describe("interrupted drags (pointercancel)", () => {
  const domRect = (left: number, width: number, height = 10) =>
    ({
      left,
      top: 0,
      width,
      height,
      right: left + width,
      bottom: height,
      x: left,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;

  it("Slider aborts without committing and reverts the display", () => {
    const onCommit = vi.fn();
    render(<Slider label="X" value={0.5} min={0} max={1} defaultValue={0.5} onCommit={onCommit} />);
    const slider = screen.getByRole("slider");
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue(domRect(0, 100));
    fireEvent.pointerDown(slider, { button: 0, clientX: 50, pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: 90, pointerId: 1 });
    expect(screen.getByText("0.90")).toBeInTheDocument(); // drag preview followed the pointer
    fireEvent.pointerCancel(slider, { pointerId: 1 });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText("0.50")).toBeInTheDocument(); // display reverted
    // A stale pointerup after the cancel must not commit the aborted drag.
    fireEvent.pointerUp(slider, { pointerId: 1 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("Slider still commits a completed drag after a previous cancel", () => {
    const onCommit = vi.fn();
    render(<Slider label="X" value={0.5} min={0} max={1} defaultValue={0.5} onCommit={onCommit} />);
    const slider = screen.getByRole("slider");
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue(domRect(0, 100));
    fireEvent.pointerDown(slider, { button: 0, clientX: 50, pointerId: 1 });
    fireEvent.pointerCancel(slider, { pointerId: 1 });
    fireEvent.pointerDown(slider, { button: 0, clientX: 50, pointerId: 2 });
    fireEvent.pointerUp(slider, { pointerId: 2 });
    expect(onCommit).toHaveBeenCalledWith(0.5);
  });

  it("DragNumber aborts without committing and reverts the display", () => {
    const onCommit = vi.fn();
    render(<DragNumber value={120} min={20} max={300} defaultValue={120} label="BPM" onCommit={onCommit} />);
    const el = screen.getByRole("spinbutton");
    fireEvent.pointerDown(el, { button: 0, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(el, { clientY: 50, pointerId: 1 }); // 50px up × 0.4 → +20
    expect(screen.getByText("140.0")).toBeInTheDocument();
    fireEvent.pointerCancel(el, { pointerId: 1 });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText("120.0")).toBeInTheDocument();
    fireEvent.pointerUp(el, { pointerId: 1 });
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe("Slider onPreview (live drag, roadmap phase U2)", () => {
  const flushFrame = () => waitFor(() => {}, { timeout: 40 });

  it("previews during drag and commits exactly once on release", async () => {
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    render(
      <Slider label="PREVIEW_GAIN" value={0} min={-24} max={24} defaultValue={0} onCommit={onCommit} onPreview={onPreview} />,
    );
    const track = screen.getByRole("slider", { name: "PREVIEW_GAIN" });
    fireEvent.pointerDown(track, { button: 0, clientX: 60, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 80, pointerId: 1 });
    // rAF is stubbed as setTimeout(16) — wait a real frame BEFORE pointer-up
    // so the coalesced preview actually fires (pointer-up cancels a pending one).
    await act(() => new Promise((r) => setTimeout(r, 30)));
    fireEvent.pointerUp(track, { pointerId: 1 });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenCalled();
    for (const [v] of onPreview.mock.calls) {
      expect(v).toBeGreaterThanOrEqual(-24);
      expect(v).toBeLessThanOrEqual(24);
    }
  });

  it("an aborted drag (pointercancel) never commits", async () => {
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    render(
      <Slider label="PREVIEW_MIX" value={50} min={0} max={100} defaultValue={100} onCommit={onCommit} onPreview={onPreview} />,
    );
    const track = screen.getByRole("slider", { name: "PREVIEW_MIX" });
    fireEvent.pointerDown(track, { button: 0, clientX: 30, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 45, pointerId: 1 });
    fireEvent.pointerCancel(track, { pointerId: 1 });
    await flushFrame();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("works without onPreview (plain commit-only usage)", () => {
    const onCommit = vi.fn();
    render(<Slider label="PREVIEW_PAN" value={0} min={-1} max={1} defaultValue={0} onCommit={onCommit} />);
    const track = screen.getByRole("slider", { name: "PREVIEW_PAN" });
    fireEvent.pointerDown(track, { button: 0, clientX: 10, pointerId: 1 });
    fireEvent.pointerUp(track, { pointerId: 1 });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
