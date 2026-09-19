import {
  openDb,
  tx,
  STORE_RECORDING_CHUNKS,
  STORE_RECORDING_SESSIONS,
  STORE_USER_SAMPLES,
  STORE_USER_SAMPLE_AUDIO,
} from "./db";
import type { PcmRecordingAudioRef, UserSampleAsset } from "./UserSampleRepository";

export interface RecordingSession {
  id: string;
  projectId: string;
  trackId: string;
  trackName: string;
  /** False for a standalone sample resample that was not armed onto a timeline lane. */
  placeOnTimeline?: boolean;
  startBar: number;
  bpm: number;
  sampleRate: number;
  channels: number;
  createdAt: string;
  /** Updated on each committed PCM block; lets another tab detect a crashed take. */
  updatedAt: number;
  status: "recording" | "recoverable";
  totalFrames: number;
  chunkCount: number;
}

export interface RecordingPcmChunk {
  sessionId: string;
  sequence: number;
  frames: number;
  /** One transferable, planar Float32 PCM block per channel. */
  channels: ArrayBuffer[];
}

const RECOVERY_STALE_MS = 5_000;

/**
 * Durable, append-only staging for live microphone takes. A chunk is only
 * acknowledged to the AudioWorklet after the IndexedDB transaction commits.
 * Finalizing a take atomically moves its metadata into the normal user-sample
 * stores while retaining the same bounded PCM blocks as the library payload.
 */
export class RecordingRecoveryRepository {
  constructor(private readonly openDatabase: typeof openDb = openDb) {}

  async begin(session: RecordingSession): Promise<void> {
    const db = await this.openDatabase();
    await tx(db, STORE_RECORDING_SESSIONS, "readwrite", (store) => store.add(session));
  }

  async appendChunk(chunk: RecordingPcmChunk): Promise<void> {
    if (!Number.isInteger(chunk.sequence) || chunk.sequence < 0) throw new Error("Invalid recording block sequence");
    if (!Number.isInteger(chunk.frames) || chunk.frames <= 0) throw new Error("Invalid recording block length");
    if (!Array.isArray(chunk.channels) || chunk.channels.length === 0)
      throw new Error("Recording block has no audio channels");
    for (const channel of chunk.channels) {
      if (!isArrayBuffer(channel) || channel.byteLength !== chunk.frames * Float32Array.BYTES_PER_ELEMENT)
        throw new Error("Recording block has an invalid PCM channel");
    }

    const db = await this.openDatabase();
    await tx(db, [STORE_RECORDING_SESSIONS, STORE_RECORDING_CHUNKS], "readwrite", (stores) => {
      const sessions = stores[STORE_RECORDING_SESSIONS];
      const chunks = stores[STORE_RECORDING_CHUNKS];
      const request = sessions.get(chunk.sessionId);
      request.onsuccess = () => {
        const session = request.result as RecordingSession | undefined;
        if (
          !session ||
          session.status !== "recording" ||
          chunk.sequence !== session.chunkCount ||
          chunk.channels.length !== session.channels ||
          chunk.frames > Math.max(128, Math.round(session.sampleRate))
        ) {
          request.transaction?.abort();
          return;
        }
        const nextFrames = session.totalFrames + chunk.frames;
        if (!Number.isSafeInteger(nextFrames)) {
          request.transaction?.abort();
          return;
        }
        chunks.add(chunk);
        sessions.put({
          ...session,
          totalFrames: nextFrames,
          chunkCount: session.chunkCount + 1,
          updatedAt: Date.now(),
        });
      };
    });
  }

  async markRecoverable(sessionId: string): Promise<void> {
    const db = await this.openDatabase();
    await tx(db, STORE_RECORDING_SESSIONS, "readwrite", (store) => {
      const request = store.get(sessionId);
      request.onsuccess = () => {
        const session = request.result as RecordingSession | undefined;
        if (session) store.put({ ...session, status: "recoverable", updatedAt: Date.now() });
      };
    });
  }

