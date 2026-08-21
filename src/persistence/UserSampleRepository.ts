import { openDb, tx, STORE_USER_SAMPLES } from "./db";

export interface UserSampleAsset {
  id: string;
  name: string;
  fileName: string;
  category: "Custom";
  duration: number;
  sampleRate: number;
  channels: number;
  createdAt: string;
}

/**
 * Persistence for user-imported audio samples. Stores metadata in IndexedDB
 * alongside the existing project/preset/library stores. AudioBuffer data is
 * held in-memory via the SampleBank — this repo only handles the metadata
 * list so the SampleBrowser can show user samples without loading all buffers.
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

  async save(asset: UserSampleAsset): Promise<void> {
    this.cache = null;
    try {
      const db = await openDb();
      await tx(db, STORE_USER_SAMPLES, "readwrite", (s) => s.put(asset));
    } catch {
      // best-effort
    }
  }

  async remove(id: string): Promise<void> {
    this.cache = null;
    try {
      const db = await openDb();
      await tx(db, STORE_USER_SAMPLES, "readwrite", (s) => s.delete(id));
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
  const slug = fileName.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
  return `user.${slug}-${Date.now().toString(36)}`;
}
