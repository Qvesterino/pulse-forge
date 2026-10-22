/**
 * Self-contained KYX project packages. Musical state stays in the ordinary
 * ProjectDocument; sample and frozen audio bytes travel beside it in a small,
 * stored-only ZIP so importing a project never depends on another machine's
 * IndexedDB contents.
 */
import type { ProjectDocument, Track } from "../project-model/types";
import type { SampleBank } from "../sample-library/factory";
import { factoryBankReady } from "../sample-library/factory";
import { MAX_AUDIO_IMPORT_BYTES } from "../audio-import-capabilities";
import { decodeAudioData } from "../services/audio-decode";
import { encodeWav, sanitizeFilename } from "../rendering/wav";
import { sha256Hex } from "./renderManifest";
import { buildZip, type ZipEntry } from "./zip";
import { importProject, MAX_PROJECT_IMPORT_BYTES } from "./project-io";
import { isPcmRecordingAudio, type UserSampleAsset } from "../persistence/UserSampleRepository";
import type { IUserSampleRepository, IFrozenBufferRepository } from "../persistence/contracts";
import { uid } from "../shared/ids";

export const PORTABLE_PROJECT_FORMAT = "com.kyx.portable-project" as const;
export const PORTABLE_PROJECT_VERSION = 1 as const;
export const MAX_PORTABLE_PROJECT_BYTES = 100 * 1024 * 1024;
export const MAX_PORTABLE_PROJECT_ASSETS = 512;
const MAX_PORTABLE_ASSET_BYTES = MAX_AUDIO_IMPORT_BYTES;
const MAX_PORTABLE_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_ZIP_ENTRIES = MAX_PORTABLE_PROJECT_ASSETS + 2;
const EOCD_SIGNATURE = 0x06054b50;
const CD_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export interface PortableSampleAsset {
  metadata: UserSampleAsset;
  path: string;
  sizeBytes: number;
  sha256: string;
  bytes: Uint8Array;
}

export interface PortableFrozenAsset {
  id: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  signature?: string;
  bytes: Uint8Array;
}

export interface PortableProjectBundle {
  doc: ProjectDocument;
  sampleAssets: PortableSampleAsset[];
  frozenAssets: PortableFrozenAsset[];
}

export interface PortableProjectProgress {
  phase: string;
  pct: number;
}

export interface PortableProjectResult {
  blob: Blob;
  filename: string;
  sampleCount: number;
  frozenCount: number;
}

export interface InstalledPortableProjectAssets {
  doc: ProjectDocument;
  /** Remove assets written by this import if saving the project fails. */
  rollback: () => Promise<void>;
}

interface PortableManifestSample {
  metadata: UserSampleAsset;
  path: string;
  sizeBytes: number;
  sha256: string;
}

interface PortableManifestFrozen {
  id: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  signature?: string;
}

interface PortableManifest {
  format: typeof PORTABLE_PROJECT_FORMAT;
  version: typeof PORTABLE_PROJECT_VERSION;
  projectPath: "project.json";
  sampleAssets: PortableManifestSample[];
  frozenAssets: PortableManifestFrozen[];
}

type PortableSampleRepository = Pick<IUserSampleRepository, "list" | "loadAudio" | "save" | "remove">;
type PortableFrozenRepository = Pick<IFrozenBufferRepository, "load" | "save" | "remove" | "listSignatures">;

