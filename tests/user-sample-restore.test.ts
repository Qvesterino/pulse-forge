import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordingRecoveryRepository, type RecordingSession } from "../src/persistence/RecordingRecoveryRepository";
import {
  restoreUserSampleAudio,
  retryUserSampleRestore,
  UserSampleRepository,
  type UserSampleRestoreReport,
} from "../src/persistence/UserSampleRepository";
import { openDb, tx, STORE_RECORDING_CHUNKS } from "../src/persistence/db";

/**
 * A TAKE THAT CAME BACK SILENT MUST SAY SO (audit S-3).
 *
 * The boot restore was fire-and-forget AND silent: a sample that could not be
 * decoded was logged and skipped, so the recorded take that used it was
 * PERMANENTLY SILENT — the user pressed play, heard nothing, and had no way
 * to learn that the app had thrown their audio away.
 *
 * Two things have to hold now:
 *
 * 1. THE FAILURE IS REPORTED. The restore returns what did not come back, by
 *    name, with the reason. A silent skip is a lie about the user's data.
 * 2. A DAMAGED RECORDING IS NOT ALL-OR-NOTHING. The PCM materialization used
 *    to reject a recording the moment ONE block was invalid or missing — so a
 *    recording that lost its last two seconds lost ALL of it. The tolerant
 *    path restores the valid PREFIX and reports the truncation, and the
 *    STRICT path (the promotion into the library) still rejects the whole
 *    recording: a half-written file must not enter the library as if it were
 *    complete.
 */

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

/** A fake OfflineAudioContext whose buffers behave like the real ones. */
function stubOfflineAudioContext(): void {
  vi.stubGlobal(
    "OfflineAudioContext",
    class {
      createBuffer(channelCount: number, frames: number, sampleRate: number): AudioBuffer {
        const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
        return {
          numberOfChannels: channelCount,
          length: frames,
          sampleRate,
          duration: frames / sampleRate,
          getChannelData: (channel: number) => channels[channel],
        } as unknown as AudioBuffer;
      }
    },
  );
}

