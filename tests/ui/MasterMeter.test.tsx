import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { MasterMeter, MasterMiniMeter, MasterStereoMeters } from "../../src/ui/MasterMeter";
import { renderWithContext } from "../helpers";

const CLIP_RED_STYLE = "rgb(248, 113, 113)";

type MeterTestEngine = ReturnType<typeof renderWithContext>["services"]["engine"] & {
  getMasterGainReductionDb: () => number;
};

function renderMasterMiniMeter() {
  return renderWithContext(<MasterMiniMeter onOpenAudioSettings={vi.fn()} audioSettingsOpen={false} />);
}

interface MeterFrameStep {
  timestamp: number;
  beforeFrame?: (engine: MeterTestEngine) => void;
  assertFrame: (container: HTMLElement) => void;
}

function withMeterFrames(renderMeter: () => ReturnType<typeof renderWithContext>, steps: MeterFrameStep[]) {
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
    const rendered = renderMeter();
    unmount = rendered.unmount;
    const engine = rendered.services.engine as MeterTestEngine;
    engine.getMasterGainReductionDb = vi.fn(() => 0);
    for (const step of steps) {
      step.beforeFrame?.(engine);
      const frame = frames.shift();
      expect(frame).toBeDefined();
      act(() => frame?.(step.timestamp));
      step.assertFrame(rendered.container);
    }
  } finally {
    unmount();
    vi.stubGlobal("requestAnimationFrame", originalRequestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", originalCancelAnimationFrame);
  }
}

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
    withMeterFrames(
      () => renderWithContext(<MasterMeter />),
      [
        {
          timestamp: 33,
          assertFrame: () => {
            expect(screen.queryByRole("alert")).not.toBeInTheDocument();
          },
        },
      ],
    );
  });

  it("expires the clip alert by elapsed time after a delayed meter frame", () => {
    withMeterFrames(
      () => renderWithContext(<MasterMeter />),
      [
        {
          timestamp: 33,
          beforeFrame: (engine) => {
            const silent = engine.getMasterLevels();
            const clipped = { ...silent, left: { ...silent.left, peak: 1, peakDb: 0 } };
            engine.getMasterLevels = vi.fn().mockReturnValueOnce(clipped).mockReturnValue(silent);
          },
          assertFrame: () => {
            expect(screen.getByRole("alert")).toBeInTheDocument();
          },
        },
        {
          timestamp: 1000,
          assertFrame: () => {
            expect(screen.queryByRole("alert")).not.toBeInTheDocument();
          },
        },
      ],
    );
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

  it("does not color the headroom indicator as clipping on the first silent frame", () => {
    withMeterFrames(
      () => renderWithContext(<MasterStereoMeters />),
      [
        {
          timestamp: 33,
          assertFrame: (container) => {
            expect(container.querySelector(".master-headroom-bar")?.getAttribute("style")).not.toContain(
              CLIP_RED_STYLE,
            );
          },
        },
      ],
    );
  });

  it("expires the headroom clip indicator by elapsed time after a delayed frame", () => {
    withMeterFrames(
      () => renderWithContext(<MasterStereoMeters />),
      [
        {
          timestamp: 33,
          beforeFrame: (engine) => {
            const silent = engine.getMasterLevels();
            const clipped = { ...silent, left: { ...silent.left, peak: 1, peakDb: 0 } };
            engine.getMasterLevels = vi.fn().mockReturnValueOnce(clipped).mockReturnValue(silent);
          },
          assertFrame: (container) => {
            expect(container.querySelector(".master-headroom-bar")?.getAttribute("style")).toContain(CLIP_RED_STYLE);
          },
        },
        {
          timestamp: 1000,
          assertFrame: (container) => {
            expect(container.querySelector(".master-headroom-bar")?.getAttribute("style")).not.toContain(
              CLIP_RED_STYLE,
            );
          },
        },
      ],
    );
  });

  it("does not mark the compact status meter as clipping on the first silent frame", () => {
    withMeterFrames(renderMasterMiniMeter, [
      {
        timestamp: 40,
        assertFrame: (container) => {
          const bars = [...container.querySelectorAll(".statusbar-meter-bar")];
          expect(bars).toHaveLength(2);
          expect(bars.some((bar) => bar.classList.contains("clipping"))).toBe(false);
        },
      },
    ]);
  });

  it("keeps the Studio I/O meter opener keyboard-accessible and clickable", () => {
    const onOpenAudioSettings = vi.fn();
    renderWithContext(<MasterMiniMeter onOpenAudioSettings={onOpenAudioSettings} audioSettingsOpen={false} />);

    const button = screen.getByRole("button", { name: "Studio I/O — audio device settings" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    expect(onOpenAudioSettings).toHaveBeenCalledOnce();
  });

  it("describes the current L/R peaks and hold when the meter button receives focus", () => {
    withMeterFrames(
      () => renderWithContext(<MasterMiniMeter onOpenAudioSettings={vi.fn()} audioSettingsOpen={false} />),
      [
        {
          timestamp: 40,
          assertFrame: (container) => {
            const button = screen.getByRole("button", { name: "Studio I/O — audio device settings" });
            const descriptionId = button.getAttribute("aria-describedby");
            expect(descriptionId).toBeTruthy();
            expect(document.getElementById(descriptionId ?? "")).toHaveTextContent(
              "Master output level: left -60.0 dB peak, right -60.0 dB peak, hold -60.0 dB.",
            );
            expect(container.querySelectorAll(".statusbar-meter-bar")).toHaveLength(2);
          },
        },
      ],
    );
  });

  it("expires the compact clip indicator by elapsed time after a delayed frame", () => {
    withMeterFrames(renderMasterMiniMeter, [
      {
        timestamp: 40,
        beforeFrame: (engine) => {
          const silent = engine.getMasterLevels();
          const clipped = { ...silent, left: { ...silent.left, peak: 1, peakDb: 0 } };
          engine.getMasterLevels = vi.fn().mockReturnValueOnce(clipped).mockReturnValue(silent);
        },
        assertFrame: (container) => {
          expect(container.querySelector(".statusbar-meter-bar")?.classList.contains("clipping")).toBe(true);
        },
      },
      {
        timestamp: 1000,
        assertFrame: (container) => {
          const bars = [...container.querySelectorAll(".statusbar-meter-bar")];
          expect(bars.some((bar) => bar.classList.contains("clipping"))).toBe(false);
        },
      },
    ]);
  });

  it("announces compact-meter clipping politely and clears it after the hold", () => {
    withMeterFrames(renderMasterMiniMeter, [
      {
        timestamp: 40,
        beforeFrame: (engine) => {
          const silent = engine.getMasterLevels();
          const clipped = { ...silent, left: { ...silent.left, peak: 1, peakDb: 0 } };
          engine.getMasterLevels = vi.fn().mockReturnValueOnce(clipped).mockReturnValue(silent);
        },
        assertFrame: () => {
          const status = screen.getByRole("status");
          expect(status).toHaveTextContent("Master output clipping.");
          expect(status.closest("button")).toBeNull();
          expect(screen.getByRole("button", { name: "Studio I/O — audio device settings" })).toBeInTheDocument();
        },
      },
      {
        timestamp: 1000,
        assertFrame: () => {
          expect(screen.getByRole("status")).toBeEmptyDOMElement();
          expect(screen.getByRole("button", { name: "Studio I/O — audio device settings" })).toBeInTheDocument();
        },
      },
    ]);
  });
});
