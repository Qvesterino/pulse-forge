/**
 * Lossless-audio handoff from KYX to a native ZYVO/VocalForge project.
 *
 * The full stereo render is authoritative and opens as the target project's
 * instrumental bed. Optional, time-aligned track renders are provided for
 * remixing; they are pre-master because nonlinear master processing cannot
 * be copied onto every isolated stem and still sum back to the master.
 */
import type { ProjectDocument, Track } from "../project-model/types";
import { BAR_TICKS, PPQ, STEP_TICKS } from "../project-model/types";
import { buildStemProject } from "../rendering/stems";
import { buildTempoMap, renderProject, type ClipWindow, type ExportQuality } from "../rendering/renderer";
import { encodeWav, sanitizeFilename } from "../rendering/wav";
import { summarizeBuffer, type BufferSummary } from "../audio-engine/metering";
import type { SampleBank } from "../sample-library/factory";
import { buildZip } from "./zip";

export const ZYVO_TRANSFER_FORMAT = "com.kyx.zyvo-transfer" as const;
export const ZYVO_TRANSFER_VERSION = 1 as const;
/** Keep in sync with the VocalForge importer; classic ZIP is deliberately bounded. */
export const MAX_ZYVO_TRANSFER_BYTES = 1024 * 1024 * 1024;
const TRANSFER_SAMPLE_RATE = 48_000;
const TRANSFER_TAIL_SECONDS = 2;

export interface ZyvoTransferTempoPoint {
  timeSeconds: number;
  bpm: number;
  ramp: false;
}

export interface ZyvoTransferSection {
  id: string;
  name: string;
  role?: string;
  sceneId: string;
  startBar: number;
  lengthBars: number;
  startSeconds: number;
  endSeconds: number;
  bpm: number;
}

export interface ZyvoTransferMarker {
  id: string;
  name: string;
  type: string;
  tick: number;
  timeSeconds: number;
}

export interface ZyvoTransferStem {
  sourceTrackId: string;
  name: string;
  sourceKind: Track["kind"];
  instrument?: string;
  groupId?: string;
  color?: string;
  sourceGain: number;
  sourcePan: number;
  sourceMuted: boolean;
  sourceSolo: boolean;
  /** Track/group processing and source fader are baked into this file. */
  audioPath: string;
  sampleRate: number;
  channels: number;
  bitDepth: 32;
  frameCount: number;
  durationSeconds: number;
}

export interface ZyvoTransferManifest {
  format: typeof ZYVO_TRANSFER_FORMAT;
  version: typeof ZYVO_TRANSFER_VERSION;
  createdAt: string;
  sourceProjectPath: "source/kyx-project.json";
  project: {
    id: string;
    name: string;
    bpm: number;
    timeSignature: { numerator: number; denominator: number };
    key: string | null;
    durationSeconds: number;
    sampleRate: number;
    tempoPoints: ZyvoTransferTempoPoint[];
    sections: ZyvoTransferSection[];
    markers: ZyvoTransferMarker[];
  };
  master: {
    audioPath: "audio/master.wav";
    sampleRate: number;
    channels: number;
    bitDepth: 32;
    frameCount: number;
    durationSeconds: number;
    quality: "studio" | "live";
  };
  stems: ZyvoTransferStem[];
  notes: string[];
}

export interface ZyvoTransferProgress {
  phase: string;
  pct: number;
}

export interface ZyvoTransferOptions {
  /** Defaults on: bakes one time-aligned, pre-master 32-bit-float WAV per renderable KYX track. */
  includeTrackStems?: boolean;
  quality?: ExportQuality;
}

export interface ZyvoTransferResult {
  blob: Blob;
  filename: string;
  manifest: ZyvoTransferManifest;
  masterSummary: BufferSummary;
}

