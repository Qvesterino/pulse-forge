/**
 * PERSISTENCE CONTRACTS — platform-neutral storage interfaces (cross-platform
 * campaign GOAL 03).
 *
 * Every IndexedDB repository in this folder is a concrete class over the
 * single `db.ts` choke point. These interfaces freeze each repository's
 * PUBLIC method surface so an alternative backend (SQLite, native
 * filesystem, in-memory for tests, remote sync) can substitute it without
 * the app knowing. TypeScript structural typing means the existing classes
 * already satisfy them — nothing else in the app changes behavior.
 *
 * Contract conventions (apply to every interface below):
 * - Responsibilities: durable per-topic storage; NO business rules beyond
 *   what is already embedded in the concrete repos (schema validation,
 *   pruning policy) — callers keep their semantics.
 * - Inputs/outputs: plain serializable data (project model, metadata
 *   records, bytes); AudioBuffers appear only where a repo materializes
 *   recordings/frozen tracks.
 * - Error model: methods resolve or throw the raw storage error; quota/
 *   corruption surfaces as a rejected promise — best-effort layers
 *   (autosave, recovery) guard at their own boundary.
 * - Lifecycle: constructors may open lazily; `openDatabase` injection
 *   (where present) is the test/alternative-backend seam.
 * - Cancellation: none today — IndexedDB transactions run to completion;
 *   long operations (forEachChunk) are bounded by store size.
 * - Capability limits: per-store caps (snapshots per project, ledger
 *   sizes, prune ages) are documented on the concrete classes and are part
 *   of the observable contract.
 */

import type { IncompatibleProjectMeta, SavedProjectMeta } from "./ProjectRepository";
import type { ProjectSnapshot } from "./SnapshotRepository";
import type { InstrumentPreset } from "../presets/types";
import type { UserKit } from "./KitRepository";
import type { GroovePoolEntry } from "./GroovePoolRepository";
import type { MorphPresetEntry } from "./MorphPresetRepository";
import type { UltinaPresetEntry } from "./UltinaPresetRepository";
import type { FrozenAudioEntry } from "./FrozenBufferRepository";
import type { RecordingPcmChunk, RecordingSession } from "./RecordingRecoveryRepository";
import type { LibraryState } from "./LibraryRepository";
import type { PcmRecordingAudioRef, UserSampleAsset, UserSampleAudio } from "./UserSampleRepository";
import type { ProjectDocument } from "../project-model/types";

/** Durable project documents + their metadata index (the app's core data). */
export interface IProjectRepository {
  save(doc: ProjectDocument): Promise<void>;
  load(id: string): Promise<ProjectDocument | null>;
  listAll(): Promise<SavedProjectMeta[]>;
  listIncompatible(): Promise<IncompatibleProjectMeta[]>;
  referencedFrozenBufferIds(): Promise<Set<string>>;
  delete(id: string): Promise<void>;
  rename(id: string, name: string): Promise<ProjectDocument | null>;
  duplicate(id: string): Promise<ProjectDocument | null>;
  loadMostRecent(): Promise<ProjectDocument | null>;
}

/** Rolling per-project undo-safety snapshots with prune policy. */
export interface ISnapshotRepository {
  save(projectId: string, doc: ProjectDocument, label: string): Promise<ProjectSnapshot>;
  list(projectId: string, limit?: number): Promise<ProjectSnapshot[]>;
  get(id: string): Promise<ProjectSnapshot | null>;
  delete(id: string): Promise<void>;
  prune(projectId: string, keep?: number): Promise<void>;
}

/** User instrument presets. */
export interface IPresetRepository {
  list(): Promise<InstrumentPreset[]>;
  save(preset: InstrumentPreset): Promise<void>;
  delete(id: string): Promise<void>;
}

