import type { SampleLayer } from "../project-model/types";
import { parseSfz } from "./sfz";

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
 * the SFZ location. Folder inputs carry webkitRelativePath, so resolution is
 * suffix-based: the provided file whose path ENDS WITH the region's sample
 * path wins (case-insensitive). Missing files mark the zone unresolved —
 * the layer is skipped, never a silent wrong sample.
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
  const { defaultPath, regions } = parseSfz(sfzText);
  const stem = sfzFileName.replace(/\.sfz$/i, "");
  const instrumentName = options.instrumentName ?? stem;
  const samplePrefix = options.samplePrefix ?? `user.sfz.${stem.toLowerCase().replace(/[^a-z0-9]+/g, "") || "inst"}`;

  // Index by lowercase tail of the provided path.
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