/** Package only audio referenced by the project, never the entire local library. */
export async function buildPortableProject(
  doc: ProjectDocument,
  bank: SampleBank,
  sampleRepository: PortableSampleRepository,
  frozenRepository: PortableFrozenRepository,
  onProgress: (progress: PortableProjectProgress) => void = () => {},
  signal?: AbortSignal,
): Promise<PortableProjectResult> {
  throwIfAborted(signal);
  onProgress({ phase: "Collecting project audio", pct: 0.04 });

  const references = collectProjectAudioReferences(doc);
  if (references.sampleIds.size + references.frozenIds.size > MAX_PORTABLE_PROJECT_ASSETS) {
    throw new Error(`This project references more than ${MAX_PORTABLE_PROJECT_ASSETS} audio assets.`);
  }
  const metadata = new Map((await sampleRepository.list()).map((asset) => [asset.id, asset]));
  const frozenSignatures = new Map((await frozenRepository.listSignatures()).map((row) => [row.id, row.signature]));
  const sampleAssets: PortableSampleAsset[] = [];
  const frozenAssets: PortableFrozenAsset[] = [];
  let payloadBytes = 0;

  const sampleIds = [...references.sampleIds].sort();
  for (let index = 0; index < sampleIds.length; index += 1) {
    throwIfAborted(signal);
    const id = sampleIds[index];
    let asset = metadata.get(id);
    const stored = await sampleRepository.loadAudio(id);
    let bytes: Uint8Array;

    if (stored && !isPcmRecordingAudio(stored)) {
      bytes = await audioBytes(stored);
    } else {
      const buffer = bank.get(id);
      if (!buffer) {
        throw new Error(`The project uses “${id}”, but its audio is unavailable. Restore or relink it before export.`);
      }
      bytes = new Uint8Array(encodeWav(buffer, 32));
    }

    if (!asset) {
      const buffer = bank.get(id) ?? (await decodeAudioData(copyArrayBuffer(bytes)));
      asset = {
        id,
        name: id,
        fileName: `${sanitizeFilename(id)}.wav`,
        category: "Custom",
        duration: buffer?.duration ?? 0,
        sampleRate: buffer?.sampleRate ?? 44_100,
        channels: buffer?.numberOfChannels ?? 2,
        createdAt: new Date().toISOString(),
      };
    } else if (stored && isPcmRecordingAudio(stored)) {
      // PCM take chunks are an internal IndexedDB representation. The WAV in
      // the package is a normal audio file that another KYX install can decode.
      asset = { ...asset, fileName: `${sanitizeFilename(asset.fileName.replace(/\.[^.]+$/, ""))}.wav` };
    }

    assertPortableAssetSize(bytes.byteLength, asset.fileName);
    const path = `assets/sample-${String(index + 1).padStart(4, "0")}.bin`;
    const digest = await requiredSha256(bytes);
    payloadBytes += bytes.byteLength;
    if (payloadBytes > MAX_PORTABLE_PROJECT_BYTES) throw tooLargeError();
    sampleAssets.push({ metadata: asset, path, sizeBytes: bytes.byteLength, sha256: digest, bytes });
    onProgress({
      phase: `Adding audio ${index + 1}/${sampleIds.length}`,
      pct: 0.08 + (0.56 * (index + 1)) / Math.max(1, sampleIds.length),
    });
  }

  const frozenIds = [...references.frozenIds].sort();
  for (let index = 0; index < frozenIds.length; index += 1) {
    throwIfAborted(signal);
    const id = frozenIds[index];
    let data = await frozenRepository.load(id);
    if (!data) {
      const buffer = bank.get(id);
      if (!buffer) {
        throw new Error(`The frozen audio “${id}” is unavailable. Unfreeze or restore that track before export.`);
      }
      data = encodeWav(buffer, 32);
    }
    const bytes = new Uint8Array(data);
    assertPortableAssetSize(bytes.byteLength, `frozen audio ${id}`);
    const path = `assets/frozen-${String(index + 1).padStart(4, "0")}.bin`;
    const digest = await requiredSha256(bytes);
    payloadBytes += bytes.byteLength;
    if (payloadBytes > MAX_PORTABLE_PROJECT_BYTES) throw tooLargeError();
    const signature = frozenSignatures.get(id);
    frozenAssets.push({
      id,
      path,
      sizeBytes: bytes.byteLength,
      sha256: digest,
      ...(signature ? { signature } : {}),
      bytes,
    });
    onProgress({
      phase: `Adding frozen audio ${index + 1}/${frozenIds.length}`,
      pct: 0.66 + (0.18 * (index + 1)) / Math.max(1, frozenIds.length),
    });
  }

  throwIfAborted(signal);
  const projectBytes = new TextEncoder().encode(JSON.stringify(doc, null, 2));
  if (projectBytes.byteLength > MAX_PROJECT_IMPORT_BYTES) {
    throw new Error(`Project data exceeds the ${MAX_PROJECT_IMPORT_BYTES / 1024 / 1024} MB project limit.`);
  }

  const manifest: PortableManifest = {
    format: PORTABLE_PROJECT_FORMAT,
    version: PORTABLE_PROJECT_VERSION,
    projectPath: "project.json",
    sampleAssets: sampleAssets.map(({ metadata: asset, path, sizeBytes, sha256 }) => ({
      metadata: asset,
      path,
      sizeBytes,
      sha256,
    })),
    frozenAssets: frozenAssets.map(({ id, path, sizeBytes, sha256, signature }) => ({
      id,
      path,
      sizeBytes,
      sha256,
      ...(signature ? { signature } : {}),
    })),
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  if (manifestBytes.byteLength > MAX_PORTABLE_MANIFEST_BYTES)
    throw new Error("Portable project manifest is too large.");
  const entries: ZipEntry[] = [
    { name: "project.json", data: projectBytes },
    { name: "manifest.json", data: manifestBytes },
    ...sampleAssets.map(({ path, bytes }) => ({ name: path, data: bytes })),
    ...frozenAssets.map(({ path, bytes }) => ({ name: path, data: bytes })),
  ];
  const estimatedBytes = entries.reduce((total, entry) => total + entry.name.length + 76 + entry.data.byteLength, 22);
  if (estimatedBytes > MAX_PORTABLE_PROJECT_BYTES) throw tooLargeError();
  throwIfAborted(signal);
  onProgress({ phase: "Writing portable project", pct: 0.9 });
  const blob = buildZip(entries);
  if (blob.size > MAX_PORTABLE_PROJECT_BYTES) throw tooLargeError();
  onProgress({ phase: "Project ready", pct: 1 });
  return {
    blob,
    filename: `${sanitizeFilename(doc.name)}.kyxpack`,
    sampleCount: sampleAssets.length,
    frozenCount: frozenAssets.length,
  };
}

/** Read a portable .kyxpack, or a legacy JSON project, from the project browser. */
export async function importPortableProjectFile(file: File): Promise<PortableProjectBundle> {
  const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isZip = signature.length >= 4 && signature[0] === 0x50 && signature[1] === 0x4b;
  if (!isZip) {
    return { doc: await importProject(file), sampleAssets: [], frozenAssets: [] };
  }
  if (file.size > MAX_PORTABLE_PROJECT_BYTES) throw tooLargeError();
  const archive = new Uint8Array(await file.arrayBuffer());
  return parsePortableArchive(archive);
}

/** Install included audio before the document is saved/opened. */
export async function installPortableProjectAssets(
  bundle: PortableProjectBundle,
  bank: SampleBank,
  sampleRepository: PortableSampleRepository,
  frozenRepository: PortableFrozenRepository,
): Promise<InstalledPortableProjectAssets> {
  const createdSampleIds: string[] = [];
  const createdFrozenIds: string[] = [];
  const sampleIdMap = new Map<string, string>();
  const frozenIdMap = new Map<string, string>();
  const existingSampleRows = new Map((await sampleRepository.list()).map((asset) => [asset.id, asset]));
  // The factory catalogue builds in the BACKGROUND, so wait for it: the
  // occupied-id set is what keeps an installed portable project from
  // colliding with a factory sample that has not arrived yet.
  await factoryBankReady(bank);
  const occupiedIds = new Set([...existingSampleRows.keys(), ...bank.entries().map(([id]) => id)]);

  const rollback = async () => {
    for (const id of createdSampleIds) {
      bank.remove(id);
      await sampleRepository.remove(id);
    }
    for (const id of createdFrozenIds) {
      bank.remove(id);
      await frozenRepository.remove(id);
    }
  };

  try {
    for (const packaged of bundle.sampleAssets) {
      const originalId = packaged.metadata.id;
      let targetId = originalId;
      const existingRow = existingSampleRows.get(originalId);
      if (existingRow) {
        const existingAudio = await sampleRepository.loadAudio(originalId);
        if (existingAudio && !isPcmRecordingAudio(existingAudio)) {
          const existingBytes = await audioBytes(existingAudio);
          if ((await requiredSha256(existingBytes)) === packaged.sha256) {
            if (!bank.has(originalId)) bank.add(originalId, await decodePackagedAudio(packaged.bytes));
            continue;
          }
        }
        targetId = nextAvailableId("portable-sample", occupiedIds);
      } else if (bank.has(originalId)) {
        // A factory sample can already occupy this ID without a user-library
        // row. Keep that buffer intact and give the imported audio a fresh ID.
        targetId = nextAvailableId("portable-sample", occupiedIds);
      }

      const audio = await decodePackagedAudio(packaged.bytes);
      const metadata: UserSampleAsset = { ...packaged.metadata, id: targetId };
      const bytes = copyArrayBuffer(packaged.bytes);
      createdSampleIds.push(targetId);
      occupiedIds.add(targetId);
      await sampleRepository.save(metadata, bytes);
      bank.add(targetId, audio);
      if (targetId !== originalId) sampleIdMap.set(originalId, targetId);
      existingSampleRows.set(targetId, metadata);
    }

    for (const packaged of bundle.frozenAssets) {
      let targetId = packaged.id;
      const existingData = await frozenRepository.load(packaged.id);
      if (existingData) {
        const existingBytes = new Uint8Array(existingData);
        if ((await requiredSha256(existingBytes)) === packaged.sha256) {
          if (!bank.has(packaged.id)) bank.add(packaged.id, await decodePackagedAudio(packaged.bytes));
          continue;
        }
        targetId = nextAvailableId("portable-frozen", occupiedIds);
      } else if (bank.has(packaged.id)) {
        targetId = nextAvailableId("portable-frozen", occupiedIds);
      }

      const audio = await decodePackagedAudio(packaged.bytes);
      createdFrozenIds.push(targetId);
      occupiedIds.add(targetId);
      await frozenRepository.save(targetId, copyArrayBuffer(packaged.bytes), packaged.signature);
      bank.add(targetId, audio);
      if (targetId !== packaged.id) frozenIdMap.set(packaged.id, targetId);
    }
  } catch (error) {
    await rollback();
    throw error;
  }

  return {
    doc: rewriteProjectAssetReferences(bundle.doc, sampleIdMap, frozenIdMap),
    rollback,
  };
}

function collectProjectAudioReferences(doc: ProjectDocument): { sampleIds: Set<string>; frozenIds: Set<string> } {
  const sampleIds = new Set<string>();
  const frozenIds = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (typeof value === "string" && value.length > 0) sampleIds.add(value);
  };

  for (const track of doc.tracks) {
    if (track.frozen?.bufferId) frozenIds.add(track.frozen.bufferId);
    if (track.kind === "drum") {
      for (const pad of track.pads) {
        add(pad.assetId);
        for (const layer of pad.layers ?? []) add(layer.sampleId);
      }
    } else if (track.kind === "instrument") {
      add(track.sampleId);
      add(track.sampleIdB);
      for (const layer of track.velocityLayers ?? []) add(layer.sampleId);
    } else if (track.kind === "generative" && track.generative.style.kind === "audio") {
      add(track.generative.style.bufferId);
    }
  }
  for (const clip of doc.arrangement.audioClips ?? []) add(clip.bufferId);
  for (const transition of doc.arrangement.transitions ?? []) add(transition.cueAssetId);
  for (const set of doc.liveSets ?? []) for (const pad of set.pads) add(pad.bufferId);
  return { sampleIds, frozenIds };
}

