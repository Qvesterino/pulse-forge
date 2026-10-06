import type { SampleLayer } from "../project-model/types";
import type { ProjectDocument } from "../project-model/types";
import type { Command } from "../commands/types";
import { parseSfz } from "./sfz";
import { setVelocityLayersCommand } from "../commands/layerCommands";

/**
 * USER SFZ LIBRARY IMPORT — turns a user's SFZ instrument (an .sfz file plus
 * its sample folder) into a KYX sampler track with proper keyzones, velocity
 * windows and per-sample roots.
 *
 * The user's files are THEIR content: persisted in their browser
 * (UserSampleRepository), no license gate (the license registry only governs
 * material KYX redistributes).
 *
 * Sample resolution: SFZ `sample=` paths are relative to default_path and to
 * the SFZ location. Inputs are indexed by normalized path tail, so a region
 * resolves when the provided file's path ENDS WITH the region's sample path
 * (case-insensitive). Missing files mark the zone unresolved — the layer is
 * skipped, never a silent wrong sample.
 */

export interface SfzImportFile {
  /** File name or webkitRelativePath from the folder input. */
  name: string;
  data: ArrayBuffer;
}

export interface SfzPlannedRegion {
  sampleId: string;
  fileName: string;
  layer: SampleLayer;
}

export interface SfzImportPlan {
  instrumentName: string;
  samplePrefix: string;
  regions: SfzPlannedRegion[];
  /** Regions whose sample file was not provided by the user. */
  missing: Array<{ sample: string; fileName: string }>;
  /** Regions skipped for degenerate key/velocity ranges. */
  skipped: Array<{ sample: string; reason: string }>;
}

export interface SfzImportOptions {
  /** Preset/instrument display name (default: the SFZ file stem). */
  instrumentName?: string;
  /** Sample id prefix (default: user.sfz.<slug of the sfz file stem>). */
  samplePrefix?: string;
}

const bs = String.fromCharCode(92);

function baseName(p: string): string {
  const normalized = p.split(bs).join("/");
  const at = normalized.lastIndexOf("/");
  return at >= 0 ? normalized.slice(at + 1) : normalized;
}

function normalizedTail(p: string): string {
  return baseName(p).toLowerCase();
}

export function planSfzInstrumentImport(
  sfzFileName: string,
  sfzText: string,
  files: SfzImportFile[],
  options: SfzImportOptions = {},
): SfzImportPlan {
  const { regions } = parseSfz(sfzText);
  const stem = sfzFileName.replace(/\.sfz$/i, "");
  const instrumentName = options.instrumentName ?? stem;
  const samplePrefix = options.samplePrefix ?? `user.sfz.${stem.toLowerCase().replace(/[^a-z0-9]+/g, "") || "inst"}`;

  const byTail = new Map<string, SfzImportFile>();
  for (const file of files) byTail.set(normalizedTail(file.name), file);

  const planned: SfzPlannedRegion[] = [];
  const missing: SfzImportPlan["missing"] = [];
  const skipped: SfzImportPlan["skipped"] = [];
  const usedIds = new Set<string>();
  let zoneCounter = 0;

  for (const region of regions) {
    const sampleTail = normalizedTail(region.sample);
    const file = byTail.get(sampleTail) ?? null;
    if (!file) {
      missing.push({ sample: region.sample, fileName: baseName(region.sample) });
      continue;
    }
    if (region.hikey <= region.lokey || region.hivel <= region.lovel) {
      skipped.push({ sample: region.sample, reason: "degenerate key/velocity range" });
      continue;
    }
    zoneCounter += 1;
    let sampleId = `${samplePrefix}.k${region.keycenter}z${zoneCounter}`;
    while (usedIds.has(sampleId)) sampleId += "x";
    usedIds.add(sampleId);
    planned.push({
      sampleId,
      fileName: file.name,
      layer: {
        id: `layer.user.${sampleId}`,
        sampleId,
        min: region.lovel / 127,
        max: region.hivel >= 127 ? 1 : Math.min(1, (region.hivel + 1) / 127),
        minPitch: region.lokey,
        maxPitch: region.hikey,
        root: region.keycenter,
      },
    });
  }

  return {
    instrumentName,
    samplePrefix,
    regions: planned,
    missing,
    skipped,
  };
}

/** Minimal WAV header read for the asset metadata (no full decode — the
 * browser decodeAudioData validates + decodes on bank add). */
export function wavMeta(data: ArrayBuffer): {
  duration: number;
  sampleRate: number;
  channels: number;
} {
  const buf = new Uint8Array(data);
  let pos = 12;
  let channels = 1;
  let bits = 16;
  let rate = 44100;
  let frames = 0;
  while (pos + 8 <= buf.length) {
    const id = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
    const size = buf[pos + 4] | (buf[pos + 5] << 8) | (buf[pos + 6] << 16) | (buf[pos + 7] << 24);
    if (id === "fmt ") {
      channels = buf[pos + 10] | (buf[pos + 11] << 8);
      rate = buf[pos + 12] | (buf[pos + 13] << 8) | (buf[pos + 14] << 16) | (buf[pos + 15] << 24);
      bits = buf[pos + 22] | (buf[pos + 23] << 8);
    } else if (id === "data") {
      const bytesPer = Math.max(1, (bits / 8) * channels);
      frames = Math.floor(size / bytesPer);
      break;
    }
    pos += 8 + size + (size % 2);
  }
  return { duration: rate > 0 ? frames / rate : 0, sampleRate: rate, channels };
}

