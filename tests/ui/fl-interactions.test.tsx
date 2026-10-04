import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Slider, DragNumber } from "../../src/ui/controls";
import { StatusHint } from "../../src/ui/StatusHint";

/** Dispatch a REAL non-passive wheel event — the hook attaches a native
 *  listener precisely because React's synthetic wheel is passive. */
function wheel(el: Element, deltaY: number, ctrlKey = false) {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY, ctrlKey, cancelable: true, bubbles: true }));
}

describe("FL wheel adjust (ROADMAP-UI-2027 V3)", () => {
  afterEach(() => vi.useRealTimers());

  it("Slider: a wheel burst previews live and settles as ONE commit", async () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    const onPreview = vi.fn();
    render(
      <Slider label="TILT" value={0} min={-12} max={12} defaultValue={0} onCommit={onCommit} onPreview={onPreview} />,
    );
    const track = screen.getByRole("slider", { name: "TILT" });
    wheel(track, -100);
    wheel(track, -100);
    wheel(track, -100);
    // Preview is live during the burst, commit waits for the settle. The
    // preview rides a rAF — flushing the settle timer flushes it too.
    act(() => vi.advanceTimersByTime(400));
    expect(onPreview).toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledTimes(1);
    const settled = onCommit.mock.calls[0][0] as number;
    expect(settled).toBeGreaterThan(0);
    // Three coarse notches = +2% ratio each, from centre 0.50 → 0.56 of ±12.
    expect(settled).toBeCloseTo(0.56 * 24 - 12, 1);
  });

  it("Slider: Ctrl+wheel is the fine step (≈1/10th)", async () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    render(<Slider label="FINE" value={0} min={0} max={1} defaultValue={0.5} onCommit={onCommit} />);
    wheel(screen.getByRole("slider", { name: "FINE" }), -100, true);
    act(() => vi.advanceTimersByTime(400));
    const settled = onCommit.mock.calls[0][0] as number;
    expect(settled).toBeCloseTo(0.0025, 4);
  });

  it("Slider: wheel is inert while disabled", async () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    render(<Slider label="LOCKED" value={0.5} min={0} max={1} defaultValue={0.5} disabled onCommit={onCommit} />);
    wheel(screen.getByRole("slider", { name: "LOCKED" }), -100);
    act(() => vi.advanceTimersByTime(400));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("Slider: horizontal scrubs stay with scrolling (no value change)", async () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    render(<Slider label="PAN" value={0} min={-1} max={1} defaultValue={0} onCommit={onCommit} />);
    const track = screen.getByRole("slider", { name: "PAN" });
    track.dispatchEvent(new WheelEvent("wheel", { deltaX: 120, deltaY: 0, cancelable: true }));
    act(() => vi.advanceTimersByTime(400));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("DragNumber: wheel steps at the control's own resolution, once per burst", async () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    render(<DragNumber label="BPM" value={124} min={40} max={240} defaultValue={124} onCommit={onCommit} />);
    const spin = screen.getByRole("spinbutton", { name: "BPM" });
    wheel(spin, -100);
    wheel(spin, -100);
    act(() => vi.advanceTimersByTime(400));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toBeGreaterThan(124);
  });

  it("DragNumber: a burst landing back on the document value writes nothing", async () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    // Integer-resolution control (BPM): +1 notch then −1 notch lands back on
    // the document value — a round trip must not touch undo history.
    render(<DragNumber label="BPM" value={124} min={40} max={240} defaultValue={124} onCommit={onCommit} />);
    const spin = screen.getByRole("spinbutton", { name: "BPM" });
    wheel(spin, -100);
    wheel(spin, 100);
    act(() => vi.advanceTimersByTime(400));
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe("StatusHint (live hint bar)", () => {
  it("shows the hovered control's data-hint + value, falls back when nothing is hovered", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <StatusHint fallback={<span data-testid="fallback">STATIC</span>} />
        <div data-hint="TILT — tone tilt" data-hint-value="+3.0 dB">
          <button type="button">the control</button>
        </div>
      </div>,
    );
    expect(screen.getByTestId("fallback")).toBeInTheDocument();

    await user.hover(screen.getByRole("button", { name: "the control" }));
    expect(screen.getByText("TILT — tone tilt")).toBeInTheDocument();
    expect(screen.getByText("+3.0 dB")).toBeInTheDocument();
    expect(screen.queryByTestId("fallback")).not.toBeInTheDocument();

    await user.hover(document.body);
    expect(screen.getByTestId("fallback")).toBeInTheDocument();
  });

  it("Slider and DragNumber publish data-hint", () => {
    render(
      <div>
        <Slider label="TILT" value={3} min={-12} max={12} defaultValue={0} onCommit={() => {}} />
        <DragNumber label="BPM" value={124} min={40} max={240} defaultValue={124} onCommit={() => {}} />
      </div>,
    );
    const sliderHost = screen.getByRole("slider", { name: "TILT" }).closest(".slider");
    const spinHost = screen.getByRole("spinbutton", { name: "BPM" });
    expect(sliderHost?.getAttribute("data-hint")).toBe("TILT");
    expect(sliderHost?.getAttribute("data-hint-value")).toBe("3.00");
    expect(spinHost.getAttribute("data-hint")).toBe("BPM");
    expect(spinHost.getAttribute("data-hint-value")).toBe("124.0");
  });
});
