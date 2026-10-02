import type { Services } from "../services";
import type { ProjectDocument } from "../project-model/types";
import { buildStemProject } from "../rendering/stems";
import { analyzeLoudnessBuffer } from "../audio-engine/kweighting";
import { SONG_LOUDNESS_TARGET_LUFS } from "../intent/genre-reference.generated";

/**
 * KYX MCP — RENDER SUMMARY BRIDGE (kyx_render_summary, the agent's "ears").
 *
 * An agent cannot listen. What it CAN do is make decisions from NUMBERS:
 * this bridge renders the project OFFLINE (the same path exports take) and
 * reports per-strip evidence — integrated LUFS (BS.1770-4), peak dBFS,
 * crest factor (peak−RMS = punchiness), duration — plus the master strip
 * and RELATIVE deltas against the loudest strip and the −14 streaming
 * reference. Mixing agents compare evidence; raw vibes are never returned.
 *
 * Per-strip renders use buildStemProject (pure doc clone, group parents
 * preserved, mute/solo cleared — the Audit-11 lesson) with masterProcessing
 * disabled so a strip's numbers are the strip's own, not the limiter's.
 * The master render keeps the full chain. Slow but honest: N+1 offline
 * renders per call, bounded by a strip cap.
 */

export interface RenderStripSummary {
  id: string;
  name: string;
  kind: string;
  lufs: number | null;
  peakDb: number;
  crestDb: number;
  durationSec: number;
}

export interface RenderSummaryData {
  scope: "master" | "tracks" | "all";
  strips: RenderStripSummary[];
  master: { lufs: number | null; peakDb: number; crestDb: number; durationSec: number } | null;
  referenceLufs: number;
}

/** Minimal structural AudioBuffer — works with the real thing and fakes. */
interface AnalyzableBuffer {
  length: number;
  sampleRate: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** Peak/RMS/crest/duration + BS.1770 integrated LUFS for one buffer. */
export function analyzeBufferMetrics(buffer: AnalyzableBuffer): {
  lufs: number | null;
  peakDb: number;
  crestDb: number;
  durationSec: number;
} {
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    channels.push(buffer.getChannelData(channel));
  }
  let peak = 0;
  let sumSquares = 0;
  let count = 0;
  for (const data of channels) {
    for (let i = 0; i < data.length; i += 1) {
      const sample = data[i];
      const abs = sample < 0 ? -sample : sample;
      if (abs > peak) peak = abs;
      sumSquares += sample * sample;
      count += 1;
    }
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, count));
  const peakDb = round1(20 * Math.log10(Math.max(peak, 1e-4)));
  const rmsDb = 20 * Math.log10(Math.max(rms, 1e-4));
  const reading = analyzeLoudnessBuffer(channels, buffer.sampleRate);
  return {
    lufs: reading.measured ? round1(reading.integrated) : null,
    peakDb,
    crestDb: round1(peakDb - rmsDb),
    durationSec: round1(buffer.length / buffer.sampleRate),
  };
}

/** Relative deltas an agent can act on: every strip vs the loudest one. */
export function buildRelativeLines(data: RenderSummaryData): string[] {
  const measured = data.strips.filter((strip) => strip.lufs !== null);
  if (measured.length < 2) return [];
  const loudest = measured.reduce((best, strip) => ((strip.lufs ?? -99) > (best.lufs ?? -99) ? strip : best));
  return measured
    .filter((strip) => strip.id !== loudest.id)
    .map(
      (strip) =>
        `${strip.name} is ${((strip.lufs ?? 0) - (loudest.lufs ?? 0)).toFixed(1)} LU vs loudest (${loudest.name})`,
    );
}

function formatStrip(strip: RenderStripSummary): string {
  const lufs = strip.lufs !== null ? `${strip.lufs.toFixed(1)} LUFS` : "unmeasurable";
  return `${strip.name} — ${lufs} · peak ${strip.peakDb.toFixed(1)} dBFS · crest ${strip.crestDb.toFixed(1)} dB · ${strip.durationSec.toFixed(1)} s`;
}

/** The agent-facing read-back: evidence table + relative deltas + the
 * streaming-reference verdict for the master. */
export function formatRenderSummary(data: RenderSummaryData): string {
  const lines: string[] = [];
  if (data.strips.length > 0) {
    lines.push(`strips (${data.scope === "all" ? "master processing bypassed" : "scope master"}):`);
    for (const strip of data.strips) lines.push(`  ${formatStrip(strip)}`);
    lines.push(...buildRelativeLines(data).map((line) => `  ${line}`));
  }
  if (data.master) {
    const masterStrip: RenderStripSummary = {
      id: "master",
      name: "MASTER",
      kind: "master",
      ...data.master,
    };
    const target = data.master.lufs !== null ? data.master.lufs - data.referenceLufs : null;
    const verdict =
      target === null
        ? "unmeasurable"
        : Math.abs(target) <= 1
          ? `on the ${data.referenceLufs} streaming target (within 1 LU)`
          : `${Math.abs(target).toFixed(1)} LU ${target > 0 ? "louder" : "quieter"} than the ${data.referenceLufs} streaming target`;
    lines.push(`  MASTER — ${formatStrip(masterStrip)} · ${verdict}`);
  }
  return lines.join("\n");
}

const STRIP_CAP = 14;

/** The engine path: offline-render master + per-strip stems and measure. */
export async function mcpRenderSummary(
  services: Services,
  request: { scope?: "master" | "tracks" | "all" },
): Promise<RenderSummaryData> {
  const scope = request.scope ?? "all";
  const doc: ProjectDocument = services.store.getDoc();
  const { renderProject } = await import("../rendering/renderer");
  const mode = doc.arrangement.clips.length > 0 ? "song" : "pattern";
  const sampleRate = 44100 as const;

  const strips: RenderStripSummary[] = [];
  if (scope !== "master") {
    const candidates = doc.tracks.filter((t) => t.kind !== "group");
    const overflow = candidates.length - STRIP_CAP;
    for (const track of overflow > 0 ? candidates.slice(0, STRIP_CAP) : candidates) {
      const stemDoc = buildStemProject(doc, (candidate) => candidate.id === track.id);
      const buffer = await renderProject(stemDoc, services.bank, {
        mode,
        sampleRate,
        tailSeconds: 0.6,
        masterProcessing: false,
      });
      strips.push({
        id: track.id,
        name: track.name,
        kind: track.kind,
        ...analyzeBufferMetrics(buffer),
      });
    }
  }

  let master: RenderSummaryData["master"] = null;
  if (scope !== "tracks") {
    const buffer = await renderProject(doc, services.bank, { mode, sampleRate, tailSeconds: 0.6 });
    master = analyzeBufferMetrics(buffer);
  }

  return {
    scope,
    strips,
    master,
    referenceLufs: SONG_LOUDNESS_TARGET_LUFS,
  };
}
