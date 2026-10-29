import type { Services } from "../services";
import type { ProjectDocument } from "../project-model/types";
import { storeRevision } from "./revision";
import { ticksPerBar } from "../project-model/schema";
import { resolveAnalysisWindow } from "../analysis/contract";
import { analyzeMixHealth } from "../analysis/mixDoctor";
import { downmixToMono16k } from "../analysis/adapters/audio-tagging";
import { classifyAudio } from "../ai/audio/audio-client";

/**
 * KYX MCP — ANALYZE AUDIO BRIDGE (kyx_analyze, E-6).
 *
 * The perception audit's Phase-7 ask: ONE parametrized perception entry
 * (trackId + featureSet + window) returning the E-1 envelope — provenance
 * (project id, revision, algorithm identity, resolved window), a BOUNDED
 * payload digest, and the unavailable/low-confidence/no-event distinction —
 * without flooding the tool registry. kyx_render_summary (numbers for
 * mixing), kyx_diagnose_mix (attributed fixes) and kyx_unsuno
 * (transcription) stay: they are compositions, not duplicates.
 *
 * Feature sets:
 *   mix-health   — the strip's own mix digest (peak/LUFS/crest/band
 *                  shares/flags) from a per-strip render (masterProcessing
 *                  off, so the numbers are the strip's own).
 *   audio-labels — the on-device AST tagger (E-5 adapter) over the same
 *                  render. Unavailable model = status "partial" with the
 *                  model-unavailable reason — analysis unavailable is NOT
 *                  "no labels detected".
 *
 * Bounded by construction: the payload is a DIGEST (top-5 labels, the
 * health report's own scalar fields) — raw PCM and full spectra never
 * reach the tool result.
 */

export interface AnalyzeAudioRequest {
  trackId: string;
  featureSet: "mix-health" | "audio-labels";
  fromBar?: number;
  toBar?: number;
}

export interface AnalyzeAudioResult {
  status: "analyzed" | "partial";
  algorithm: { name: string; version: string };
  provenance: {
    projectId: string;
    revision: number | null;
    trackId: string;
    trackName: string;
    window: { startTick: number; endTick: number; startSec: number; endSec: number };
    algorithm: { name: string; version: string };
  };
  confidence: number | null;
  mixHealth?: {
    peak: number;
    lufsIntegrated: number | null;
    crestDb: number;
    clippedSamples: number;
    bandShares: Record<string, number>;
    flags: string[];
  };
  labels?: Array<{ label: string; score: number }>;
  partialReason?: string;
}

const WINDOW_MAX_BARS = 16;

interface AnalyzableBuffer {
  length: number;
  sampleRate: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/** Structural render dependency — injectable for tests, real in hosts. */
export type StripRenderer = (
  doc: ProjectDocument,
  trackId: string,
  options: { sampleRate: number; signal?: AbortSignal },
) => Promise<AnalyzableBuffer>;

async function defaultStripRender(
  services: Services,
  doc: ProjectDocument,
  trackId: string,
  options: { sampleRate: number; signal?: AbortSignal },
) {
  const { renderTrack } = await import("../rendering/track-renderer");
  const { buildStemProject } = await import("../rendering/stems");
  const stemDoc = buildStemProject(doc, (track) => track.id === trackId);
  // masterProcessing OFF: the strip's own numbers, not the limiter's
  // (the same per-strip rule kyx_render_summary follows).
  return renderTrack(stemDoc, trackId, services.bank, {
    mode: "song",
    sampleRate: options.sampleRate,
    tailSeconds: 0,
    arrangementOnly: true,
    masterProcessing: false,
    signal: options.signal,
  });
}

export async function mcpAnalyzeAudio(
  services: Services,
  request: AnalyzeAudioRequest,
  signal?: AbortSignal,
  deps?: { render?: StripRenderer; classify?: (mono16k: Float32Array) => Promise<Array<{ label: string; score: number }> | null> },
): Promise<AnalyzeAudioResult> {
  const doc = services.store.getDoc();
  const track = doc.tracks.find((t) => t.id === request.trackId);
  if (!track) {
    throw new Error(`no track with id "${request.trackId}" — list ids via kyx_state subject:tracks`);
  }
  const barTicks = ticksPerBar(doc);
  const fromBar = Math.max(0, Math.floor(request.fromBar ?? 0));
  const toBar = Math.floor(request.toBar ?? fromBar + 8);
  if (toBar <= fromBar) throw new Error("toBar must be greater than fromBar");
  if (toBar - fromBar > WINDOW_MAX_BARS) {
    throw new Error(`analysis window is limited to ${WINDOW_MAX_BARS} bars`);
  }
  const window = { startTick: fromBar * barTicks, endTick: toBar * barTicks };

  const render = deps?.render ?? ((d, id, opts) => defaultStripRender(services, d, id, opts));
  const buffer = await render(doc, request.trackId, { sampleRate: 44100, signal });
  const { throwIfAborted } = await import("../rendering/renderer");
  throwIfAborted(signal);

  const projectRevision = storeRevision(services.store);
  const resolved = resolveAnalysisWindow(doc, {
    ...(projectRevision === null ? {} : { revision: projectRevision }),
    scope: { kind: "track", id: request.trackId },
    window,
  }, 44100);

  const provenance = {
    projectId: doc.id,
    revision: projectRevision,
    trackId: request.trackId,
    trackName: typeof track.name === "string" ? track.name : request.trackId,
    window: {
      startTick: window.startTick,
      endTick: window.endTick,
      startSec: resolved.startSec,
      endSec: resolved.endSec,
    },
    algorithm:
      request.featureSet === "audio-labels"
        ? { name: "audio-tagging", version: "audio-tag.v1" }
        : { name: "mix-doctor", version: "1" },
  };

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) channels.push(buffer.getChannelData(ch));

