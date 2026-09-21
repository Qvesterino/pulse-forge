import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PcmMicRecorder } from "../src/audio-engine/PcmMicRecorder";
import { RecordingRecoveryRepository } from "../src/persistence/RecordingRecoveryRepository";
import { openDb, STORE_RECORDING_CHUNKS, STORE_RECORDING_SESSIONS } from "../src/persistence/db";

/**
 * Chunk-ack protocol under ARTIFICIAL IDB LATENCY (GOAL 07).
 *
 * The recorder acknowledges a PCM block to the worklet only after the
 * IndexedDB transaction commits, and serializes writes through one chain.
 * These tests prove that contract stays intact when storage is slow:
 *   - acks arrive strictly in sequence order (no ack before the previous
 *     block committed),
 *   - slow-but-working storage is NOT misreported as a persistence failure,
 *   - stopping mid-flight (writes still pending) waits for the tail — every
 *     committed frame survives into the recoverable session.
 *
 * Self-contained harness (the concurrent session is actively editing
 * tests/pcm-mic-recorder.test.ts — do not couple to it).
 */

class SlowRecoveryRepo extends RecordingRecoveryRepository {
  constructor(private delayMs: number) {
    super();
  }
  private stall(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }
  override async begin(session: Parameters<RecordingRecoveryRepository["begin"]>[0]): Promise<void> {
    await this.stall();
    return super.begin(session);
  }
  override async appendChunk(chunk: Parameters<RecordingRecoveryRepository["appendChunk"]>[0]): Promise<void> {
    await this.stall();
    return super.appendChunk(chunk);
  }
  override async markRecoverable(sessionId: string): Promise<void> {
    await this.stall();
    return super.markRecoverable(sessionId);
  }
}

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

function createSlowRecorder(delayMs: number) {
  const recovery = new SlowRecoveryRepo(delayMs);
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
        // "ready" once the trim stage chains into the capture node.
        if (node === lastNode) queueMicrotask(() => lastNode?.emit({ type: "ready", channels: 1, sampleRate: 48_000 }));
      }),
      disconnect: vi.fn(),
    })),
    createAnalyser: vi.fn(() => ({ fftSize: 1024, getFloatTimeDomainData: vi.fn(), connect: vi.fn(), disconnect: vi.fn() })),
    createBuffer: (channels: number, frames: number, sampleRate: number) => ({
      numberOfChannels: channels,
      length: frames,
      sampleRate,
      duration: frames / sampleRate,
      getChannelData: () => new Float32Array(frames),
    }),
    resume: vi.fn(async () => {}),
  } as unknown as AudioContext;

  const onError = vi.fn();
  const recorder = new PcmMicRecorder({
    ctx: context,
    recovery,
    inputDeviceId: "",
    addWorkletModule: vi.fn(async () => {}),
    getUserMedia: vi.fn(async () => stream),
  });
  recorder.onError = onError;
  return { recorder, onError };
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


describe("PcmMicRecorder chunk-ack under IDB latency (GOAL 07)", () => {
  beforeEach(() => {
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    lastNode = null;
    await wipe();
  });

  it("acks stay in strict sequence order when storage is slower than the stream", async () => {
    const { recorder, onError } = createSlowRecorder(30);
    await recorder.start(() => ({
      projectId: "project-1",
      trackId: "vocal-1",
      trackName: "Lead Vocal",
      startBar: 2,
      bpm: 110,
    }));

    // Emit faster than the 30 ms per-append storage can commit.
    for (let sequence = 0; sequence < 6; sequence++) lastNode!.emit(chunk(sequence));

    // Let the write chain drain (6 blocks × 30 ms + slack).
    await new Promise((resolve) => setTimeout(resolve, 400));

    const acks = lastNode!.sent.filter((m) => m.type === "ack").map((m) => m.sequence);
    expect(acks).toEqual([0, 1, 2, 3, 4, 5]);
    // Slow-but-working storage must not be reported as a persistence failure.
    expect(onError).not.toHaveBeenCalled();

    const take = await recorder.stop();
    expect(take).not.toBeNull();
  });

  it("stop mid-flight waits for the write tail — no committed frame is lost", async () => {
    const { recorder } = createSlowRecorder(40);
    await recorder.start(() => ({
      projectId: "project-1",
      trackId: "vocal-1",
      trackName: "Lead Vocal",
      startBar: 2,
      bpm: 110,
    }));

    const BLOCKS = 5;
    const FRAMES = 4;
    for (let sequence = 0; sequence < BLOCKS; sequence++) lastNode!.emit(chunk(sequence, FRAMES));
    // Stop immediately — appends are still queuing through the 40 ms stalls.
    const take = await recorder.stop();
    expect(take).not.toBeNull();
    const sessionId = take!.session.id;

    const recovery = new RecordingRecoveryRepository();
    const session = await recovery.get(sessionId);
    expect(session).toBeDefined();
    expect(session!.totalFrames).toBe(BLOCKS * FRAMES);
    expect(session!.chunkCount).toBe(BLOCKS);
    expect(session!.status).toBe("recoverable");
    // The recovery read-back validation (forEachChunk) is the strictest
    // completeness check — it throws on any missing/unordered block.
    let visited = 0;
    await recovery.forEachChunk(sessionId, (c, offset) => {
      expect(offset).toBe(visited * FRAMES);
      expect(c.sequence).toBe(visited);
      visited++;
    });
    expect(visited).toBe(BLOCKS);
  });

  it("a persistence FAILURE during latency still stops cleanly and keeps committed blocks", async () => {
    // One shot repo: appendChunk throws after the first two blocks — the
    // recorder must flag persistenceError, stop, and keep blocks 0–1.
    class BrokenAfterTwo extends RecordingRecoveryRepository {
      private appends = 0;
      override async appendChunk(chunk: Parameters<RecordingRecoveryRepository["appendChunk"]>[0]): Promise<void> {
        this.appends++;
        if (this.appends > 2) throw new Error("QuotaExceededError (simulated)");
        return super.appendChunk(chunk);
      }
    }
    const recovery = new BrokenAfterTwo();
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
      createAnalyser: vi.fn(() => ({ fftSize: 1024, getFloatTimeDomainData: vi.fn(), connect: vi.fn(), disconnect: vi.fn() })),
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

    await recorder.start(() => ({
      projectId: "project-1",
      trackId: "vocal-1",
      trackName: "Lead Vocal",
      startBar: 2,
      bpm: 110,
    }));
    for (let sequence = 0; sequence < 5; sequence++) lastNode!.emit(chunk(sequence));
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(errors.join(" ")).toContain("Audio storage stopped");
    // Blocks 0–1 committed before the fault and remain recoverable.
    const sessions = await recovery.listRecoverable(Date.now());
    const mine = sessions.find((s) => s.trackName === "Lead Vocal");
    expect(mine).toBeDefined();
    expect(mine!.chunkCount).toBe(2);
    expect(mine!.totalFrames).toBe(8);
  });
});
