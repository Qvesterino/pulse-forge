import { assetUrl } from "../shared/assetUrls";
import { decodeAudioData } from "../services/audio-decode";
import { persistBankBuffer } from "./bank-persist";
import type { SampleBank } from "./factory";
import type { IUserSampleRepository } from "../persistence/contracts";
import type { UserSampleAsset } from "../persistence/UserSampleRepository";

const MANIFEST_PATH = "/samples/kyx-starter-loops/manifest.json";
const MAX_PACK_BYTES = 32 * 1024 * 1024;
const MAX_LOOP_BYTES = 8 * 1024 * 1024;
const MAX_LOOP_COUNT = 16;

interface StarterLoopManifestAsset {
  id: string;
  name: string;
  fileName: string;
  url: string;
  bytes: number;
  sha256: string;
  duration: number;
  bpm: number;
  genre: string;
  mood: string;
  instrument: string;
  key: string;
}

interface StarterLoopManifest {
  version: number;
  pack: { id: string; name: string; license: string; creator: string; bars: number };
  assets: StarterLoopManifestAsset[];
}

export interface StarterLoopInstallProgress {
  completed: number;
  total: number;
  name: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedText(value: unknown, maxLength = 80): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function parseManifest(value: unknown): StarterLoopManifest {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.pack) || !Array.isArray(value.assets)) {
    throw new Error("KYX Starter Loops manifest is invalid.");
  }
  const pack = value.pack;
  if (
    pack.id !== "kyx-starter-loops" ||
    pack.name !== "KYX Starter Loops" ||
    pack.license !== "kyx-original" ||
    pack.creator !== "KYX" ||
    pack.bars !== 4 ||
    value.assets.length < 1 ||
    value.assets.length > MAX_LOOP_COUNT
  ) {
    throw new Error("KYX Starter Loops manifest has unsupported pack metadata.");
  }

  let totalBytes = 0;
  const ids = new Set<string>();
  const assets = value.assets.map((candidate): StarterLoopManifestAsset => {
    if (!isRecord(candidate)) throw new Error("KYX Starter Loops manifest contains an invalid loop.");
    const asset = candidate;
    if (
      !isBoundedText(asset.id, 120) ||
      !asset.id.startsWith("kyx.loop.v1.") ||
      !isBoundedText(asset.name) ||
      !isBoundedText(asset.fileName, 100) ||
      !isBoundedText(asset.url, 200) ||
      !asset.url.startsWith("/samples/kyx-starter-loops/") ||
      !isSafeInteger(asset.bytes) ||
      asset.bytes <= 44 ||
      asset.bytes > MAX_LOOP_BYTES ||
      !isBoundedText(asset.sha256, 64) ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !isFiniteNumber(asset.duration) ||
      asset.duration <= 0 ||
      !isFiniteNumber(asset.bpm) ||
      asset.bpm < 40 ||
      asset.bpm > 240 ||
      !isBoundedText(asset.genre) ||
      !isBoundedText(asset.mood) ||
      !isBoundedText(asset.instrument) ||
      !isBoundedText(asset.key)
    ) {
      throw new Error("KYX Starter Loops manifest contains invalid loop metadata.");
    }
    if (ids.has(asset.id)) throw new Error("KYX Starter Loops manifest contains duplicate loop IDs.");
    ids.add(asset.id);
    totalBytes += asset.bytes;
    return asset as unknown as StarterLoopManifestAsset;
  });
  if (totalBytes > MAX_PACK_BYTES)
    throw new Error("KYX Starter Loops pack is larger than the supported download limit.");
  return { version: 1, pack: pack as unknown as StarterLoopManifest["pack"], assets };
}

async function fetchManifest(fetcher: typeof fetch): Promise<StarterLoopManifest> {
  const response = await fetcher(assetUrl(MANIFEST_PATH), { cache: "no-cache" });
  if (!response.ok) throw new Error("KYX Starter Loops manifest could not be downloaded.");
  return parseManifest(await response.json());
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifySha256(bytes: ArrayBuffer, expected: string): Promise<void> {
  if (!globalThis.crypto?.subtle) throw new Error("This device cannot verify the loop pack download.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  if (toHex(digest) !== expected) throw new Error("A KYX Starter Loop failed its integrity check. Please retry.");
}

/** Download, verify, decode and persist the original KYX loops on request. */
export async function installKyxStarterLoops(
  bank: SampleBank,
  repository: IUserSampleRepository,
  options: {
    fetcher?: typeof fetch;
    onProgress?: (progress: StarterLoopInstallProgress) => void;
  } = {},
): Promise<UserSampleAsset[]> {
  const fetcher = options.fetcher ?? fetch;
  const manifest = await fetchManifest(fetcher);
  const existing = await repository.list();
  const existingIds = new Set(existing.map((asset) => asset.id));
  const installed: UserSampleAsset[] = [];
  let completed = 0;

  for (const item of manifest.assets) {
    if (existingIds.has(item.id) && bank.has(item.id)) {
      completed++;
      options.onProgress?.({ completed, total: manifest.assets.length, name: item.name });
      continue;
    }
    const response = await fetcher(assetUrl(item.url));
    if (!response.ok) throw new Error(`Could not download ${item.name}. Check your connection and retry.`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== item.bytes) throw new Error(`${item.name} downloaded with an unexpected file size.`);
    await verifySha256(bytes, item.sha256);
    const buffer = await decodeAudioData(bytes.slice(0));
    if (Math.abs(buffer.duration - item.duration) > 0.04)
      throw new Error(`${item.name} has an unexpected audio duration.`);

    const asset: UserSampleAsset = {
      id: item.id,
      name: item.name,
      fileName: item.fileName,
      category: "Custom",
      duration: buffer.duration,
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels,
      createdAt: new Date().toISOString(),
      bpm: item.bpm,
      loopMetadata: {
        isLoop: true,
        genre: item.genre,
        mood: item.mood,
        instrument: item.instrument,
        key: item.key,
      },
      factoryPack: {
        id: manifest.pack.id,
        version: manifest.version,
        license: "kyx-original",
        creator: manifest.pack.creator,
      },
    };
    await persistBankBuffer(bank, item.id, buffer, () => repository.save(asset, bytes));
    installed.push(asset);
    existingIds.add(item.id);
    completed++;
    options.onProgress?.({ completed, total: manifest.assets.length, name: item.name });
  }

  return installed;
}
