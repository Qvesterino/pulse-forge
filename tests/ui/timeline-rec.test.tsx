/**
 * Timeline recording — arm a track, REC the mic straight into the song.
 *
 * jsdom has no microphone, so the UI tests cover the wiring up to the error
 * path (REC without MediaRecorder surfaces a readable message) and the
 * pure helpers cover the placement math. The full capture path is exercised
 * manually (mic → clip appears at the playhead bar).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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
  let mediaRecorderMissing = true;

  beforeEach(() => {
    mediaRecorderMissing = typeof (globalThis as { MediaRecorder?: unknown }).MediaRecorder === "undefined";
  });

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

  it("REC without mic support surfaces a readable error, not a crash", async () => {
    if (!mediaRecorderMissing) return; // only meaningful where MediaRecorder is absent
    const doc = createDocWithTracks();
    const services = mockServices(doc);
    // Engine must report a live context for the flow to reach the recorder.
    (services.engine as { ensureContext: () => unknown; getLiveAudioContext: () => unknown }).ensureContext = vi.fn();
    (services.engine as { getLiveAudioContext: () => unknown }).getLiveAudioContext = vi.fn(() => ({}));

    renderWithContext(<ArrangementPanel />, { services });
    fireEvent.change(screen.getByLabelText("Arm track for recording"), {
      target: { value: doc.tracks[0].id },
    });
    fireEvent.click(screen.getByRole("button", { name: "● REC" }));

    await screen.findByText(/MediaRecorder|not available|mic/i);
    // No state stuck on "recording" — REC button is back.
    expect(screen.getByRole("button", { name: "● REC" })).toBeTruthy();
  });

  it("REC with a ready engine but blocked mic keeps the store untouched", async () => {
    if (!mediaRecorderMissing) return;
    const doc = createDocWithTracks();
    const services = mockServices(doc);
    const executeSpy = services.store.execute as ReturnType<typeof vi.fn>;
    (services.engine as { ensureContext: () => unknown }).ensureContext = vi.fn();
    (services.engine as { getLiveAudioContext: () => unknown }).getLiveAudioContext = vi.fn(() => ({}));

    renderWithContext(<ArrangementPanel />, { services });
    fireEvent.change(screen.getByLabelText("Arm track for recording"), {
      target: { value: doc.tracks[0].id },
    });
    fireEvent.click(screen.getByRole("button", { name: "● REC" }));
    await screen.findByText(/MediaRecorder|not available|mic/i);

    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("warns when the take is usable now but its audio could not be persisted", async () => {
    vi.doMock("../../src/audio-engine/recorder", () => ({
      LiveRecorder: class {
        elapsedSeconds = 1;
        async start() {}
        async stop() {
          return {
            buffer: { duration: 1, sampleRate: 48_000, numberOfChannels: 1 } as AudioBuffer,
            blob: new Blob(["recorded audio"], { type: "audio/webm;codecs=opus" }),
          };
        }
        cancel() {}
      },
      extensionForMime: () => ".webm",
    }));

    try {
      const doc = createDocWithTracks();
      const services = mockServices(doc);
      (services.engine as any).getLiveAudioContext = vi.fn(() => ({ currentTime: 0 }));
      services.userSamples.save = vi.fn(async () => {
        throw new Error("quota exceeded");
      });

      renderWithContext(<ArrangementPanel />, { services });
      fireEvent.change(screen.getByLabelText("Arm track for recording"), {
        target: { value: doc.tracks[0].id },
      });
      fireEvent.click(screen.getByRole("button", { name: "● REC" }));
      fireEvent.click(await screen.findByRole("button", { name: /STOP/ }));

      expect(await screen.findByRole("alert")).toHaveTextContent(/only in memory.*lost/i);
      expect(services.userSamples.save).toHaveBeenCalledOnce();
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
