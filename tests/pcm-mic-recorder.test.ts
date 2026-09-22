import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PcmMicRecorder } from "../src/audio-engine/PcmMicRecorder";
import { RecordingRecoveryRepository } from "../src/persistence/RecordingRecoveryRepository";
import { openDb, STORE_RECORDING_CHUNKS, STORE_RECORDING_SESSIONS } from "../src/persistence/db";

let lastNode: FakeWorkletNode | null = null;
let acknowledgeStop = true;

class FakeWorkletNode {
  sent: Array<Record<string, unknown>> = [];
  options: Record<string, unknown> | undefined;
  onprocessorerror: (() => void) | null = null;
  port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (message: Record<string, unknown>) => {
      this.sent.push(message);
      if (message.type === "stop" && acknowledgeStop) queueMicrotask(() => this.emit({ type: "stopped" }));
    },
    close: vi.fn(),
  };

  constructor(...args: unknown[]) {
    this.options = args[2] as Record<string, unknown> | undefined;
    lastNode = this;
  }

  connect = vi.fn();
  disconnect = vi.fn();

  emit(data: unknown): void {
    this.port.onmessage?.({ data } as MessageEvent);
  }
}

function createRecorder(
  options: { deferMicrophonePermission?: boolean; inputDeviceId?: string; inputGainDb?: number } = {},
) {
  const recovery = new RecordingRecoveryRepository();
  const track = new EventTarget() as MediaStreamTrack;
  Object.defineProperty(track, "readyState", { value: "live" });
  track.stop = vi.fn();
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  let resolveMicrophonePermission: ((value: MediaStream) => void) | null = null;
  const microphonePermission = options.deferMicrophonePermission
    ? new Promise<MediaStream>((resolve) => {
        resolveMicrophonePermission = resolve;
      })
    : Promise.resolve(stream);
  const getUserMedia = vi.fn(() => microphonePermission);
  const source = {
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const gains: Array<{
    gain: { value: number; cancelScheduledValues: ReturnType<typeof vi.fn>; setTargetAtTime: ReturnType<typeof vi.fn> };
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  const samples = [new Float32Array(0)];
  const contextStateEvents = new EventTarget();
  const context = {
    state: "running",
    sampleRate: 48_000,
    currentTime: 1,
    destination: {},
    audioWorklet: {},
    addEventListener: contextStateEvents.addEventListener.bind(contextStateEvents),
    removeEventListener: contextStateEvents.removeEventListener.bind(contextStateEvents),
    createMediaStreamSource: vi.fn(() => source),
    createGain: vi.fn(() => {
      const gain = {
        gain: { value: 1, cancelScheduledValues: vi.fn(), setTargetAtTime: vi.fn() },
        // "ready" fires once the trim stage chains into the capture node:
        // source → trim gain → worklet (post-trim graph complete).
        connect: vi.fn((node: unknown) => {
          if (node === lastNode)
            queueMicrotask(() => lastNode?.emit({ type: "ready", channels: 1, sampleRate: 48_000 }));
        }),
        disconnect: vi.fn(),
      };
      gains.push(gain);
      return gain;
    }),
    createAnalyser: vi.fn(() => ({
      fftSize: 1024,
      getFloatTimeDomainData: vi.fn((target: Float32Array) => {
        const frame = (context as unknown as { __analyserFrame?: Float32Array }).__analyserFrame;
        if (frame) target.set(frame.subarray(0, Math.min(frame.length, target.length)));
      }),
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
    createBuffer: (channels: number, frames: number, sampleRate: number) => {
      expect([channels, frames, sampleRate]).toEqual([1, 2, 48_000]);
      samples[0] = new Float32Array(frames);
      return {
        numberOfChannels: channels,
        length: frames,
        sampleRate,
        duration: frames / sampleRate,
        getChannelData: () => samples[0],
      } as unknown as AudioBuffer;
    },
    resume: vi.fn(async () => {}),
  } as unknown as AudioContext;

  const recorder = new PcmMicRecorder({
    ctx: context,
    recovery,
    inputDeviceId: options.inputDeviceId ?? "",
    inputGainDb: options.inputGainDb,
    addWorkletModule: vi.fn(async () => {}),
    getUserMedia,
  });
  const metadata = () => ({
    projectId: "project-1",
    trackId: "vocal-1",
    trackName: "Lead Vocal",
    placeOnTimeline: true,
    startBar: 2,
    bpm: 110,
    recordingInputOffsetMs: 17,
  });
  const changeContextState = (state: string) => {
    (context as unknown as { state: string }).state = state;
    contextStateEvents.dispatchEvent(new Event("statechange"));
  };
  return {
    recorder,
    recovery,
    metadata,
    samples,
    track,
    source,
    gains,
    context,
    changeContextState,
    getUserMedia,
    resolveMicrophonePermission: () => resolveMicrophonePermission?.(stream),
  };
}

async function waitForAck(node: FakeWorkletNode): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (node.sent.some((message) => message.type === "ack")) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("PCM block was not acknowledged after persistence");
}

async function clearRecordingStores(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([STORE_RECORDING_SESSIONS, STORE_RECORDING_CHUNKS], "readwrite");
    transaction.objectStore(STORE_RECORDING_SESSIONS).clear();
    transaction.objectStore(STORE_RECORDING_CHUNKS).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  lastNode = null;
  acknowledgeStop = true;
  await clearRecordingStores();
});

describe("PcmMicRecorder", () => {
  it("pins the requested microphone instead of silently recording from the system default", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    const { recorder, metadata, getUserMedia } = createRecorder({ inputDeviceId: "interface-input-2" });
    await recorder.start(metadata);

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        deviceId: { exact: "interface-input-2" },
      },
    });
    await recorder.cancel();
  });

  it("explains when a previously selected microphone is no longer available", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    const { recorder, metadata, getUserMedia } = createRecorder({ inputDeviceId: "removed-input" });
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error("No device"), { name: "NotFoundError" }));

    await expect(recorder.start(metadata)).rejects.toThrow(/selected microphone is unavailable/i);
    expect(recorder.state).toBe("idle");
  });

  it("keeps a cancelled permission request from overlapping a new take", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    const { recorder, metadata, track, getUserMedia, resolveMicrophonePermission } = createRecorder({
      deferMicrophonePermission: true,
    });
    const pendingStart = recorder.start(metadata);
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());

    await recorder.cancel();
    expect(recorder.state).toBe("idle");
    await expect(recorder.start(metadata)).rejects.toThrow(/start is still settling/i);
    expect(getUserMedia).toHaveBeenCalledOnce();

    resolveMicrophonePermission();
    await expect(pendingStart).rejects.toThrow(/cancelled/i);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(recorder.state).toBe("idle");
  });

  it("records Float32 PCM, waits for durable block acknowledgement, and marks the take recoverable", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    const { recorder, recovery, metadata, samples, track, source, gains } = createRecorder();
    await recorder.start(metadata);
    expect(recorder.state).toBe("recording");
    expect(lastNode?.options).toMatchObject({ processorOptions: { chunkFrames: 24_000 } });
    expect(gains[1].gain.value).toBe(0); // direct monitoring is opt-in
    recorder.setMonitoring(true);
    expect(gains[1].gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 1, 0.01);
    // source → trim (gains[2]) → worklet + monitor (gains[1])
    expect(source.connect).toHaveBeenCalledWith(gains[2]);
    expect(gains[2].connect).toHaveBeenCalledWith(lastNode);
    expect(gains[2].connect).toHaveBeenCalledWith(gains[1]);
    expect(lastNode?.sent).toContainEqual({ type: "start" });

    const pcm = new Float32Array([0.25, -1.25]);
    lastNode!.emit({ type: "chunk", sequence: 0, frames: 2, channels: [pcm.buffer] });
    await waitForAck(lastNode!);
    const take = await recorder.stop();

    expect(take?.session.trackName).toBe("Lead Vocal");
    expect(take?.session.recordingInputOffsetMs).toBe(17);
    expect(Array.from(samples[0])).toEqual([0.25, -1.25]);
    await expect(recovery.get(take!.session.id)).resolves.toMatchObject({ status: "recoverable", totalFrames: 2 });
    expect(track.stop).toHaveBeenCalledOnce();
    expect(source.disconnect).toHaveBeenCalledOnce();
    expect(gains[0].disconnect).toHaveBeenCalledOnce();
    expect(gains[1].disconnect).toHaveBeenCalledOnce();
    expect(gains[2].disconnect).toHaveBeenCalled();
  });

  it("keeps committed audio staged when the panel cancels/unmounts", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    const { recorder, recovery, metadata } = createRecorder();
    await recorder.start(metadata);
    const pcm = new Float32Array([0.5, 0.75]);
    lastNode!.emit({ type: "chunk", sequence: 0, frames: 2, channels: [pcm.buffer] });
    await waitForAck(lastNode!);
    const sessionId = (await recovery.listRecoverable())[0]?.id;
    // The active session is deliberately hidden from recovery while its
    // committed-block heartbeat is fresh.
    expect(sessionId).toBeUndefined();

    await recorder.cancel();
    await expect(recovery.listRecoverable()).resolves.toMatchObject([{ totalFrames: 2, status: "recoverable" }]);
  });

  it("honors monitoring enabled before capture starts and cleans up the dry route", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    const { recorder, metadata, gains, track } = createRecorder();
    recorder.setMonitoring(true);
    await recorder.start(metadata);

    expect(gains[1].gain.value).toBe(1);
    await recorder.cancel();
    expect(gains[1].disconnect).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("stops itself on microphone loss and preserves committed PCM for recovery", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    const { recorder, recovery, metadata, track } = createRecorder();
    const onError = vi.fn();
    recorder.onError = onError;
    await recorder.start(metadata);

    const pcm = new Float32Array([0.125, -0.25]);
    lastNode!.emit({ type: "chunk", sequence: 0, frames: 2, channels: [pcm.buffer] });
    await waitForAck(lastNode!);
    track.dispatchEvent(new Event("ended"));

    for (let i = 0; i < 30 && recorder.state !== "idle"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(recorder.state).toBe("idle");
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/microphone disconnected/i));
    await expect(recovery.listRecoverable()).resolves.toMatchObject([{ totalFrames: 2, status: "recoverable" }]);
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("stops and preserves the take when the AudioContext is suspended", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    const { recorder, recovery, metadata, track, changeContextState } = createRecorder();
    const onError = vi.fn();
    recorder.onError = onError;
    await recorder.start(metadata);

    lastNode!.emit({ type: "chunk", sequence: 0, frames: 2, channels: [new Float32Array([0.25, -0.5]).buffer] });
    await waitForAck(lastNode!);
    changeContextState("suspended");

    const take = await recorder.stop();
    expect(take?.session.totalFrames).toBe(2);
    expect(onError).toHaveBeenCalledWith(
      expect.stringMatching(/audio context became suspended.*uncommitted buffer may be incomplete/i),
    );
    await expect(recovery.get(take!.session.id)).resolves.toMatchObject({ status: "recoverable", totalFrames: 2 });
    expect(recorder.state).toBe("idle");
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("stops and preserves the take when the microphone track is muted", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    const { recorder, recovery, metadata, track } = createRecorder();
    const onError = vi.fn();
    recorder.onError = onError;
    await recorder.start(metadata);

    lastNode!.emit({ type: "chunk", sequence: 0, frames: 2, channels: [new Float32Array([0.125, -0.25]).buffer] });
    await waitForAck(lastNode!);
    track.dispatchEvent(new Event("mute"));

    const take = await recorder.stop();
    expect(take?.session.totalFrames).toBe(2);
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/microphone input was interrupted/i));
    await expect(recovery.get(take!.session.id)).resolves.toMatchObject({ status: "recoverable", totalFrames: 2 });
    expect(recorder.state).toBe("idle");
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("refuses to start when the microphone is already muted", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    const { recorder, recovery, metadata, track } = createRecorder();
    Object.defineProperty(track, "muted", { value: true });

    await expect(recorder.start(metadata)).rejects.toThrow(/not delivering audio/i);

    expect(recorder.state).toBe("idle");
    expect(track.stop).toHaveBeenCalledOnce();
    await expect(recovery.listRecoverable()).resolves.toEqual([]);
  });

  it("warns when the worklet never confirms its final flush and keeps committed PCM recoverable", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    const { recorder, recovery, metadata, samples, track } = createRecorder();
    const onError = vi.fn();
    recorder.onError = onError;
    await recorder.start(metadata);

    const pcm = new Float32Array([0.25, -0.5]);
    lastNode!.emit({ type: "chunk", sequence: 0, frames: 2, channels: [pcm.buffer] });
    await waitForAck(lastNode!);
    acknowledgeStop = false;

    const take = await recorder.stop();

    expect(take?.session.totalFrames).toBe(2);
    expect(Array.from(samples[0])).toEqual([0.25, -0.5]);
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/final tail may be incomplete/i));
    await expect(recovery.get(take!.session.id)).resolves.toMatchObject({ status: "recoverable", totalFrames: 2 });
    expect(recorder.state).toBe("idle");
    expect(track.stop).toHaveBeenCalledOnce();
  }, 5_000);

  it("cleans up and preserves recovery data if the worklet port rejects the stop command", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    const { recorder, recovery, metadata, track } = createRecorder();
    const onError = vi.fn();
    recorder.onError = onError;
    await recorder.start(metadata);

    const pcm = new Float32Array([0.125, -0.25]);
    lastNode!.emit({ type: "chunk", sequence: 0, frames: 2, channels: [pcm.buffer] });
    await waitForAck(lastNode!);
    const originalPostMessage = lastNode!.port.postMessage;
    lastNode!.port.postMessage = (message) => {
      if (message.type === "stop") throw new Error("AudioWorklet port is closed");
      originalPostMessage(message);
    };

    const take = await recorder.stop();

    expect(take?.session.totalFrames).toBe(2);
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/could not confirm its stop command/i));
    await expect(recovery.get(take!.session.id)).resolves.toMatchObject({ status: "recoverable", totalFrames: 2 });
    expect(recorder.state).toBe("idle");
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("applies the input trim to the capture graph and reports it back", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    const { recorder, metadata, gains } = createRecorder({ inputGainDb: -6 });
    await recorder.start(metadata);
    // gains[2] is the pre-capture trim stage (mute/monitor are gains[0]/[1]).
    expect(gains[2].gain.value).toBeCloseTo(Math.pow(10, -6 / 20), 5);
    expect(recorder.inputGain).toBe(-6);
    recorder.setInputGainDb(3.7);
    expect(recorder.inputGain).toBe(3.7);
    expect(gains[2].gain.setTargetAtTime).toHaveBeenLastCalledWith(Math.pow(10, 3.7 / 20), 1, 0.01);
    await recorder.cancel();
  });

  it("clamps the input trim to the UI range and ignores non-finite values", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    const { recorder, metadata } = createRecorder();
    expect(recorder.inputGain).toBe(0);
    recorder.setInputGainDb(100);
    expect(recorder.inputGain).toBe(12);
    recorder.setInputGainDb(-100);
    expect(recorder.inputGain).toBe(-24);
    recorder.setInputGainDb(Number.NaN);
    expect(recorder.inputGain).toBe(0);
    await recorder.start(metadata);
    expect(recorder.inputGain).toBe(0);
    await recorder.cancel();
  });

  it("reads input peak/RMS from the post-trim tap, 0 when unwired", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    const { recorder, metadata, context } = createRecorder();
    expect(recorder.getInputLevel()).toEqual({ peak: 0, rms: 0 });
    // Wire a fake analyser that reports a fixed frame.
    const frame = new Float32Array([0, 0.5, -0.25, 0.125]);
    (context as unknown as { __analyserFrame?: Float32Array }).__analyserFrame = frame;
    await recorder.start(metadata);
    const level = recorder.getInputLevel();
    expect(level.peak).toBeCloseTo(0.5, 5);
    // RMS runs over the full 1024-frame analyser window (mostly zeros here).
    expect(level.rms).toBeCloseTo(Math.sqrt((0.25 + 0.0625 + 0.015625) / 1024), 8);
    await recorder.cancel();
    expect(recorder.getInputLevel()).toEqual({ peak: 0, rms: 0 });
  });

  it("allows only one live mic capture per tab across recorder instances", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    // ArrangementPanel take and ExportPanel resample build independent recorders;
    // the second must be refused while the first holds the microphone.
    const first = createRecorder();
    await first.recorder.start(first.metadata);
    expect(first.recorder.state).toBe("recording");

    const second = createRecorder();
    await expect(second.recorder.start(second.metadata)).rejects.toThrow(/already in use/i);
    expect(second.recorder.state).toBe("idle");
    expect(second.getUserMedia).not.toHaveBeenCalled();

    await first.recorder.cancel();
    expect(first.recorder.state).toBe("idle");

    // Freeing the claim lets the next take capture.
    await second.recorder.start(second.metadata);
    expect(second.recorder.state).toBe("recording");
    await second.recorder.cancel();
  });

  it("gives up when the audio context never resumes and frees the mic claim", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    const first = createRecorder();
    const suspended = first.context as unknown as { state: string; resume: () => Promise<void> };
    suspended.state = "suspended";
    suspended.resume = () => new Promise<void>(() => {});

    vi.useFakeTimers();
    try {
      const pending = first.recorder.start(first.metadata);
      const rejection = expect(pending).rejects.toThrow(/did not resume/i);
      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
    expect(first.recorder.state).toBe("idle");

    // The failed start must not hold the microphone forever.
    const second = createRecorder();
    await second.recorder.start(second.metadata);
    expect(second.recorder.state).toBe("recording");
    await second.recorder.cancel();
  });
});
