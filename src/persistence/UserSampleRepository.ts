import { decodeAudioData } from "../services/audio-decode";
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
   * Detected or user-corrected loop tempo in BPM (0.1 precision).
   * Optional — samples without a reliable pulse can be assigned one in the
   * loop metadata editor; clearing it disables tempo-aware matching.
   */
  bpm?: number;
  /** User-authored loop catalog metadata; stored with the sample row, not in project state. */
  loopMetadata?: {
    /** Explicit false lets users exclude a tempo-detected file from the loop catalog. */
    isLoop?: boolean;
    genre?: string;
    mood?: string;
    instrument?: string;
    key?: string;
  };
  /** Optional provenance for generated audio; absent means imported/recorded user audio. */
  origin?: "generated";
  generated?: {
    providerId: string;
    modelId: string;
    inputHash: string;
    sourceHash?: string;
    prompt?: string;
    providerVersion?: string;
  };
  /** First-party optional sample pack that supplied this asset. */
  factoryPack?: {
    id: string;
    version: number;
    license: "kyx-original";
    creator: string;
  };
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
    // Order matters: write AUDIO FIRST, then metadata. The previous order
    // (metadata then audio) could leave a ghost metadata row listed in the
    // sample browser with no audio bytes — invisible to the user as broken,
    // but a permanent dead row in the library until manual cleanup. Reversing
    // the order means the worst-case failure is an orphaned audio blob that
    // never appears in the library (the user sees no broken sample) and can
    // be pruned by a later sweep.
    if (data) {
      await tx(db, STORE_USER_SAMPLE_AUDIO, "readwrite", (s) =>
        s.put({ id: asset.id, data } satisfies UserSampleAudio),
      );
    }
    await tx(db, STORE_USER_SAMPLES, "readwrite", (s) => s.put(asset));
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

/** Stable sample identity for a recording session, so retry/recovery repairs the same clip reference. */
export function recordedTakeSampleId(recordingId: string): string {
  const slug = recordingId
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("Recording ID is required to create a stable sample ID");
  return `user.recording-${slug}`;
}

/**
 * One sample that could not be restored — or only partly restored.
 *
 * The failure is REPORTED, never swallowed. A silent skip is what turned a
 * damaged recording into a permanently silent take with no explanation
 * (audit S-3): the user pressed play, heard nothing, and had no way to learn
 * that the app had thrown their audio away.
 */
export interface UserSampleRestoreFailure {
  id: string;
  /** The sample's name, when the library still knows it. */
  name: string | null;
  /** Why it could not be restored. */
  reason: string;
  /** True when SOME of the audio survived — a truncated recording. */
  partial: boolean;
  /** How much survived, in seconds (partial restores only). */
  restoredSeconds?: number;
}

/** What the boot restore managed. */
export interface UserSampleRestoreReport {
  /** The samples that came back whole. */
  restored: string[];
  /** The samples that did not. */
  failed: UserSampleRestoreFailure[];
}

/**
 * Decode persisted user-sample audio back into the SampleBank after a reload.
 * Fire-and-forget for the app (it runs fine before this completes — samples
 * simply become playable as they finish decoding), but NOT silent: the
 * outcome is RETURNED, so the caller can tell the user which takes are not
 * coming back.
 *
 * Decoding runs on a throwaway OfflineAudioContext so no AudioContext unlock
 * is needed; decoded buffers carry their own sample rate and play correctly
 * from the live engine.
 */
export async function restoreUserSampleAudio(
  bank: SampleBank,
  decode: (data: ArrayBuffer) => Promise<AudioBuffer> = defaultDecodeAudioBytes,
  restorePcm: (reference: PcmRecordingAudioRef) => Promise<AudioBuffer> = (reference) =>
    new RecordingRecoveryRepository().materializeStoredSample(reference, { tolerant: true }),
  options: { only?: string[] } = {},
): Promise<UserSampleRestoreReport> {
  const repo = new UserSampleRepository();
  const entries = await repo.listAudio();
  const names = new Map((await repo.list()).map((asset) => [asset.id, asset.name]));
  const restored: string[] = [];
  const failed: UserSampleRestoreFailure[] = [];
  for (const { id, data } of entries) {
    if (options.only && !options.only.includes(id)) continue;
    try {
      const buffer = isPcmRecordingAudio(data)
        ? await restorePcm(data)
        : await decode(isBlob(data) ? await data.arrayBuffer() : (data as ArrayBuffer));
      // A PCM restore can come back SHORT: the tail of the recording did not
      // survive. The audio that DID survive is still worth playing — but the
      // truncation must be reported, never passed off as the whole take.
      if (isPcmRecordingAudio(data) && buffer.length < data.frames) {
        if (buffer.length <= 0) {
          failed.push({
            id,
            name: names.get(id) ?? null,
            reason: "the saved recording could not be read back at all",
            partial: false,
          });
          continue;
        }
        bank.add(id, buffer);
        failed.push({
          id,
          name: names.get(id) ?? null,
          reason: "the saved recording is incomplete",
          partial: true,
          restoredSeconds: buffer.duration,
        });
        continue;
      }
      bank.add(id, buffer);
      restored.push(id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failed.push({ id, name: names.get(id) ?? null, reason, partial: false });
    }
  }
  return { restored, failed };
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
  // Audio-decode platform contract (GOAL 03): the shared adapter keeps the
  // exact throwaway-OfflineAudioContext behavior and lets a non-Web-Audio
  // host inject its decoder once at boot.
  return decodeAudioData(data);
}

const restoreByBank = new WeakMap<object, Promise<UserSampleRestoreReport>>();

/**
 * Fire-and-forget boot restore, memoized per bank: the offline renderer and
 * any future consumer await the SAME in-flight (or completed) work instead of
 * re-listing and re-decoding every sample. A failed memoized run is retried
 * on the next call.
 *
 * It is fire-and-forget for the BOOT — the app must not wait for a decode —
 * but it is NOT silent: the report says which samples did not come back.
 */
export function restoreUserSampleAudioMemoized(bank: SampleBank): Promise<UserSampleRestoreReport> {
  const key = bank as unknown as object;
  const existing = restoreByBank.get(key);
  if (existing) return existing;
  const running = restoreUserSampleAudio(bank).catch((err: unknown) => {
    restoreByBank.delete(key);
    throw err;
  });
  restoreByBank.set(key, running);
  return running;
}

/**
 * Re-try the samples that failed to restore.
 *
 * The bytes are still in the store — a failed decode is often transient, and
 * the staged PCM blocks are skipped past, never deleted. So the user gets a
 * second chance instead of a silent loss.
 */
export async function retryUserSampleRestore(
  bank: SampleBank,
  ids: string[],
  decode: (data: ArrayBuffer) => Promise<AudioBuffer> = defaultDecodeAudioBytes,
): Promise<UserSampleRestoreReport> {
  if (ids.length === 0) return { restored: [], failed: [] };
  return restoreUserSampleAudio(bank, decode, undefined, { only: ids });
}

/**
 * Offline-render readiness for user samples — the symmetric counterpart of
 * the curated layer's `curatedReadyWithin`. Rendering before the boot restore
 * finishes silently drops `user.*` buffers (clips skip, sampler notes die) —
 * and a freeze would persist that silence permanently. Bounded so a broken
 * store degrades to today's behavior instead of hanging the export.
 */
export async function userSamplesReadyWithin(bank: SampleBank, timeoutMs: number): Promise<void> {
  await Promise.race([
    restoreUserSampleAudioMemoized(bank).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
