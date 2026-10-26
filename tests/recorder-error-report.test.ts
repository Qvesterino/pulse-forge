// Audit R-4: a recorder must report EVERY error, not only the first.
//
// The first error stopped the capture; a LATER error — the storage failing
// while the capture unwinds — used to be dropped by `if (this.errorReported)
// return;`. The take was then explained by the wrong cause, and the reason
// it is SHORT (the storage) was never told.
//
// The teeth probe: restore the early return in `reportError` and the RED case
// below goes green again.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PcmMicRecorder } from "../src/audio-engine/PcmMicRecorder";
import {
  RecordingRecoveryRepository,
  RecordingStorageQuotaError,
} from "../src/persistence/RecordingRecoveryRepository";
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
  connect = vi.fn();
  disconnect = vi.fn();

  constructor() {
    lastNode = this;
  }

  emit(data: unknown): void {
    this.port.onmessage?.({ data } as MessageEvent);
  }
}

/** A repo whose storage fails on the first block — the take cannot be saved. */
class FailingRepo extends RecordingRecoveryRepository {
  override async appendChunk(_chunk: Parameters<RecordingRecoveryRepository["appendChunk"]>[0]): Promise<void> {
    throw new RecordingStorageQuotaError("Browser storage filled during recording");
  }
}

function createRecorder() {
  const recovery = new FailingRepo();
  const track = new EventTarget() as MediaStreamTrack;
  Object.defineProperty(track, "readyState", { value: "live" });
  track.stop = vi.fn();
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  const context = {
    state: "running",
    sampleRate: 48_000,
    currentTime: 1,
    destination: {},
    audioWorklet: {},
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
    createGain: vi.fn(() => ({
      gain: { value: 1, cancelScheduledValues: vi.fn(), setTargetAtTime: vi.fn() },
      connect: vi.fn((node: unknown) => {
        if (node === lastNode) queueMicrotask(() => lastNode?.emit({ type: "ready", channels: 1, sampleRate: 48_000 }));
      }),
      disconnect: vi.fn(),
    })),
    createAnalyser: vi.fn(() => ({
      fftSize: 1024,
      getFloatTimeDomainData: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
    createBuffer: (channels: number, frames: number, sampleRate: number) => ({
      numberOfChannels: channels,
      length: frames,
      sampleRate,
      duration: frames / sampleRate,
      getChannelData: () => new Float32Array(frames),
    }),
    resume: vi.fn(async () => {}),
  } as unknown as AudioContext;

  const errors: string[] = [];
  const recorder = new PcmMicRecorder({
    ctx: context,
    recovery,
    inputDeviceId: "",
    addWorkletModule: vi.fn(async () => {}),
    getUserMedia: vi.fn(async () => stream),
  });
  recorder.onError = (message) => errors.push(message);
  return { recorder, errors, track };
}

function chunk(sequence: number, frames = 4) {
  return {
    type: "chunk",
    sequence,
    frames,
    channels: [new Float32Array(frames).map((_, i) => (i + 1) * 0.1).buffer],
  };
}

async function wipe(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction([STORE_RECORDING_SESSIONS, STORE_RECORDING_CHUNKS], "readwrite");
    t.objectStore(STORE_RECORDING_SESSIONS).clear();
    t.objectStore(STORE_RECORDING_CHUNKS).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

describe("recorder error reporting (audit R-4)", () => {
  beforeEach(() => {
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    lastNode = null;
    await wipe();
  });

  it("reports the LATER storage failure, not only the first interruption", async () => {
    const { recorder, errors, track } = createRecorder();
    await recorder.start(() => ({
      projectId: "project-1",
      trackId: "vocal-1",
      trackName: "Lead Vocal",
      startBar: 2,
      bpm: 110,
    }));

    // The input is interrupted first — this is what stopped the capture.
    track.dispatchEvent(new Event("ended"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Audio input disconnected");

    // The storage then fails while the capture unwinds: THIS is why the take
    // is short, and it used to be swallowed.
    lastNode!.emit(chunk(0));

    const deadline = Date.now() + 5_000;
    while (errors.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(errors).toHaveLength(2);
    expect(errors[1]).toContain("browser storage is full");
    // The earlier cause stays visible next to the later one.
    expect(errors[1]).toContain("Earlier: Audio input disconnected");
  });

  it("keeps every reported error in the recorder's error list", async () => {
    const { recorder, track } = createRecorder();
    await recorder.start(() => ({
      projectId: "project-1",
      trackId: "vocal-1",
      trackName: "Lead Vocal",
      startBar: 2,
      bpm: 110,
    }));

    track.dispatchEvent(new Event("ended"));
    lastNode!.emit(chunk(0));

    const deadline = Date.now() + 5_000;
    while (recorder.errors.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(recorder.errors).toHaveLength(2);
    expect(recorder.errors[0]).toContain("Audio input disconnected");
    expect(recorder.errors[1]).toContain("browser storage is full");
  });

  it("reports a single error unchanged when nothing follows it", async () => {
    const { recorder, errors, track } = createRecorder();
    await recorder.start(() => ({
      projectId: "project-1",
      trackId: "vocal-1",
      trackName: "Lead Vocal",
      startBar: 2,
      bpm: 110,
    }));

    track.dispatchEvent(new Event("ended"));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Audio input disconnected");
    expect(errors[0]).not.toContain("Earlier:");
  });
});
