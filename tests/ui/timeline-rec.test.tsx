/**
 * Timeline recording — arm a track, REC the mic straight into the song.
 *
 * jsdom has no AudioWorklet or microphone. The UI tests cover the explicit
 * unsupported-capability path; recorder persistence is tested separately.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { clipLengthBars, recordingStartBar, secondsPerBar } from "../../src/ui/timelineRec";
import { BAR_TICKS } from "../../src/project-model/types";
import { renderWithContext, mockServices } from "../helpers";

describe("recording placement math", () => {
  it("computes seconds per bar (4/4)", () => {
    expect(secondsPerBar(120)).toBe(2);
    expect(secondsPerBar(60)).toBe(4);
    expect(secondsPerBar(240)).toBe(1);
    expect(secondsPerBar(Number.NaN)).toBe(2); // safe fallback
  });

  it("converts take duration to clip bars with a sensible floor", () => {
    expect(clipLengthBars(2, 120)).toBe(1); // exactly one bar
    expect(clipLengthBars(3.333, 120)).toBe(1.67); // rounded to 2 decimals
    expect(clipLengthBars(0.05, 120)).toBe(0.25); // floor keeps it visible
    expect(clipLengthBars(8, 240)).toBe(8); // fast tempo → many bars
  });

  it("anchors the clip at the transport's bar", () => {
    expect(recordingStartBar(0)).toBe(0);
    expect(recordingStartBar(BAR_TICKS * 4 + 5)).toBe(4); // mid-bar start → whole bar
    expect(recordingStartBar(-10)).toBe(0);
  });
});

describe("arrangement REC wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the ARM select with project tracks and disables REC until armed", () => {
    const doc = createDocWithTracks();
    const services = mockServices(doc);
    renderWithContext(<ArrangementPanel />, { services });

    const select = screen.getByLabelText("Arm track for recording") as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.value).toBe("");
    expect(select.textContent).toContain("Drums");

    const rec = screen.getByRole("button", { name: "● REC" }) as HTMLButtonElement;
    expect(rec.disabled).toBe(true);

    fireEvent.change(select, { target: { value: doc.tracks[0].id } });
    expect((screen.getByRole("button", { name: "● REC" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("REC without AudioWorklet support surfaces a readable error, not a crash", async () => {
    const doc = createDocWithTracks();
    const services = mockServices(doc);
    // Engine must report a live context for the flow to reach the recorder.
    (services.engine as { ensureContext: () => unknown; getLiveAudioContext: () => unknown }).ensureContext = vi.fn();
    (services.engine as { getLiveAudioContext: () => unknown }).getLiveAudioContext = vi.fn(() => ({
      state: "running",
    }));

    renderWithContext(<ArrangementPanel />, { services });
    fireEvent.change(screen.getByLabelText("Arm track for recording"), {
      target: { value: doc.tracks[0].id },
    });
    fireEvent.click(screen.getByRole("button", { name: "● REC" }));

    await screen.findByText(/AudioWorklet|not available|mic/i);
    // No state stuck on "recording" — REC button is back.
    expect(screen.getByRole("button", { name: "● REC" })).toBeTruthy();
  });

  it("REC with a browser lacking capture support keeps the store untouched", async () => {
    const doc = createDocWithTracks();
    const services = mockServices(doc);
    const executeSpy = services.store.execute as ReturnType<typeof vi.fn>;
    (services.engine as { ensureContext: () => unknown }).ensureContext = vi.fn();
    (services.engine as { getLiveAudioContext: () => unknown }).getLiveAudioContext = vi.fn(() => ({
      state: "running",
    }));

    renderWithContext(<ArrangementPanel />, { services });
    fireEvent.change(screen.getByLabelText("Arm track for recording"), {
      target: { value: doc.tracks[0].id },
    });
    fireEvent.click(screen.getByRole("button", { name: "● REC" }));
    await screen.findByText(/AudioWorklet|not available|mic/i);

    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("warns when the take is usable now but its audio could not be persisted", async () => {
    vi.doMock("../../src/audio-engine/PcmMicRecorder", () => ({
      PcmMicRecorder: class {
        elapsedSeconds = 1;
        metadata: any;
        onError = null;
        async start(getMetadata: () => unknown) {
          this.metadata = getMetadata();
        }
        async stop() {
          return {
            session: {
              id: "recording.test",
              ...this.metadata,
            },
            buffer: { duration: 1, sampleRate: 48_000, numberOfChannels: 1 } as AudioBuffer,
          };
        }
        cancel() {}
      },
    }));

    try {
      const doc = createDocWithTracks();
      const services = mockServices(doc);
      (services.engine as any).getLiveAudioContext = vi.fn(() => ({ currentTime: 0 }));
      services.recordingRecovery.finalize = vi.fn(async () => {
        throw new Error("quota exceeded");
      });

      renderWithContext(<ArrangementPanel />, { services });
      fireEvent.change(screen.getByLabelText("Arm track for recording"), {
        target: { value: doc.tracks[0].id },
      });
      fireEvent.click(screen.getByRole("button", { name: "● REC" }));
      fireEvent.click(await screen.findByRole("button", { name: /STOP/ }));

      expect(await screen.findByRole("alert")).toHaveTextContent(/committed PCM blocks remain in recovery storage/i);
      expect(services.recordingRecovery.finalize).toHaveBeenCalledOnce();
      expect(services.bank.add).toHaveBeenCalledOnce();
      expect(services.store.execute).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock("../../src/audio-engine/recorder");
    }
  });
});

function createDocWithTracks() {
  const doc = mockServices().store.doc;
  return doc;
}
