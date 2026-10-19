import { describe, expect, it, vi } from "vitest";
import { ArrangementCaptureController } from "../src/arrangement/capture";
import { assignLivePad, createLiveSet } from "../src/commands/commands";
import { ProjectStore } from "../src/store/ProjectStore";
import { BAR_TICKS } from "../src/project-model/types";
import type { AudioClip } from "../src/project-model/types";
import { createProjectFromTemplate } from "../src/project-model/templates";

interface BoundarySubscription {
  tick: number;
  listener: (boundary: { tick: number; audioTime: number; cancelled?: true }) => void;
  active: boolean;
  scheduled: boolean;
}

function makeHarness(loop: boolean) {
  let doc = createProjectFromTemplate("house");
  doc = createLiveSet(doc, "Performance").execute(doc);
  const set = doc.liveSets?.find((candidate) => candidate.id === doc.activeLiveSetId)!;
  doc = assignLivePad(doc, set.id, {
    slot: 0,
    bufferId: "user.capture-loop",
    name: loop ? "Capture Loop" : "Capture Hit",
    bpm: 120,
    ...(loop ? { loop: true } : {}),
  }).execute(doc);
  const store = new ProjectStore(doc);
  const trackId = doc.tracks.find((track) => track.kind !== "generative")!.id;
  const subscriptions: BoundarySubscription[] = [];
  let tick = 0;
  let playing = true;
  let audioTime = 1;
  const liveVoices = new Set<string>();
  const triggerAudioClip = vi.fn(
    (_clip: AudioClip, _when: number, _voiceId: string, _loopUntilStopped: boolean) => true,
  );
  triggerAudioClip.mockImplementation((_clip, _when, voiceId, _loopUntilStopped) => {
    liveVoices.add(voiceId);
    return true;
  });
  const stopLivePadVoice = vi.fn((_voiceId: string, _when: number) => {});
  const cancelLivePadStop = vi.fn();
  const cancelLivePadVoice = vi.fn();
  const capture = new ArrangementCaptureController(
    () => store.doc,
    (command) => store.execute(command),
    () => tick,
  );
  capture.attachLivePadRuntime({
    isPlaying: () => playing,
    startSongTransport: () => {
      playing = true;
    },
    getAudioTime: () => audioTime,
    subscribeTickBoundary: (boundaryTick, listener) => {
      const subscription: BoundarySubscription = { tick: boundaryTick, listener, active: true, scheduled: false };
      subscriptions.push(subscription);
      return () => {
        if (!subscription.active) return;
        subscription.active = false;
        if (subscription.scheduled) {
          subscription.listener({ tick: subscription.tick, audioTime, cancelled: true });
        }
      };
    },
    triggerAudioClip,
    hasLivePadVoice: (voiceId) => liveVoices.has(voiceId),
    stopLivePadVoice,
    cancelLivePadStop,
    cancelLivePadVoice,
  });
  capture.start();

  return {
    capture,
    store,
    set,
    trackId,
    triggerAudioClip,
    stopLivePadVoice,
    cancelLivePadStop,
    cancelLivePadVoice,
    subscriptions,
    setTick: (value: number) => (tick = value),
    setAudioTime: (value: number) => (audioTime = value),
    setPlaying: (value: boolean) => (playing = value),
    panic: () => liveVoices.clear(),
    fire: (boundaryTick: number) => {
      const subscription = subscriptions.find((item) => item.active && !item.scheduled && item.tick === boundaryTick);
      if (!subscription) throw new Error(`No pending boundary at ${boundaryTick}`);
      subscription.scheduled = true;
      subscription.listener({ tick: boundaryTick, audioTime: audioTime + 1 });
    },
    cancelBoundary: (boundaryTick: number) => {
      const subscription = subscriptions.find((item) => item.active && item.scheduled && item.tick === boundaryTick);
      if (!subscription) throw new Error(`No pending boundary at ${boundaryTick}`);
      subscription.scheduled = false;
      subscription.listener({ tick: boundaryTick, audioTime: audioTime + 1, cancelled: true });
    },
  };
}

