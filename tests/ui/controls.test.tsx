import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Slider, DragNumber, dragNumberResolution } from "../../src/ui/controls";

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

  it("stays inert on every gesture while disabled — no document write", async () => {
    // A disabled slider must not mutate state through ANY of its gesture
    // paths. Before the audit, double-click reset and the right-click value
    // menu both bypassed the disabled flag, so a control rendered greyed out
    // still wrote to the project on double-click.
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Slider label="CHANCE" value={0.25} min={0} max={1} defaultValue={1} onCommit={onCommit} disabled />);
    const track = screen.getByRole("slider", { name: "CHANCE" });
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

    // 1. drag (pointer) — must not move or commit
    fireEvent.pointerDown(track, { button: 0, clientX: 80, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 90, pointerId: 1 });
    fireEvent.pointerUp(track, { pointerId: 1 });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText("0.25")).toBeInTheDocument();

    // 2. double-click reset — must not write the default
    await user.dblClick(track);
    expect(onCommit).not.toHaveBeenCalled();

    // 3. arrow keys — must not write
    fireEvent.keyDown(track, { key: "ArrowRight" });
    fireEvent.keyDown(track, { key: "ArrowUp" });
    expect(onCommit).not.toHaveBeenCalled();

    // 4. context menu — must not open (no "Type value…" affordance at all)
    fireEvent.contextMenu(track, { clientX: 10, clientY: 10 });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByText("Reset to default (1)")).not.toBeInTheDocument();
    expect(screen.queryByText("Type value…")).not.toBeInTheDocument();
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

describe("DragNumber resolution on sub-unit ranges (audit: fine controls that could not move)", () => {
  // HUMANIZE / VEL·RND / GATE in MidiPanel: 0..0.5 and 0.01..1, drag sensitivity
  // 0.005 per pixel, 2-decimal display. The old hardcoded 1-decimal quantisation
  // and hardcoded ±1 arrow step made these unusable.

  it("derives a step that is a fraction of a sub-unit range", () => {
    expect(dragNumberResolution(0, 0.5).step).toBeCloseTo(0.005, 6);
    expect(dragNumberResolution(0.01, 1).step).toBeCloseTo(0.0099, 6);
    // Ranges of a unit or more keep the historical 1-unit step (BPM 120 → 121).
    expect(dragNumberResolution(20, 300).step).toBe(1);
  });

  it("keeps 1 decimal for unit-scale ranges and adds precision for sub-unit ranges", () => {
    expect(dragNumberResolution(20, 300).decimals).toBe(1);
    expect(dragNumberResolution(0, 0.5).decimals).toBeGreaterThanOrEqual(2);
    expect(dragNumberResolution(0.01, 1).decimals).toBeGreaterThanOrEqual(2);
  });

  it("honours an explicit step override", () => {
    expect(dragNumberResolution(0, 100, 0.25).step).toBe(0.25);
    // A non-positive / non-finite override falls back to the derived step.
    expect(dragNumberResolution(0, 100, 0).step).toBe(1);
    expect(dragNumberResolution(0, 100, Number.NaN).step).toBe(1);
  });

  it("degenerate range does not produce NaN/Infinity", () => {
    expect(dragNumberResolution(5, 5)).toEqual({ step: 1, decimals: 1 });
    expect(dragNumberResolution(Number.NaN, 1).step).toBe(1);
  });

  it("arrow key nudges a fraction of the range instead of slamming to the end stop", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <DragNumber
        value={0.1}
        min={0}
        max={0.5}
        defaultValue={0.1}
        sensitivity={0.005}
        format={(v) => `±${v.toFixed(2)}`}
        label="HUMANIZE"
        onCommit={onCommit}
      />,
    );
    const control = screen.getByRole("spinbutton");
    // Focus without a pointer gesture: DragNumber intentionally commits a
    // pointer interaction on release, so a click would add an unrelated call.
    act(() => control.focus());
    await user.keyboard("{ArrowUp}");
    // Old behaviour: 0.1 + 1 = 1.1 clamped to max 0.5 (the entire range in one press).
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [committed] = onCommit.mock.calls[0];
    expect(committed).toBeGreaterThan(0.1);
    expect(committed).toBeLessThan(0.5);
    onCommit.mockClear();
    await user.keyboard("{ArrowDown}");
    const [back] = onCommit.mock.calls[0];
    expect(back).toBeLessThan(0.1);
    expect(back).toBeGreaterThanOrEqual(0);
  });

  it("a one-pixel drag is no longer a dead zone", () => {
    const onCommit = vi.fn();
    render(
      <DragNumber
        value={0.1}
        min={0}
        max={0.5}
        defaultValue={0.1}
        sensitivity={0.005}
        label="HUMANIZE"
        onCommit={onCommit}
      />,
    );
    const el = screen.getByRole("spinbutton");
    fireEvent.pointerDown(el, { button: 0, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(el, { clientY: 99, pointerId: 1 }); // 1px up = +0.005
    fireEvent.pointerUp(el, { pointerId: 1 });
    // Old behaviour: 0.105 quantised to 0.1 — a dead pixel, no change at all.
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [committed] = onCommit.mock.calls[0];
    expect(committed).toBeGreaterThan(0.1);
  });

  it("a drag still commits exactly once, on release", () => {
    const onCommit = vi.fn();
    render(
      <DragNumber
        value={0.1}
        min={0}
        max={0.5}
        defaultValue={0.1}
        sensitivity={0.005}
        label="HUMANIZE"
        onCommit={onCommit}
      />,
    );
    const el = screen.getByRole("spinbutton");
    fireEvent.pointerDown(el, { button: 0, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(el, { clientY: 80, pointerId: 1 });
    fireEvent.pointerMove(el, { clientY: 60, pointerId: 1 });
    expect(onCommit).not.toHaveBeenCalled(); // preview only — no document write mid-drag
    fireEvent.pointerUp(el, { pointerId: 1 });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("unit-scale behaviour is unchanged (BPM arrow step stays 1)", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<DragNumber value={120} min={20} max={300} defaultValue={120} label="BPM" onCommit={onCommit} />);
    await user.click(screen.getByRole("spinbutton"));
    await user.keyboard("{ArrowUp}");
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(121);
  });

  it("a plain click without movement writes nothing (no no-op undo entry)", () => {
    const onCommit = vi.fn();
    render(<DragNumber value={0.1} min={0} max={0.5} defaultValue={0.1} label="HUMANIZE" onCommit={onCommit} />);
    const el = screen.getByRole("spinbutton");
    // Old behaviour: pointerdown+pointerup with zero movement committed the
    // unchanged value, so every click pushed a no-op command into history.
    fireEvent.pointerDown(el, { button: 0, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(el, { pointerId: 1 });
    expect(onCommit).not.toHaveBeenCalled();
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
      <Slider
        label="PREVIEW_GAIN"
        value={0}
        min={-24}
        max={24}
        defaultValue={0}
        onCommit={onCommit}
        onPreview={onPreview}
      />,
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
      <Slider
        label="PREVIEW_MIX"
        value={50}
        min={0}
        max={100}
        defaultValue={100}
        onCommit={onCommit}
        onPreview={onPreview}
      />,
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