/** Build a self-contained transfer archive; never mutates the supplied document. */
export async function buildZyvoTransfer(
  doc: ProjectDocument,
  bank: SampleBank,
  onProgress: (progress: ZyvoTransferProgress) => void = () => {},
  signal?: AbortSignal,
  options: ZyvoTransferOptions = {},
): Promise<ZyvoTransferResult> {
  throwIfAborted(signal);
  const includeTrackStems = options.includeTrackStems ?? true;
  const quality = options.quality ?? "studio";
  const sourceTracks = doc.tracks.filter((track) => track.kind !== "group");
  const tracksToRender = includeTrackStems ? sourceTracks : [];
  if (tracksToRender.length > 2000) throw new Error("KYX transfer supports up to 2,000 track stems. Disable stems to transfer the full master mix.");
  if (doc.markers.length > 10_000 || doc.arrangement.clips.length > 10_000) {
    throw new Error("KYX transfer supports up to 10,000 arrangement sections and markers.");
  }
  const baseName = sanitizeFilename(doc.name);
  const transferProjectName = doc.name.trim().slice(0, 180) || "KYX Session";
  const sourceProject = encodeUtf8(JSON.stringify(doc, null, 2));
  if (sourceProject.byteLength > 64 * 1024 * 1024) throw new Error("The embedded KYX project JSON exceeds the 64 MiB transfer limit.");

  onProgress({ phase: "Rendering exact KYX master", pct: 0.04 });
  const masterBuffer = await renderProject(doc, bank, {
    mode: "song",
    sampleRate: TRANSFER_SAMPLE_RATE,
    tailSeconds: TRANSFER_TAIL_SECONDS,
    quality,
    signal,
  });
  throwIfAborted(signal);
  assertTransferBuffer(masterBuffer, "KYX master");

  const estimatedArchiveBytes = estimateArchiveBytes(
    masterBuffer.length,
    tracksToRender.length,
    sourceProject.byteLength,
  );
  if (estimatedArchiveBytes > MAX_ZYVO_TRANSFER_BYTES) {
    throw new Error(
      `This transfer would be about ${formatBytes(estimatedArchiveBytes)}. ` +
        `The safe single-file limit is ${formatBytes(MAX_ZYVO_TRANSFER_BYTES)}; ` +
        `turn off “Include track stems” to transfer the exact master mix only.`,
    );
  }

  const entries: { name: string; data: Uint8Array }[] = [
    { name: "audio/master.wav", data: new Uint8Array(encodeWav(masterBuffer, 32)) },
    { name: "source/kyx-project.json", data: sourceProject },
  ];

  const windows = collectSongWindows(doc);
  const timing = windows.length > 0 ? buildTempoMap(doc, windows) : null;
  const timeAt = timing?.timeAt ?? ((tick: number) => (tick * 60) / (doc.bpm * PPQ));
  const stemMetadata: ZyvoTransferStem[] = [];

  for (let index = 0; index < tracksToRender.length; index++) {
    throwIfAborted(signal);
    const sourceTrack = tracksToRender[index];
    const pct = 0.12 + ((index + 1) / Math.max(1, tracksToRender.length)) * 0.68;
    onProgress({ phase: `Rendering stem ${index + 1}/${tracksToRender.length}: ${sourceTrack.name}`, pct });

    const selected = buildStemProject(doc, (track) => track.id === sourceTrack.id);
    // A muted source still gets a usable stem. Its original mute/solo state is
    // retained in the manifest; the VocalForge import starts all stems muted
    // while the exact full-mix reference plays.
    const stemDoc: ProjectDocument = {
      ...selected,
      tracks: selected.tracks.map((track) => ({ ...track, mute: false, solo: false }) as Track),
    };
    const buffer = await renderProject(stemDoc, bank, {
      mode: "song",
      sampleRate: TRANSFER_SAMPLE_RATE,
      tailSeconds: TRANSFER_TAIL_SECONDS,
      quality,
      masterProcessing: false,
      signal,
    });
    throwIfAborted(signal);
    assertTransferBuffer(buffer, `KYX stem “${sourceTrack.name}”`);
    if (buffer.length !== masterBuffer.length) {
      throw new Error(`KYX stem “${sourceTrack.name}” is not sample-aligned with the master render.`);
    }

    // Float32 stems retain pre-master headroom and avoid a second lossy or
    // nonlinear conversion; the 1 GiB transfer cap remains the hard guard.
    const audioPath = `audio/tracks/${String(index + 1).padStart(3, "0")}-${slug(sourceTrack.name)}-${slug(sourceTrack.id)}.wav`;
    entries.push({ name: audioPath, data: new Uint8Array(encodeWav(buffer, 32)) });
    stemMetadata.push({
      sourceTrackId: sourceTrack.id,
      name: sourceTrack.name,
      sourceKind: sourceTrack.kind,
      ...(sourceTrack.kind === "instrument" ? { instrument: sourceTrack.instrument } : {}),
      ...(sourceTrack.groupId ? { groupId: sourceTrack.groupId } : {}),
      ...(sourceTrack.color ? { color: sourceTrack.color } : {}),
      sourceGain: sourceTrack.gain,
      sourcePan: sourceTrack.pan,
      sourceMuted: sourceTrack.mute,
      sourceSolo: sourceTrack.solo,
      audioPath,
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels,
      bitDepth: 32,
      frameCount: buffer.length,
      durationSeconds: buffer.duration,
    });
  }

  throwIfAborted(signal);
  onProgress({ phase: "Writing arrangement and source metadata", pct: 0.84 });
  const manifest: ZyvoTransferManifest = {
    format: ZYVO_TRANSFER_FORMAT,
    version: ZYVO_TRANSFER_VERSION,
    createdAt: new Date().toISOString(),
    sourceProjectPath: "source/kyx-project.json",
    project: {
      id: doc.id,
      name: transferProjectName,
      bpm: doc.bpm,
      timeSignature: { ...doc.timeSignature },
      key: doc.key ?? null,
      durationSeconds: masterBuffer.duration,
      sampleRate: masterBuffer.sampleRate,
      tempoPoints: buildTempoPoints(doc, windows, timeAt),
      sections: buildSections(doc, timeAt),
      markers: doc.markers.map((marker) => ({
        id: marker.id,
        name: marker.name,
        type: marker.type,
        tick: marker.tick,
        timeSeconds: timeAt(marker.tick),
      })),
    },
    master: {
      audioPath: "audio/master.wav",
      sampleRate: masterBuffer.sampleRate,
      channels: masterBuffer.numberOfChannels,
      bitDepth: 32,
      frameCount: masterBuffer.length,
      durationSeconds: masterBuffer.duration,
      quality,
    },
    stems: stemMetadata,
    notes: [
      "The full-mix WAV is the authoritative sound reference and is loaded as the VocalForge instrumental bed.",
      "Track stems are aligned from time zero, include KYX track/group processing and are rendered before the KYX master stage.",
      "Track fader gain and pan are baked into each stem; imported stem mixer channels start at unity/center and muted.",
      "The original KYX JSON is included. Instrument, effect, automation and sample-bank state are preserved there, not translated into VocalForge-native synth state.",
      "Nonlinear track/group processing means isolated stems are remix sources, not a promise that summing them recreates the mastered full mix.",
      "Sidechain keying from tracks outside an isolated stem may not reproduce in that stem; the full-mix render remains the authoritative reference.",
    ],
  };
  entries.push({ name: "manifest.json", data: encodeUtf8(JSON.stringify(manifest, null, 2)) });
  entries.push({ name: "README.md", data: encodeUtf8(buildReadme(doc.name, manifest)) });

  throwIfAborted(signal);
  onProgress({ phase: "Packaging native VocalForge transfer", pct: 0.94 });
  const blob = buildZip(entries);
  if (blob.size > MAX_ZYVO_TRANSFER_BYTES) {
    throw new Error(`The generated transfer is too large (${formatBytes(blob.size)}).`);
  }
  onProgress({ phase: "Transfer ready", pct: 1 });
  return {
    blob,
    filename: `${baseName}.kyxzyvo`,
    manifest,
    masterSummary: summarizeBuffer(masterBuffer),
  };
}

