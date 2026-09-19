import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PcmMicRecorder } from "../src/audio-engine/PcmMicRecorder";
import { RecordingRecoveryRepository } from "../src/persistence/RecordingRecoveryRepository";
import { openDb, STORE_RECORDING_CHUNKS, STORE_RECORDING_SESSIONS } from "../src/persistence/db";

let lastNode: FakeWorkletNode | null = null;

class FakeWorkletNode {
  sent: Array<Record<string, unknown>> = [];
  onprocessorerror: (() => void) | null = null;
  port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (message: Record<string, unknown>) => {
      this.sent.push(message);
      if (message.type === "stop") queueMicrotask(() => this.emit({ type: "stopped" }));
    },
    close: vi.fn(),
  };

  constructor() {
    lastNode = this;
  }

  connect = vi.fn();
  disconnect = vi.fn();

  emit(data: unknown): void {
    this.port.onmessage?.({ data } as MessageEvent);
  }
}

function createRecorder() {
  const recovery = new RecordingRecoveryRepository();
  const track = new EventTarget() as MediaStreamTrack;
  Object.defineProperty(track, "readyState", { value: "live" });
  track.stop = vi.fn();
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  const source = {
    connect: (node: FakeWorkletNode) =>
      queueMicrotask(() => node.emit({ type: "ready", channels: 1, sampleRate: 48_000 })),
    disconnect: vi.fn(),
  };
  const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  const samples = [new Float32Array(0)];
  const context = {
    state: "running",
    sampleRate: 48_000,
    currentTime: 1,
    destination: {},
    audioWorklet: {},
    createMediaStreamSource: vi.fn(() => source),
    createGain: vi.fn(() => gain),
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
    addWorkletModule: vi.fn(async () => {}),
    getUserMedia: vi.fn(async () => stream),
  });
  const metadata = () => ({
    projectId: "project-1",
    trackId: "vocal-1",
    trackName: "Lead Vocal",
    placeOnTimeline: true,
    startBar: 2,
    bpm: 110,
  });
  return { recorder, recovery, metadata, samples, track, source, gain };
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
  await clearRecordingStores();
});

describe("PcmMicRecorder", () => {
  it("records Float32 PCM, waits for durable block acknowledgement, and marks the take recoverable", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    const { recorder, recovery, metadata, samples, track, source, gain } = createRecorder();
    await recorder.start(metadata);
    expect(recorder.state).toBe("recording");
    expect(lastNode?.sent).toContainEqual({ type: "start" });

    const pcm = new Float32Array([0.25, -1.25]);
    lastNode!.emit({ type: "chunk", sequence: 0, frames: 2, channels: [pcm.buffer] });
    await waitForAck(lastNode!);
    const take = await recorder.stop();

    expect(take?.session.trackName).toBe("Lead Vocal");
    expect(Array.from(samples[0])).toEqual([0.25, -1.25]);
    await expect(recovery.get(take!.session.id)).resolves.toMatchObject({ status: "recoverable", totalFrames: 2 });
    expect(track.stop).toHaveBeenCalledOnce();
    expect(source.disconnect).toHaveBeenCalledOnce();
    expect(gain.disconnect).toHaveBeenCalledOnce();
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
});
