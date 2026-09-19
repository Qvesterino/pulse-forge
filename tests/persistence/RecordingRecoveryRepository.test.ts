import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordingRecoveryRepository, type RecordingSession } from "../../src/persistence/RecordingRecoveryRepository";
import { restoreUserSampleAudio, UserSampleRepository } from "../../src/persistence/UserSampleRepository";
import { openDb, tx, STORE_RECORDING_CHUNKS, STORE_RECORDING_SESSIONS } from "../../src/persistence/db";
import { materializePcmTake } from "../../src/audio-engine/pcmRecording";

const recovery = new RecordingRecoveryRepository();
const samples = new UserSampleRepository();

function session(id: string): RecordingSession {
  return {
    id,
    projectId: "project-1",
    trackId: "track-1",
    trackName: "Lead Vocal",
    startBar: 3,
    bpm: 96,
    sampleRate: 48_000,
    channels: 2,
    createdAt: new Date().toISOString(),
    updatedAt: Date.now(),
    status: "recording",
    totalFrames: 0,
    chunkCount: 0,
  };
}

function block(sessionId: string, sequence: number, left: number[], right: number[]) {
  return {
    sessionId,
    sequence,
    frames: left.length,
    channels: [new Float32Array(left).buffer, new Float32Array(right).buffer],
  };
}

async function wipe(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      [STORE_RECORDING_SESSIONS, STORE_RECORDING_CHUNKS, "user-samples", "user-sample-audio"],
      "readwrite",
    );
    for (const name of [STORE_RECORDING_SESSIONS, STORE_RECORDING_CHUNKS, "user-samples", "user-sample-audio"])
      tx.objectStore(name).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await wipe();
});

describe("RecordingRecoveryRepository", () => {
  it("commits ordered PCM blocks and exposes a stopped session for recovery", async () => {
    const take = session("recording-a");
    await recovery.begin(take);
    await recovery.appendChunk(block(take.id, 0, [0.1, 0.2], [-0.1, -0.2]));
    await recovery.appendChunk(block(take.id, 1, [0.3], [-0.3]));
    await recovery.markRecoverable(take.id);

    await expect(recovery.listRecoverable()).resolves.toMatchObject([
      { id: take.id, status: "recoverable", totalFrames: 3, chunkCount: 2 },
    ]);
    const visited: Array<[number, number]> = [];
    await recovery.forEachChunk(take.id, (chunk, offset) => visited.push([chunk.sequence, offset]));
    expect(visited).toEqual([
      [0, 0],
      [1, 2],
    ]);
  });

  it("rejects a sequence gap without changing the durable session", async () => {
    const take = session("recording-gap");
    await recovery.begin(take);
    await expect(recovery.appendChunk(block(take.id, 1, [0], [0]))).rejects.toThrow();
    await expect(recovery.get(take.id)).resolves.toMatchObject({ totalFrames: 0, chunkCount: 0 });
  });

  it("rejects PCM blocks whose channel layout differs from the recording session", async () => {
    const take = session("recording-channel-mismatch");
    await recovery.begin(take);
    await expect(
      recovery.appendChunk({
        sessionId: take.id,
        sequence: 0,
        frames: 1,
        channels: [new Float32Array([0.25]).buffer],
      }),
    ).rejects.toThrow();
    await expect(recovery.get(take.id)).resolves.toMatchObject({ totalFrames: 0, chunkCount: 0 });
  });

  it("materializes exact float PCM and atomically promotes it to a user sample", async () => {
    const take = session("recording-finalize");
    await recovery.begin(take);
    await recovery.appendChunk(block(take.id, 0, [1.25, -0.75], [-1.5, 0.5]));
    await recovery.markRecoverable(take.id);

    const channels = [new Float32Array(2), new Float32Array(2)];
    const context = {
      createBuffer: (channelCount: number, frames: number, sampleRate: number) => {
        expect([channelCount, frames, sampleRate]).toEqual([2, 2, 48_000]);
        return {
          numberOfChannels: channelCount,
          length: frames,
          sampleRate,
          duration: frames / sampleRate,
          getChannelData: (channel: number) => channels[channel],
        } as unknown as AudioBuffer;
      },
    } as unknown as BaseAudioContext;
    const rendered = await materializePcmTake(recovery, take.id, context);
    expect(Array.from(channels[0])).toEqual([1.25, -0.75]);
    expect(Array.from(channels[1])).toEqual([-1.5, 0.5]);

    await recovery.finalize(take.id, {
      id: "user.recovered-test",
      name: "Recovered vocal",
      fileName: "user.recovered-test.wav",
      category: "Custom",
      duration: rendered.buffer.duration,
      sampleRate: rendered.buffer.sampleRate,
      channels: rendered.buffer.numberOfChannels,
      createdAt: new Date().toISOString(),
    });

    expect(await recovery.get(take.id)).toBeUndefined();
    await expect(recovery.listRecoverable()).resolves.toEqual([]);
    const savedAudio = await samples.loadAudio("user.recovered-test");
    expect(savedAudio).toMatchObject({
      kind: "pcm-f32-planar-v1",
      recordingId: take.id,
      frames: 2,
      chunkCount: 1,
      sampleRate: 48_000,
      channels: 2,
    });
    expect((await samples.list()).map((asset) => asset.id)).toContain("user.recovered-test");

    const restored: Array<[string, AudioBuffer]> = [];
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        createBuffer(channelCount: number, frames: number, sampleRate: number): AudioBuffer {
          const restoredChannels = Array.from({ length: channelCount }, () => new Float32Array(frames));
          return {
            numberOfChannels: channelCount,
            length: frames,
            sampleRate,
            duration: frames / sampleRate,
            getChannelData: (channel: number) => restoredChannels[channel],
          } as unknown as AudioBuffer;
        }
      },
    );
    await restoreUserSampleAudio(
      { add: (id: string, buffer: AudioBuffer) => restored.push([id, buffer]) } as any,
      async () => {
        throw new Error("Chunked PCM must not go through a compressed-file decoder");
      },
    );
    expect(restored).toHaveLength(1);
    expect(Array.from(restored[0][1].getChannelData(0))).toEqual([1.25, -0.75]);
    expect(Array.from(restored[0][1].getChannelData(1))).toEqual([-1.5, 0.5]);

    await samples.remove("user.recovered-test");
    expect(await samples.loadAudio("user.recovered-test")).toBeUndefined();
    const db = await openDb();
    await expect(
      tx(db, STORE_RECORDING_CHUNKS, "readonly", (store) => store.get([take.id, 0])),
    ).resolves.toBeUndefined();
  });
});
