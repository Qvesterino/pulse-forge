/**
 * Timeline recording — arm a track, REC an audio input straight into the song.
 *
 * jsdom has no AudioWorklet or physical audio input. The UI tests cover the explicit
 * unsupported-capability path; recorder persistence is tested separately.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderProject } from "../../src/rendering/renderer";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import {
  addRecordedAudioClip,
  addRecordedAudioClips,
  addRecordedLoopTakeClips,
  addRecordedAudioTakeClip,
  clipLengthBars,
  compensateRecordingStartBar,
  recordedTakeAlreadyPlaced,
  recordedLoopPasses,
  recordedPunchWindow,
  resolveRecordedAudioDestinations,
  recordingStartBar,
  secondsPerBar,
  takeStartReturnTick,
} from "../../src/ui/timelineRec";
import { BAR_TICKS } from "../../src/project-model/types";
import { createDefaultProject, ticksPerBarFor } from "../../src/project-model/schema";
import {
  addAudioClip,
  addAudioTakeClip,
  compAudioTakeRange,
  createDrumTrack,
  setActiveAudioTake,
} from "../../src/commands/commands";
import { audioClipsForPlayback } from "../../src/project-model/audio-takes";
import { createLiveAudioTakeAuditionProject } from "../../src/rendering/take-audition";
import { loadRecordingInputDeviceId, saveRecordingInputDeviceId } from "../../src/audio-engine/recordingInput";
import { ProjectStore } from "../../src/store/ProjectStore";
import type { Services } from "../../src/services";

vi.mock("../../src/rendering/renderer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/rendering/renderer")>();
  return { ...actual, renderProject: vi.fn() };
});
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
  // The placement helpers take the document's bar length in ticks (ADR 0056).
  // 4/4 is 1920; 6/8 is 1440 (three quarter notes).
  const FOUR_FOUR = ticksPerBarFor({ numerator: 4, denominator: 4 });
  const SIX_EIGHT = ticksPerBarFor({ numerator: 6, denominator: 8 });

  it("computes seconds per bar in the document's meter", () => {
    expect(secondsPerBar(120, FOUR_FOUR)).toBe(2);
    expect(secondsPerBar(60, FOUR_FOUR)).toBe(4);
    expect(secondsPerBar(240, FOUR_FOUR)).toBe(1);
    expect(secondsPerBar(Number.NaN, FOUR_FOUR)).toBe(2); // safe fallback
    // A 6/8 bar is three quarter notes — 1.5 s at 120 BPM, not 2 s.
    expect(secondsPerBar(120, SIX_EIGHT)).toBe(1.5);
    expect(secondsPerBar(120, SIX_EIGHT)).not.toBe(secondsPerBar(120, FOUR_FOUR));
  });

  it("converts take duration to clip bars with a sensible floor", () => {
    expect(clipLengthBars(2, 120, FOUR_FOUR)).toBe(1); // exactly one bar
    expect(clipLengthBars(3.333, 120, FOUR_FOUR)).toBe(1.67); // rounded to 2 decimals
    expect(clipLengthBars(0.05, 120, FOUR_FOUR)).toBe(0.25); // floor keeps it visible
    expect(clipLengthBars(8, 240, FOUR_FOUR)).toBe(8); // fast tempo → many bars
    // The same 2 s of audio is 1.33 bars of 6/8 — the meter decides, not the clock.
    expect(clipLengthBars(2, 120, SIX_EIGHT)).toBe(1.33);
  });

  it("anchors the clip at the exact transport tick", () => {
    expect(recordingStartBar(0, FOUR_FOUR)).toBe(0);
    expect(recordingStartBar(BAR_TICKS * 4 + 5, FOUR_FOUR)).toBeCloseTo(4 + 5 / BAR_TICKS, 12);
    expect(recordingStartBar(-10, FOUR_FOUR)).toBe(0);
    expect(recordingStartBar(Number.NaN, FOUR_FOUR)).toBe(0);
    // Musical bar 1 of a 6/8 document is tick 1440, not 1920.
    expect(recordingStartBar(1440, SIX_EIGHT)).toBe(1);
    expect(recordingStartBar(1440, SIX_EIGHT)).not.toBe(recordingStartBar(1440, FOUR_FOUR));
  });

  it("applies manual input compensation in time units and never places before bar zero", () => {
    expect(compensateRecordingStartBar(2, 25, 120, FOUR_FOUR)).toBeCloseTo(1.9875, 10);
    expect(compensateRecordingStartBar(2, -25, 120, FOUR_FOUR)).toBeCloseTo(2.0125, 10);
    expect(compensateRecordingStartBar(0.01, 500, 120, FOUR_FOUR)).toBe(0);
  });

  it("uses durable punch-in frames and exact locators for completed punch placement", () => {
    expect(
      recordedPunchWindow(
        {
          id: "punch-1",
          projectId: "project-1",
          trackId: "track-1",
          trackName: "Guitar",
          startBar: 1,
          bpm: 120,
          sampleRate: 48_000,
          channels: 1,
          createdAt: "2026-09-26T00:00:00.000Z",
          updatedAt: 1,
          status: "recoverable",
          totalFrames: 48_100,
          chunkCount: 2,
          punchCapture: { startTick: 960, endTick: 1920 },
          punchOutReached: true,
          takeBoundaries: [1_000],
        },
        FOUR_FOUR,
      ),
    ).toEqual({ offsetSec: 1_000 / 48_000, lengthBars: 0.5 });
  });

  it("uses only the recovered audio duration for a manually stopped partial punch", () => {
    const window = recordedPunchWindow(
      {
        id: "punch-2",
        projectId: "project-1",
        trackId: "track-1",
        trackName: "Guitar",
        startBar: 1,
        bpm: 120,
        sampleRate: 48_000,
        channels: 1,
        createdAt: "2026-09-26T00:00:00.000Z",
        updatedAt: 1,
        status: "recoverable",
        totalFrames: 48_100,
        chunkCount: 2,
        punchCapture: { startTick: 960, endTick: 1920 },
        takeBoundaries: [1_000],
      },
      FOUR_FOUR,
    );
    expect(window?.offsetSec).toBeCloseTo(1_000 / 48_000, 12);
    expect(window?.lengthBars).toBe(0.49);
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

  it("places channel-split clips against one buffer as one undoable edit", () => {
    const base = createDocWithTracks();
    const doc = createDrumTrack(base).execute(base);
    const firstTrack = doc.tracks[0].id;
    const secondTrack = doc.tracks[doc.tracks.length - 1].id;
    const command = addRecordedAudioClips(
      doc,
      [
        { trackId: firstTrack, sourceChannel: 0 },
        { trackId: secondTrack, sourceChannel: 1 },
      ],
      "recorded-stereo-take",
      2 + 3 / BAR_TICKS,
      1,
      { fadeIn: 0.005 },
    );
    const added = command.execute(doc);
    expect(added.arrangement.audioClips).toHaveLength(2);
    expect(added.arrangement.audioClips!.map((clip) => clip.sourceChannel).sort()).toEqual([0, 1]);
    expect(new Set(added.arrangement.audioClips!.map((clip) => clip.bufferId))).toEqual(
      new Set(["recorded-stereo-take"]),
    );
    expect(added.arrangement.audioClips![0].startBar).toBeCloseTo(2 + 3 / BAR_TICKS, 12);
    expect(command.undo(added).arrangement.audioClips ?? []).toHaveLength(0);
    expect(command.execute(doc).arrangement.audioClips).toHaveLength(2);
  });

  it("adds a selected alternate take at exact tick placement as one undoable command", () => {
    const doc = createDefaultProject();
    const trackId = doc.tracks[0].id;
    const startBar = 3 + 17 / BAR_TICKS;
    const first = addRecordedAudioTakeClip(doc, "group-1", "pass-1", trackId, "recorded-pass-1", startBar, 2).execute(
      doc,
    );
    const command = addRecordedAudioTakeClip(first, "group-1", "pass-2", trackId, "recorded-pass-2", startBar, 2.5);
    const selected = command.execute(first);

    expect(selected.arrangement.audioClips).toHaveLength(2);
    expect(selected.arrangement.audioClips![1]?.startBar).toBeCloseTo(startBar, 12);
    expect(selected.arrangement.takeGroups).toEqual([{ id: "group-1", trackId, activeTakeId: "pass-2" }]);
    expect(audioClipsForPlayback(selected.arrangement).map((clip) => clip.bufferId)).toEqual(["recorded-pass-2"]);
    expect(command.undo(selected)).toEqual(first);
  });

  it("turns durable loop-boundary frames into selectable source windows in one undoable edit", () => {
    const doc = createDefaultProject();
    const passes = recordedLoopPasses(288_000, 48_000, [0, 96_000, 192_000], 120, "recording-42", FOUR_FOUR);
    expect(passes).toEqual([
      { takeId: "recording-42-pass-1", startFrame: 0, endFrame: 96_000, lengthBars: 1 },
      { takeId: "recording-42-pass-2", startFrame: 96_000, endFrame: 192_000, lengthBars: 1 },
      { takeId: "recording-42-pass-3", startFrame: 192_000, endFrame: 288_000, lengthBars: 1 },
    ]);

    const command = addRecordedLoopTakeClips(
      doc,
      "loop-group",
      doc.tracks[0].id,
      "recording-audio",
      1 + 7 / BAR_TICKS,
      48_000,
      288_000,
      passes,
    );
    const placed = command.execute(doc);
    expect(placed.arrangement.audioClips).toHaveLength(3);
    expect(placed.arrangement.audioClips?.map((clip) => clip.offsetSec).sort((a, b) => a - b)).toEqual([0, 2, 4]);
    expect(placed.arrangement.audioClips?.map((clip) => clip.trimEnd).sort((a, b) => a - b)).toEqual([0, 2, 4]);
    expect(placed.arrangement.audioClips?.map((clip) => clip.lengthBars).sort((a, b) => a - b)).toEqual([1, 1, 1]);
    expect(placed.arrangement.audioClips?.every((clip) => Math.abs(clip.startBar - (1 + 7 / BAR_TICKS)) < 1e-12)).toBe(
      true,
    );
    expect(placed.arrangement.takeGroups?.[0]?.activeTakeId).toBe("recording-42-pass-3");
    expect(audioClipsForPlayback(placed.arrangement).map((clip) => clip.offsetSec)).toEqual([4]);
    expect(command.undo(placed)).toEqual(doc);
  });

  it("applies per-pass phrase alignment to the take offsets, and ignores a mismatched shift list", () => {
    const doc = createDefaultProject();
    const passes = recordedLoopPasses(288_000, 48_000, [0, 96_000, 192_000], 120, "recording-42", FOUR_FOUR);

    // Vocal-first alignment: each pass skips its OWN measured late head, inside
    // the same placement command — one undo removes take and correction.
    const command = addRecordedLoopTakeClips(
      doc,
      "loop-group",
      doc.tracks[0].id,
      "recording-audio",
      1,
      48_000,
      288_000,
      passes,
      {},
      [0.04, 0, 0.08],
    );
    const placed = command.execute(doc);
    expect(placed.arrangement.audioClips?.map((clip) => clip.offsetSec).sort((a, b) => a - b)).toEqual([0.04, 2, 4.08]);
    expect(command.undo(placed)).toEqual(doc);

    // A shift list that does not line up with the passes is IGNORED rather than
    // guessed at: an unaligned take is honest, a wrongly aligned one is not.
    const mismatched = addRecordedLoopTakeClips(
      doc,
      "loop-group-2",
      doc.tracks[0].id,
      "recording-audio",
      1,
      48_000,
      288_000,
      passes,
      {},
      [0.1],
    );
    const placedMismatch = mismatched.execute(doc);
    expect(placedMismatch.arrangement.audioClips?.map((clip) => clip.offsetSec).sort((a, b) => a - b)).toEqual([
      0, 2, 4,
    ]);
  });

  it("validates saved channel destinations against the restored buffer and project", () => {
    const base = createDocWithTracks();
    const doc = createDrumTrack(base).execute(base);
    const [primary, secondary] = doc.tracks;
    const mapping = [
      { channelIndex: 0, trackId: primary.id, trackName: primary.name },
      { channelIndex: 1, trackId: "deleted-track", trackName: "Deleted" },
    ];
    expect(resolveRecordedAudioDestinations(doc, primary.id, mapping, 2)).toEqual({
      destinations: [{ trackId: primary.id, sourceChannel: 0 }],
      unavailableChannels: [],
      missingTracks: ["Deleted"],
      usedFallback: false,
    });
    expect(resolveRecordedAudioDestinations(doc, primary.id, mapping, 1).unavailableChannels).toEqual([1]);
    expect(secondary).toBeTruthy();
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

    const rec = screen.getByRole("button", { name: "Record audio input onto the armed track" }) as HTMLButtonElement;
    expect(rec.disabled).toBe(true);
    const monitor = screen.getByRole("button", { name: "DRY SOFT MON OFF" });
    expect(monitor).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(monitor);
    expect(screen.getByRole("button", { name: "DRY SOFT MON ON" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.change(select, { target: { value: doc.tracks[0].id } });
    expect(
      (screen.getByRole("button", { name: "Record audio input onto the armed track" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("arms loop-pass recording only when explicit transport locators are set", () => {
    const services = mockServices(createDocWithTracks());
    Object.assign(services.transport, { loopEnabled: true, loopStart: 0, loopEnd: BAR_TICKS });
    renderWithContext(<ArrangementPanel />, { services });

    const loopPasses = screen.getByLabelText("Record transport loop as alternate takes");
    expect(loopPasses).toBeEnabled();
    fireEvent.click(loopPasses);
    expect(loopPasses).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Captured channel 2 destination")).toBeDisabled();
  });

  it("arms one-pass punch recording from disabled-loop transport locators", async () => {
    let metadata: Record<string, unknown> | undefined;
    recorderMock.implementation = class {
      onError: ((message: string) => void) | null = null;
      onPunchOut: (() => void) | null = null;
      captureInfo = null;
      constructor(_options: unknown) {}
      setMonitoring() {}
      async start(getMetadata: () => Record<string, unknown> | null) {
        metadata = getMetadata() ?? undefined;
      }
      async cancel() {}
      async stop() {
        return null;
      }
    };

    try {
      const doc = createDocWithTracks();
      const services = mockServices(doc);
      const punchBoundary = vi.fn(() => () => {});
      (services.scheduler as any).subscribeTickBoundary = punchBoundary;
      Object.assign(services.transport, { loopEnabled: false, loopStart: BAR_TICKS, loopEnd: BAR_TICKS * 2 });
      (services.engine as any).ensureContext = vi.fn();
      (services.engine as any).getLiveAudioContext = vi.fn(() => ({ currentTime: 0, sampleRate: 48_000 }));

      renderWithContext(<ArrangementPanel />, { services });
      fireEvent.change(screen.getByLabelText("Arm track for recording"), {
        target: { value: doc.tracks[0].id },
      });
      const punch = screen.getByRole("button", { name: "Arm punch-in and punch-out recording" });
      expect(punch).toBeEnabled();
      fireEvent.click(punch);
      expect(screen.getByRole("button", { name: "Arm punch-in and punch-out recording" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      fireEvent.click(screen.getByRole("button", { name: "Record audio input onto the armed track" }));
      await screen.findByRole("button", { name: /STOP/ });

      expect(metadata).toMatchObject({ startBar: 1, punchCapture: { startTick: BAR_TICKS, endTick: BAR_TICKS * 2 } });
      expect(services.transport.seek).toHaveBeenCalledWith(BAR_TICKS);
      expect(punchBoundary).toHaveBeenNthCalledWith(1, BAR_TICKS, expect.any(Function));
      expect(punchBoundary).toHaveBeenNthCalledWith(2, BAR_TICKS * 2, expect.any(Function));
    } finally {
      recorderMock.implementation = null;
    }
  });

  it("shows a storage-headroom warning without stopping an otherwise valid recording", async () => {
    const warning = "Browser storage estimates 0.4 GiB free; a 30-minute take may need more.";
    recorderMock.implementation = class {
      onError: ((message: string) => void) | null = null;
      onPunchOut: (() => void) | null = null;
      onStorageWarning: ((message: string) => void) | null = null;
      captureInfo = null;
      constructor(_options: unknown) {}
      setMonitoring() {}
      async start() {
        await Promise.resolve();
        this.onStorageWarning?.(warning);
      }
      async cancel() {}
      async stop() {
        return null;
      }
    };

    const doc = createDocWithTracks();
    const services = mockServices(doc);
    (services.engine as any).ensureContext = vi.fn();
    (services.engine as any).getLiveAudioContext = vi.fn(() => ({ currentTime: 0, sampleRate: 48_000 }));
    renderWithContext(<ArrangementPanel />, { services });
    fireEvent.change(screen.getByLabelText("Arm track for recording"), { target: { value: doc.tracks[0].id } });
    fireEvent.click(screen.getByRole("button", { name: "Record audio input onto the armed track" }));

    await screen.findByRole("button", { name: /STOP/ });
    const status = await screen.findByText(warning);
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("button", { name: /STOP/ })).toBeTruthy();
  });

  it("switches audible passes from the selected audio take group", () => {
    const base = createDocWithTracks();
    const trackId = base.tracks[0].id;
    const first = addAudioTakeClip(base, "group-ui", "pass-ui-1", trackId, "audio.pass-1", 1, 2).execute(base);
    const withTwoPasses = addAudioTakeClip(first, "group-ui", "pass-ui-2", trackId, "audio.pass-2", 1, 2).execute(
      first,
    );
    const services = mockServices(withTwoPasses);
    const { container } = renderWithContext(<ArrangementPanel />, { services });

    fireEvent.click(container.querySelector(".arr-audio-clip")!);
    const activeTake = screen.getByLabelText("Active audio take") as HTMLSelectElement;
    expect(activeTake.value).toBe("pass-ui-1");
    expect(activeTake.options).toHaveLength(2);
    fireEvent.change(activeTake, { target: { value: "pass-ui-2" } });

    const command = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(command?.type).toBe("setActiveAudioTake");
    const selected = command.execute(withTwoPasses);
    expect(selected.arrangement.takeGroups?.[0]?.activeTakeId).toBe("pass-ui-2");
    expect(audioClipsForPlayback(selected.arrangement).map((clip) => clip.bufferId)).toEqual(["audio.pass-2"]);
  });

  it("shows source and comp takes as aligned lanes with undoable active-pass controls", () => {
    const base = createDocWithTracks();
    const trackId = base.tracks[0].id;
    const first = addAudioTakeClip(base, "lane-ui-group", "lane-ui-pass-1", trackId, "audio.lane-1", 1, 2).execute(
      base,
    );
    const second = addAudioTakeClip(first, "lane-ui-group", "lane-ui-pass-2", trackId, "audio.lane-2", 1, 2).execute(
      first,
    );
    const comp = compAudioTakeRange(second, "lane-ui-group", "lane-ui-pass-2", BAR_TICKS, BAR_TICKS * 2).execute(
      second,
    );
    const services = mockServices(comp);
    const { container } = renderWithContext(<ArrangementPanel />, { services });

    fireEvent.click(container.querySelector(".arr-audio-clip")!);
    fireEvent.click(screen.getByRole("button", { name: "Show audio take lanes" }));

    const lanes = screen.getByRole("region", { name: "Audio take lanes" });
    const laneQueries = within(lanes);
    const mainLane = container.querySelector(".arr-lane") as HTMLElement;
    expect(lanes.querySelectorAll(".arr-audio-take-lane")).toHaveLength(3);
    expect(lanes.style.width).toBe(mainLane.style.width);
    expect(laneQueries.getByRole("button", { name: "Activate TAKE 1" })).toHaveAttribute("aria-pressed", "false");
    expect(laneQueries.getByRole("button", { name: "Activate TAKE 2" })).toHaveAttribute("aria-pressed", "false");
    expect(laneQueries.getByRole("button", { name: "Activate COMP" })).toHaveAttribute("aria-pressed", "true");
    expect(lanes.querySelectorAll(".arr-audio-take-lane-segment")).toHaveLength(3);
    expect(lanes.querySelector(".arr-audio-take-lane-segment")?.getAttribute("style")).toContain(
      `left: ${container.querySelector<HTMLElement>(".arr-audio-clip")?.style.left}`,
    );

    fireEvent.click(laneQueries.getByRole("button", { name: "Activate TAKE 2" }));
    const command = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(command?.type).toBe("setActiveAudioTake");
    const selected = command.execute(comp);
    expect(selected.arrangement.audioClips).toHaveLength(3);
    expect(audioClipsForPlayback(selected.arrangement).map((clip) => clip.bufferId)).toEqual(["audio.lane-2"]);
  });

  it("auditions one isolated take lane through offline render and exposes a stop control", async () => {
    const base = createDocWithTracks();
    const trackId = base.tracks[0].id;
    const first = addAudioTakeClip(
      base,
      "audition-ui-group",
      "audition-ui-1",
      trackId,
      "audio.audition-1",
      0,
      1,
    ).execute(base);
    const withTwoTakes = addAudioTakeClip(
      first,
      "audition-ui-group",
      "audition-ui-2",
      trackId,
      "audio.audition-2",
      0,
      1,
    ).execute(first);
    const services = mockServices(withTwoTakes);
    const previewBuffer = vi.fn();
    Object.assign(services.engine, { previewBuffer });
    // This test builds its OWN services, so it must also state the live
    // context rate: the audition renders at
    // `getLiveAudioContext()?.sampleRate ?? 44100`. Without it the assertion
    // below was measuring the hard-coded fallback, not the project contract.
    Object.assign(services.engine, {
      getLiveAudioContext: vi.fn(() => ({ currentTime: 0, sampleRate: 48_000 })),
    });
    vi.mocked(renderProject).mockResolvedValue({} as AudioBuffer);
    const { container } = renderWithContext(<ArrangementPanel />, { services });

    fireEvent.click(container.querySelector(".arr-audio-clip")!);
    fireEvent.click(screen.getByRole("button", { name: "Show audio take lanes" }));
    fireEvent.click(screen.getByRole("button", { name: "Audition TAKE 1" }));

    await waitFor(() => expect(previewBuffer).toHaveBeenCalledOnce());
    const renderCall = vi.mocked(renderProject).mock.calls.at(-1)!;
    const auditionDoc = renderCall[0];
    const options = renderCall[2];
    expect(auditionDoc.arrangement.audioClips?.map((clip) => clip.bufferId)).toEqual(["audio.audition-1"]);
    expect(auditionDoc.patterns.every((pattern) => Object.keys(pattern.notes).length === 0)).toBe(true);
    expect(auditionDoc.tracks.find((track) => track.id === trackId)?.mute).toBe(false);
    expect(options).toMatchObject({ mode: "song", sampleRate: 48_000, masterProcessing: false });
    expect(screen.getByRole("button", { name: "Stop audition TAKE 1" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Stop audition TAKE 1" }));
    expect(services.engine.stopPreview).toHaveBeenCalled();
  });

  it("solos a take lane in live Song playback without mutating the project or rendering offline", () => {
    const base = createDocWithTracks();
    const trackId = base.tracks[0].id;
    const first = addAudioTakeClip(
      base,
      "live-audition-ui-group",
      "live-audition-ui-1",
      trackId,
      "audio.live-audition-1",
      0,
      1,
    ).execute(base);
    const withTwoTakes = addAudioTakeClip(
      first,
      "live-audition-ui-group",
      "live-audition-ui-2",
      trackId,
      "audio.live-audition-2",
      0,
      1,
    ).execute(first);
    const services = mockServices(withTwoTakes);
    Object.assign(services.playback, { mode: "song" });
    Object.assign(services.transport, { playing: true, position: BAR_TICKS / 2 });
    vi.mocked(renderProject).mockReset();
    const { container } = renderWithContext(<ArrangementPanel />, { services });

    fireEvent.click(container.querySelector(".arr-audio-clip")!);
    fireEvent.click(screen.getByRole("button", { name: "Show audio take lanes" }));
    fireEvent.click(screen.getByRole("button", { name: "Live solo TAKE 1" }));

    expect(services.setLiveTakeAuditionProject).toHaveBeenCalledOnce();
    const [liveDoc, resumedOffsets] = (services.setLiveTakeAuditionProject as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const expected = createLiveAudioTakeAuditionProject(
      withTwoTakes,
      "live-audition-ui-group",
      "live-audition-ui-1",
      BAR_TICKS / 2,
    );
    expect(liveDoc).toEqual(expected.project);
    expect(resumedOffsets).toEqual(expected.resumedAudioClipOffsets);
    expect(renderProject).not.toHaveBeenCalled();
    expect(services.store.getDoc()).toBe(withTwoTakes);
    expect(screen.getByRole("button", { name: "Stop live audition TAKE 1" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Stop live audition TAKE 1" }));
    expect(services.setLiveTakeAuditionProject).toHaveBeenLastCalledWith(null);
  });

  it("renders, persists and undoably replaces selected audio clips on consolidation", async () => {
    const base = createDefaultProject();
    const track = base.tracks[0];
    if (!track) throw new Error("empty project fixture missing track");
    const first = addAudioClip(base, track.id, "audio.consolidate-1", 0, 1).execute(base);
    const second = addAudioClip(first, track.id, "audio.consolidate-2", 1, 1).execute(first);
    const services = mockServices(second);
    Object.assign(services.engine, { getLiveAudioContext: vi.fn(() => ({ sampleRate: 48_000 })) });
    const renderedBuffer = {
      duration: 4 / 48_000,
      length: 4,
      sampleRate: 48_000,
      numberOfChannels: 2,
      getChannelData: () => new Float32Array(4),
    } as unknown as AudioBuffer;
    vi.mocked(renderProject).mockResolvedValue(renderedBuffer);
    const { container } = renderWithContext(<ArrangementPanel />, { services });

    fireEvent.contextMenu(container.querySelector(".arr-audio-clip")!, { clientX: 100, clientY: 100 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Consolidate to one clip" }));

    await waitFor(() => expect(services.userSamples.save).toHaveBeenCalledOnce());
    const renderCall = vi.mocked(renderProject).mock.calls.at(-1)!;
    expect(renderCall[0].arrangement.audioClips?.map((clip) => clip.bufferId)).toEqual([
      "audio.consolidate-1",
      "audio.consolidate-2",
    ]);
    expect(renderCall[2]).toMatchObject({ mode: "song", sampleRate: 48_000, tailSeconds: 0, masterProcessing: false });
    expect(services.bank.add).toHaveBeenCalledOnce();
    const savedAsset = (services.userSamples.save as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const command = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(command?.type).toBe("consolidateAudioClips");
    const consolidated = command.execute(second) as typeof second;
    expect(consolidated.arrangement.audioClips).toHaveLength(1);
    expect(consolidated.arrangement.audioClips?.[0]?.bufferId).toBe(savedAsset.id);
    expect(command.undo(consolidated)).toEqual(second);
  });

  it("selects a take-lane region by dragging and comps it with one undoable edit", () => {
    const base = createDocWithTracks();
    const trackId = base.tracks[0].id;
    const first = addAudioTakeClip(
      base,
      "lane-comp-group",
      "lane-comp-pass-1",
      trackId,
      "audio.comp-source-1",
      0,
      1,
    ).execute(base);
    const withTwoTakes = addAudioTakeClip(
      first,
      "lane-comp-group",
      "lane-comp-pass-2",
      trackId,
      "audio.comp-source-2",
      0,
      1,
    ).execute(first);
    const initialComp = compAudioTakeRange(withTwoTakes, "lane-comp-group", "lane-comp-pass-1", 0, BAR_TICKS).execute(
      withTwoTakes,
    );
    const services = mockServices(initialComp);
    const { container } = renderWithContext(<ArrangementPanel />, { services });

    fireEvent.click(container.querySelector(".arr-audio-clip")!);
    fireEvent.click(screen.getByRole("button", { name: "Show audio take lanes" }));

    const sourceLane = screen.getByLabelText("TAKE 2 timeline segments");
    const barWidth = Number.parseFloat(sourceLane.style.backgroundSize);
    const left = 100;
    Object.defineProperty(sourceLane, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: left,
        y: 0,
        left,
        top: 0,
        right: left + Number.parseFloat(sourceLane.style.width),
        bottom: 30,
        width: Number.parseFloat(sourceLane.style.width),
        height: 30,
        toJSON: () => ({}),
      }),
    });
    fireEvent.pointerDown(sourceLane, { button: 0, pointerId: 31, clientX: left + barWidth * 0.75 });
    fireEvent.pointerMove(sourceLane, { pointerId: 31, clientX: left + barWidth * 0.25 });
    fireEvent.pointerUp(sourceLane, { pointerId: 31, clientX: left + barWidth * 0.25 });

    const range = within(sourceLane).getByLabelText("Selected comp range from TAKE 2");
    expect(Number.parseFloat((range as HTMLElement).style.left)).toBeCloseTo(barWidth * 0.25, 5);
    expect(Number.parseFloat((range as HTMLElement).style.width)).toBeCloseTo(barWidth * 0.5, 5);
    const crossfade = screen.getByLabelText("Comp crossfade duration") as HTMLSelectElement;
    expect(crossfade.value).toBe("120");
    fireEvent.change(crossfade, { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "Comp selected take-lane range" }));

    const command = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(command?.type).toBe("compAudioTakeRange");
    const comped = command.execute(initialComp) as typeof initialComp;
    const group = comped.arrangement.takeGroups?.[0];
    expect(group?.activeTakeId).toBe(group?.compTakeId);
    expect(comped.arrangement.audioClips).toHaveLength(7);
    expect(comped.arrangement.audioClips?.filter((clip) => clip.takeId === "lane-comp-pass-1")).toHaveLength(1);
    expect(comped.arrangement.audioClips?.filter((clip) => clip.takeId === "lane-comp-pass-2")).toHaveLength(1);
    const audibleComp = audioClipsForPlayback(comped.arrangement);
    expect(audibleComp).toHaveLength(5);
    expect(audibleComp.some((clip) => clip.compSourceTakeId === "lane-comp-pass-1" && clip.fadeOut > 0.05)).toBe(true);
    expect(
      audibleComp.some(
        (clip) => clip.compSourceTakeId === "lane-comp-pass-2" && clip.fadeIn > 0.05 && clip.fadeOut > 0.05,
      ),
    ).toBe(true);
  });

  it("exposes an undoable comp-range action using the transport locators", () => {
    const base = createDocWithTracks();
    const trackId = base.tracks[0].id;
    const first = addAudioTakeClip(base, "comp-ui-group", "comp-source-1", trackId, "audio.comp-1", 0, 1).execute(base);
    const withTwoPasses = addAudioTakeClip(
      first,
      "comp-ui-group",
      "comp-source-2",
      trackId,
      "audio.comp-2",
      0,
      1,
    ).execute(first);
    const existingComp = compAudioTakeRange(withTwoPasses, "comp-ui-group", "comp-source-1", 0, BAR_TICKS).execute(
      withTwoPasses,
    );
    const activeSecondPass = setActiveAudioTake(existingComp, "comp-ui-group", "comp-source-2").execute(existingComp);
    const services = mockServices(activeSecondPass);
    Object.assign(services.transport, { loopStart: BAR_TICKS / 4, loopEnd: (BAR_TICKS * 3) / 4 });
    const { container } = renderWithContext(<ArrangementPanel />, { services });

    fireEvent.click(container.querySelector(".arr-audio-clip")!);
    fireEvent.click(screen.getByRole("button", { name: "Show audio take lanes" }));
    fireEvent.change(screen.getByLabelText("Comp crossfade duration"), { target: { value: "240" } });
    fireEvent.click(screen.getByRole("button", { name: "Comp selected transport range from active take" }));

    const command = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(command?.type).toBe("compAudioTakeRange");
    const comped = command.execute(activeSecondPass);
    expect(comped.arrangement.takeGroups?.[0]?.activeTakeId).toBe(comped.arrangement.takeGroups?.[0]?.compTakeId);
    const audible = audioClipsForPlayback(comped.arrangement).filter(
      (clip) => clip.takeId === comped.arrangement.takeGroups?.[0]?.compTakeId,
    );
    const newPassClip = audible.find((clip) => clip.compSourceTakeId === "comp-source-2");
    expect(audible).toHaveLength(5);
    expect(newPassClip).toMatchObject({ startBar: 0.1875, lengthBars: 0.625 });
    expect(newPassClip?.fadeIn).toBeGreaterThan(0.003);
    expect(newPassClip?.fadeOut).toBe(newPassClip?.fadeIn);
  });

  it("aligns an alternate recording to the take-group start and persists its pass identity", async () => {
    let metadata: Record<string, unknown> | undefined;
    recorderMock.implementation = class {
      onError = null;
      captureInfo = {
        capturedChannels: 2,
        capturedSampleRate: 48_000,
        inputTrackChannels: 2,
        inputTrackSampleRate: 48_000,
        supportedChannelCount: { min: 1, max: 2 },
      };
      constructor(_options: unknown) {}
      setMonitoring() {}
      async start(getMetadata: () => Record<string, unknown> | null) {
        metadata = getMetadata() ?? undefined;
      }
      async cancel() {}
    };

    try {
      const base = createDocWithTracks();
      const trackId = base.tracks[0].id;
      const withTake = addAudioTakeClip(
        base,
        "existing-take-group",
        "pass-original",
        trackId,
        "audio.original",
        2,
        2,
      ).execute(base);
      const services = mockServices(withTake);
      (services.engine as any).ensureContext = vi.fn();
      (services.engine as any).getLiveAudioContext = vi.fn(() => ({ currentTime: 0, sampleRate: 48_000 }));
      (services.transport as any).seek = vi.fn((tick: number) => {
        (services.transport as any).position = tick;
      });

      renderWithContext(<ArrangementPanel />, { services });
      fireEvent.change(screen.getByLabelText("Arm track for recording"), { target: { value: trackId } });
      fireEvent.change(screen.getByLabelText("Recording take mode"), {
        target: { value: "existing-take-group" },
      });
      expect(screen.getByLabelText("Captured channel 2 destination")).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Record audio input onto the armed track" }));
      await screen.findByRole("button", { name: /STOP/ });

      expect(services.transport.seek).toHaveBeenCalledWith(2 * BAR_TICKS);
      expect(metadata).toMatchObject({
        trackId,
        startBar: 2,
        takeGroupId: "existing-take-group",
      });
      expect(typeof metadata?.takeId).toBe("string");
      expect(metadata?.channelDestinations).toBeUndefined();
    } finally {
      recorderMock.implementation = null;
    }
  });

  it("labels the selected source and meter as a general audio input", () => {
    const doc = createDocWithTracks();
    renderWithContext(<ArrangementPanel />, { services: mockServices(doc) });

    const inputSelect = screen.getByLabelText("Audio input device") as HTMLSelectElement;
    expect(inputSelect.value).toBe("");
    expect(inputSelect.selectedOptions[0]?.textContent).toBe("INPUT: system default");
    expect(screen.getByRole("meter", { name: "Audio input level" })).toBeTruthy();
  });

  it("routes the chosen audio-interface input into the audio recorder", async () => {
    const originalDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    const previousInputId = loadRecordingInputDeviceId();
    let recorderInputId: string | undefined;
    let recorderMetadata: Record<string, unknown> | undefined;
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
      captureInfo = {
        capturedChannels: 2,
        capturedSampleRate: 48_000,
        inputTrackChannels: 2,
        inputTrackSampleRate: 48_000,
        supportedChannelCount: { min: 1, max: 2 },
      };
      constructor(options: { inputDeviceId?: string }) {
        recorderInputId = options.inputDeviceId;
      }
      setMonitoring() {}
      async start(getMetadata: () => Record<string, unknown> | null) {
        recorderMetadata = getMetadata() ?? undefined;
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
      (services.engine as any).getLiveAudioContext = vi.fn(() => ({ currentTime: 0, sampleRate: 48_000 }));
      const view = renderWithContext(<ArrangementPanel />, { services });
      const inputSelect = screen.getByLabelText("Audio input device");
      await screen.findByRole("option", { name: "Studio Interface · Input 2" });
      fireEvent.change(inputSelect, { target: { value: "interface-input-2" } });
      fireEvent.change(screen.getByLabelText("Arm track for recording"), {
        target: { value: doc.tracks[0].id },
      });
      const channelDestination = screen.getByLabelText("Captured channel 2 destination") as HTMLSelectElement;
      expect(channelDestination.options.length).toBeGreaterThan(1);
      fireEvent.change(channelDestination, {
        target: { value: doc.tracks.find((track) => track.id !== doc.tracks[0].id)!.id },
      });
      fireEvent.click(screen.getByRole("button", { name: "Record audio input onto the armed track" }));
      await screen.findByRole("button", { name: /STOP/ });

      expect(recorderInputId).toBe("interface-input-2");
      expect(recorderMetadata?.channelDestinations).toEqual([
        { channelIndex: 0, trackId: doc.tracks[0].id, trackName: doc.tracks[0].name },
        {
          channelIndex: 1,
          trackId: doc.tracks.find((track) => track.id !== doc.tracks[0].id)!.id,
          trackName: doc.tracks.find((track) => track.id !== doc.tracks[0].id)!.name,
        },
      ]);
      expect(
        await screen.findByText(/LAST CAPTURE: 2 ch @ 48 kHz · track 2 ch @ 48 kHz · browser range 1–2 ch/),
      ).toBeTruthy();
      expect(screen.getByText(/does not verify physical interface routing/i)).toBeTruthy();
      view.unmount();
    } finally {
      saveRecordingInputDeviceId(previousInputId);
      if (originalDevices) Object.defineProperty(navigator, "mediaDevices", originalDevices);
      else Reflect.deleteProperty(navigator, "mediaDevices");
      recorderMock.implementation = null;
    }
  });

  it("requests four distinct input channels and maps each one to its own timeline track", async () => {
    const originalDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    let requestedChannelCount: number | undefined;
    let recorderMetadata: Record<string, unknown> | undefined;
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => [
        { kind: "audioinput", deviceId: "interface-multichannel", label: "Multichannel Interface" },
      ]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: mediaDevices });
    recorderMock.implementation = class {
      onError: ((message: string) => void) | null = null;
      captureInfo = {
        capturedChannels: 4,
        capturedSampleRate: 48_000,
        inputTrackChannels: 4,
        inputTrackSampleRate: 48_000,
        supportedChannelCount: { min: 1, max: 8 },
      };
      constructor(options: { requestedChannelCount?: number }) {
        requestedChannelCount = options.requestedChannelCount;
      }
      setMonitoring() {}
      async start(getMetadata: () => Record<string, unknown> | null) {
        recorderMetadata = getMetadata() ?? undefined;
      }
      async cancel() {}
      async stop() {
        return null;
      }
    };

    try {
      let doc = createDocWithTracks();
      while (doc.tracks.length < 4) {
        const template = doc.tracks[0];
        doc = {
          ...doc,
          tracks: [
            ...doc.tracks,
            { ...template, id: `input-route-${doc.tracks.length}`, name: `Input ${doc.tracks.length + 1}` },
          ],
        };
      }
      const services = mockServices(doc);
      (services.engine as any).ensureContext = vi.fn();
      (services.engine as any).getLiveAudioContext = vi.fn(() => ({ currentTime: 0, sampleRate: 48_000 }));
      const view = renderWithContext(<ArrangementPanel />, { services });
      await screen.findByRole("option", { name: "Multichannel Interface" });
      fireEvent.change(screen.getByLabelText("Audio input device"), { target: { value: "interface-multichannel" } });
      fireEvent.change(screen.getByLabelText("Capture input channel count"), { target: { value: "4" } });
      fireEvent.change(screen.getByLabelText("Arm track for recording"), { target: { value: doc.tracks[0].id } });
      fireEvent.change(screen.getByLabelText("Captured channel 2 destination"), {
        target: { value: doc.tracks[1].id },
      });
      fireEvent.click(screen.getByText("INPUT ROUTING · 4 CHANNELS"));
      fireEvent.change(screen.getByLabelText("Captured channel 3 destination"), {
        target: { value: doc.tracks[2].id },
      });
      fireEvent.change(screen.getByLabelText("Captured channel 4 destination"), {
        target: { value: doc.tracks[3].id },
      });
      fireEvent.click(screen.getByRole("button", { name: "Record audio input onto the armed track" }));
      await screen.findByRole("button", { name: /STOP/ });

      expect(requestedChannelCount).toBe(4);
      expect(recorderMetadata?.channelDestinations).toEqual(
        doc.tracks.slice(0, 4).map((track, channelIndex) => ({
          channelIndex,
          trackId: track.id,
          trackName: track.name,
        })),
      );
      view.unmount();
    } finally {
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
    fireEvent.click(screen.getByRole("button", { name: "Record audio input onto the armed track" }));

    await screen.findByRole("alert");
    // No state stuck on "recording" — REC button is back.
    expect(screen.getByRole("button", { name: "Record audio input onto the armed track" })).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "Record audio input onto the armed track" }));
    await screen.findByRole("alert");

    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("serializes rapid REC clicks while the audio input is opening", async () => {
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
      (services.engine as any).getLiveAudioContext = vi.fn(() => ({ currentTime: 0, sampleRate: 48_000 }));

      renderWithContext(<ArrangementPanel />, { services });
      fireEvent.change(screen.getByLabelText("Arm track for recording"), {
        target: { value: doc.tracks[0].id },
      });
      const recButton = screen.getByRole("button", { name: "Record audio input onto the armed track" });
      act(() => {
        fireEvent.click(recButton);
        fireEvent.click(recButton);
      });

      // While the input opens the REC affordance is replaced by a dedicated
      // CANCEL control (opening the device can hang on the OS prompt), so a
      // second REC click has nothing to hit — exactly one start runs.
      const cancelButton = await screen.findByRole("button", { name: "Cancel audio input startup" });
      expect(cancelButton).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Record audio input onto the armed track" })).not.toBeInTheDocument();
      await vi.waitFor(() => expect(startCount).toBe(1));

      unblockStart();
      await screen.findByRole("button", { name: /STOP/ });
      expect(startCount).toBe(1);
    } finally {
      unblockStart();
      recorderMock.implementation = null;
    }
  });

  it("does not open the audio input if the arrangement unmounts while REC is loading", async () => {
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
      (services.engine as any).getLiveAudioContext = vi.fn(() => ({ currentTime: 0, sampleRate: 48_000 }));

      const { unmount } = renderWithContext(<ArrangementPanel />, { services });
      fireEvent.change(screen.getByLabelText("Arm track for recording"), {
        target: { value: doc.tracks[0].id },
      });
      fireEvent.click(screen.getByRole("button", { name: "Record audio input onto the armed track" }));
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
      (services.engine as any).getLiveAudioContext = vi.fn(() => ({ currentTime: 0, sampleRate: 48_000 }));
      services.recordingRecovery.finalize = vi.fn(async () => {
        throw new Error("quota exceeded");
      });

      renderWithContext(<ArrangementPanel />, { services });
      fireEvent.change(screen.getByLabelText("Arm track for recording"), {
        target: { value: doc.tracks[0].id },
      });
      fireEvent.click(screen.getByRole("button", { name: "Record audio input onto the armed track" }));
      fireEvent.click(await screen.findByRole("button", { name: /STOP/ }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/committed PCM blocks remain in recovery storage/i);
      expect(services.recordingRecovery.finalize).toHaveBeenCalledOnce();
      expect(services.bank.add).toHaveBeenCalledOnce();
      expect(services.store.execute).toHaveBeenCalledOnce();
    } finally {
      recorderMock.implementation = null;
    }
  });
  it(
    "aligns a late phrase onto its entry at record stop — inside the placed take, and says so",
    // The alignment renders the whole phrase through the engine; on a loaded
    // machine that is more than vitest's 5 s default.
    { timeout: 30_000 },
    async () => {
      // VOCAL-FIRST LOOP, end to end: a singer enters 40 ms late; the take is
      // placed with its leading silence skipped so the phrase lands on the entry,
      // the correction rides in the SAME command (one undo), and the user is told
      // what happened rather than left to notice by ear.
      const doc = createDocWithTracks();
      let metadata: any;
      const sampleRate = 48_000;
      const phrase = new Float32Array(sampleRate);
      const onset = Math.round(0.04 * sampleRate);
      for (let index = onset; index < phrase.length; index += 1) {
        phrase[index] = Math.sin((2 * Math.PI * 220 * (index - onset)) / sampleRate) * 0.5;
      }
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
              id: "recording.align",
              ...metadata,
              projectId: doc.id,
              trackId: doc.tracks[0].id,
            },
            buffer: {
              duration: 1,
              sampleRate,
              numberOfChannels: 1,
              getChannelData: () => phrase,
            } as unknown as AudioBuffer,
            // The take carries its own silence measurement (audit R-1): the
            // panel reads it unguarded, so the fake has to carry it too.
            silence: { peak: 0.5, rms: 0.2, silent: false },
          };
        }
        cancel() {}
      };

      try {
        const store = new ProjectStore(doc);
        const services = { ...mockServices(doc), store } as unknown as Services;
        (services.engine as any).getLiveAudioContext = vi.fn(() => ({ currentTime: 0, sampleRate: 48_000 }));

        renderWithContext(<ArrangementPanel />, { services });
        fireEvent.change(screen.getByLabelText("Arm track for recording"), {
          target: { value: doc.tracks[0].id },
        });
        fireEvent.click(screen.getByRole("button", { name: "Record audio input onto the armed track" }));
        fireEvent.click(await screen.findByRole("button", { name: /STOP/ }));

        expect(await screen.findByText(/aligned onto its entry/i)).toBeInTheDocument();
        const clips = store.doc.arrangement.audioClips ?? [];
        expect(clips).toHaveLength(1);
        const leadInSec = Number.isFinite(metadata?.leadInSec) ? metadata.leadInSec : 0;
        const shift = clips[0]!.offsetSec - leadInSec;
        expect(shift).toBeGreaterThan(0.035);
        expect(shift).toBeLessThanOrEqual(0.04);
      } finally {
        recorderMock.implementation = null;
      }
    },
  );
});

describe("CF-10 — a single take parks the playhead at its start", () => {
  const BAR = BAR_TICKS;
  function takeFixture(doc: ReturnType<typeof createDocWithTracks>, startBar: number) {
    const sampleRate = 48_000;
    // The fixture OWNS the recorded reality: session.startBar is what a real
    // capture would report (the mock harness's frozen clock cannot express
    // transport positions). stopRec parks the playhead from THIS number.
    return {
      session: {
        id: "recording.cf10",
        projectId: doc.id,
        trackId: doc.tracks[0].id,
        startBar,
      },
      buffer: {
        duration: 1,
        sampleRate,
        numberOfChannels: 1,
        getChannelData: () => new Float32Array(sampleRate),
      } as unknown as AudioBuffer,
      silence: { peak: 0.5, rms: 0.2, silent: false },
    };
  }

  function fakeRecorderClass(doc: ReturnType<typeof createDocWithTracks>, startBar: number) {
    return class {
      elapsedSeconds = 1;
      onError = null;
      setMonitoring() {}
      async start(_getMetadata: () => unknown) {}
      async stop() {
        return takeFixture(doc, startBar);
      }
      cancel() {}
    };
  }

  afterEach(() => {
    try {
      window.localStorage.removeItem("pf:rec-return-to-start");
    } catch {
      /* ignore */
    }
  });

  it("after STOP the playhead parks at the take's start bar, and the notice says so", async () => {
    const doc = createDocWithTracks();
    recorderMock.implementation = fakeRecorderClass(doc, 5);
    try {
      const services = { ...mockServices(doc), store: new ProjectStore(doc) } as unknown as Services;
      (services.engine as any).getLiveAudioContext = vi.fn(() => ({ currentTime: 0, sampleRate: 48_000 }));
      const seekSpy = vi.spyOn(services.transport, "seek");
      renderWithContext(<ArrangementPanel />, { services });

      fireEvent.change(screen.getByLabelText("Arm track for recording"), {
        target: { value: doc.tracks[0].id },
      });
      fireEvent.click(screen.getByRole("button", { name: "Record audio input onto the armed track" }));
      fireEvent.click(await screen.findByRole("button", { name: /STOP/ }));

      // The parked playhead IS the last seek, and it is the take's start.
      expect(await screen.findByText(/Playhead returned to the take start/)).toBeInTheDocument();
      expect(seekSpy.mock.calls.at(-1)?.[0]).toBe(5 * BAR);
      const clips = services.store.getDoc().arrangement.audioClips ?? [];
      expect(clips).toHaveLength(1);
      expect(clips[0].startBar).toBe(5);
    } finally {
      recorderMock.implementation = null;
    }
  });

  it("NEGATIVE: the RETURN TO START toggle off leaves the playhead alone", async () => {
    const doc = createDocWithTracks();
    recorderMock.implementation = fakeRecorderClass(doc, 5);
    try {
      const services = { ...mockServices(doc), store: new ProjectStore(doc) } as unknown as Services;
      (services.engine as any).getLiveAudioContext = vi.fn(() => ({ currentTime: 0, sampleRate: 48_000 }));
      const seekSpy = vi.spyOn(services.transport, "seek");
      renderWithContext(<ArrangementPanel />, { services });

      fireEvent.click(screen.getByRole("button", { name: /RETURN TO START ON/ }));
      expect(screen.getByRole("button", { name: /RETURN TO START OFF/ })).toHaveAttribute("aria-pressed", "false");

      fireEvent.change(screen.getByLabelText("Arm track for recording"), {
        target: { value: doc.tracks[0].id },
      });
      fireEvent.click(screen.getByRole("button", { name: "Record audio input onto the armed track" }));
      fireEvent.click(await screen.findByRole("button", { name: /STOP/ }));

      expect(screen.queryByText(/Playhead returned to the take start/)).toBeNull();
      expect(seekSpy.mock.calls.some(([tick]) => tick === 5 * BAR)).toBe(false);
      // The take still placed — wait for the recorder to return to idle (the
      // placement is async; the OFF path shows no completion notice to await).
      await screen.findByRole("button", { name: "Record audio input onto the armed track" });
      expect((services.store.getDoc().arrangement.audioClips ?? []).length).toBe(1);
    } finally {
      recorderMock.implementation = null;
    }
  });

  it("CF-10 decision table: only an enabled single take returns a tick", () => {
    const input = { startBar: 4, barUnitTicks: BAR_TICKS };
    expect(
      takeStartReturnTick({ ...input, enabled: true, punchCapture: false, loopCapture: false, hasTakeGroup: false }),
    ).toBe(4 * BAR_TICKS);
    expect(
      takeStartReturnTick({ ...input, enabled: false, punchCapture: false, loopCapture: false, hasTakeGroup: false }),
    ).toBeNull();
    expect(
      takeStartReturnTick({ ...input, enabled: true, punchCapture: true, loopCapture: false, hasTakeGroup: false }),
    ).toBeNull();
    expect(
      takeStartReturnTick({ ...input, enabled: true, punchCapture: false, loopCapture: true, hasTakeGroup: false }),
    ).toBeNull();
    expect(
      takeStartReturnTick({ ...input, enabled: true, punchCapture: false, loopCapture: false, hasTakeGroup: true }),
    ).toBeNull();
    // Fractional and negative starts clamp to a musical tick on or after bar 0.
    expect(
      takeStartReturnTick({
        ...input,
        startBar: 2.5,
        enabled: true,
        punchCapture: false,
        loopCapture: false,
        hasTakeGroup: false,
      }),
    ).toBe(Math.round(2.5 * BAR_TICKS));
    expect(
      takeStartReturnTick({
        ...input,
        startBar: -3,
        enabled: true,
        punchCapture: false,
        loopCapture: false,
        hasTakeGroup: false,
      }),
    ).toBe(0);
    expect(
      takeStartReturnTick({
        ...input,
        startBar: Number.NaN,
        enabled: true,
        punchCapture: false,
        loopCapture: false,
        hasTakeGroup: false,
      }),
    ).toBe(0);
  });
});

function createDocWithTracks() {
  const doc = mockServices().store.doc;
  return doc;
}
