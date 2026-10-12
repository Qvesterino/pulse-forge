import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { SkrutkaPanel, skrutkaPanelSampleRate } from "../../src/ui/SkrutkaPanel";
import { skrutkaPeakDelay } from "../../src/effects/skrutka-curve";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { ServicesContext } from "../../src/ui/context";

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

  it("plots the processor's full effective curve for a RAND LFO and automated parameters", () => {
    const services = mockServices(createProjectFromTemplate("house"));
    const arc = vi.fn();
    const context = new Proxy(
      { arc },
      {
        get(target, property) {
          return property in target ? target[property as keyof typeof target] : () => undefined;
        },
        set() {
          return true;
        },
      },
    ) as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    (services.engine as unknown as Record<string, unknown>).getFxMeters = vi.fn(() => ({
      lfo: 0.25,
      focusHz: 1234,
      env: 0,
      key: 1,
      radius: 0.7,
      dispersion: 0.85,
      punch: -0.5,
      punchHz: 500,
      punchMix: 0.7,
      punchRadius: 0.4,
      shape: 2.5,
      spread: 0.35,
      field: 0.3,
      dyn: 0.4,
      dynPunch: -0.3,
      keyMode: 2,
      lfoDepth: 0.75,
      mix: 0.62,
      output: -2,
    }));

    const { container } = renderWithContext(
      <SkrutkaPanel
        trackId="t1"
        fxId="fx1"
        params={{ ...paramsOf(), focusHz: 400, lfoShape: 2, lfoDepth: 1 }}
        degraded={false}
      />,
      { services },
    );
    vi.advanceTimersByTime(66);

    const expectedX = (Math.log(1234 / 30) / Math.log(16_000 / 30)) * 200;
    expect(arc).toHaveBeenCalledTimes(2);
    expect(arc.mock.calls[0]?.[0]).toBeCloseTo(expectedX, 5);
    const expectedPeak = skrutkaPeakDelay(
      {
        dispersion: 0.85,
        punch: -0.5,
        punchHz: 500,
        punchMix: 0.7,
        focusHz: 1234,
        spread: 0.35,
        shape: 2.5,
        field: 0.3,
        mix: 0.62,
        output: -2,
      },
      48_000,
      "M",
      0.7,
      0.4,
    );
    expect(container.querySelector(".skrutka-readout")).toHaveTextContent(
      `WET +${expectedPeak.ms.toFixed(1)} ms @ ${Math.round(expectedPeak.freqHz)} Hz`,
    );
  });

  it("shows zero-delay and flat output when MIX is fully dry", () => {
    const services = mockServices(createProjectFromTemplate("house"));
    (services.engine as unknown as Record<string, unknown>).getFxMeters = vi.fn(() => null);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(stub2dContext());
    const { container } = renderWithContext(
      <SkrutkaPanel trackId="t1" fxId="fx1" params={{ ...paramsOf(), mix: 0 }} degraded={false} />,
      { services },
    );

    fireEvent.click(screen.getByRole("button", { name: "OUT DELAY" }));
    vi.advanceTimersByTime(66);
    expect(container.querySelector(".skrutka-readout")).toHaveTextContent("OUT — no delay hump");

    fireEvent.click(screen.getByRole("button", { name: "OUT LEVEL" }));
    vi.advanceTimersByTime(66);
    expect(container.querySelector(".skrutka-readout")).toHaveTextContent("OUT flat ±0.0 dB");
    expect(screen.getByRole("button", { name: "OUT LEVEL" })).toHaveAttribute("aria-pressed", "true");
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

  it("shows live DYNAMIC and KEY response and reports a missing KEY source", () => {
    const services = mockServices(createProjectFromTemplate("house"));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(stub2dContext());
    (services.engine as unknown as Record<string, unknown>).getFxMeters = vi.fn(() => ({
      lfo: 0.25,
      focusHz: 220,
      env: 0.62,
      key: 1.55,
      radius: 0.7,
      dispersion: 0.5,
      punch: 0.3,
      punchHz: 0,
      punchMix: 1,
      punchRadius: 0.28,
      shape: 0,
      spread: 0,
      field: 0,
      dyn: 0.5,
      dynPunch: 0,
      keyMode: 1,
      lfoDepth: 0,
      mix: 1,
      output: 0,
    }));

    const props = {
      trackId: "t1",
      fxId: "fx1",
      params: { ...paramsOf(), dyn: 0.5, keyMode: 1 },
      degraded: false,
      keySourceConnected: true,
    };
    const { rerender } = renderWithContext(<SkrutkaPanel {...props} />, { services });
    vi.advanceTimersByTime(66);

    expect(screen.getByRole("meter", { name: "DYNAMIC activity" })).toHaveAttribute("aria-valuenow", "62");
    expect(screen.getByRole("meter", { name: "KEY response" })).toHaveAttribute("aria-valuenow", "55");
    expect(screen.getByText("PUMP 55% · ×1.55")).toBeInTheDocument();

    rerender(
      <ServicesContext.Provider value={services}>
        <SkrutkaPanel {...props} keySourceConnected={false} />
      </ServicesContext.Provider>,
    );
    vi.advanceTimersByTime(66);
    expect(screen.getByText("NO SOURCE")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "KEY response" })).toHaveAttribute("aria-valuenow", "0");
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

  it("STORE A captures the rack params and re-seeds the live runtime", () => {
    const services = mockServices(createProjectFromTemplate("house"));
    const setCurves = vi.fn();
    (services.engine as unknown as Record<string, unknown>).getFxRuntime = vi.fn(() => ({ setCurves }));
    (services.engine as unknown as Record<string, unknown>).getFxMeters = vi.fn(() => null);
    const onCurvesStateChange = vi.fn();
    const { container } = renderWithContext(
      <SkrutkaPanel
        trackId="t1"
        fxId="fx1"
        params={{ ...paramsOf(), dispersion: 0.7 }}
        degraded={false}
        onParam={vi.fn()}
        onCurvesStateChange={onCurvesStateChange}
      />,
      { services },
    );
    vi.spyOn(container.querySelector("canvas")!, "getContext").mockReturnValue(stub2dContext());

    fireEvent.click(screen.getByRole("button", { name: "STORE A" }));
    expect(onCurvesStateChange).toHaveBeenCalledWith({
      slots: { A: expect.objectContaining({ dispersion: 0.7, focusHz: 220 }) },
    });
    expect(setCurves).toHaveBeenCalledWith(expect.objectContaining({ dispersion: 0.7 }), null);
  });

  it("re-seeds the live runtime when persisted curve state changes (undo/redo)", () => {
    const services = mockServices(createProjectFromTemplate("house"));
    const setCurves = vi.fn();
    (services.engine as unknown as Record<string, unknown>).getFxRuntime = vi.fn(() => ({ setCurves }));
    (services.engine as unknown as Record<string, unknown>).getFxMeters = vi.fn(() => null);
    const props = {
      trackId: "t1",
      fxId: "fx1",
      params: paramsOf(),
      degraded: false,
      onCurvesStateChange: vi.fn(),
    };
    const { rerender } = renderWithContext(
      <SkrutkaPanel {...props} deviceState={{ kind: "twist-curves-v1", data: { slots: { A: { focusHz: 100 } } } }} />,
      { services },
    );
    expect(setCurves).toHaveBeenLastCalledWith({ focusHz: 100 }, null);

    rerender(
      <ServicesContext.Provider value={services}>
        <SkrutkaPanel
          {...props}
          deviceState={{ kind: "twist-curves-v1", data: { slots: { A: { focusHz: 300 }, B: { focusHz: 900 } } } }}
        />
      </ServicesContext.Provider>,
    );
    expect(setCurves).toHaveBeenLastCalledWith({ focusHz: 300 }, { focusHz: 900 });
  });

  it("CLEAR forgets both curves and restores the runtime", () => {
    const services = mockServices(createProjectFromTemplate("house"));
    const setCurves = vi.fn();
    (services.engine as unknown as Record<string, unknown>).getFxRuntime = vi.fn(() => ({ setCurves }));
    (services.engine as unknown as Record<string, unknown>).getFxMeters = vi.fn(() => null);
    const onCurvesStateChange = vi.fn();
    const { container } = renderWithContext(
      <SkrutkaPanel
        trackId="t1"
        fxId="fx1"
        params={{ ...paramsOf(), morph: 0.5 }}
        degraded={false}
        deviceState={{ kind: "twist-curves-v1", data: { slots: { A: { focusHz: 100 }, B: { focusHz: 900 } } } }}
        onParam={vi.fn()}
        onCurvesStateChange={onCurvesStateChange}
      />,
      { services },
    );
    vi.spyOn(container.querySelector("canvas")!, "getContext").mockReturnValue(stub2dContext());

    fireEvent.click(screen.getByRole("button", { name: "CLEAR" }));
    expect(onCurvesStateChange).toHaveBeenCalledWith({ slots: {} });
    expect(setCurves).toHaveBeenCalledWith(null, null);
  });

  it("reports the MORPH mode chip and the morph slider only with stored curves", () => {
    const services = mockServices(createProjectFromTemplate("house"));
    (services.engine as unknown as Record<string, unknown>).getFxMeters = vi.fn(() => null);
    const { unmount } = renderWithContext(
      <SkrutkaPanel
        trackId="t1"
        fxId="fx1"
        params={{ ...paramsOf(), morph: 0.4 }}
        degraded={false}
        deviceState={{ kind: "twist-curves-v1", data: { slots: { A: { focusHz: 100 }, B: { focusHz: 900 } } } }}
        onParam={vi.fn()}
      />,
      { services },
    );
    expect(screen.getByText("MORPH 40% A→B")).toBeInTheDocument();
    const slider = screen.getByLabelText("Curve morph") as HTMLInputElement;
    expect(slider.disabled).toBe(false);
    unmount();

    renderWithContext(<SkrutkaPanel trackId="t1" fxId="fx1" params={paramsOf()} degraded={false} onParam={vi.fn()} />, {
      services,
    });
    expect(screen.getByText("MORPH OFF")).toBeInTheDocument();
    expect((screen.getByLabelText("Curve morph") as HTMLInputElement).disabled).toBe(true);
  });

  it("applies a scene pack pair from the select and shows the SCENE-INTENSITY chip", () => {
    const services = mockServices(createProjectFromTemplate("house"));
    const setCurves = vi.fn();
    (services.engine as unknown as Record<string, unknown>).getFxRuntime = vi.fn(() => ({ setCurves }));
    (services.engine as unknown as Record<string, unknown>).getFxMeters = vi.fn(() => null);
    const onApplyScenePair = vi.fn();
    const { container } = renderWithContext(
      <SkrutkaPanel
        trackId="t1"
        fxId="fx1"
        params={{ ...paramsOf(), morph: 0 }}
        degraded={false}
        sceneBound
        onParam={vi.fn()}
        onApplyScenePair={onApplyScenePair}
      />,
      { services },
    );
    vi.spyOn(container.querySelector("canvas")!, "getContext").mockReturnValue(stub2dContext());

    expect(screen.getByText("SCENE-INTENSITY")).toBeInTheDocument();
    expect(screen.getByText("House — Tight → Liquid")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Scene pack"), { target: { value: "house-tight-liquid" } });
    expect(onApplyScenePair).toHaveBeenCalledWith(expect.objectContaining({ id: "house-tight-liquid" }));
    const call = setCurves.mock.calls.at(-1)!;
    expect(call[0].focusHz).toBe(250);
    expect(call[1].focusHz).toBe(900);
  });

  it("shows CUSTOM when the stored slots do not match any pack pair", () => {
    const services = mockServices(createProjectFromTemplate("house"));
    (services.engine as unknown as Record<string, unknown>).getFxMeters = vi.fn(() => null);
    renderWithContext(
      <SkrutkaPanel
        trackId="t1"
        fxId="fx1"
        params={paramsOf()}
        degraded={false}
        deviceState={{ kind: "twist-curves-v1", data: { slots: { A: { focusHz: 123 }, B: { focusHz: 456 } } } }}
        onParam={vi.fn()}
        onApplyScenePair={vi.fn()}
      />,
      { services },
    );
    expect(screen.getByText("CUSTOM")).toBeInTheDocument();
  });
});
