import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { KorenPanel } from "../../src/ui/KorenPanel";
import { KOREN_SCENE_PACK, korenSceneSlots } from "../../src/effects/koren-scene-pack";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";

/**
 * KorenPanel — live f0/harmonics readout + PHONE CHECK audition toggle.
 *
 * jsdom has no canvas implementation, so the draw path runs against a stub
 * 2D context (every method a no-op) while the telemetry readouts and the
 * monitor-filter contract are asserted on the mock engine.
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

describe("KorenPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("shows telemetry readouts and drives the monitor filter with PHONE CHECK", () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    const setMonitorHighpass = vi.fn();
    (services.engine as unknown as Record<string, unknown>).setMonitorHighpass = setMonitorHighpass;
    (services.engine as unknown as Record<string, unknown>).getFxMeters = vi.fn(() => ({
      f0: 55,
      clarity: 0.95,
      harm: 14.2,
      key: 1,
      partials: Float32Array.from([0.4, 0.1, 0.02]),
    }));

    const { unmount, container } = renderWithContext(
      <KorenPanel trackId="t1" fxId="fx1" params={{ focusHz: 60 }} degraded={false} />,
      { services },
    );
    const canvas = container.querySelector("canvas");
    expect(canvas).not.toBeNull();
    vi.spyOn(canvas!, "getContext").mockReturnValue(stub2dContext());

    vi.advanceTimersByTime(200);
    expect(screen.getByText("55.0 Hz")).toBeInTheDocument();
    expect(screen.getByText("+14.2 dB harmonics")).toBeInTheDocument();

    const button = screen.getByRole("button", { name: "PHONE CHECK" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button);
    expect(setMonitorHighpass).toHaveBeenCalledWith(350);
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(setMonitorHighpass).toHaveBeenLastCalledWith(null);

    unmount();
    // Unmount must never leave the audition filter on the monitor path.
    expect(setMonitorHighpass).toHaveBeenLastCalledWith(null);
  });

  it("shows the degraded notice while the worklet module has not landed", () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    (services.engine as unknown as Record<string, unknown>).getFxMeters = vi.fn(() => null);
    renderWithContext(<KorenPanel trackId="t1" fxId="fx1" params={{ focusHz: 90 }} degraded={true} />, { services });
    expect(screen.getByText(/GROW is bypassed/)).toBeInTheDocument();
    expect(screen.getByText("— Hz")).toBeInTheDocument();
  });

  it("applies a scene pack pair from the select and shows the SCENE-INTENSITY chip", () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    (services.engine as unknown as Record<string, unknown>).getFxMeters = vi.fn(() => null);
    const onApplyScenePair = vi.fn();
    renderWithContext(
      <KorenPanel
        trackId="t1"
        fxId="fx1"
        params={{ focusHz: 90 }}
        degraded={false}
        sceneBound
        onApplyScenePair={onApplyScenePair}
      />,
      { services },
    );
    expect(screen.getByText("SCENE-INTENSITY")).toBeInTheDocument();
    expect(screen.getByText("Drill — Phone → Growl")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Scene pack"), { target: { value: "drill-phone-growl" } });
    expect(onApplyScenePair).toHaveBeenCalledWith(expect.objectContaining({ id: "drill-phone-growl" }));
  });

  it("resolves the stored slots to the matching pair and falls back to CUSTOM", () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    (services.engine as unknown as Record<string, unknown>).getFxMeters = vi.fn(() => null);
    const pair = KOREN_SCENE_PACK.find((candidate) => candidate.id === "techno-rolling-drone")!;
    const { unmount } = renderWithContext(
      <KorenPanel
        trackId="t1"
        fxId="fx1"
        params={pair.a}
        degraded={false}
        deviceState={{ kind: "koren-scene-v1", data: { slots: korenSceneSlots(pair) } }}
        onApplyScenePair={vi.fn()}
      />,
      { services },
    );
    expect((screen.getByLabelText("Scene pack") as HTMLSelectElement).value).toBe("techno-rolling-drone");
    unmount();

    renderWithContext(
      <KorenPanel
        trackId="t1"
        fxId="fx1"
        params={{ focusHz: 90 }}
        degraded={false}
        deviceState={{ kind: "koren-scene-v1", data: { slots: { A: { drive: 0.1 }, B: { drive: 0.9 } } } }}
        onApplyScenePair={vi.fn()}
      />,
      { services },
    );
    expect((screen.getByLabelText("Scene pack") as HTMLSelectElement).value).toBe("");
    expect(screen.getByText("CUSTOM")).toBeInTheDocument();
  });
});