/** base64 → STANDALONE ArrayBuffer. Uses atob when present (browser),
 * Buffer otherwise (node-side tests and scripts). */
export function base64ToBuffer(b64: string): ArrayBuffer {
  const globalAtob = (globalThis as { atob?: (s: string) => string }).atob;
  if (typeof globalAtob === "function") {
    const bin = globalAtob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer as ArrayBuffer;
  }
  const buf = Buffer.from(b64, "base64");
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out.buffer as ArrayBuffer;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const globalBtoa = (globalThis as { btoa?: (s: string) => string }).btoa;
  if (typeof globalBtoa === "function") {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return globalBtoa(bin);
  }
  return Buffer.from(bytes).toString("base64");
}

// ── MCP/agent orchestration (base64 transport) ──────────────────────────────

export interface SfzLibraryImportInput {
  /** Instrument display name — also drives the sample id prefix. */
  name: string;
  /** The .sfz instrument file content, base64. */
  sfzBase64: string;
  /** Target sampler track (must exist; kyx_state lists track ids). */
  trackId: string;
  /** The WAV files the SFZ references, base64. */
  samples: Array<{ fileName: string; base64: string }>;
}

export interface SfzLibraryImportResult {
  trackId: string;
  fallbackSampleId: string;
  layers: SampleLayer[];
  imported: number;
  missing: Array<{ sample: string; fileName: string }>;
  skipped: Array<{ sample: string; reason: string }>;
}

/** Total decoded byte budget for one agent import — a hostile or mistaken
 * payload must not fill the browser's storage in one call. */
export const SFZ_IMPORT_MAX_BYTES = 256 * 1024 * 1024;

export interface SfzLibraryImportSinks {
  bank: { add(id: string, buffer: AudioBuffer): void };
  userSamples: {
    save(
      asset: {
        id: string;
        name: string;
        fileName: string;
        category: "Custom";
        duration: number;
        sampleRate: number;
        channels: number;
        createdAt: string;
      },
      data?: ArrayBuffer,
    ): Promise<void>;
  };
  decode(bytes: ArrayBuffer): Promise<AudioBuffer>;
  getDoc(): ProjectDocument;
  execute(command: Command): void;
}

/**
 * Orchestrates a base64 agent import: plan → decode → persist → bank →
 * ONE undoable velocity-layers command on the target sampler track.
 * Returns the applied layers + counts for the MCP read-back.
 */
export async function importSfzLibrary(
  input: SfzLibraryImportInput,
  sinks: SfzLibraryImportSinks,
): Promise<SfzLibraryImportResult> {
  // Cheap PRE-decode estimate (base64 chars × 3/4): the relay caps messages
  // at 8 MB, but the desktop stdio transport is unbounded — without this a
  // hugely oversized request allocated its full decoded size before the
  // exact cap below could throw (agent-surface audit 10-06).
  const base64Chars = input.sfzBase64.length + input.samples.reduce((sum, s) => sum + s.base64.length, 0);
  if (base64Chars * 3 > SFZ_IMPORT_MAX_BYTES * 4) {
    throw new Error(
      `import too large (~${Math.round((base64Chars * 3) / 4 / 1e6)} MB — limit ${Math.round(SFZ_IMPORT_MAX_BYTES / 1e6)} MB); import in smaller batches`,
    );
  }
  const sfzBytes = base64ToBuffer(input.sfzBase64);
  let total = sfzBytes.byteLength;
  const decodedSamples = input.samples.map((s) => {
    const data = base64ToBuffer(s.base64);
    total += data.byteLength;
    return { name: s.fileName, data };
  });
  if (total > SFZ_IMPORT_MAX_BYTES) {
    throw new Error(
      `import too large (${Math.round(total / 1e6)} MB decoded — limit ${Math.round(SFZ_IMPORT_MAX_BYTES / 1e6)} MB); import in smaller batches`,
    );
  }

  const sfzText = new TextDecoder().decode(new Uint8Array(sfzBytes));
  const plan = planSfzInstrumentImport(`${input.name}.sfz`, sfzText, decodedSamples, {
    instrumentName: input.name,
  });
  if (plan.regions.length === 0) {
    throw new Error(
      `no regions resolved (${plan.missing.length} sample files missing from the import) — check that the SFZ and its WAVs came from the same folder`,
    );
  }

  const bytesByFileName = new Map(decodedSamples.map((s) => [s.name, s.data]));
  for (const region of plan.regions) {
    const data = bytesByFileName.get(region.fileName);
    if (data == null) throw new Error(`sample bytes missing after plan: ${region.fileName}`);
    const buffer = await sinks.decode(data.slice(0));
    sinks.bank.add(region.sampleId, buffer);
    const meta = wavMeta(data);
    await sinks.userSamples.save(
      {
        id: region.sampleId,
        name: region.fileName,
        fileName: `${region.sampleId}.wav`,
        category: "Custom",
        duration: meta.duration,
        sampleRate: meta.sampleRate,
        channels: meta.channels,
        createdAt: new Date().toISOString(),
      },
      data,
    );
  }

  const fallbackSampleId = plan.regions[0]?.sampleId ?? "";
  const layers = plan.regions.map((r) => r.layer);
  sinks.execute(setVelocityLayersCommand(sinks.getDoc(), input.trackId, layers, fallbackSampleId));

  return {
    trackId: input.trackId,
    fallbackSampleId,
    layers,
    imported: plan.regions.length,
    missing: plan.missing,
    skipped: plan.skipped,
  };
}
