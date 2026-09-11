import { openDb, tx, STORE_FROZEN_AUDIO } from "./db";
import type { SampleBank } from "../sample-library/factory";
import type { ProjectDocument } from "../project-model/types";

interface FrozenAudioEntry {
  id: string;
  /** WAV-encoded bytes of the rendered track. */
  data: ArrayBuffer;
}

/**
 * Persistence for frozen-track audio (DB v6, `frozen-audio` store). The
 * project document only carries `track.frozen.bufferId` — the rendered audio
 * itself lives here so frozen tracks survive reloads. Without it, a reloaded
 * project would have frozen tracks with no buffer: permanently silent.
 */
export class FrozenBufferRepository {
  constructor(private readonly openDatabase: typeof openDb = openDb) {}

  async save(bufferId: string, data: ArrayBuffer): Promise<void> {
    try {
      const db = await this.openDatabase();
      await tx(db, STORE_FROZEN_AUDIO, "readwrite", (s) => s.put({ id: bufferId, data } satisfies FrozenAudioEntry));
    } catch (error) {
      // A freeze is not complete until its rendered bytes are durable. The
      // old best-effort catch made the UI mark a track frozen even though a
      // reload would leave it permanently silent. Let the caller surface a
      // retryable error while keeping the in-session audio available.
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not persist frozen audio for ${bufferId}: ${detail}`);
    }
  }

  async load(bufferId: string): Promise<ArrayBuffer | undefined> {
    try {
      const db = await this.openDatabase();
      const entry = await tx<FrozenAudioEntry | undefined>(db, STORE_FROZEN_AUDIO, "readonly", (s) => s.get(bufferId));
      return entry?.data;
    } catch {
      return undefined;
    }
  }

  async remove(bufferId: string): Promise<void> {
    try {
      const db = await this.openDatabase();
      await tx(db, STORE_FROZEN_AUDIO, "readwrite", (s) => s.delete(bufferId));
    } catch {
      // best-effort
    }
  }

  async list(): Promise<FrozenAudioEntry[]> {
    try {
      const db = await this.openDatabase();
      const all = await tx<FrozenAudioEntry[]>(db, STORE_FROZEN_AUDIO, "readonly", (s) => s.getAll());
      return all ?? [];
    } catch {
      return [];
    }
  }
}

/**
 * Restore frozen-track audio into the bank after a reload.
 * Returns the bufferIds that could NOT be restored — callers should unfreeze
 * those tracks so they play live instead of staying silent.
 */
export async function restoreFrozenTracks(
  doc: ProjectDocument,
  bank: SampleBank,
  repo: FrozenBufferRepository = new FrozenBufferRepository(),
  decode: (data: ArrayBuffer) => Promise<AudioBuffer> = defaultDecodeAudioBytes,
): Promise<string[]> {
  const missing: string[] = [];
  const frozen = doc.tracks.filter((t) => "frozen" in t && t.frozen);
  for (const track of frozen) {
    const bufferId = track.frozen!.bufferId;
    if (bank.has(bufferId)) continue;
    const data = await repo.load(bufferId);
    if (!data) {
      missing.push(bufferId);
      continue;
    }
    try {
      bank.add(bufferId, await decode(data));
    } catch (err) {
      console.warn(`[freeze] failed to decode frozen buffer ${bufferId}:`, err);
      missing.push(bufferId);
    }
  }
  return missing;
}

function defaultDecodeAudioBytes(data: ArrayBuffer): Promise<AudioBuffer> {
  if (typeof OfflineAudioContext === "undefined") {
    return Promise.reject(new Error("OfflineAudioContext unavailable"));
  }
  // decodeAudioData only needs the context's machinery, not a running one —
  // a minimal OfflineAudioContext keeps restore independent of the live
  // engine (and of autoplay-gesture state).
  const ctx = new OfflineAudioContext(1, 1, 44100);
  return ctx.decodeAudioData(data);
}
