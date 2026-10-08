import { describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { MasterMeter, MasterStereoMeters } from "../../src/ui/MasterMeter";
import { renderWithContext } from "../helpers";

describe("MasterMeter", () => {
  it("renders master meter group", () => {
    renderWithContext(<MasterMeter />);
    expect(screen.getByRole("group", { name: /Master meter/ })).toBeInTheDocument();
  });

  it("shows the buss-glue gain reduction separately", () => {
    renderWithContext(<MasterMeter />);
    expect(screen.getByText(/GLUE 0\.0 dB/)).toBeInTheDocument();
  });

  it("does not announce clipping on the first silent meter frame", () => {
    const frames: FrameRequestCallback[] = [];
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    let unmount = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    try {
      const rendered = renderWithContext(<MasterMeter />);
      unmount = rendered.unmount;
      const engine = rendered.services.engine as typeof rendered.services.engine & {
        getMasterGainReductionDb: () => number;
      };
      engine.getMasterGainReductionDb = vi.fn(() => 0);
      const firstFrame = frames.shift();
      expect(firstFrame).toBeDefined();
      act(() => firstFrame?.(33));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      unmount();
      vi.stubGlobal("requestAnimationFrame", originalRequestAnimationFrame);
      vi.stubGlobal("cancelAnimationFrame", originalCancelAnimationFrame);
    }
  });
});

describe("MasterStereoMeters", () => {
  it("renders the stereo indicator group", () => {
    renderWithContext(<MasterStereoMeters />);
    expect(screen.getByRole("group", { name: /Master stereo indicators/ })).toBeInTheDocument();
  });

  it("shows L and R channel labels", () => {
    renderWithContext(<MasterStereoMeters />);
    expect(screen.getByText("L")).toBeInTheDocument();
    expect(screen.getByText("R")).toBeInTheDocument();
  });

  it("shows correlation meter label", () => {
    renderWithContext(<MasterStereoMeters />);
    expect(screen.getByText("×CORR")).toBeInTheDocument();
  });

  it("shows headroom label", () => {
    renderWithContext(<MasterStereoMeters />);
    expect(screen.getByText("HEAD")).toBeInTheDocument();
  });

  it("shows ceiling dB value", () => {
    renderWithContext(<MasterStereoMeters />);
    // Default ceiling is -1
    expect(screen.getByText("-1.0 dB")).toBeInTheDocument();
  });
});
