/**
 * Timeline recording — arm a track, REC the mic straight into the song.
 *
 * jsdom has no AudioWorklet or microphone. The UI tests cover the explicit
 * unsupported-capability path; recorder persistence is tested separately.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import {
  addRecordedAudioClip,
  clipLengthBars,
  compensateRecordingStartBar,
  recordedTakeAlreadyPlaced,
  recordingStartBar,
  secondsPerBar,
} from "../../src/ui/timelineRec";
import { BAR_TICKS } from "../../src/project-model/types";
import { createDefaultProject } from "../../src/project-model/schema";
import { loadRecordingInputDeviceId, saveRecordingInputDeviceId } from "../../src/audio-engine/recordingInput";
import { renderWithContext, mockServices } from "../helpers";

const recorderMock = vi.hoisted(() => ({
  implementation: null as (new (...args: any[]) => any) | null,
}));

vi.mock("../../src/audio-engine/PcmMicRecorder", async () => {
  const actual = await vi.importActual<typeof import("../../src/audio-engine/PcmMicRecorder")>(
    "../../src/audio-engine/PcmMicRecorder",
  );
  return {
    ...actual,
    PcmMicRecorder: class {
      constructor(options: any) {
        const Implementation = recorderMock.implementation;
        return Implementation ? new Implementation(options) : new actual.PcmMicRecorder(options);
      }
    },
  };
});

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

  it("anchors the clip at the exact transport tick", () => {
    expect(recordingStartBar(0)).toBe(0);
    expect(recordingStartBar(BAR_TICKS * 4 + 5)).toBeCloseTo(4 + 5 / BAR_TICKS, 12);
    expect(recordingStartBar(-10)).toBe(0);
    expect(recordingStartBar(Number.NaN)).toBe(0);
  });

  it("applies manual input compensation in time units and never places before bar zero", () => {
    expect(compensateRecordingStartBar(2, 25, 120)).toBeCloseTo(1.9875, 10);
    expect(compensateRecordingStartBar(2, -25, 120)).toBeCloseTo(2.0125, 10);
    expect(compensateRecordingStartBar(0.01, 500, 120)).toBe(0);
  });

  it("preserves recorded clip tick placement through add, undo, and redo", () => {
    const doc = createDefaultProject();
    const startBar = 3 + 17 / BAR_TICKS;
    const command = addRecordedAudioClip(doc, doc.tracks[0].id, "recorded-vocal", startBar, 1);
    const added = command.execute(doc);
    expect(added.arrangement.audioClips![0].startBar).toBeCloseTo(startBar, 12);
    const undone = command.undo(added);
    expect(undone.arrangement.audioClips ?? []).toHaveLength(0);
    expect(command.execute(undone).arrangement.audioClips![0].startBar).toBeCloseTo(startBar, 12);
  });

  it("detects an already-placed take so a recovery retry does not duplicate its clip", () => {
    const doc = createDefaultProject();
    const takeBufferId = "user.recording-recording-session-123";
    const placed = addRecordedAudioClip(doc, doc.tracks[0].id, takeBufferId, 2, 1).execute(doc);

    expect(recordedTakeAlreadyPlaced(placed, takeBufferId)).toBe(true);
    expect(recordedTakeAlreadyPlaced(doc, takeBufferId)).toBe(false);
  });
});

describe("arrangement REC wiring", () => {
  afterEach(() => {
    recorderMock.implementation = null;
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
    const monitor = screen.getByRole("button", { name: "DRY MON OFF" });
    expect(monitor).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(monitor);
    expect(screen.getByRole("button", { name: "DRY MON ON" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.change(select, { target: { value: doc.tracks[0].id } });
    expect((screen.getByRole("button", { name: "● REC" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("routes the chosen audio-interface input into the vocal recorder", async () => {
    const originalDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    const previousInputId = loadRecordingInputDeviceId();
    let recorderInputId: string | undefined;
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => [
        { kind: "audioinput", deviceId: "interface-input-2", label: "Studio Interface · Input 2" },
      ]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: mediaDevices });
    recorderMock.implementation = class {
      onError: ((message: string) => void) | null = null;
      constructor(options: { inputDeviceId?: string }) {
        recorderInputId = options.inputDeviceId;
      }
      setMonitoring() {}
      async start() {}
      async cancel() {}
      async stop() {
        return null;
      }
    };

    try {
      const doc = createDocWithTracks();
      const services = mockServices(doc);
      (services.engine as any).ensureContext = vi.fn();
      (services.engine as any).getLiveAudioContext = vi.fn(() => ({ currentTime: 0 }));
      const view = renderWithContext(<ArrangementPanel />, { services });
      const micSelect = screen.getByLabelText("Microphone input device");
      await screen.findByRole("option", { name: "Studio Interface · Input 2" });
      fireEvent.change(micSelect, { target: { value: "interface-input-2" } });
      fireEvent.change(screen.getByLabelText("Arm track for recording"), {
        target: { value: doc.tracks[0].id },
      });
      fireEvent.click(screen.getByRole("button", { name: "● REC" }));
      await screen.findByRole("button", { name: /STOP/ });

      expect(recorderInputId).toBe("interface-input-2");
      view.unmount();
    } finally {
      saveRecordingInputDeviceId(previousInputId);
      if (originalDevices) Object.defineProperty(navigator, "mediaDevices", originalDevices);
      else Reflect.deleteProperty(navigator, "mediaDevices");
      recorderMock.implementation = null;
    }
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

    await screen.findByRole("alert");
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
    await screen.findByRole("alert");

    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("serializes rapid REC clicks while the microphone is opening", async () => {
    let unblockStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      unblockStart = resolve;
    });
    let startCount = 0;
    recorderMock.implementation = class {
      onError = null;
      setMonitoring() {}
      async start() {
        startCount++;
        await startGate;
      }
      async cancel() {}
      async stop() {
        return null;
      }
    };

    try {
      const doc = createDocWithTracks();
      const services = mockServices(doc);
      (services.engine as any).ensureContext = vi.fn();
      (services.engine as any).getLiveAudioContext = vi.fn(() => ({ currentTime: 0 }));

      renderWithContext(<ArrangementPanel />, { services });
      fireEvent.change(screen.getByLabelText("Arm track for recording"), {
        target: { value: doc.tracks[0].id },
      });
      const recButton = screen.getByRole("button", { name: "● REC" });
      act(() => {
        fireEvent.click(recButton);
        fireEvent.click(recButton);
      });

      const openingButton = await screen.findByRole("button", { name: "◌ MIC…" });
      expect(openingButton).toBeDisabled();
      await vi.waitFor(() => expect(startCount).toBe(1));

      unblockStart();
      await screen.findByRole("button", { name: /STOP/ });
      expect(startCount).toBe(1);
    } finally {
      unblockStart();
      recorderMock.implementation = null;
    }
  });

  it("does not open the microphone if the arrangement unmounts while REC is loading", async () => {
    const startSpy = vi.fn();
    const cancelSpy = vi.fn();
    recorderMock.implementation = class {
      onError = null;
      setMonitoring() {}
      async start() {
        startSpy();
      }
      async cancel() {
        cancelSpy();
      }
    };

    try {
      const doc = createDocWithTracks();
      const services = mockServices(doc);
      (services.engine as any).ensureContext = vi.fn();
      (services.engine as any).getLiveAudioContext = vi.fn(() => ({ currentTime: 0 }));

      const { unmount } = renderWithContext(<ArrangementPanel />, { services });
      fireEvent.change(screen.getByLabelText("Arm track for recording"), {
        target: { value: doc.tracks[0].id },
      });
      fireEvent.click(screen.getByRole("button", { name: "● REC" }));
      unmount();
      await vi.dynamicImportSettled();

      expect(startSpy).not.toHaveBeenCalled();
      expect(cancelSpy).not.toHaveBeenCalled();
    } finally {
      recorderMock.implementation = null;
    }
  });

  it("warns when the take is usable now but its audio could not be persisted", async () => {
    const doc = createDocWithTracks();
    let metadata: any;
    recorderMock.implementation = class {
      elapsedSeconds = 1;
      onError = null;
      setMonitoring() {}
      async start(getMetadata: () => unknown) {
        metadata = getMetadata();
      }
      async stop() {
        return {
          session: {
            id: "recording.test",
            ...metadata,
            projectId: doc.id,
            trackId: doc.tracks[0].id,
          },
          buffer: { duration: 1, sampleRate: 48_000, numberOfChannels: 1 } as AudioBuffer,
        };
      }
      cancel() {}
    };

    try {
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
      recorderMock.implementation = null;
    }
  });
});

function createDocWithTracks() {
  const doc = mockServices().store.doc;
  return doc;
}
