/**
 * Scorepack builder: packages a project into a .scorepack ZIP file containing
 * master WAV + stems + cue WAVs + JSON manifests + README.
 */
import type { ProjectDocument } from "../project-model/types";
import type { SampleBank } from "../sample-library/factory";
import { renderProject, type ExportQuality } from "../rendering/renderer";
import { buildStemProject, STEM_GROUPS } from "../rendering/stems";
import { encodeWav } from "../rendering/wav";
import { buildZip } from "./zip";
import { markerAssetFor } from "../project-model/markers";

export interface ScorepackProgress {
  phase: string;
  pct: number;
}

export interface ScorepackResult {
  blob: Blob;
  filename: string;
}

export interface ScorepackOptions {
  /**
   * Global Live/Export quality switch for master and stems. "studio" bumps
   * PRISM to 8× and default-tier VØID to the render tier. When set, it wins
   * over the legacy per-plugin flags below. Defaults to "studio".
   */
  quality?: ExportQuality;
  /** Legacy per-plugin flag (kept for back-compat). Prefer `quality`. */
  fxeqRenderQuality?: boolean;
  /** Legacy per-plugin flag (kept for back-compat). Prefer `quality`. */
  ozvenaRenderQuality?: boolean;
}

class MissingCueAssetError extends Error {
  constructor(assetId: string) {
    super("Asset " + assetId + " not found in bank");
    this.name = "MissingCueAssetError";
  }
}

export async function buildScorepack(
  doc: ProjectDocument,
  bank: SampleBank,
  onProgress: (p: ScorepackProgress) => void = () => {},
  signal?: AbortSignal,
  options: ScorepackOptions = {},
): Promise<ScorepackResult> {
  const baseName = doc.name.replace(/[^a-zA-Z0-9 _.-]/g, "_").replace(/ +/g, "-");
  const sampleRate = 48000;
  const tailSeconds = 2;

  const entries: { name: string; data: Uint8Array }[] = [];

  const qualityOpts =
    options.quality !== undefined
      ? { quality: options.quality }
      : {
          fxeqRenderQuality: options.fxeqRenderQuality ?? true,
          ozvenaRenderQuality: options.ozvenaRenderQuality ?? true,
        };

  throwIfAborted(signal);
  onProgress({ phase: "Rendering master", pct: 0.1 });
  const masterBuffer = await renderProject(doc, bank, {
    mode: "song",
    sampleRate,
    tailSeconds,
    ...qualityOpts,
  });
  throwIfAborted(signal);
  entries.push({ name: "audio/" + baseName + "-master.wav", data: new Uint8Array(encodeWav(masterBuffer, 24)) });

  throwIfAborted(signal);
  onProgress({ phase: "Rendering stems", pct: 0.3 });
  for (let i = 0; i < STEM_GROUPS.length; i++) {
    throwIfAborted(signal);
    const group = STEM_GROUPS[i];
    const stemDoc = buildStemProject(doc, group.filter);
    const stemBuffer = await renderProject(stemDoc, bank, {
      mode: "song",
      sampleRate,
      tailSeconds,
      ...qualityOpts,
      // Audit 11 D1: scorepack stems are deliverables too — no master chain
      // baked into them (the scorepack's master.wav carries the full mix).
      masterProcessing: false,
    });
    throwIfAborted(signal);
    entries.push({
      name: "audio/stems/" + baseName + "-" + group.id + ".wav",
      data: new Uint8Array(encodeWav(stemBuffer, 24)),
    });
  }

  throwIfAborted(signal);
  onProgress({ phase: "Rendering cues", pct: 0.6 });
  const cueEntries = new Set<string>();
  for (const marker of doc.markers) {
    throwIfAborted(signal);
    const assetId = markerAssetFor(marker.type);
    if (!assetId || cueEntries.has(marker.type)) continue;
    cueEntries.add(marker.type);
    try {
      const cueBuffer = await renderCueAsset(assetId, bank, sampleRate);
      throwIfAborted(signal);
      entries.push({
        name: "audio/cues/" + marker.type + ".wav",
        data: new Uint8Array(encodeWav(cueBuffer, 24)),
      });
    } catch (error) {
      // A missing cue is optional, but cancellation and a real render failure
      // are not. Swallowing either here would make a cancelled or incomplete
      // scorepack look successful. Only the explicit missing-asset sentinel is
      // best-effort.
      if (isAbortError(error)) throw error;
      if (!(error instanceof MissingCueAssetError)) throw error;
    }
  }

  throwIfAborted(signal);
  onProgress({ phase: "Writing manifests", pct: 0.85 });
  entries.push({ name: "score.json", data: encodeUtf8(JSON.stringify(buildScoreJson(doc), null, 2)) });
  entries.push({ name: "markers.json", data: encodeUtf8(JSON.stringify(buildMarkersJson(doc), null, 2)) });
  entries.push({ name: "automation.json", data: encodeUtf8(JSON.stringify(buildAutomationJson(doc), null, 2)) });
  entries.push({ name: "intensity.json", data: encodeUtf8(JSON.stringify(buildIntensityJson(doc), null, 2)) });
  entries.push({ name: "README.md", data: encodeUtf8(buildReadme(baseName, doc)) });

  throwIfAborted(signal);
  onProgress({ phase: "Building ZIP", pct: 0.95 });
  const blob = buildZip(entries);
  onProgress({ phase: "Done", pct: 1 });

  return { blob, filename: baseName + ".scorepack" };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
}

