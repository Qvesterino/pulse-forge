/**
 * PROVENANCE-STAMPED RENDER MANIFEST (Wave 2/C).
 *
 * Every WAV this app writes can carry an `iXML` chunk (the de-facto
 * interchange place for DAW session metadata) holding a manifest that answers
 * the three questions a modern, AI-assisted production has to answer about a
 * bounced file:
 *
 *   1. WHICH project produced it — id + name, so a file lying in someone's
 *      downloads folder can be traced back.
 *   2. CAN IT BE REPRODUCED — a SHA-256 over the rendered float PCM
 *      (`hashPcmChannels`). Re-render the same project and compare: equal
 *      hashes mean the audio is bit-identical, not "sounds the same".
 *   3. WHAT AI IS IN IT — receipts for every generated asset the project
 *      uses (provider, model, prompt, hashes) and every AI-generated pattern
 *      (engine, seed, genre, content hash). This is the licensing paper
 *      trail: a commercial client can see exactly which model touched the
 *      mix, and which seeds reproduce it.
 *
 * The manifest is JSON inside a `<KYX>` element of a `<BWFXML>` document —
 * deliberately boring and self-describing, so a future version can migrate
 * without guesswork (`format` carries the version).
 *
 * Everything here is dependency-free and pure apart from the WebCrypto hash
 * (which degrades honestly to `null` where `crypto.subtle` is unavailable —
 * an insecure context must not pretend it verified anything).
 */

import type { ProjectDocument } from "../project-model/types";
import type { UserSampleAsset } from "../persistence/UserSampleRepository";

export const KYX_IXML_CHUNK_ID = "iXML";
export const KYX_IXML_TAG = "KYX";
export const KYX_MANIFEST_FORMAT = "kyx-render-manifest/1";

/** Caps keep the manifest small enough to live inside a WAV header. */
export const MANIFEST_MAX_ASSETS = 64;
export const MANIFEST_MAX_PATTERNS = 64;
export const MANIFEST_MAX_TRACKS = 32;
export const MANIFEST_MAX_PROMPT_CHARS = 160;

export type ManifestScope = "master" | "stems" | "track";

/**
 * Render settings that AFFECT the PCM. Recorded so a re-render can REPRODUCE
 * the file instead of merely resembling it: same mode, same rate, same
 * quality tier, same tail. Absent on manifests written before this field —
 * the verifier then re-renders with the documented defaults and says so.
 */
export interface ManifestRenderSettings {
  mode: string;
  sampleRate: number;
  quality?: string;
  masterProcessing?: boolean;
  tailSeconds?: number;
}

export interface ManifestAiAssetReceipt {
  assetId: string;
  name: string;
  providerId: string;
  modelId: string;
  inputHash: string;
  prompt?: string;
  sourceHash?: string;
  providerVersion?: string;
}

export interface ManifestAiPatternReceipt {
  patternId: string;
  patternName: string;
  engineId: string;
  engineVersion: string;
  seed: string;
  genre: string;
  outputContentHash?: string;
}

export interface ManifestAiTrackReceipt {
  trackId: string;
  trackName: string;
  providerId: string;
  modelId: string;
  style: "text" | "audio";
}

export interface RenderManifest {
  format: string;
  /** ISO timestamp of the render (injectable for deterministic tests). */
  renderedAt: string;
  project: { id: string; name: string };
  scope: ManifestScope;
  mode: string;
  sampleRate: number;
  bitDepth: number;
  durationSec: number;
  /** Human label inside a scope (e.g. "drums stem"). */
  label?: string;
  /** Settings that affect the PCM — the reproduction recipe. */
  settings?: ManifestRenderSettings;
  hash: {
    algorithm: "SHA-256" | null;
    /** The hash covers the rendered float PCM, little-endian, channel by
     *  channel — independent of the export bit depth and dither. */
    scope: "float32-pcm-le";
    value: string | null;
  };
  counts: { tracks: number; patterns: number; aiAssets: number; aiPatterns: number; aiTracks: number };
  aiAssets: ManifestAiAssetReceipt[];
  aiPatterns: ManifestAiPatternReceipt[];
  aiTracks: ManifestAiTrackReceipt[];
}

