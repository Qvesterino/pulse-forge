import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StretchDialog, clampStretchRate, stretchedPlaybackSec, fitRate } from "../../src/ui/StretchDialog";

describe("stretch math", () => {
  it("clamps rate to the engine 0.25–4 gate", () => {
    expect(clampStretchRate(0.1)).toBe(0.25);
    expect(clampStretchRate(9)).toBe(4);
    expect(clampStretchRate(1.234)).toBe(1.23);
    expect(clampStretchRate(Number.NaN)).toBe(1);
  });

  it("playback seconds follow rate (0.5 = half speed = twice as long)", () => {
    expect(stretchedPlaybackSec(4, 0.5)).toBe(8);
    expect(stretchedPlaybackSec(4, 2)).toBe(2);
    expect(stretchedPlaybackSec(0, 2)).toBe(0);
  });

  it("fit rate mirrors fitAudioClipTempo (detected/project, clamped)", () => {
    expect(fitRate(128, 124)).toBeCloseTo(1.03, 2);
    expect(fitRate(10, 124)).toBeNull();
    expect(fitRate(128, 0)).toBeNull();
  });
});

function renderDialog(overrides: Partial<React.ComponentProps<typeof StretchDialog>> = {}) {
  const onApply = vi.fn();
  const onClose = vi.fn();
  render(
    <StretchDialog
      clipName="Vox"
      sourceSec={4}
      initialRate={1}
      initialMode="resample"
      detectedBpm={128}
      projectBpm={124}
      onApply={onApply}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onApply, onClose };
}

describe("StretchDialog", () => {
  it("shows live duration math and applies rate + mode", () => {
    const { onApply } = renderDialog();
    expect(screen.getByText(/Source 4\.00s → plays 4\.00s/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Stretch rate"), { target: { value: "0.5" } });
    expect(screen.getByText(/plays 8\.00s/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Stretch · keep pitch/));
    fireEvent.click(screen.getByText("Apply"));
    expect(onApply).toHaveBeenCalledWith(0.5, "stretch");
  });

  it("Fit locks detected tempo and switches to preserve mode", () => {
    const { onApply } = renderDialog();
    fireEvent.click(screen.getByText(/Fit 128 → 124 BPM/));
    expect((screen.getByLabelText("Stretch rate") as HTMLInputElement).value).toBe("1.03");
    fireEvent.click(screen.getByText("Apply"));
    expect(onApply).toHaveBeenCalledWith(1.03, "stretch");
  });

  it("fit hides without detection, Reset restores 1.00", () => {
    renderDialog({ detectedBpm: null });
    expect(screen.queryByText(/Fit /)).toBeNull();
    expect(screen.getByText(/fit unavailable/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Stretch rate"), { target: { value: "2" } });
    fireEvent.click(screen.getByText("Reset"));
    expect((screen.getByLabelText("Stretch rate") as HTMLInputElement).value).toBe("1");
  });

  it("Escape and Cancel close without applying", () => {
    const { onApply, onClose } = renderDialog();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });
});