function rewriteProjectAssetReferences(
  doc: ProjectDocument,
  sampleIdMap: ReadonlyMap<string, string>,
  frozenIdMap: ReadonlyMap<string, string>,
): ProjectDocument {
  const sampleId = (value: string | null) => (value ? (sampleIdMap.get(value) ?? value) : value);
  const frozenId = (value: string) => frozenIdMap.get(value) ?? value;
  const tracks: Track[] = doc.tracks.map((track) => {
    let rewritten: Track = track;
    if (track.kind === "drum") {
      rewritten = {
        ...track,
        pads: track.pads.map((pad) => ({
          ...pad,
          assetId: sampleId(pad.assetId),
          ...(pad.layers
            ? { layers: pad.layers.map((layer) => ({ ...layer, sampleId: sampleId(layer.sampleId) })) }
            : {}),
        })),
      };
    } else if (track.kind === "instrument") {
      rewritten = {
        ...track,
        sampleId: sampleId(track.sampleId),
        ...(track.sampleIdB !== undefined ? { sampleIdB: sampleId(track.sampleIdB) } : {}),
        ...(track.velocityLayers
          ? { velocityLayers: track.velocityLayers.map((layer) => ({ ...layer, sampleId: sampleId(layer.sampleId) })) }
          : {}),
      };
    } else if (track.kind === "generative" && track.generative.style.kind === "audio") {
      rewritten = {
        ...track,
        generative: {
          ...track.generative,
          style: {
            ...track.generative.style,
            bufferId: sampleIdMap.get(track.generative.style.bufferId) ?? track.generative.style.bufferId,
          },
        },
      };
    }
    if (rewritten.frozen)
      rewritten = {
        ...rewritten,
        frozen: { ...rewritten.frozen, bufferId: frozenId(rewritten.frozen.bufferId) },
      } as Track;
    return rewritten;
  });

  return {
    ...doc,
    tracks,
    arrangement: {
      ...doc.arrangement,
      ...(doc.arrangement.audioClips
        ? {
            audioClips: doc.arrangement.audioClips.map((clip) => ({
              ...clip,
              bufferId: sampleIdMap.get(clip.bufferId) ?? clip.bufferId,
            })),
          }
        : {}),
      ...(doc.arrangement.transitions
        ? {
            transitions: doc.arrangement.transitions.map((transition) => ({
              ...transition,
              ...(transition.cueAssetId
                ? { cueAssetId: sampleIdMap.get(transition.cueAssetId) ?? transition.cueAssetId }
                : {}),
            })),
          }
        : {}),
    },
    ...(doc.liveSets
      ? {
          liveSets: doc.liveSets.map((set) => ({
            ...set,
            pads: set.pads.map((pad) => ({ ...pad, bufferId: sampleIdMap.get(pad.bufferId) ?? pad.bufferId })),
          })),
        }
      : {}),
  };
}