// ── hashing ───────────────────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** SHA-256 hex of the given bytes; `null` when WebCrypto is unavailable. */
export async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== "function") return null;
  try {
    const digest = await subtle.digest("SHA-256", bytes as unknown as BufferSource);
    return toHex(new Uint8Array(digest));
  } catch {
    return null;
  }
}

/**
 * Hash the rendered PCM: SHA-256 over the channel views (no copy — a joined
 * buffer would double the render's resident memory for a long master, which
 * is exactly what the export working-set budgets exist to prevent), folded
 * into one digest per channel and then into a single hash with the channel
 * count included so a mono and a dual-mono render cannot collide.
 *
 * Bit depth and dither are deliberately NOT part of the hash: the artistically
 * meaningful content is the float render, so a 24-bit master of the same
 * render verifies as a match.
 */
export async function hashPcmChannels(channels: readonly Float32Array[]): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== "function") return null;
  try {
    const perChannel: Uint8Array[] = [];
    for (const channel of channels) {
      const view = new Uint8Array(channel.buffer, channel.byteOffset, channel.byteLength);
      perChannel.push(new Uint8Array(await subtle.digest("SHA-256", view as unknown as BufferSource)));
    }
    const folded = new Uint8Array(4 + perChannel.length * 32);
    new DataView(folded.buffer).setUint32(0, channels.length, true);
    let cursor = 4;
    for (const digest of perChannel) {
      folded.set(digest, cursor);
      cursor += digest.byteLength;
    }
    return sha256Hex(folded);
  } catch {
    return null;
  }
}

// ── collection ────────────────────────────────────────────────────────────

function truncatePrompt(prompt: string | undefined): string | undefined {
  if (prompt == null) return undefined;
  const clean = prompt.trim();
  if (clean === "") return undefined;
  return clean.length > MANIFEST_MAX_PROMPT_CHARS ? `${clean.slice(0, MANIFEST_MAX_PROMPT_CHARS - 1)}…` : clean;
}

/**
 * AI receipts for the assets this project actually places on the timeline:
 * a generated asset that sits unused in the library is not part of the mix
 * and does not belong in the file's manifest.
 */
export function collectAiAssetReceipts(
  doc: ProjectDocument,
  assets: readonly UserSampleAsset[],
): ManifestAiAssetReceipt[] {
  const referenced = new Set<string>();
  for (const clip of doc.arrangement.audioClips ?? []) referenced.add(clip.bufferId);
  const receipts: ManifestAiAssetReceipt[] = [];
  for (const asset of assets) {
    if (receipts.length >= MANIFEST_MAX_ASSETS) break;
    const provenance = asset.generated;
    if (asset.origin !== "generated" || provenance == null) continue;
    if (!referenced.has(asset.id)) continue;
    receipts.push({
      assetId: asset.id,
      name: asset.name,
      providerId: provenance.providerId,
      modelId: provenance.modelId,
      inputHash: provenance.inputHash,
      ...(truncatePrompt(provenance.prompt) !== undefined ? { prompt: truncatePrompt(provenance.prompt)! } : {}),
      ...(provenance.sourceHash ? { sourceHash: provenance.sourceHash } : {}),
      ...(provenance.providerVersion ? { providerVersion: provenance.providerVersion } : {}),
    });
  }
  return receipts;
}

/** AI receipts for generated patterns (the deterministic recipe that made them). */
export function collectAiPatternReceipts(doc: ProjectDocument): ManifestAiPatternReceipt[] {
  const receipts: ManifestAiPatternReceipt[] = [];
  for (const pattern of doc.patterns) {
    if (receipts.length >= MANIFEST_MAX_PATTERNS) break;
    const generation = pattern.generation;
    if (generation == null) continue;
    receipts.push({
      patternId: pattern.id,
      patternName: pattern.name,
      engineId: generation.engineId,
      engineVersion: generation.engineVersion,
      seed: generation.seed,
      genre: generation.genre,
      ...(generation.outputContentHash ? { outputContentHash: generation.outputContentHash } : {}),
    });
  }
  return receipts;
}