async function wipe(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      [STORE_RECORDING_CHUNKS, "user-samples", "user-sample-audio", "recording-sessions"],
      "readwrite",
    );
    for (const name of [STORE_RECORDING_CHUNKS, "user-samples", "user-sample-audio", "recording-sessions"]) {
      tx.objectStore(name).clear();
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Promote a two-block PCM recording into the user library. */
async function stageRecording(id: string): Promise<{ recordingId: string; frames: number }> {
  const take = session(id);
  await recovery.begin(take);
  await recovery.appendChunk(block(take.id, 0, [1, 2, 3, 4], [-1, -2, -3, -4]));
  await recovery.appendChunk(block(take.id, 1, [5, 6], [-5, -6]));
  await recovery.markRecoverable(take.id);
  await recovery.finalize(take.id, {
    id: `user.${id}`,
    name: `Take ${id}`,
    fileName: `user.${id}.wav`,
    category: "Custom",
    duration: 6 / 48_000,
    sampleRate: 48_000,
    channels: 2,
    createdAt: new Date().toISOString(),
  });
  return { recordingId: take.id, frames: 6 };
}

/** Delete one PCM block — the recording's tail is gone. */
async function damageTail(recordingId: string): Promise<void> {
  const db = await openDb();
  await tx(db, STORE_RECORDING_CHUNKS, "readwrite", (store) => {
    const request = store.index("by-session").openCursor(IDBKeyRange.only(recordingId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (cursor.value.sequence === 1) cursor.delete();
      else cursor.continue();
    };
  });
}

function fakeBank(): { add: (id: string, buffer: AudioBuffer) => void; ids: string[] } {
  const ids: string[] = [];
  return {
    ids,
    add: (id: string) => {
      ids.push(id);
    },
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await wipe();
});

describe("the restore reports what did not come back", () => {
  it("a sample that fails to decode is named, with its reason — and stays out of the bank", async () => {
    await samples.save(
      {
        id: "user.broken",
        name: "Broken Take",
        fileName: "broken.wav",
        category: "Custom",
        duration: 1,
        sampleRate: 48_000,
        channels: 1,
        createdAt: new Date().toISOString(),
      },
      new ArrayBuffer(16),
    );
    const bank = fakeBank();

    const report = await restoreUserSampleAudio(bank as never, async () => {
      throw new Error("the decoder said no");
    });

    expect(report.restored).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatchObject({
      id: "user.broken",
      name: "Broken Take",
      reason: "the decoder said no",
      partial: false,
    });
    expect(bank.ids, "a sample that did not come back must not be in the bank").toEqual([]);
  });

  it("a sample that comes back whole is reported as restored", async () => {
    await samples.save(
      {
        id: "user.good",
        name: "Good Take",
        fileName: "good.wav",
        category: "Custom",
        duration: 1,
        sampleRate: 48_000,
        channels: 1,
        createdAt: new Date().toISOString(),
      },
      new ArrayBuffer(16),
    );
    const bank = fakeBank();
    stubOfflineAudioContext();

    const report = await restoreUserSampleAudio(bank as never, async () => {
      const context = new OfflineAudioContext(1, 1, 48_000);
      return context.createBuffer(1, 8, 48_000);
    });

    expect(report.restored).toEqual(["user.good"]);
    expect(report.failed).toEqual([]);
    expect(bank.ids).toEqual(["user.good"]);
  });
});

describe("a damaged recording keeps what survived", () => {
  it("the valid prefix is restored, and the truncation is reported", async () => {
    stubOfflineAudioContext();
    const { recordingId, frames } = await stageRecording("recording-partial");
    await damageTail(recordingId);
    const bank = fakeBank();

    const report = await restoreUserSampleAudio(bank as never, async () => {
      throw new Error("the compressed decoder must not be used for chunked PCM");
    });

    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatchObject({
      id: "user.recording-partial",
      name: "Take recording-partial",
      partial: true,
    });
    expect(report.failed[0]?.restoredSeconds).toBeGreaterThan(0);
    expect(bank.ids, "the audio that survived must still play").toEqual(["user.recording-partial"]);
    expect(frames).toBe(6);
  });

  it("a recording whose blocks are all gone does not enter the bank", async () => {
    stubOfflineAudioContext();
    const { recordingId } = await stageRecording("recording-lost");
    await damageTail(recordingId);
    const db = await openDb();
    await tx(db, STORE_RECORDING_CHUNKS, "readwrite", (store) => {
      store.clear();
    });
    const bank = fakeBank();

    const report = await restoreUserSampleAudio(bank as never, async () => {
      throw new Error("the compressed decoder must not be used for chunked PCM");
    });

    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.partial).toBe(false);
    expect(bank.ids).toEqual([]);
  });

  it("the STRICT path still rejects the whole recording — a half-written file must not enter the library", async () => {
    stubOfflineAudioContext();
    const { recordingId } = await stageRecording("recording-strict");
    await damageTail(recordingId);
    const reference = (await samples.loadAudio("user.recording-strict")) as {
      kind: string;
      recordingId: string;
      frames: number;
      chunkCount: number;
      sampleRate: number;
      channels: number;
    };

    await expect(recovery.materializeStoredSample(reference as never)).rejects.toThrow();
  });
});

describe("the retry re-runs only what failed", () => {
  it("and it reports what came back this time", async () => {
    await samples.save(
      {
        id: "user.flaky",
        name: "Flaky Take",
        fileName: "flaky.wav",
        category: "Custom",
        duration: 1,
        sampleRate: 48_000,
        channels: 1,
        createdAt: new Date().toISOString(),
      },
      new ArrayBuffer(16),
    );
    const bank = fakeBank();
    stubOfflineAudioContext();
    let attempts = 0;

    const report: UserSampleRestoreReport = await restoreUserSampleAudio(bank as never, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("the decoder was not ready yet");
      const context = new OfflineAudioContext(1, 1, 48_000);
      return context.createBuffer(1, 8, 48_000);
    });
    expect(report.failed).toHaveLength(1);

    const retried = await retryUserSampleRestore(bank as never, ["user.flaky"], async () => {
      const context = new OfflineAudioContext(1, 1, 48_000);
      return context.createBuffer(1, 8, 48_000);
    });

    expect(retried.restored).toEqual(["user.flaky"]);
    expect(retried.failed).toEqual([]);
    expect(bank.ids).toEqual(["user.flaky"]);
  });
});
