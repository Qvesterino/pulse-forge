import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { SkrutkaPanel, skrutkaPanelSampleRate } from "../../src/ui/SkrutkaPanel";
import { skrutkaPeakDelay } from "../../src/effects/skrutka-curve";
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
    field: 0,
    dyn: 0,
    dynPunch: 0,
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

  it("uses the live audio rate for the curve and falls back only for invalid hosts", () => {
    expect(skrutkaPanelSampleRate(44_100)).toBe(44_100);
    expect(skrutkaPanelSampleRate(96_000)).toBe(96_000);
    expect(skrutkaPanelSampleRate(null)).toBe(48_000);
    expect(skrutkaPanelSampleRate(Number.NaN)).toBe(48_000);
    expect(skrutkaPanelSampleRate(0)).toBe(48_000);
  });

  it("draws the delay readout using the active audio context sample rate", () => {
    const services = mockServices(createProjectFromTemplate("house"));
    const liveContextSpy = vi
      .spyOn(services.engine, "getLiveAudioContext")
      .mockReturnValue({ sampleRate: 44_100 } as AudioContext);
    const canvasSpy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(stub2dContext());
    const params = paramsOf();
    const cp = {
      dispersion: params.dispersion!,
      punch: params.punch!,
      punchHz: params.punchHz!,
      punchMix: params.punchMix!,
      focusHz: params.focusHz!,
      spread: params.spread!,
      shape: params.shape!,
      field: params.field!,
    };

    const { container } = renderWithContext(<SkrutkaPanel trackId="t1" fxId="fx1" params={params} degraded={false} />, {
      services,
    });
    const peak44100 = skrutkaPeakDelay(cp, 44_100, "L");
    const peak48000 = skrutkaPeakDelay(cp, 48_000, "L");
    expect(peak44100.ms).not.toBe(peak48000.ms);
    expect(container.querySelector(".skrutka-readout")).toHaveTextContent(
      `+${peak44100.ms.toFixed(1)} ms @ ${Math.round(peak44100.freqHz)} Hz`,
    );

    canvasSpy.mockRestore();
    liveContextSpy.mockRestore();
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

  it("renders the SHAPE / FIELD / DYN / KEY / LFO state chips", () => {
    const services = mockServices(createProjectFromTemplate("house"));
    (services.engine as unknown as Record<string, unknown>).getFxMeters = vi.fn(() => null);
    renderWithContext(
      <SkrutkaPanel
        trackId="t1"
        fxId="fx1"
        params={{ ...paramsOf(), shape: 2, field: 0.6, dyn: 0.5, keyMode: 1, lfoDepth: 0.4, lfoShape: 1 }}
        degraded={false}
      />,
      { services },
    );
    expect(screen.getByText("SHAPE DOUBLE")).toBeInTheDocument();
    expect(screen.getByText("FIELD 60% SIDE")).toBeInTheDocument();
    expect(screen.getByText("DYN ATTACK 50%")).toBeInTheDocument();
    expect(screen.getByText("PUNCH-DYN OFF")).toBeInTheDocument();
    expect(screen.getByText("KEY PUMP")).toBeInTheDocument();
    expect(screen.getByText("LFO TRI 40%")).toBeInTheDocument();
  });

  it("shows FIELD STEREO / MID variants for the neutral and negative field", () => {
    const services = mockServices(createProjectFromTemplate("house"));
    (services.engine as unknown as Record<string, unknown>).getFxMeters = vi.fn(() => null);
    renderWithContext(<SkrutkaPanel trackId="t1" fxId="fx1" params={paramsOf()} degraded={false} />, { services });
    expect(screen.getByText("FIELD STEREO")).toBeInTheDocument();
    cleanup();
    renderWithContext(
      <SkrutkaPanel trackId="t1" fxId="fx1" params={{ ...paramsOf(), field: -0.6 }} degraded={false} />,
      { services },
    );
    expect(screen.getByText("FIELD 60% MID")).toBeInTheDocument();
  });
});