function collectSongWindows(doc: ProjectDocument): ClipWindow[] {
  const windows: ClipWindow[] = [];
  for (const clip of [...doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar)) {
    const scene = doc.scenes.find((candidate) => candidate.id === clip.sceneId);
    const pattern = scene && doc.patterns.find((candidate) => candidate.id === scene.patternId);
    if (!scene || !pattern) continue;
    const base = clip.startBar * BAR_TICKS;
    windows.push({
      pattern,
      base,
      from: base,
      to: base + clip.lengthBars * BAR_TICKS,
      bpm: scene.bpm ?? doc.bpm,
      sceneId: scene.id,
    });
  }
  if (windows.length === 0) {
    const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId) ?? doc.patterns[0];
    if (pattern) {
      windows.push({ pattern, base: 0, from: 0, to: pattern.stepCount * STEP_TICKS, bpm: doc.bpm });
    }
  }
  return windows;
}

function buildTempoPoints(
  doc: ProjectDocument,
  windows: ClipWindow[],
  timeAt: (tick: number) => number,
): ZyvoTransferTempoPoint[] {
  const changes: Array<{ tick: number; bpm: number }> = [{ tick: 0, bpm: doc.bpm }];
  const sorted = [...windows].sort((a, b) => a.from - b.from);
  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];
    changes.push({ tick: current.from, bpm: current.bpm ?? doc.bpm });
    const next = sorted[i + 1];
    if (!next || current.to < next.from) changes.push({ tick: current.to, bpm: doc.bpm });
  }
  const points: ZyvoTransferTempoPoint[] = [];
  for (const change of changes.sort((a, b) => a.tick - b.tick)) {
    const point = { timeSeconds: Math.max(0, timeAt(change.tick)), bpm: change.bpm, ramp: false as const };
    const previous = points[points.length - 1];
    if (previous && Math.abs(previous.timeSeconds - point.timeSeconds) < 1e-9) {
      points[points.length - 1] = point;
    } else if (!previous || previous.bpm !== point.bpm) {
      points.push(point);
    }
  }
  return points.length > 0 ? points : [{ timeSeconds: 0, bpm: doc.bpm, ramp: false }];
}