async function parsePortableArchive(archive: Uint8Array): Promise<PortableProjectBundle> {
  const entries = readStoredZip(archive);
  const projectBytes = entries.get("project.json");
  const manifestBytes = entries.get("manifest.json");
  if (!projectBytes || !manifestBytes) throw new Error("This KYX package is missing its project or manifest.");
  if (manifestBytes.byteLength > MAX_PORTABLE_MANIFEST_BYTES)
    throw new Error("Portable project manifest is too large.");

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch {
    throw new Error("Portable project manifest is invalid JSON.");
  }
  const manifest = validateManifest(rawManifest);
  const expectedPaths = new Set(["project.json", "manifest.json"]);
  const totalAssets = manifest.sampleAssets.length + manifest.frozenAssets.length;
  if (totalAssets > MAX_PORTABLE_PROJECT_ASSETS) throw new Error("Portable project contains too many audio assets.");

  const sampleAssets: PortableSampleAsset[] = [];
  const frozenAssets: PortableFrozenAsset[] = [];
  let totalAssetBytes = 0;
  const declaredPaths = new Set<string>();
  for (const item of manifest.sampleAssets) {
    if (declaredPaths.has(item.path)) throw new Error(`Portable project repeats asset path “${item.path}”.`);
    declaredPaths.add(item.path);
    const bytes = await verifyManifestAsset(entries, item.path, item.sizeBytes, item.sha256);
    expectedPaths.add(item.path);
    totalAssetBytes += bytes.byteLength;
    sampleAssets.push({ ...item, bytes });
  }
  for (const item of manifest.frozenAssets) {
    if (declaredPaths.has(item.path)) throw new Error(`Portable project repeats asset path “${item.path}”.`);
    declaredPaths.add(item.path);
    const bytes = await verifyManifestAsset(entries, item.path, item.sizeBytes, item.sha256);
    expectedPaths.add(item.path);
    totalAssetBytes += bytes.byteLength;
    frozenAssets.push({ ...item, bytes });
  }
  if (totalAssetBytes > MAX_PORTABLE_PROJECT_BYTES) throw tooLargeError();
  if (expectedPaths.size !== totalAssets + 2) throw new Error("Portable project manifest repeats an audio path.");
  if (entries.size !== expectedPaths.size || [...entries.keys()].some((path) => !expectedPaths.has(path))) {
    throw new Error("Portable project contains files that are not listed in its manifest.");
  }

  if (projectBytes.byteLength > MAX_PROJECT_IMPORT_BYTES) {
    throw new Error(`Project data exceeds the ${MAX_PROJECT_IMPORT_BYTES / 1024 / 1024} MB project limit.`);
  }
  let projectJson: string;
  try {
    projectJson = new TextDecoder("utf-8", { fatal: true }).decode(projectBytes);
  } catch {
    throw new Error("Portable project document is invalid JSON.");
  }
  // Reuse the same schema validation and migration as legacy .kyx JSON files.
  const doc = await importProject(projectJson);
  const references = collectProjectAudioReferences(doc);
  const packagedSampleIds = new Set(sampleAssets.map((asset) => asset.metadata.id));
  const packagedFrozenIds = new Set(frozenAssets.map((asset) => asset.id));
  if (
    packagedSampleIds.size !== references.sampleIds.size ||
    [...references.sampleIds].some((id) => !packagedSampleIds.has(id)) ||
    packagedFrozenIds.size !== references.frozenIds.size ||
    [...references.frozenIds].some((id) => !packagedFrozenIds.has(id))
  ) {
    throw new Error(
      "Portable project is incomplete: one or more referenced audio assets are missing from the package.",
    );
  }
  return { doc, sampleAssets, frozenAssets };
}