async function renderCueAsset(assetId: string, bank: SampleBank, sampleRate: number): Promise<AudioBuffer> {
  const buf = bank.get(assetId);
  if (!buf) throw new MissingCueAssetError(assetId);
  if (buf.sampleRate === sampleRate) return buf;
  // `buf.length` is a frame count at the SOURCE rate. Reusing it at the
  // target rate changes the cue duration whenever the rates differ (and can
  // truncate a longer resample). Preserve the source duration instead.
  const ctx = new OfflineAudioContext(1, resampledCueFrameCount(buf, sampleRate), sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0);
  return ctx.startRendering();
}

/** Target frame count used when a scorepack cue is resampled offline. */
export function resampledCueFrameCount(source: Pick<AudioBuffer, "duration">, sampleRate: number): number {
  return Math.max(1, Math.ceil(source.duration * sampleRate));
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError")
  );
}

function encodeUtf8(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function buildScoreJson(doc: ProjectDocument): Record<string, unknown> {
  return {
    version: "1.0",
    project: {
      name: doc.name,
      bpm: doc.bpm,
      timeSignature: doc.timeSignature,
      key: doc.key ?? null,
      tags: doc.tags ?? [],
      durationBars: doc.arrangement.clips.reduce((max, c) => Math.max(max, c.startBar + c.lengthBars), 0),
    },
    scenes: doc.scenes.map((s) => ({
      id: s.id,
      name: s.name,
      patternId: s.patternId,
      intensity: s.intensity,
      loop: s.loop ?? false,
      hasIntensityCurve: (s.intensityCurve?.length ?? 0) > 0,
    })),
    markerCount: doc.markers.length,
    sceneAutomationCount: doc.sceneAutomation.length,
  };
}

function buildMarkersJson(doc: ProjectDocument): Record<string, unknown>[] {
  const secondsPerTick = 60 / (doc.bpm * 480);
  return doc.markers.map((m) => ({
    id: m.id,
    name: m.name,
    type: m.type,
    tick: m.tick,
    seconds: m.tick * secondsPerTick,
    linkedClipId: m.linkedClipId ?? null,
    cue: markerAssetFor(m.type),
    customId: m.customId ?? null,
  }));
}

function buildAutomationJson(doc: ProjectDocument): Record<string, unknown> {
  const secondsPerTick = 60 / (doc.bpm * 480);
  return {
    pattern: doc.automation.map((lane) => ({
      target: lane.target,
      points: lane.points.map((p) => ({ tick: p.tick, value: p.value, seconds: p.tick * secondsPerTick })),
    })),
    scene: doc.sceneAutomation.map((lane) => ({
      sceneId: lane.sceneId,
      target: lane.target,
      points: lane.points.map((p) => ({ offset: p.tick, value: p.value })),
    })),
  };
}

function buildIntensityJson(doc: ProjectDocument): unknown {
  return doc.scenes.map((s) => ({
    sceneId: s.id,
    name: s.name,
    intensity: s.intensity,
    curve: (s.intensityCurve ?? []).map((p) => ({ offset: p.offset, value: p.value })),
    loop: s.loop ?? false,
  }));
}

function buildReadme(baseName: string, doc: ProjectDocument): string {
  const lines: string[] = [];
  lines.push("# " + baseName + " - Scorepack");
  lines.push("");
  lines.push("Generated by KYX v1.0.");
  lines.push("");
  lines.push("## Contents");
  lines.push("");
  lines.push("- score.json - project metadata (BPM, key, time signature, tags, scene list)");
  lines.push("- markers.json - timeline markers with type, tick position, and seconds");
  lines.push("- automation.json - pattern and scene automation curves");
  lines.push("- intensity.json - per-scene intensity scalars and curves");
  lines.push("- audio/" + baseName + "-master.wav - full mix (24-bit, " + doc.bpm + " BPM)");
  lines.push("- audio/stems/*.wav - grouped stems (drums / bass / music)");
  lines.push("- audio/cues/*.wav - one-shot cue assets for typed markers");
  lines.push("");
  lines.push("## Key");
  lines.push("");
  lines.push("- BPM: " + doc.bpm);
  lines.push("- Time Signature: " + doc.timeSignature.numerator + "/" + doc.timeSignature.denominator);
  lines.push("- Key: " + (doc.key ?? "not set"));
  lines.push("- Scenes: " + doc.scenes.length);
  lines.push("- Markers: " + doc.markers.length);
  lines.push("");
  lines.push("## Use");
  lines.push("");
  lines.push("Import this scorepack into any Qvester-compatible tool.");
  lines.push("");
  lines.push("---");
  lines.push("*Created by KYX*");
  return lines.join("\n");
}
