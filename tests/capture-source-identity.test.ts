// Audit R-2: the recorded source must BE the source that is displayed.
//
// In native WASAPI mode the recorder opens the Windows endpoint the I/O panel
// chose and IGNORES the browser's `audio.deviceId` constraint — so the device
// dropdown named one microphone while another one recorded. The recorder has
// to NAME the source that really captured, and the recording offset has to be
// looked up under THAT source.
//
// The teeth probe: make the recorder report the SELECTED device in the native
// path (or make `getSnapshotFor` ignore the requested source) and the RED case
// below goes green again.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PcmMicRecorder, NATIVE_CAPTURE_SOURCE_PREFIX } from "../src/audio-engine/PcmMicRecorder";
import { RecordingAlignmentController, recordingAlignmentStorageKey } from "../src/audio-engine/recordingAlignment";
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
  connect = vi.fn();
  disconnect = vi.fn();

  constructor() {
    lastNode = this;
  }

  emit(data: unknown): void {
    this.port.onmessage?.({ data } as MessageEvent);
  }
}

function fakeContext() {
  return {
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
}

function fakeStream() {
  const track = new EventTarget() as MediaStreamTrack;
  Object.defineProperty(track, "readyState", { value: "live" });
  track.stop = vi.fn();
  return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
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

describe("the capture source is the source that is displayed (audit R-2)", () => {
  beforeEach(() => {
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    lastNode = null;
    await wipe();
  });

  it("the browser path reports the SELECTED device as the capture source", async () => {
    const recorder = new PcmMicRecorder({
      ctx: fakeContext(),
      recovery: new RecordingRecoveryRepository(),
      inputDeviceId: "mic-a",
      addWorkletModule: vi.fn(async () => {}),
      getUserMedia: vi.fn(async () => fakeStream()),
    });

    expect(recorder.captureSource).toBe("");
    await recorder.start(() => ({
      projectId: "project-1",
      trackId: "vocal-1",
      trackName: "Lead Vocal",
      startBar: 0,
      bpm: 120,
    }));

    expect(recorder.captureSource).toBe("mic-a");
    await recorder.cancel();
  });

  it("a native capture source is namespaced, so it can never collide with a browser device", () => {
    // The Windows endpoint id and the browser device id are different id
    // spaces; the prefix keeps them apart.
    expect(NATIVE_CAPTURE_SOURCE_PREFIX).toBe("wasapi:");
    expect(`${NATIVE_CAPTURE_SOURCE_PREFIX}{0.0.0.00000000}.{GUID}`).not.toBe("{0.0.0.00000000}.{GUID}");
  });

  it("the offset is read for the source that ACTUALLY recorded, not for the selected one", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    const controller = new RecordingAlignmentController(storage, () => "mic-a");
    controller.setOffsetMs(42);

    // The browser device the dropdown names has its own calibration…
    expect(controller.getSnapshotFor("mic-a")).toBe(42);
    // …and the native endpoint that really recorded does NOT inherit it.
    expect(controller.getSnapshotFor(`${NATIVE_CAPTURE_SOURCE_PREFIX}{0.0.0.0}.{GUID}`)).toBe(0);
    // The controller's own state is untouched by the read.
    expect(controller.getSnapshot()).toBe(42);
  });

  it("a native endpoint with its own calibration gets THAT one", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    const nativeId = `${NATIVE_CAPTURE_SOURCE_PREFIX}{0.0.0.0}.{GUID}`;
    values.set(recordingAlignmentStorageKey(nativeId), "17");
    const controller = new RecordingAlignmentController(storage, () => "mic-a");

    expect(controller.getSnapshotFor(nativeId)).toBe(17);
    expect(controller.getSnapshot()).toBe(0);
  });
});