function validateManifest(value: unknown): PortableManifest {
  if (!isRecord(value) || value.format !== PORTABLE_PROJECT_FORMAT || value.version !== PORTABLE_PROJECT_VERSION) {
    throw new Error("Unsupported KYX portable project format or version.");
  }
  if (
    value.projectPath !== "project.json" ||
    !Array.isArray(value.sampleAssets) ||
    !Array.isArray(value.frozenAssets)
  ) {
    throw new Error("Portable project manifest has an invalid structure.");
  }
  if (value.sampleAssets.length + value.frozenAssets.length > MAX_PORTABLE_PROJECT_ASSETS) {
    throw new Error("Portable project contains too many audio assets.");
  }
  const sampleIds = new Set<string>();
  const frozenIds = new Set<string>();
  const sampleAssets = value.sampleAssets.map((entry): PortableManifestSample => {
    if (
      !isRecord(entry) ||
      !isSafeAssetPath(entry.path) ||
      typeof entry.sizeBytes !== "number" ||
      !Number.isSafeInteger(entry.sizeBytes) ||
      typeof entry.sha256 !== "string"
    ) {
      throw new Error("Portable project sample entry is invalid.");
    }
    const metadata = cleanSampleMetadata(entry.metadata);
    if (sampleIds.has(metadata.id)) throw new Error(`Portable project repeats sample ID “${metadata.id}”.`);
    sampleIds.add(metadata.id);
    assertManifestAsset(entry.path, entry.sizeBytes, entry.sha256);
    return { metadata, path: entry.path, sizeBytes: entry.sizeBytes, sha256: entry.sha256 };
  });
  const frozenAssets = value.frozenAssets.map((entry): PortableManifestFrozen => {
    if (
      !isRecord(entry) ||
      !isSafeAssetPath(entry.path) ||
      typeof entry.sizeBytes !== "number" ||
      !Number.isSafeInteger(entry.sizeBytes) ||
      typeof entry.sha256 !== "string"
    ) {
      throw new Error("Portable project frozen audio entry is invalid.");
    }
    if (typeof entry.id !== "string" || !isSafeId(entry.id))
      throw new Error("Portable project frozen audio ID is invalid.");
    if (frozenIds.has(entry.id)) throw new Error(`Portable project repeats frozen audio ID “${entry.id}”.`);
    frozenIds.add(entry.id);
    assertManifestAsset(entry.path, entry.sizeBytes, entry.sha256);
    if (entry.signature !== undefined && (typeof entry.signature !== "string" || entry.signature.length > 256)) {
      throw new Error("Portable project frozen signature is invalid.");
    }
    return {
      id: entry.id,
      path: entry.path,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
      ...(typeof entry.signature === "string" ? { signature: entry.signature } : {}),
    };
  });
  return {
    format: PORTABLE_PROJECT_FORMAT,
    version: PORTABLE_PROJECT_VERSION,
    projectPath: "project.json",
    sampleAssets,
    frozenAssets,
  };
}