describe("Live Pad arrangement capture", () => {
  it("quantizes loop start and stop, captures it with a scene in one undoable command", () => {
    const h = makeHarness(true);
    const before = h.store.doc;
    const sceneId = before.scenes[0]!.id;
    h.capture.recordSceneLaunch(sceneId, 0);

    expect(h.capture.toggleLivePad(h.set.id, 0, h.trackId, 2)).toMatch(/Queued Capture Loop/);
    expect(h.subscriptions.map((item) => item.tick)).toContain(BAR_TICKS);
    h.fire(BAR_TICKS);
    expect(h.triggerAudioClip).toHaveBeenCalledWith(
      expect.objectContaining({ bufferId: "user.capture-loop", loop: true }),
      2,
      expect.stringMatching(/^live-pad-/),
      true,
    );

    h.setTick(BAR_TICKS + 96);
    expect(h.capture.toggleLivePad(h.set.id, 0, h.trackId, 2)).toMatch(/stop at bar 3/i);
    h.setAudioTime(8);
    h.fire(BAR_TICKS * 2);
    expect(h.stopLivePadVoice).toHaveBeenCalledWith(expect.stringMatching(/^live-pad-/), 9);

    h.setTick(BAR_TICKS * 2);
    expect(h.capture.finish()).toBe(true);
    const captured = h.store.doc.arrangement.audioClips?.find((clip) => clip.liveSetId === h.set.id);
    expect(captured).toMatchObject({
      bufferId: "user.capture-loop",
      livePadSlot: 0,
      loop: true,
      lengthBars: 1,
    });
    expect(h.store.doc.arrangement.clips.length).toBe(before.arrangement.clips.length + 1);
    expect(h.store.undoStackLength).toBe(1);
    h.store.undo();
    expect(h.store.doc).toEqual(before);
  });

  it("lets a second press cancel a pending start without leaving an arrangement clip", () => {
    const h = makeHarness(true);
    h.capture.toggleLivePad(h.set.id, 0, h.trackId, 2);
    expect(h.capture.toggleLivePad(h.set.id, 0, h.trackId, 2)).toMatch(/Cancelled the queued start/i);
    expect(h.cancelLivePadVoice).toHaveBeenCalledWith(expect.stringMatching(/^live-pad-/));
    expect(h.capture.finish()).toBe(false);
    expect((h.store.doc.arrangement.audioClips ?? []).some((clip) => clip.liveSetId === h.set.id)).toBe(false);
  });

  it("lets a repeated press cancel a queued loop stop", () => {
    const h = makeHarness(true);
    h.capture.toggleLivePad(h.set.id, 0, h.trackId, 2);
    h.fire(BAR_TICKS);
    h.setTick(BAR_TICKS + 24);
    h.capture.toggleLivePad(h.set.id, 0, h.trackId, 2);
    h.capture.toggleLivePad(h.set.id, 0, h.trackId, 2);
    expect(h.cancelLivePadStop).toHaveBeenCalledWith(expect.stringMatching(/^live-pad-/));
    expect(h.capture.getSnapshot().livePads[0]?.stopTick).toBeNull();
    h.capture.cancel();
  });

  it("restarts a pending voice after a scheduler time-map cancellation without duplicating its clip", () => {
    const h = makeHarness(true);
    h.capture.toggleLivePad(h.set.id, 0, h.trackId, 2);
    h.fire(BAR_TICKS);
    h.cancelBoundary(BAR_TICKS);
    h.setAudioTime(4);
    h.fire(BAR_TICKS);
    h.setTick(BAR_TICKS * 2);
    expect(h.capture.finish()).toBe(true);
    expect(h.triggerAudioClip).toHaveBeenCalledTimes(2);
    expect(h.store.doc.arrangement.audioClips?.filter((clip) => clip.liveSetId === h.set.id)).toHaveLength(1);
  });

  it("keeps one-shot pads finite and allows repeated hits to layer", () => {
    const h = makeHarness(false);
    h.capture.toggleLivePad(h.set.id, 0, h.trackId, 2);
    h.capture.toggleLivePad(h.set.id, 0, h.trackId, 2);
    h.fire(BAR_TICKS);
    h.fire(BAR_TICKS);
    expect(h.triggerAudioClip).toHaveBeenCalledTimes(2);
    expect(h.triggerAudioClip.mock.calls.every((call) => call[0].loop !== true && call[3] === false)).toBe(true);
    h.setTick(BAR_TICKS * 2);
    expect(h.capture.finish()).toBe(true);
    expect(h.store.doc.arrangement.audioClips?.filter((clip) => clip.liveSetId === h.set.id)).toHaveLength(2);
  });

  it("starts capture while stopped and allows different loop pads to layer", () => {
    const h = makeHarness(true);
    h.setPlaying(false);
    h.store.execute(
      assignLivePad(h.store.doc, h.set.id, {
        slot: 1,
        bufferId: "user.capture-loop-two",
        name: "Second Loop",
        bpm: 120,
        loop: true,
      }),
    );
    expect(h.capture.toggleLivePad(h.set.id, 0, h.trackId, 2)).toMatch(/Queued Capture Loop/);
    expect(h.capture.toggleLivePad(h.set.id, 1, h.trackId, 2)).toMatch(/Queued Second Loop/);
    expect(h.triggerAudioClip).not.toHaveBeenCalled();
    h.fire(BAR_TICKS);
    h.fire(BAR_TICKS);
    expect(h.triggerAudioClip).toHaveBeenCalledTimes(2);
    h.setTick(BAR_TICKS * 2);
    expect(h.capture.finish()).toBe(true);
    expect(h.store.doc.arrangement.audioClips?.filter((clip) => clip.liveSetId === h.set.id)).toHaveLength(2);
  });

  it("closes an interval on pause and keeps the capture session armed", () => {
    const h = makeHarness(true);
    h.capture.toggleLivePad(h.set.id, 0, h.trackId, 2);
    h.fire(BAR_TICKS);
    h.setTick(BAR_TICKS + 96);
    h.capture.pauseLivePads();
    expect(h.capture.getSnapshot().capturing).toBe(true);
    expect(h.capture.getSnapshot().livePads).toHaveLength(0);
    h.setTick(BAR_TICKS * 2);
    expect(h.capture.finish()).toBe(true);
    expect(h.store.doc.arrangement.audioClips?.find((clip) => clip.liveSetId === h.set.id)?.lengthBars).toBe(0.25);
  });

  it("discards pending and captured voices on cancel", () => {
    const h = makeHarness(true);
    h.capture.toggleLivePad(h.set.id, 0, h.trackId, 2);
    h.fire(BAR_TICKS);
    h.capture.cancel();
    expect(h.capture.getSnapshot().capturing).toBe(false);
    expect(h.cancelLivePadVoice).toHaveBeenCalledWith(expect.stringMatching(/^live-pad-/));
    expect((h.store.doc.arrangement.audioClips ?? []).some((clip) => clip.liveSetId === h.set.id)).toBe(false);
  });

  it("drops open loop intervals if the AudioEngine panics before FINISH", () => {
    const h = makeHarness(true);
    h.capture.toggleLivePad(h.set.id, 0, h.trackId, 2);
    h.fire(BAR_TICKS);
    h.panic();
    h.setTick(BAR_TICKS + 48);
    expect(h.capture.finish()).toBe(false);
    expect((h.store.doc.arrangement.audioClips ?? []).some((clip) => clip.liveSetId === h.set.id)).toBe(false);
  });
});
