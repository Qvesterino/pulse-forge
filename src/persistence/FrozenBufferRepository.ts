import { decodeAudioData } from "../services/audio-decode";
import { openDb, tx, STORE_FROZEN_AUDIO } from "./db";
import type { SampleBank } from "../sample-library/factory";
import type { ProjectDocument } from "../project-model/types";

export interface FrozenAudioEntry {
  id: string;
  /** WAV-encoded bytes of the rendered track. */
  data: ArrayBuffer;
  /**
   * Wave 2/D: signature of the document the buffer was rendered FROM (see
   * src/rendering/freezeSignature.ts). Absent on buffers frozen before this
   * field existed — those honestly report "unknown" staleness instead of
   * guessing. Stored beside the bytes, not in the document, because it
   * describes the BUFFER (a side artifact) and needs no schema migration.
   */
  signature?: string;
}

/**
 * Persistence for frozen-track audio (DB v6, `frozen-audio` store). The
 * project document only carries `track.frozen.bufferId` — the rendered audio
 * itself lives here so frozen tracks survive reloads. Without it, a reloaded
 * project would have frozen tracks with no buffer: permanently silent.
 */
export class FrozenBufferRepository {
  constructor(private readonly openDatabase: typeof openDb = openDb) {}

  async save(bufferId: string, data: ArrayBuffer, signature?: string): Promise<void> {
    try {
      const db = await this.openDatabase();
      await tx(db, STORE_FROZEN_AUDIO, "readwrite", (s) =>
        s.put({ id: bufferId, data, ...(signature ? { signature } : {}) } satisfies FrozenAudioEntry),
      );
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

  /**
   * Ids of all stored frozen buffers. The orphan-GC sweep only needs keys —
   * `list()` would materialize every rendered track's WAV bytes on every
   * project open just to read `entry.id`.
   */
  async listIds(): Promise<string[]> {
    try {
      const db = await this.openDatabase();
      const keys = await tx<IDBValidKey[]>(db, STORE_FROZEN_AUDIO, "readonly", (s) => s.getAllKeys());
      return (keys ?? []).map(String);
    } catch {
      return [];
    }
  }

  /**
   * Signature of every stored frozen buffer (Wave 2/D). Reads the record's
   * `signature` field through a cursor — `list()` would materialize every
   * rendered track's WAV bytes just to read one string, the same reason
   * `listIds` exists. Entries without a signature are omitted.
   */
  async listSignatures(): Promise<Array<{ id: string; signature: string }>> {
    const rows: Array<{ id: string; signature: string }> = [];
    try {
      const db = await this.openDatabase();
      await tx<void>(db, STORE_FROZEN_AUDIO, "readonly", (store) => {
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          const value = cursor.value as { id?: unknown; signature?: unknown } | undefined;
          if (typeof value?.id === "string" && typeof value.signature === "string" && value.signature !== "") {
            rows.push({ id: value.id, signature: value.signature });
          }
          cursor.continue();
        };
      });
    } catch {
      return [];
    }
    return rows;
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
  // Audio-decode platform contract (GOAL 03): the shared adapter keeps the
  // exact throwaway-OfflineAudioContext behavior and lets a non-Web-Audio
  // host inject its decoder once at boot.
  return decodeAudioData(data);
}
