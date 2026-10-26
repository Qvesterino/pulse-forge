import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LatencyCalibrationWizard } from "../../src/ui/LatencyCalibrationWizard";
import { recordingAlignment, recordingAlignmentStorageKey } from "../../src/audio-engine/recordingAlignment";
import { saveRecordingInputDeviceId } from "../../src/audio-engine/recordingInput";
import { renderWithContext } from "../helpers";
import type { AudioLatencyMeasurement } from "../../src/audio-engine/latencyCalibration";

vi.mock("../../src/audio-engine/latencyProbe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/audio-engine/latencyProbe")>();
  return {
    ...actual,
    measureAudioRoundTrip: vi.fn(async (): Promise<AudioLatencyMeasurement> => ({
      roundTripMs: 63.4,
      jitterMs: 1.5,
      sampleCount: 8,
      stable: true,
      sampleRate: 48_000,
      measuredAt: new Date().toISOString(),
    })),
  };
});

afterEach(() => {
  recordingAlignment.reset();
  saveRecordingInputDeviceId("");
  vi.unstubAllGlobals();
});

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

  describe("audio test → recording placement", () => {
    const openAudioPhase = async () => {
      class FakeAudioContext {}
      vi.stubGlobal("AudioContext", FakeAudioContext);
      const rendered = renderWithContext(<LatencyCalibrationWizard open onClose={() => {}} />);
      (
        rendered.services.engine.ensureContext as unknown as { mockReturnValue: (value: unknown) => void }
      ).mockReturnValue(new FakeAudioContext());
      fireEvent.click(screen.getByRole("button", { name: "START AUDIO TEST" }));
      await screen.findByText("AUDIO PATH RESULT");
      return rendered;
    };

    it("applies a stable round-trip measurement to recording placement", async () => {
      await openAudioPhase();
      expect(recordingAlignment.getSnapshot()).toBe(63);
      expect(screen.getByText(/Applied to mic recording placement: 63 ms/)).toBeInTheDocument();
      // The MIDI step's slider now reflects the applied measurement.
      fireEvent.click(screen.getByRole("button", { name: "CONTINUE TO MIDI" }));
      expect(screen.getByRole("slider", { name: "Microphone recording offset" })).toHaveValue("63");
    });

    it("notes when the measured round trip exceeds the ±500 ms placement limit", async () => {
      const { measureAudioRoundTrip } = await import("../../src/audio-engine/latencyProbe");
      vi.mocked(measureAudioRoundTrip).mockResolvedValueOnce({
        roundTripMs: 731.2,
        jitterMs: 1.5,
        sampleCount: 8,
        stable: true,
        sampleRate: 48_000,
        measuredAt: new Date().toISOString(),
      });
      await openAudioPhase();
      expect(recordingAlignment.getSnapshot()).toBe(500);
      expect(screen.getByText(/measured 731 ms — limited to ±500 ms/)).toBeInTheDocument();
    });

    it("leaves recording placement untouched when the measurement is unstable", async () => {
      recordingAlignment.setOffsetMs(-42);
      const { measureAudioRoundTrip } = await import("../../src/audio-engine/latencyProbe");
      vi.mocked(measureAudioRoundTrip).mockResolvedValueOnce({
        roundTripMs: 512.5,
        jitterMs: 40,
        sampleCount: 2,
        stable: false,
        sampleRate: 48_000,
        measuredAt: new Date().toISOString(),
      });
      await openAudioPhase();
      expect(recordingAlignment.getSnapshot()).toBe(-42);
      expect(screen.queryByText(/Applied to mic recording placement/)).toBeNull();
    });

    // Audit R-3: the calibration must measure the microphone the app RECORDS
    // from, and the offset must be filed under THAT device — not under a
    // global key that every interface inherits.
    it("measures the selected input and files the offset under that device", async () => {
      saveRecordingInputDeviceId("mic-a");
      const { measureAudioRoundTrip } = await import("../../src/audio-engine/latencyProbe");
      vi.mocked(measureAudioRoundTrip).mockClear();

      await openAudioPhase();

      expect(vi.mocked(measureAudioRoundTrip).mock.calls[0][3]).toBe("mic-a");
      expect(localStorage.getItem(recordingAlignmentStorageKey("mic-a"))).toBe("63");
      // Another device inherits nothing.
      expect(localStorage.getItem(recordingAlignmentStorageKey("mic-b"))).toBeNull();
    });

    it("names the input the calibration belongs to, so an uncompensated interface has an explanation", async () => {
      saveRecordingInputDeviceId("mic-a");
      const original = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          enumerateDevices: async () => [
            { kind: "audioinput", deviceId: "mic-a", label: "Studio interface · Input 1" },
          ],
        },
      });
      try {
        renderWithContext(<LatencyCalibrationWizard open onClose={() => {}} />);
        expect(await screen.findByTestId("latency-input-label")).toHaveTextContent("Studio interface · Input 1");
      } finally {
        if (original) Object.defineProperty(navigator, "mediaDevices", original);
        else Reflect.deleteProperty(navigator, "mediaDevices");
      }
    });
  });
});
