import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LatencyCalibrationWizard } from "../../src/ui/LatencyCalibrationWizard";
import { recordingAlignment } from "../../src/audio-engine/recordingAlignment";
import { renderWithContext } from "../helpers";

describe("LatencyCalibrationWizard", () => {
  it("opens on the intro step and allows MIDI fine-tune without project edits", () => {
    const { services } = renderWithContext(<LatencyCalibrationWizard open onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Latency calibration" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "SKIP TO MIDI" }));
    expect(screen.getByText("MIDI FINE-TUNE")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("slider", { name: "MIDI reference offset" }), { target: { value: "24" } });
    expect(services.latency.getSnapshot().midiReferenceOffsetMs).toBe(24);
    fireEvent.change(screen.getByRole("slider", { name: "Microphone recording offset" }), {
      target: { value: "31" },
    });
    expect(recordingAlignment.getSnapshot()).toBe(31);
    expect(services.store.execute).not.toHaveBeenCalled();
  });

  it("resets local calibration and closes cleanly", () => {
    const onClose = vi.fn();
    const { services } = renderWithContext(<LatencyCalibrationWizard open onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "SKIP TO MIDI" }));
    fireEvent.change(screen.getByRole("slider", { name: "MIDI reference offset" }), { target: { value: "18" } });
    fireEvent.click(screen.getByRole("button", { name: "RESET" }));
    expect(services.latency.getSnapshot().midiReferenceOffsetMs).toBe(0);
    expect(recordingAlignment.getSnapshot()).toBe(0);
    expect(screen.getByText("LATENCY CALIBRATION")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close latency calibration" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