/** AI receipts for generative (model-driven) tracks. */
export function collectAiTrackReceipts(doc: ProjectDocument): ManifestAiTrackReceipt[] {
  const receipts: ManifestAiTrackReceipt[] = [];
  for (const track of doc.tracks) {
    if (receipts.length >= MANIFEST_MAX_TRACKS) break;
    if (track.kind !== "generative") continue;
    receipts.push({
      trackId: track.id,
      trackName: track.name,
      providerId: track.generative.providerId,
      modelId: track.generative.modelId,
      style: track.generative.style.kind,
    });
  }
  return receipts;
}

export interface BuildRenderManifestInput {
  doc: ProjectDocument;
  scope: ManifestScope;
  mode: string;
  sampleRate: number;
  bitDepth: number;
  durationSec: number;
  /** Result of {@link hashPcmChannels}; null = WebCrypto unavailable. */
  renderHash: string | null;
  assets?: readonly UserSampleAsset[];
  /** Scope-local label, e.g. "drums stem". */
  label?: string;
  /** Settings that affect the PCM (quality/masterProcessing/tail). */
  settings?: Partial<Omit<ManifestRenderSettings, "mode" | "sampleRate">>;
  /** Injectable clock for deterministic tests. */
  date?: Date;
}

export function buildRenderManifest(input: BuildRenderManifestInput): RenderManifest {
  const aiAssets = collectAiAssetReceipts(input.doc, input.assets ?? []);
  const aiPatterns = collectAiPatternReceipts(input.doc);
  const aiTracks = collectAiTrackReceipts(input.doc);
  const settings: ManifestRenderSettings = {
    mode: input.mode,
    sampleRate: input.sampleRate,
    ...(input.settings?.quality !== undefined ? { quality: input.settings.quality } : {}),
    ...(input.settings?.masterProcessing !== undefined ? { masterProcessing: input.settings.masterProcessing } : {}),
    ...(input.settings?.tailSeconds !== undefined ? { tailSeconds: input.settings.tailSeconds } : {}),
  };
  return {
    format: KYX_MANIFEST_FORMAT,
    renderedAt: (input.date ?? new Date()).toISOString(),
    project: { id: input.doc.id, name: input.doc.name },
    scope: input.scope,
    mode: input.mode,
    sampleRate: input.sampleRate,
    bitDepth: input.bitDepth,
    durationSec: Math.max(0, Math.round(input.durationSec * 1000) / 1000),
    ...(input.label !== undefined ? { label: input.label } : {}),
    settings,
    hash: {
      algorithm: input.renderHash == null ? null : "SHA-256",
      scope: "float32-pcm-le",
      value: input.renderHash,
    },
    counts: {
      tracks: input.doc.tracks.length,
      patterns: input.doc.patterns.length,
      aiAssets: aiAssets.length,
      aiPatterns: aiPatterns.length,
      aiTracks: aiTracks.length,
    },
    aiAssets,
    aiPatterns,
    aiTracks,
  };
}

/** One-line human summary for status text. */
export function formatManifestSummary(manifest: RenderManifest): string {
  const hash =
    manifest.hash.value == null ? "hash unavailable (insecure context)" : `hash ${manifest.hash.value.slice(0, 12)}`;
  const ai = manifest.counts.aiAssets + manifest.counts.aiPatterns + manifest.counts.aiTracks;
  return `${hash} · ${manifest.counts.tracks} tracks · ${ai === 0 ? "no AI provenance" : `${ai} AI receipt(s)`}`;
}