function cleanSampleMetadata(value: unknown): UserSampleAsset {
  if (
    !isRecord(value) ||
    !isSafeId(value.id) ||
    !isBoundedString(value.name, 1, 200) ||
    !isBoundedString(value.fileName, 1, 255) ||
    value.category !== "Custom" ||
    typeof value.duration !== "number" ||
    !Number.isFinite(value.duration) ||
    value.duration <= 0 ||
    value.duration > 86_400 ||
    !Number.isInteger(value.sampleRate) ||
    (value.sampleRate as number) < 8_000 ||
    (value.sampleRate as number) > 384_000 ||
    !Number.isInteger(value.channels) ||
    (value.channels as number) < 1 ||
    (value.channels as number) > 32 ||
    !isBoundedString(value.createdAt, 1, 64)
  ) {
    throw new Error("Portable project sample metadata is invalid.");
  }

  const metadata: UserSampleAsset = {
    id: value.id,
    name: value.name,
    fileName: value.fileName,
    category: "Custom",
    duration: value.duration,
    sampleRate: value.sampleRate as number,
    channels: value.channels as number,
    createdAt: value.createdAt,
  };
  if (value.bpm !== undefined) {
    if (typeof value.bpm !== "number" || !Number.isFinite(value.bpm) || value.bpm < 1 || value.bpm > 400) {
      throw new Error("Portable project loop tempo is invalid.");
    }
    metadata.bpm = value.bpm;
  }
  if (value.loopMetadata !== undefined) {
    if (!isRecord(value.loopMetadata)) throw new Error("Portable project loop tags are invalid.");
    const loopMetadata: NonNullable<UserSampleAsset["loopMetadata"]> = {};
    if (value.loopMetadata.isLoop !== undefined) {
      if (typeof value.loopMetadata.isLoop !== "boolean") throw new Error("Portable project loop flag is invalid.");
      loopMetadata.isLoop = value.loopMetadata.isLoop;
    }
    for (const key of ["genre", "mood", "instrument", "key"] as const) {
      const field = value.loopMetadata[key];
      if (field !== undefined) {
        if (!isBoundedString(field, 0, 100)) throw new Error("Portable project loop tags are invalid.");
        loopMetadata[key] = field;
      }
    }
    metadata.loopMetadata = loopMetadata;
  }
  if (value.origin !== undefined) {
    if (value.origin !== "generated") throw new Error("Portable project sample origin is invalid.");
    metadata.origin = "generated";
  }
  if (value.generated !== undefined) {
    if (!isRecord(value.generated)) throw new Error("Portable project generated-audio metadata is invalid.");
    const generated: NonNullable<UserSampleAsset["generated"]> = {
      providerId: boundedField(value.generated.providerId, "providerId", 128),
      modelId: boundedField(value.generated.modelId, "modelId", 128),
      inputHash: boundedField(value.generated.inputHash, "inputHash", 256),
    };
    if (value.generated.sourceHash !== undefined)
      generated.sourceHash = boundedField(value.generated.sourceHash, "sourceHash", 256);
    if (value.generated.prompt !== undefined) generated.prompt = boundedField(value.generated.prompt, "prompt", 2_000);
    if (value.generated.providerVersion !== undefined)
      generated.providerVersion = boundedField(value.generated.providerVersion, "providerVersion", 128);
    metadata.generated = generated;
  }
  if (value.factoryPack !== undefined) {
    if (
      !isRecord(value.factoryPack) ||
      !isBoundedString(value.factoryPack.id, 1, 128) ||
      !Number.isInteger(value.factoryPack.version) ||
      value.factoryPack.license !== "kyx-original" ||
      !isBoundedString(value.factoryPack.creator, 1, 128)
    ) {
      throw new Error("Portable project pack provenance is invalid.");
    }
    metadata.factoryPack = {
      id: value.factoryPack.id,
      version: value.factoryPack.version as number,
      license: "kyx-original",
      creator: value.factoryPack.creator,
    };
  }
  return metadata;
}

