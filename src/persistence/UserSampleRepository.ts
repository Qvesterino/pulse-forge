import { openDb, tx, STORE_USER_SAMPLES, STORE_USER_SAMPLE_AUDIO } from "./db";
import type { SampleBank } from "../sample-library/factory";
import { RecordingRecoveryRepository } from "./RecordingRecoveryRepository";

export interface UserSampleAsset {
  id: string;
  name: string;
  fileName: string;
  category: "Custom";
  duration: number;
  sampleRate: number;
  channels: number;
  createdAt: string;
  /**
   * Detected tempo in BPM (0.1 precision), measured once at import time.
   * Optional — samples imported before tempo detection simply lack it, and
   * loops without a steady pulse never get one.
   */
  bpm?: number;
}

export interface UserSampleAudio {
  id: string;
  /** Encoded file bytes, or a durable chunked Float32 recording reference. */
  data: ArrayBuffer | Blob | PcmRecordingAudioRef;
}

export interface PcmRecordingAudioRef {
  kind: "pcm-f32-planar-v1";
  recordingId: string;
  frames: number;
  chunkCount: number;
  sampleRate: number;
  channels: number;
}

export function isPcmRecordingAudio(value: UserSampleAudio["data"]): value is PcmRecordingAudioRef {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PcmRecordingAudioRef>;
  return (
    candidate.kind === "pcm-f32-planar-v1" &&
    typeof candidate.recordingId === "string" &&
    Number.isSafeInteger(candidate.frames) &&
    Number.isInteger(candidate.chunkCount) &&
    Number.isInteger(candidate.sampleRate) &&
    Number.isInteger(candidate.channels)
  );
}

/**
 * Persistence for user-imported audio samples. Metadata lives in the
 * `user-samples` store so the SampleBrowser can list user samples without
 * loading any audio. Imported files keep their encoded bytes in
 * `user-sample-audio`; microphone recordings store a reference to committed
 * Float32 PCM blocks there and retain those blocks in the recording store.
 * Both formats restore into the SampleBank through `restoreUserSampleAudio`.
 */
export class UserSampleRepository {
  private cache: UserSampleAsset[] | null = null;

  /** Recording finalization writes the sample row in a larger atomic transaction. */
  invalidateCache(): void {
    this.cache = null;
  }

  async list(): Promise<UserSampleAsset[]> {
    if (this.cache) return this.cache;
    try {
      const db = await openDb();
      const all = await tx(db, STORE_USER_SAMPLES, "readonly", (s) => s.getAll());
      this.cache = (all as UserSampleAsset[]) ?? [];
      return this.cache;
    } catch {
      // Transient failure (blocked open, quota hiccup): do NOT cache an empty
      // list — the user's samples must not appear deleted for the rest of the
      // session. A later successful call repopulates the cache.
      return [];
    }
  }

  async save(asset: UserSampleAsset, data?: ArrayBuffer | Blob): Promise<void> {
    this.cache = null;
    const db = await openDb();
    // Capture the prior metadata row: on the overwrite path a blind rollback
    // delete would destroy a previously-good sample listing while its old
    // audio bytes stay orphaned in user-sample-audio.
    const prev = await tx<UserSampleAsset | undefined>(
      db,
      STORE_USER_SAMPLES,
      "readonly",
      (s) => s.get(asset.id) as IDBRequest<UserSampleAsset | undefined>,
    );
    await tx(db, STORE_USER_SAMPLES, "readwrite", (s) => s.put(asset));
    if (!data) return;
    try {
      await tx(db, STORE_USER_SAMPLE_AUDIO, "readwrite", (s) =>
        s.put({ id: asset.id, data } satisfies UserSampleAudio),
      );
    } catch (err) {
      // Metadata without audio is a PERMANENT ghost sample: listed forever,
      // silently silent after reload. Restore the previous row (or remove the
      // fresh one when nothing existed) and surface the failure so importers
      // can show an error instead.
      try {
        if (prev) {
          await tx(db, STORE_USER_SAMPLES, "readwrite", (s) => s.put(prev));
        } else {
          await tx(db, STORE_USER_SAMPLES, "readwrite", (s) => s.delete(asset.id));
        }
      } catch {
        // rollback best-effort
      }
      this.cache = null;
      throw err instanceof Error ? err : new Error(`Failed to persist sample audio for ${asset.id}`);
    }
  }

