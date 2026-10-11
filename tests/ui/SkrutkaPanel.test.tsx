import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { SkrutkaPanel } from "../../src/ui/SkrutkaPanel";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";

/**
 * SkrutkaPanel — v2 curve editor + BAND SOLO audition.
 *
 * jsdom has no canvas implementation, so the draw path runs against a stub
 * 2D context (every method a no-op) while the drag commit and the
 * monitor-band contract are asserted on the mocks.
 */

function stub2dContext() {
  return new Proxy(
    {},
    {
      get() {
        return () => undefined;
      },
      set() {
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
}

function paramsOf(): Record<string, number> {
  return {
    dispersion: 0.5,
    punch: 0.3,
    punchHz: 0,
    punchMix: 1,
    focusHz: 220,
    shape: 0,
    spread: 0,
    dyn: 0,
    keyMode: 0,
    lfoRate: 0.5,
    lfoSync: 0,
    lfoShape: 0,
    lfoDepth: 0,
    mix: 1,
    output: 0,
  };
}

describe("SkrutkaPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("BAND SOLO drives the monitor band on/off and releases it on unmount", () => {
    const services = mockServices(createProjectFromTemplate("house"));
    const setMonitorBand = vi.fn();
    (services.engine as unknown as Record<string, unknown>).setMonitorBand = setMonitorBand;
    (services.engine as unknown as Record<string, unknown>).getFxMeters = vi.fn(() => null);

    const { unmount, container } = renderWithContext(
      <SkrutkaPanel trackId="t1" fxId="fx1" params={paramsOf()} degraded={false} />,
      { services },
    );
    vi.spyOn(container.querySelector("canvas")!, "getContext").mockReturnValue(stub2dContext());

    const button = screen.getByRole("button", { name: "BAND SOLO" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button);
    expect(setMonitorBand).toHaveBeenCalledWith(220);
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(setMonitorBand).toHaveBeenLastCalledWith(null);

    fireEvent.click(button);
    unmount();
    expect(setMonitorBand).toHaveBeenLastCalledWith(null);
  });

  it("dragging the curve commits focus + dispersion inside one undo frame", () => {
    const services = mockServices(createProjectFromTemplate("house"));
    (services.engine as unknown as Record<string, unknown>).getFxMeters = vi.fn(() => null);
    const onParam = vi.fn();
    const onGestureStart = vi.fn();
    const onGestureEnd = vi.fn();

    const { container } = renderWithContext(
      <SkrutkaPanel
        trackId="t1"
        fxId="fx1"
        params={paramsOf()}
        degraded={false}
        onParam={onParam}
        onGestureStart={onGestureStart}
        onGestureEnd={onGestureEnd}
      />,
      { services },
    );
    const canvas = container.querySelector("canvas")!;
    vi.spyOn(canvas, "getContext").mockReturnValue(stub2dContext());
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 300,
      bottom: 100,
      width: 300,
      height: 100,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.pointerDown(canvas, { clientX: 150, clientY: 30, pointerId: 1 });
    expect(onGestureStart).toHaveBeenCalledTimes(1);
    expect(onParam).toHaveBeenCalledWith("focusHz", expect.any(Number));
    expect(onParam).toHaveBeenCalledWith("dispersion", expect.any(Number));
    const focusCall = onParam.mock.calls.find((call) => call[0] === "focusHz")!;
    // x = 150/300 → geometric mean of the axis: 30 × (16000/30)^0.5 ≈ 693 Hz.
    expect(focusCall[1]).toBeGreaterThan(600);
    expect(focusCall[1]).toBeLessThan(800);

    fireEvent.pointerMove(canvas, { clientX: 200, clientY: 60, pointerId: 1 });
    const moves = onParam.mock.calls.filter((call) => call[0] === "focusHz").length;
    expect(moves).toBeGreaterThanOrEqual(2);

    fireEvent.pointerUp(canvas, { clientX: 200, clientY: 60, pointerId: 1 });
    expect(onGestureEnd).toHaveBeenCalledTimes(1);
  });

  it("renders the SHAPE / DYN / KEY / LFO state chips", () => {
    const services = mockServices(createProjectFromTemplate("house"));
    (services.engine as unknown as Record<string, unknown>).getFxMeters = vi.fn(() => null);
    renderWithContext(
      <SkrutkaPanel
        trackId="t1"
        fxId="fx1"
        params={{ ...paramsOf(), shape: 2, dyn: 0.5, keyMode: 1, lfoDepth: 0.4, lfoShape: 1 }}
        degraded={false}
      />,
      { services },
    );
    expect(screen.getByText("SHAPE DOUBLE")).toBeInTheDocument();
    expect(screen.getByText("DYN ATTACK 50%")).toBeInTheDocument();
    expect(screen.getByText("KEY PUMP")).toBeInTheDocument();
    expect(screen.getByText("LFO TRI 40%")).toBeInTheDocument();
  });
});