/** User drum kits (sample-mapped pad sets). */
export interface IKitRepository {
  list(): Promise<UserKit[]>;
  save(kit: UserKit): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Pooled groove timings (dice ecosystem). */
export interface IGroovePoolRepository {
  list(): Promise<GroovePoolEntry[]>;
  save(entry: GroovePoolEntry): Promise<void>;
  remove(id: string): Promise<void>;
}

/** MORPH dynamics plugin user presets (user presets + A/B slots). */
export interface IMorphPresetRepository {
  list(): Promise<MorphPresetEntry[]>;
  save(entry: MorphPresetEntry): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Ultina plugin user presets. */
export interface IUltinaPresetRepository {
  list(): Promise<UltinaPresetEntry[]>;
  save(entry: UltinaPresetEntry): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Frozen (bounced) track audio keyed by buffer id — project binary blobs. */
export interface IFrozenBufferRepository {
  save(bufferId: string, data: ArrayBuffer): Promise<void>;
  load(bufferId: string): Promise<ArrayBuffer | undefined>;
  remove(bufferId: string): Promise<void>;
  list(): Promise<FrozenAudioEntry[]>;
}

/**
 * In-progress PCM recording sessions: chunked append while recording,
 * recoverable after a crash, materializable to sample assets. The
 * `excludeOwnerId`/prune parameters are the crash-recovery policy surface.
 */
export interface IRecordingRecoveryRepository {
  begin(session: RecordingSession): Promise<void>;
  appendChunk(chunk: RecordingPcmChunk): Promise<void>;
  markRecoverable(sessionId: string): Promise<void>;
  get(sessionId: string): Promise<RecordingSession | undefined>;
  listRecoverable(now?: number, excludeOwnerId?: string): Promise<RecordingSession[]>;
  forEachChunk(sessionId: string, visit: (chunk: RecordingPcmChunk, frameOffset: number) => void): Promise<void>;
  materializeStoredSample(reference: PcmRecordingAudioRef): Promise<AudioBuffer>;
  finalize(sessionId: string, asset: UserSampleAsset): Promise<void>;
  removePcmSample(assetId: string, reference: PcmRecordingAudioRef): Promise<void>;
  remove(sessionId: string): Promise<void>;
  pruneAncient(now?: number, maxAgeMs?: number): Promise<number>;
}

/** Favorites/usage counters for the sample library + presets. Live state surface for React (subscribe + sync snapshot). */
export interface ILibraryRepository {
  subscribe(listener: (state: LibraryState) => void): () => void;
  get(): LibraryState;
  load(): Promise<LibraryState>;
  toggleAssetFavorite(id: string): Promise<LibraryState>;
  togglePresetFavorite(id: string): Promise<LibraryState>;
  recordAsset(id: string): Promise<LibraryState>;
  recordPreset(id: string): Promise<LibraryState>;
}

/**
 * User-imported sample assets: metadata list, audio bytes (or a reference
 * into the recording recovery store for PCM takes), with a memoized list
 * cache (`invalidateCache` is part of the contract).
 */
export interface IUserSampleRepository {
  invalidateCache(): void;
  list(): Promise<UserSampleAsset[]>;
  save(asset: UserSampleAsset, data?: ArrayBuffer | Blob): Promise<void>;
  loadAudio(id: string): Promise<ArrayBuffer | Blob | PcmRecordingAudioRef | undefined>;
  listAudio(): Promise<UserSampleAudio[]>;
  remove(id: string): Promise<void>;
}

/**
 * The storage backend as one injectable bundle — what a platform adapter
 * implements to replace IndexedDB wholesale (web = the concrete repos,
 * tests = in-memory, native = SQLite/filesystem).
 */
export interface PersistenceContracts {
  projects: IProjectRepository;
  snapshots: ISnapshotRepository;
  presets: IPresetRepository;
  kits: IKitRepository;
  groovePool: IGroovePoolRepository;
  morphPresets: IMorphPresetRepository;
  ultinaPresets: IUltinaPresetRepository;
  frozenAudio: IFrozenBufferRepository;
  recordingRecovery: IRecordingRecoveryRepository;
  library: ILibraryRepository;
  userSamples: IUserSampleRepository;
}