function readStoredZip(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.byteLength < 22 || bytes.byteLength > MAX_PORTABLE_PROJECT_BYTES)
    throw new Error("Portable project ZIP size is invalid.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const firstEocd = Math.max(0, bytes.byteLength - 22 - 0xffff);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= firstEocd; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("Portable project is not a supported ZIP archive.");
  const commentLength = view.getUint16(eocd + 20, true);
  if (eocd + 22 + commentLength !== bytes.byteLength)
    throw new Error("Portable project ZIP has trailing or truncated data.");
  const disk = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (
    disk !== 0 ||
    cdDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount > MAX_ZIP_ENTRIES ||
    cdOffset === 0xffffffff ||
    cdSize === 0xffffffff ||
    cdOffset + cdSize !== eocd
  ) {
    throw new Error("Portable project ZIP directory is invalid or exceeds supported limits.");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const result = new Map<string, Uint8Array>();
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = cdOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd || view.getUint32(cursor, true) !== CD_SIGNATURE)
      throw new Error("Portable project ZIP entry is invalid.");
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const entryCommentLength = view.getUint16(cursor + 32, true);
    const diskStart = view.getUint16(cursor + 34, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const next = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (
      next > eocd ||
      (flags & 0x0009) !== 0 ||
      method !== 0 ||
      compressedSize !== uncompressedSize ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff ||
      diskStart !== 0 ||
      uncompressedSize > MAX_PORTABLE_ASSET_BYTES + MAX_PROJECT_IMPORT_BYTES
    ) {
      throw new Error("Portable project ZIP uses unsupported or unsafe entry options.");
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_PORTABLE_PROJECT_BYTES) throw tooLargeError();

    let name: string;
    try {
      name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    } catch {
      throw new Error("Portable project ZIP contains an invalid filename.");
    }
    if (name !== "project.json" && name !== "manifest.json" && !isSafeAssetPath(name)) {
      throw new Error("Portable project ZIP contains an unsupported file path.");
    }
    if (result.has(name)) throw new Error(`Portable project ZIP repeats “${name}”.`);

    if (localOffset + 30 > cdOffset || view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
      throw new Error("Portable project ZIP local header is invalid.");
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localCrc = view.getUint32(localOffset + 14, true);
    const localCompressedSize = view.getUint32(localOffset + 18, true);
    const localUncompressedSize = view.getUint32(localOffset + 22, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (
      localFlags !== flags ||
      localMethod !== method ||
      localCrc !== crc ||
      localCompressedSize !== compressedSize ||
      localUncompressedSize !== uncompressedSize ||
      dataEnd > cdOffset ||
      dataStart > dataEnd
    ) {
      throw new Error("Portable project ZIP local and central headers do not match.");
    }
    let localName: string;
    try {
      localName = decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength));
    } catch {
      throw new Error("Portable project ZIP contains an invalid local filename.");
    }
    if (localName !== name) throw new Error("Portable project ZIP entry names do not match.");
    const data = bytes.subarray(dataStart, dataEnd);
    if (crc32(data) !== crc) throw new Error(`Portable project file “${name}” failed its CRC check.`);
    result.set(name, data);
    ranges.push({ start: localOffset, end: dataEnd });
    cursor = next;
  }
  if (cursor !== eocd) throw new Error("Portable project ZIP central directory has trailing data.");
  ranges.sort((a, b) => a.start - b.start);
  let expectedLocalOffset = 0;
  for (const range of ranges) {
    if (range.start !== expectedLocalOffset)
      throw new Error("Portable project ZIP contains gaps or overlapping entries.");
    expectedLocalOffset = range.end;
  }
  if (expectedLocalOffset !== cdOffset) throw new Error("Portable project ZIP contains unlisted data.");
  return result;
}