  async get(sessionId: string): Promise<RecordingSession | undefined> {
    const db = await this.openDatabase();
    return tx<RecordingSession | undefined>(db, STORE_RECORDING_SESSIONS, "readonly", (store) => store.get(sessionId));
  }

  /**
   * Only expose sessions that have audio and are known stopped or stale.
   * An actively recording second tab refreshes updatedAt once per block.
   */
  async listRecoverable(now = Date.now()): Promise<RecordingSession[]> {
    const db = await this.openDatabase();
    const sessions = await tx<RecordingSession[]>(db, STORE_RECORDING_SESSIONS, "readonly", (store) => store.getAll());
    return (sessions ?? [])
      .filter(
        (session) =>
          session.totalFrames > 0 && (session.status === "recoverable" || now - session.updatedAt >= RECOVERY_STALE_MS),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Visits blocks in order without loading the entire take into main-thread memory. */
  async forEachChunk(sessionId: string, visit: (chunk: RecordingPcmChunk, frameOffset: number) => void): Promise<void> {
    const session = await this.get(sessionId);
    if (!session) throw new Error("Recording recovery session was not found");
    await this.forEachPcmBlock(sessionId, session.chunkCount, session.totalFrames, session.channels, visit);
    const current = await this.get(sessionId);
    if (!current || current.chunkCount !== session.chunkCount || current.totalFrames !== session.totalFrames) {
      throw new Error("Recording recovery data changed while it was being read; the staged audio was kept");
    }
  }

  async materializeStoredSample(reference: PcmRecordingAudioRef): Promise<AudioBuffer> {
    if (typeof OfflineAudioContext === "undefined") throw new Error("OfflineAudioContext is unavailable");
    if (
      !Number.isInteger(reference.frames) ||
      reference.frames <= 0 ||
      !reference.recordingId ||
      !Number.isInteger(reference.chunkCount) ||
      reference.chunkCount <= 0 ||
      !Number.isInteger(reference.channels) ||
      reference.channels < 1 ||
      reference.channels > 32 ||
      !Number.isInteger(reference.sampleRate) ||
      reference.sampleRate < 8_000 ||
      reference.sampleRate > 384_000
    ) {
      throw new Error("Saved PCM recording metadata is invalid");
    }
    const context = new OfflineAudioContext(1, 1, reference.sampleRate);
    let buffer: AudioBuffer;
    try {
      buffer = context.createBuffer(reference.channels, reference.frames, reference.sampleRate);
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      throw new Error(`Saved recording is too large to restore into memory${detail}`);
    }
    await this.forEachPcmBlock(
      reference.recordingId,
      reference.chunkCount,
      reference.frames,
      reference.channels,
      (chunk, offset) => {
        if (chunk.channels.length !== buffer.numberOfChannels || offset + chunk.frames > buffer.length) {
          throw new Error("Saved PCM recording block dimensions are invalid");
        }
        for (let channel = 0; channel < chunk.channels.length; channel++) {
          buffer.getChannelData(channel).set(new Float32Array(chunk.channels[channel]), offset);
        }
      },
    );
    return buffer;
  }

  private async forEachPcmBlock(
    ownerId: string,
    expectedChunks: number,
    expectedFrames: number,
    expectedChannels: number,
    visit: (chunk: RecordingPcmChunk, frameOffset: number) => void,
  ): Promise<void> {
    const db = await this.openDatabase();
    let expectedSequence = 0;
    let frameOffset = 0;
    let visitFailure: unknown;
    await tx(db, STORE_RECORDING_CHUNKS, "readonly", (store) => {
      const cursorRequest = store.index("by-session").openCursor(IDBKeyRange.only(ownerId));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const chunk = cursor.value as RecordingPcmChunk;
        const chunkValid =
          chunk.sessionId === ownerId &&
          chunk.sequence === expectedSequence &&
          Number.isInteger(chunk.frames) &&
          chunk.frames > 0 &&
          Array.isArray(chunk.channels) &&
          chunk.channels.length === expectedChannels &&
          chunk.channels.every(
            (channel) => isArrayBuffer(channel) && channel.byteLength === chunk.frames * Float32Array.BYTES_PER_ELEMENT,
          ) &&
          Number.isSafeInteger(frameOffset + chunk.frames) &&
          frameOffset + chunk.frames <= expectedFrames;
        if (!chunkValid) {
          visitFailure = new Error("Recording PCM data has an invalid, missing, or out-of-order block");
          cursorRequest.transaction?.abort();
          return;
        }
        try {
          visit(chunk, frameOffset);
          expectedSequence++;
          frameOffset += chunk.frames;
          cursor.continue();
        } catch (error) {
          visitFailure = error;
          cursorRequest.transaction?.abort();
        }
      };
    }).catch((error) => {
      if (visitFailure) throw visitFailure;
      throw error;
    });

    if (expectedSequence !== expectedChunks || frameOffset !== expectedFrames) {
      throw new Error("Recording PCM data is incomplete; the original audio was kept");
    }
  }

  /**
   * Atomically promote staged PCM to the regular sample library. If storage
   * fails, the session and all its blocks remain available for another retry.
   */
  async finalize(sessionId: string, asset: UserSampleAsset): Promise<void> {
    const db = await this.openDatabase();
    await tx(
      db,
      [STORE_RECORDING_SESSIONS, STORE_RECORDING_CHUNKS, STORE_USER_SAMPLES, STORE_USER_SAMPLE_AUDIO],
      "readwrite",
      (stores) => {
        const sessions = stores[STORE_RECORDING_SESSIONS];
        const request = sessions.get(sessionId);
        request.onsuccess = () => {
          const session = request.result as RecordingSession | undefined;
          if (!session || session.totalFrames <= 0) {
            request.transaction?.abort();
            return;
          }
          stores[STORE_USER_SAMPLES].put(asset);
          stores[STORE_USER_SAMPLE_AUDIO].put({
            id: asset.id,
            data: {
              kind: "pcm-f32-planar-v1",
              recordingId: session.id,
              frames: session.totalFrames,
              chunkCount: session.chunkCount,
              sampleRate: session.sampleRate,
              channels: session.channels,
            } satisfies PcmRecordingAudioRef,
          });
          sessions.delete(sessionId);
        };
      },
    );
  }

  async removePcmSample(assetId: string, reference: PcmRecordingAudioRef): Promise<void> {
    const db = await this.openDatabase();
    await tx(
      db,
      [STORE_RECORDING_SESSIONS, STORE_RECORDING_CHUNKS, STORE_USER_SAMPLES, STORE_USER_SAMPLE_AUDIO],
      "readwrite",
      (stores) => {
        stores[STORE_USER_SAMPLES].delete(assetId);
        stores[STORE_USER_SAMPLE_AUDIO].delete(assetId);
        stores[STORE_RECORDING_SESSIONS].delete(reference.recordingId);
        const chunks = stores[STORE_RECORDING_CHUNKS];
        for (let sequence = 0; sequence < reference.chunkCount; sequence++) {
          chunks.delete([reference.recordingId, sequence]);
        }
      },
    );
  }

  async remove(sessionId: string): Promise<void> {
    const db = await this.openDatabase();
    await tx(db, [STORE_RECORDING_SESSIONS, STORE_RECORDING_CHUNKS], "readwrite", (stores) => {
      const sessions = stores[STORE_RECORDING_SESSIONS];
      const chunks = stores[STORE_RECORDING_CHUNKS];
      const request = sessions.get(sessionId);
      request.onsuccess = () => {
        const session = request.result as RecordingSession | undefined;
        sessions.delete(sessionId);
        if (session) {
          for (let sequence = 0; sequence < session.chunkCount; sequence++) chunks.delete([sessionId, sequence]);
          return;
        }
        const keysRequest = chunks.index("by-session").getAllKeys(IDBKeyRange.only(sessionId));
        keysRequest.onsuccess = () => {
          for (const key of keysRequest.result) chunks.delete(key);
        };
      };
    });
  }
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  // IndexedDB returns structured clones that can originate in another realm;
  // instanceof ArrayBuffer is false for those otherwise-valid PCM payloads.
  return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}
