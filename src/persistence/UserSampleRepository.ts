import { openDb, tx, STORE_USER_SAMPLES, STORE_USER_SAMPLE_AUDIO } from "./db";
import type { SampleBank } from "../sample-library/factory";

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
  /** Original encoded file bytes (WAV/MP3/OGG/…) — decoded back into the SampleBank on boot. */
  data: ArrayBuffer;
}

/**
 * Persistence for user-imported audio samples. Metadata lives in the
 * `user-samples` store so the SampleBrowser can list user samples without
 * loading any audio; the original encoded bytes live in `user-sample-audio`
 * (added in DB v5) and are decoded back into the in-memory SampleBank at
 * boot via `restoreUserSampleAudio` so imports survive reloads.
 */
export class UserSampleRepository {
  private cache: UserSampleAsset[] | null = null;

  async list(): Promise<UserSampleAsset[]> {
    if (this.cache) return this.cache;
    try {
      const db = await openDb();
      const all = await tx(db, STORE_USER_SAMPLES, "readonly", (s) => s.getAll());
      this.cache = (all as UserSampleAsset[]) ?? [];
      return this.cache;
    } catch {
      this.cache = [];
      return this.cache;
    }
  }

  async save(asset: UserSampleAsset, data?: ArrayBuffer): Promise<void> {
    this.cache = null;
    const db = await openDb();
    await tx(db, STORE_USER_SAMPLES, "readwrite", (s) => s.put(asset));
    if (!data) return;
    try {
      await tx(db, STORE_USER_SAMPLE_AUDIO, "readwrite", (s) =>
        s.put({ id: asset.id, data } satisfies UserSampleAudio),
      );
    } catch (err) {
      // Metadata without audio is a PERMANENT ghost sample: listed forever,
      // silently silent after reload. Roll the metadata row back and surface
      // the failure so importers can show an error instead.
      try {
        await tx(db, STORE_USER_SAMPLES, "readwrite", (s) => s.delete(asset.id));
      } catch {
        // rollback best-effort
      }
      this.cache = null;
      throw err instanceof Error ? err : new Error(`Failed to persist sample audio for ${asset.id}`);
    }
  }

  async loadAudio(id: string): Promise<ArrayBuffer | undefined> {
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
export async function decodeAudioFile(file: File | Blob, ctx: BaseAudioContext): Promise<AudioBuffer> {
  const arrayBuffer = await file.arrayBuffer();
  return ctx.decodeAudioData(arrayBuffer);
}

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
): Promise<void> {
  const repo = new UserSampleRepository();
  const entries = await repo.listAudio();
  for (const { id, data } of entries) {
    try {
      bank.add(id, await decode(data));
    } catch (err) {
      console.warn(`[user-samples] failed to restore ${id}:`, err);
    }
  }
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