function buildSections(doc: ProjectDocument, timeAt: (tick: number) => number): ZyvoTransferSection[] {
  return [...doc.arrangement.clips]
    .sort((a, b) => a.startBar - b.startBar)
    .flatMap((clip, index) => {
      const scene = doc.scenes.find((candidate) => candidate.id === clip.sceneId);
      if (!scene) return [];
      const startTick = clip.startBar * BAR_TICKS;
      const endTick = (clip.startBar + clip.lengthBars) * BAR_TICKS;
      return [{
        id: `section_${index + 1}`,
        name: scene.name,
        ...(scene.role ? { role: scene.role } : {}),
        sceneId: scene.id,
        startBar: clip.startBar,
        lengthBars: clip.lengthBars,
        startSeconds: Math.max(0, timeAt(startTick)),
        endSeconds: Math.max(0, timeAt(endTick)),
        bpm: scene.bpm ?? doc.bpm,
      }];
    });
}

function estimateArchiveBytes(masterFrames: number, stemCount: number, sourceBytes: number): number {
  // Master and every stem are stereo IEEE float32 interchange WAVs.
  return 44 + masterFrames * 2 * 4 + stemCount * (44 + masterFrames * 2 * 4) + sourceBytes + 2_000_000;
}

function assertTransferBuffer(buffer: AudioBuffer, label: string): void {
  if (buffer.sampleRate !== TRANSFER_SAMPLE_RATE || buffer.numberOfChannels !== 2 || buffer.length <= 0) {
    throw new Error(`${label} did not render as non-empty 48 kHz stereo audio.`);
  }
}

function formatBytes(value: number): string {
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\w-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "track";
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
}

function buildReadme(projectName: string, manifest: ZyvoTransferManifest): string {
  const lines = [
    `# ${projectName} — KYX to ZYVO transfer`,
    "",
    "Open VocalForge / ZYVO and choose File → Import KYX Session…",
    "",
    "## Audio fidelity",
    "",
    `- Authoritative stereo mix: ${manifest.master.sampleRate} Hz, 32-bit float WAV, ${manifest.master.quality} offline render.`,
    "- Optional track stems are time-aligned to zero, 32-bit float, and rendered before KYX master processing.",
    "- The VocalForge project starts with the exact master mix audible and all stems muted, preventing accidental doubling.",
    "- Track/group processing is included in the stems. The full mix remains the reference because nonlinear processing cannot be undone by a stem sum.",
    "- Sidechain inputs from other tracks may differ in isolated stems; use the full mix as the definitive reference.",
    "",
    "## Editability",
    "",
    "- `source/kyx-project.json` retains the original KYX musical document and plugin/instrument parameters.",
    "- VocalForge receives native audio tracks. KYX synths and plugin states are not falsely represented as compatible VocalForge instruments.",
    "",
    `## Session details`,
    "",
    `- Tempo: ${manifest.project.bpm} BPM`,
    `- Time signature: ${manifest.project.timeSignature.numerator}/${manifest.project.timeSignature.denominator}`,
    `- Sections: ${manifest.project.sections.length}`,
    `- Markers: ${manifest.project.markers.length}`,
    `- Imported track stems: ${manifest.stems.length}`,
    "",
  ];
  return lines.join("\n");
}