async function verifyManifestAsset(
  entries: ReadonlyMap<string, Uint8Array>,
  path: string,
  sizeBytes: number,
  expectedSha256: string,
): Promise<Uint8Array> {
  const bytes = entries.get(path);
  if (!bytes) throw new Error(`Portable project is missing “${path}”.`);
  if (bytes.byteLength !== sizeBytes) throw new Error(`Portable project asset “${path}” has the wrong size.`);
  assertPortableAssetSize(sizeBytes, path);
  if ((await requiredSha256(bytes)) !== expectedSha256.toLowerCase()) {
    throw new Error(`Portable project asset “${path}” failed its SHA-256 check.`);
  }
  return bytes;
}

function assertManifestAsset(path: string, sizeBytes: number, sha256: string): void {
  if (!isSafeAssetPath(path)) throw new Error("Portable project asset path is invalid.");
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_PORTABLE_ASSET_BYTES) {
    throw new Error("Portable project asset size is invalid.");
  }
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error("Portable project asset hash is invalid.");
}

function isSafeAssetPath(value: unknown): value is string {
  return typeof value === "string" && /^assets\/(?:sample|frozen)-\d{4}\.bin$/.test(value);
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function boundedField(value: unknown, field: string, maximum: number): string {
  if (!isBoundedString(value, 0, maximum)) throw new Error(`Portable project ${field} metadata is invalid.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPortableAssetSize(bytes: number, name: string): void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_PORTABLE_ASSET_BYTES) {
    throw new Error(`Audio asset “${name}” must be no larger than ${MAX_PORTABLE_ASSET_BYTES / 1024 / 1024} MB.`);
  }
}

async function audioBytes(value: ArrayBuffer | Blob): Promise<Uint8Array> {
  return new Uint8Array(isBlob(value) ? await value.arrayBuffer() : value);
}

function isBlob(value: ArrayBuffer | Blob): value is Blob {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Blob).arrayBuffer === "function" &&
    typeof (value as Blob).size === "number" &&
    typeof (value as Blob).type === "string"
  );
}

async function requiredSha256(bytes: Uint8Array): Promise<string> {
  const digest = await sha256Hex(bytes);
  if (!digest) throw new Error("This runtime cannot calculate SHA-256 hashes needed for a portable project.");
  return digest;
}

async function decodePackagedAudio(bytes: Uint8Array): Promise<AudioBuffer> {
  assertPortableAssetSize(bytes.byteLength, "portable audio");
  const buffer = await decodeAudioData(copyArrayBuffer(bytes));
  if (buffer.length <= 0 || buffer.numberOfChannels < 1 || buffer.sampleRate < 8_000) {
    throw new Error("A packaged audio asset decoded to an empty or invalid buffer.");
  }
  return buffer;
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function nextAvailableId(prefix: string, occupied: Set<string>): string {
  let id = uid(prefix);
  while (occupied.has(id)) id = uid(prefix);
  return id;
}

function tooLargeError(): Error {
  return new Error(`Portable project exceeds the ${MAX_PORTABLE_PROJECT_BYTES / 1024 / 1024} MB package limit.`);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