  async loadAudio(id: string): Promise<ArrayBuffer | Blob | PcmRecordingAudioRef | undefined> {
    try {
      const db = await openDb();
      const entry = await tx<UserSampleAudio | undefined>(db, STORE_USER_SAMPLE_AUDIO, "readonly", (s) => s.get(id));
      return entry?.data;
    } catch {
      return undefined;
    }
  }

  async listAudio(): Promise<UserSampleAudio[]> {
    try {
      const db = await openDb();
      const all = await tx(db, STORE_USER_SAMPLE_AUDIO, "readonly", (s) => s.getAll());
      return (all as UserSampleAudio[]) ?? [];
    } catch {
      return [];
    }
  }

  async remove(id: string): Promise<void> {
    this.cache = null;
    try {
      const db = await openDb();
      const audio = await tx<UserSampleAudio | undefined>(db, STORE_USER_SAMPLE_AUDIO, "readonly", (store) =>
        store.get(id),
      );
      if (audio && isPcmRecordingAudio(audio.data)) {
        await new RecordingRecoveryRepository().removePcmSample(id, audio.data);
        return;
      }
      await tx(db, STORE_USER_SAMPLES, "readwrite", (s) => s.delete(id));
      await tx(db, STORE_USER_SAMPLE_AUDIO, "readwrite", (s) => s.delete(id));
    } catch {
      // best-effort
    }
  }
}

/**
 * Decode an audio File/Blob into an AudioBuffer using the Web Audio API.
 */
/** Generate a unique ID for a user sample. */
export function userSampleId(fileName: string): string {
  const slug = fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .toLowerCase();
  return `user.${slug}-${Date.now().toString(36)}`;
}

/**
 * Decode persisted user-sample audio back into the SampleBank after a reload.
 * Fire-and-forget: the app runs fine before this completes — samples simply
 * become playable as they finish decoding. Decoding runs on a throwaway
 * OfflineAudioContext so no AudioContext unlock is needed; decoded buffers
 * carry their own sample rate and play correctly from the live engine.
 */
export async function restoreUserSampleAudio(
  bank: SampleBank,
  decode: (data: ArrayBuffer) => Promise<AudioBuffer> = defaultDecodeAudioBytes,
  restorePcm: (reference: PcmRecordingAudioRef) => Promise<AudioBuffer> = (reference) =>
    new RecordingRecoveryRepository().materializeStoredSample(reference),
): Promise<void> {
  const repo = new UserSampleRepository();
  const entries = await repo.listAudio();
  for (const { id, data } of entries) {
    try {
      const restored = isPcmRecordingAudio(data)
        ? await restorePcm(data)
        : await decode(isBlob(data) ? await data.arrayBuffer() : (data as ArrayBuffer));
      bank.add(id, restored);
    } catch (err) {
      console.warn(`[user-samples] failed to restore ${id}:`, err);
    }
  }
}

function isBlob(value: ArrayBuffer | Blob): value is Blob {
  // IndexedDB structured clones may come from another realm, so instanceof
  // Blob is not a reliable discriminator (notably in embedded webviews).
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Blob).arrayBuffer === "function" &&
    typeof (value as Blob).size === "number" &&
    typeof (value as Blob).type === "string"
  );
}

function defaultDecodeAudioBytes(data: ArrayBuffer): Promise<AudioBuffer> {
  if (typeof OfflineAudioContext === "undefined") {
    return Promise.reject(new Error("OfflineAudioContext unavailable"));
  }
  // decodeAudioData only needs the context's machinery, not a running one —
  // a minimal OfflineAudioContext at 44.1 kHz keeps restore independent of
  // the live engine (and of autoplay-gesture state).
  const ctx = new OfflineAudioContext(1, 1, 44100);
  return ctx.decodeAudioData(data);
}
