import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { KaskadaPanel } from "../../src/ui/KaskadaPanel";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";

/**
 * KaskadaPanel — dual-spectrum display for the Kaskáda delay.
 *
 * jsdom has no canvas implementation, so the draw path is exercised with a
 * stub 2D context (every method a no-op) — enough to run the real band
 * polyline/EQ-response math against real meter frames. The gating contract
 * (engine enables analysis on mount, disables on unmount) is asserted on
 * the mock engine, mirroring the UltinaPanel consumer pattern.
 */

function stub2dContext() {
  const gradient = { addColorStop: () => undefined };
  return new Proxy(
    {
      createLinearGradient: () => gradient,
    },
    {
      get(target, prop) {
        if (prop in target) return target[prop as keyof typeof target];
        return () => undefined;
      },
      set() {
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
}

function frameOf(fill: (dry: Float32Array, wet: Float32Array) => void): Float32Array {
  const frame = new Float32Array(144).fill(-90);
  fill(frame.subarray(0, 72), frame.subarray(72));
  return frame;
}

describe("KaskadaPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("renders the legend and canvas, and gates engine metering on mount", () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    const setFxMetersEnabled = vi.fn();
    (services.engine as unknown as Record<string, unknown>).setFxMetersEnabled = setFxMetersEnabled;
    (services.engine as unknown as Record<string, unknown>).getFxMeters = vi.fn(() => null);

    const { unmount } = renderWithContext(
      <KaskadaPanel trackId="t1" fxId="fx1" params={{ toneLp: 4500, toneHp: 150 }} degraded={false} />,
      { services },
    );
    expect(screen.getByText("SPECTRUM")).toBeInTheDocument();
    expect(screen.getByText("DRY")).toBeInTheDocument();
    expect(screen.getByText("DELAY")).toBeInTheDocument();
    expect(screen.getByText("LOOP EQ")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Kaskáda dual spectrum/ })).toBeInTheDocument();
    expect(setFxMetersEnabled).toHaveBeenCalledWith("t1", "fx1", true);
    unmount();
    expect(setFxMetersEnabled).toHaveBeenCalledWith("t1", "fx1", false);
  });

  it("paints real meter frames without crashing (draw path + EQ overlay)", () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    (services.engine as unknown as Record<string, unknown>).setFxMetersEnabled = vi.fn();
    (services.engine as unknown as Record<string, unknown>).getFxMeters = vi.fn(() =>
      frameOf((dry, wet) => {
        dry[40] = -3; // 1 kHz tone on the input
        wet[40] = -8; // echo of the same tone
      }),
    );

    const { container } = renderWithContext(
      <KaskadaPanel trackId="t1" fxId="fx1" params={{ toneLp: 4500, toneHp: 150 }} degraded={false} />,
      { services },
    );
    const canvas = container.querySelector("canvas");
    expect(canvas).not.toBeNull();
    vi.spyOn(canvas!, "getContext").mockReturnValue(stub2dContext());

    // Both the initial rAF paint and one poll tick run the full draw path.
    vi.advanceTimersByTime(150);
  });

  it("ignores malformed meter payloads (wrong type or short frames)", () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    (services.engine as unknown as Record<string, unknown>).setFxMetersEnabled = vi.fn();
    (services.engine as unknown as Record<string, unknown>).getFxMeters = vi
      .fn()
      .mockReturnValueOnce(new Float32Array(10)) // too short — must not be cached
      .mockReturnValueOnce("not a frame")
      .mockReturnValueOnce(frameOf((dry) => (dry[40] = -3)));

    const { container } = renderWithContext(
      <KaskadaPanel trackId="t1" fxId="fx1" params={{ toneLp: 4500, toneHp: 150 }} degraded={false} />,
      { services },
    );
    const canvas = container.querySelector("canvas");
    vi.spyOn(canvas!, "getContext").mockReturnValue(stub2dContext());
    expect(() => vi.advanceTimersByTime(300)).not.toThrow();
  });

  it("surfaces the degraded note when the worklet DSP is unavailable", () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    (services.engine as unknown as Record<string, unknown>).setFxMetersEnabled = vi.fn();
    (services.engine as unknown as Record<string, unknown>).getFxMeters = vi.fn(() => null);
    renderWithContext(<KaskadaPanel trackId="t1" fxId="fx1" params={{ toneLp: 4500, toneHp: 150 }} degraded={true} />, {
      services,
    });
    expect(screen.getByText(/bypassed — no analysis/)).toBeInTheDocument();
  });
});