// ── iXML chunk payload ────────────────────────────────────────────────────

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Serialize a manifest as the iXML chunk payload (a BWFXML document). */
export function manifestToIxml(manifest: RenderManifest): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<BWFXML><${KYX_IXML_TAG}>${escapeXml(JSON.stringify(manifest))}</${KYX_IXML_TAG}></BWFXML>`;
}

/** Parse the JSON payload out of an iXML chunk payload, or null when absent/invalid. */
export function manifestFromIxml(ixml: string): RenderManifest | null {
  const start = ixml.indexOf(`<${KYX_IXML_TAG}>`);
  const end = ixml.indexOf(`</${KYX_IXML_TAG}>`);
  if (start < 0 || end < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(unescapeXml(ixml.slice(start + KYX_IXML_TAG.length + 2, end))) as unknown;
    if (parsed == null || typeof parsed !== "object") return null;
    const manifest = parsed as RenderManifest;
    if (manifest.format !== KYX_MANIFEST_FORMAT) return null;
    if (typeof manifest.project?.id !== "string" || typeof manifest.project?.name !== "string") return null;
    return manifest;
  } catch {
    return null;
  }
}

const RIFF_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;

/**
 * Walk a RIFF/WAVE byte stream for the `iXML` chunk and parse the manifest.
 * Defensive by construction: truncated sizes, odd chunks and non-WAV input
 * all return null instead of throwing (this parses user-supplied files).
 */
export function parseRenderManifestFromWav(bytes: Uint8Array): RenderManifest | null {
  try {
    if (bytes.byteLength < RIFF_HEADER_BYTES) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (offset: number) =>
      String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
    let cursor = RIFF_HEADER_BYTES;
    while (cursor + CHUNK_HEADER_BYTES <= bytes.byteLength) {
      const id = tag(cursor);
      const size = view.getUint32(cursor + 4, true);
      const body = cursor + CHUNK_HEADER_BYTES;
      if (body + size > bytes.byteLength) return null; // truncated file
      if (id === KYX_IXML_CHUNK_ID) {
        const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(body, body + size));
        return manifestFromIxml(text);
      }
      cursor = body + size + (size % 2); // word alignment
    }
    return null;
  } catch {
    return null;
  }
}

// ── last-export stamp (drives the VERIFY flow) ────────────────────────────

/**
 * The most recent export in this window. Deliberately ONE entry and manifest-
 * only (no blob): the panel's VERIFY action re-renders and compares hashes,
 * so keeping the file bytes resident would be pure memory cost. Surviving a
 * panel unmount is the point — the user exports, keeps working, then verifies.
 */
export interface LastRenderStamp {
  manifest: RenderManifest;
  fileName: string;
  recordedAt: number;
}

let lastStamp: LastRenderStamp | null = null;

export function rememberRenderStamp(stamp: Omit<LastRenderStamp, "recordedAt">): LastRenderStamp {
  lastStamp = { ...stamp, recordedAt: Date.now() };
  return lastStamp;
}

export function lastRenderStamp(): LastRenderStamp | null {
  return lastStamp;
}

/** Test/teardown hook — the registry is per-window by design. */
export function clearRenderStampForTests(): void {
  lastStamp = null;
}

/**
 * The settings a faithful re-render needs. Manifests written before
 * `settings` existed fall back to mode + rate (documented defaults for the
 * rest), which the verify flow reports instead of implying a perfect match.
 */
export function reproductionSettings(manifest: RenderManifest): ManifestRenderSettings {
  return manifest.settings ?? { mode: manifest.mode, sampleRate: manifest.sampleRate };
}

// ── verification ──────────────────────────────────────────────────────────

export type ManifestVerificationStatus = "match" | "project-mismatch" | "hash-mismatch" | "hash-unavailable";

export interface ManifestVerification {
  status: ManifestVerificationStatus;
  detail: string;
}

/**
 * Compare a stamped manifest against the project that is open now.
 * "match" is the strong claim: the same project re-renders to the same PCM.
 */
export async function verifyRenderManifest(
  manifest: RenderManifest,
  current: { docId: string; channels: readonly Float32Array[] },
): Promise<ManifestVerification> {
  if (manifest.hash.value == null) {
    return {
      status: "hash-unavailable",
      detail: "The file carries no render hash (WebCrypto was unavailable at export) — reproduction cannot be proven.",
    };
  }
  if (current.docId !== manifest.project.id) {
    return {
      status: "project-mismatch",
      detail: `The file was rendered from project "${manifest.project.name}" (${manifest.project.id}); the open project has a different id.`,
    };
  }
  const currentHash = await hashPcmChannels(current.channels);
  if (currentHash == null) {
    return { status: "hash-unavailable", detail: "WebCrypto is unavailable here, so the re-render cannot be hashed." };
  }
  if (currentHash === manifest.hash.value) {
    return { status: "match", detail: `Bit-identical re-render (SHA-256 ${currentHash.slice(0, 12)}).` };
  }
  return {
    status: "hash-mismatch",
    detail: `The re-render does not match (${currentHash.slice(0, 12)} ≠ ${manifest.hash.value.slice(0, 12)}) — the project or its render settings changed since this file was written.`,
  };
}