  if (request.featureSet === "mix-health") {
    const health = analyzeMixHealth(channels, buffer.sampleRate);
    return {
      status: "analyzed",
      provenance,
      algorithm: provenance.algorithm,
      confidence: null,
      mixHealth: {
        peak: health.peak,
        lufsIntegrated: health.integratedLufs,
        crestDb: health.crestDb,
        clippedSamples: health.clippedSamples,
        bandShares: { ...health.bandShares } as Record<string, number>,
        flags: health.flags.map((flag) => (typeof flag === "string" ? flag : JSON.stringify(flag))),
      },
    };
  }

  // audio-labels: mono 16 kHz over the window, through the never-throw
  // tagger client. Unavailable model ⇒ PARTIAL — never "no labels".
  const classify = deps?.classify ?? classifyAudio;
  const mono = downmixToMono16k(channels, buffer.sampleRate);
  try {
    const labels = await classify(mono);
    if (labels === null) {
      return {
        status: "partial",
        provenance,
        algorithm: provenance.algorithm,
        confidence: null,
        labels: [],
        partialReason:
          "audio tagging unavailable (model not fetched, flag off, or worker failed) — analysis unavailable, NOT 'no labels detected'",
      };
    }
    const top = [...labels].sort((a, b) => b.score - a.score).slice(0, 5);
    return {
      status: "analyzed",
      provenance,
      algorithm: provenance.algorithm,
      confidence: top[0]?.score ?? null,
      labels: top,
    };
  } catch (error) {
    return {
      status: "partial",
      provenance,
      algorithm: provenance.algorithm,
      confidence: null,
      labels: [],
      partialReason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The bounded text an agent reads — numbers and provenance, no arrays. */
export function formatAnalyzeAudio(result: AnalyzeAudioResult): string {
  const p = result.provenance;
  const head = `${p.trackName}: ${result.status} (${result.algorithm.name}@${result.algorithm.version}, revision ${p.revision ?? "unknown"})`;
  if (result.status === "partial") return `${head} — ${result.partialReason}`;
  if (result.mixHealth) {
    const m = result.mixHealth;
    const top = Object.entries(m.bandShares)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([band, share]) => `${band} ${(share * 100).toFixed(0)}%`)
      .join(", ");
    return `${head} — peak ${(20 * Math.log10(Math.max(m.peak, 1e-6))).toFixed(1)} dBFS, LUFS-I ${
      m.lufsIntegrated?.toFixed(1) ?? "n/a"
    }, crest ${m.crestDb.toFixed(1)} dB, clipped ${m.clippedSamples}, bands: ${top}${m.flags.length > 0 ? `; flags: ${m.flags.join(", ")}` : ""}`;
  }
  const labels = (result.labels ?? [])
    .slice(0, 5)
    .map((label) => `${label.label} ${(label.score * 100).toFixed(0)}%`)
    .join(", ");
  return `${head} — labels (confidence ${(100 * (result.confidence ?? 0)).toFixed(0)}%): ${labels}`;
}
