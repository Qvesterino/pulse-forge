import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
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

function frameOf(fill: (dry: Float32Array, wet: Float32Array, unmask: Float32Array) => void): Float32Array {
  const frame = new Float32Array(176).fill(-90);
  frame.fill(0, 144); // unmask reduction section is positive dB
  fill(frame.subarray(0, 72), frame.subarray(72, 144), frame.subarray(144));
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
    expect(screen.getByText("RYFT / SPECTRUM")).toBeInTheDocument();
    expect(screen.getByText("DRY")).toBeInTheDocument();
    expect(screen.getByText("DELAY")).toBeInTheDocument();
    expect(screen.getByText("LOOP EQ")).toBeInTheDocument();
    expect(screen.getByText("UNMASK")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /RYFT dual spectrum/ })).toBeInTheDocument();
    expect(setFxMetersEnabled).toHaveBeenCalledWith("t1", "fx1", true);
    unmount();
    expect(setFxMetersEnabled).toHaveBeenCalledWith("t1", "fx1", false);
  });

  it("paints real meter frames without crashing (draw path + EQ overlay)", () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    (services.engine as unknown as Record<string, unknown>).setFxMetersEnabled = vi.fn();
    (services.engine as unknown as Record<string, unknown>).getFxMeters = vi.fn(() =>
      frameOf((dry, wet, unmask) => {
        dry[40] = -3; // 1 kHz tone on the input
        wet[40] = -8; // echo of the same tone
        unmask[20] = 9; // solver carving the masked band
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
    expect(screen.getByText(/bypassed — no analysis/i)).toBeInTheDocument();
  });
});

describe("KaskadaPanel — drag EQ handles", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  function mockRect(canvas: HTMLCanvasElement) {
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 600,
      height: 110,
      right: 600,
      bottom: 110,
      x: 0,
      y: 0,
      toJSON: () => undefined,
    } as DOMRect);
  }

  it("drags the LP handle: engine preview during the move, one commit on release", () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    const previewFxParam = vi.fn();
    (services.engine as unknown as Record<string, unknown>).setFxMetersEnabled = vi.fn();
    (services.engine as unknown as Record<string, unknown>).getFxMeters = vi.fn(() => null);
    (services.engine as unknown as Record<string, unknown>).previewFxParam = previewFxParam;
    const onParam = vi.fn();

    const { container } = renderWithContext(
      <KaskadaPanel
        trackId="t1"
        fxId="fx1"
        params={{ toneLp: 4500, toneHp: 150 }}
        degraded={false}
        onParam={onParam}
      />,
      { services },
    );
    const canvas = container.querySelector("canvas")!;
    vi.spyOn(canvas, "getContext").mockReturnValue(stub2dContext());
    mockRect(canvas);

    // LP at 4500 Hz sits at x ≈ 600·ln(225)/ln(1000) ≈ 470, y ≈ 36.
    fireEvent.pointerDown(canvas, { clientX: 470, clientY: 36, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 320, clientY: 36, pointerId: 1 });
    expect(previewFxParam).toHaveBeenCalled(); // audible mid-drag

    fireEvent.pointerUp(canvas, { clientX: 320, clientY: 36, pointerId: 1 });
    expect(onParam).toHaveBeenCalledTimes(1);
    const [paramId, value] = onParam.mock.calls[0];
    expect(paramId).toBe("toneLp");
    expect(value).toBeLessThan(4500); // moved left = darker
    expect(value).toBeGreaterThanOrEqual(500); // clamped to the registry range
  });

  it("a press away from both handles does not commit anything", () => {
    const doc = createProjectFromTemplate("house");
    const services = mockServices(doc);
    (services.engine as unknown as Record<string, unknown>).setFxMetersEnabled = vi.fn();
    (services.engine as unknown as Record<string, unknown>).getFxMeters = vi.fn(() => null);
    const onParam = vi.fn();

    const { container } = renderWithContext(
      <KaskadaPanel
        trackId="t1"
        fxId="fx1"
        params={{ toneLp: 4500, toneHp: 150 }}
        degraded={false}
        onParam={onParam}
      />,
      { services },
    );
    const canvas = container.querySelector("canvas")!;
    vi.spyOn(canvas, "getContext").mockReturnValue(stub2dContext());
    mockRect(canvas);

    // HP at 150 Hz sits near x ≈ 218 — press at x 40 (nothing there).
    fireEvent.pointerDown(canvas, { clientX: 40, clientY: 36, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 60, clientY: 36, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 60, clientY: 36, pointerId: 1 });
    expect(onParam).not.toHaveBeenCalled();
  });
});
