import type { Services } from "../services";
import type { ProjectDocument } from "../project-model/types";
import { ticksPerBar } from "../project-model/schema";
import { buildStemProject } from "../rendering/stems";
import { analyzeLoudnessBuffer } from "../audio-engine/kweighting";
import { SONG_LOUDNESS_TARGET_LUFS } from "../intent/genre-reference.generated";
import { defineAnalyzer, resolveAnalysisWindow, type AudioAnalysisResult } from "../analysis/contract";
import {
  analyzeArrangementCensus,
  measureArrangementCensusEnergy,
  type ArrangementCensus,
} from "../analysis/arrangement-census";
import {
  analyzeKickBassRisk,
  makeIsolatedKickDoc,
  notAnalyzedKickBassRisk,
  selectKickBassSourcePair,
  type KickBassRiskReport,
} from "../analysis/kick-bass-risk";
import { analyzeMixHealth, type MixHealthReport } from "../analysis/mixDoctor";
import { storeRevision } from "./revision";

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
  scope: "master" | "tracks" | "all" | "track-window" | "range";
  strips: RenderStripSummary[];
  master: { lufs: number | null; peakDb: number; crestDb: number; durationSec: number } | null;
  referenceLufs: number;
  stripCoverage?: {
    sourceTracksTotal: number;
    sourceTracksMeasured: number;
    sourceTracksOmitted: number;
    limit: number;
  };
  trackWindow?: TrackWindowAnalysis;
  range?: RenderRangeAnalysis;
  arrangementCensus?: ArrangementCensus;
  kickBassRisk?: KickBassRiskReport;
}

/**
 * Full-mix range analysis (E1): the MASTER (and optionally the strips)
 * measured INSIDE a tick window, so an agent can answer range-conditional
 * production questions ("is the drop louder than the chorus?").
 *
 * The render covers the timeline from 0 through the window end and the
 * metrics are SLICED to the window afterwards — the same contract the
 * track-window path uses — so everything sounding into the window (tails,
 * notes started earlier) is in the numbers. A window render that started at
 * the window would measure a different song.
 */
export interface RenderRangeAnalysis {
  window: { startTick: number; endTick: number };
  timing: {
    startSec: number;
    endSec: number;
    durationSec: number;
    startSample: number;
    endSample: number;
    sampleRate: number;
  };
  projectRevision: number | null;
  revisionAfterRender: number | null;
  freshness: "current" | "stale" | "unknown";
  signalStage: {
    id: "song-range";
    includes: "the full mix through the master chain, timeline rendered from 0";
    excludes: "nothing — audio before the window is rendered, only the measurement is sliced";
  };
  caveats: Array<{ code: string; detail: string }>;
}

export interface TrackWindowAnalysis {
  track: { id: string; name: string; kind: string };
  signalStage: {
    id: "track-pre-master";
    includes: "selected track and routed parent-group processing";
    excludes: "other source tracks and the master chain";
  };
  projectRevision: number | null;
  revisionAfterRender: number | null;
  freshness: "current" | "stale" | "unknown";
  renderCoverage: "isolated track rendered from timeline start through project end; metrics sliced to requested window";
  result: AudioAnalysisResult<MixHealthReport>;
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

/** Header lines for a range-scoped summary (window, timing, freshness). */
function formatRangeHeader(range: RenderRangeAnalysis): string[] {
  const freshness =
    range.projectRevision === null || range.revisionAfterRender === null
      ? "unknown"
      : range.projectRevision === range.revisionAfterRender
        ? "current"
        : "stale";
  const lines = [
    `range: ticks ${range.window.startTick}..${range.window.endTick} (${range.timing.durationSec.toFixed(3)} s, ${range.timing.startSec.toFixed(6)}..${range.timing.endSec.toFixed(6)} s)`,
    `signal stage: ${range.signalStage.id} — ${range.signalStage.includes}`,
    `project revision: ${range.projectRevision === null ? "unknown" : String(range.projectRevision)} → ${range.revisionAfterRender === null ? "unknown" : String(range.revisionAfterRender)} (${freshness}); metrics measure ONLY this window`,
  ];
  for (const caveat of range.caveats) lines.push(`caveat: ${caveat.code} — ${caveat.detail}`);
  return lines;
}

/** The agent-facing read-back: evidence table + relative deltas + the
 * streaming-reference verdict for the master. */
export function formatRenderSummary(data: RenderSummaryData): string {
  if (data.trackWindow) {
    const { track, signalStage, projectRevision, revisionAfterRender, freshness, result } = data.trackWindow;
    const metrics = result.payload;
    const revisionText = projectRevision === null ? "unknown" : String(projectRevision);
    const afterText = revisionAfterRender === null ? "unknown" : String(revisionAfterRender);
    const correlation = metrics.stereoCorrelation === null ? "n/a" : metrics.stereoCorrelation.toFixed(3);
    const lufs = metrics.integratedLufs === null ? "unmeasurable" : `${metrics.integratedLufs.toFixed(1)} LUFS`;
    const lines = [
      `track window: ${track.name} (${track.id}, ${track.kind})`,
      `signal stage: ${signalStage.id} — ${signalStage.includes}; excludes ${signalStage.excludes}`,
      `window: ticks ${result.request.window.startTick}..${result.request.window.endTick}; samples ${result.alignment.startSample}..${result.alignment.endSample} at ${result.alignment.sampleRate} Hz; ${result.alignment.startSec.toFixed(6)}..${result.alignment.endSec.toFixed(6)} s (${result.alignment.durationSec.toFixed(6)} s)`,
      `project revision: ${revisionText} → ${afterText} (${freshness}); analysis ${result.algorithm.name} v${result.algorithm.version}`,
      `metrics: ${lufs}; peak ${(-metrics.headroomDb).toFixed(1)} dBFS (${metrics.peak.toFixed(4)} linear); ${metrics.headroomDb.toFixed(1)} dB headroom; crest ${metrics.crestDb.toFixed(1)} dB; clipped samples ${metrics.clippedSamples}; DC ${metrics.dcOffset.toFixed(6)}; low-end share ${(metrics.lowEndShare * 100).toFixed(1)}%; stereo correlation ${correlation}`,
      `flags: ${metrics.flags.length > 0 ? metrics.flags.map((flag) => `${flag.severity} ${flag.check}: ${flag.detail}`).join("; ") : "none"}`,
      `render coverage: ${data.trackWindow.renderCoverage}`,
    ];
    if (result.caveats.length > 0) lines.push(`caveats: ${result.caveats.map((caveat) => caveat.detail).join("; ")}`);
    return lines.join("\n");
  }

  const lines: string[] = [];
  if (data.range) lines.push(...formatRangeHeader(data.range));
  if (data.stripCoverage) {
    const { sourceTracksTotal, sourceTracksMeasured, sourceTracksOmitted, limit } = data.stripCoverage;
    lines.push(
      sourceTracksOmitted > 0
        ? `strip coverage: ${sourceTracksMeasured}/${sourceTracksTotal} source tracks measured; ${sourceTracksOmitted} omitted by the ${limit}-track cap`
        : `strip coverage: all ${sourceTracksTotal} source tracks measured`,
    );
  }
  if (data.strips.length > 0) {
    lines.push(
      `strips (${data.scope === "all" || data.scope === "range" ? "master processing bypassed" : "scope master"}):`,
    );
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
  if (data.arrangementCensus) lines.push(...formatArrangementCensus(data.arrangementCensus));
  if (data.kickBassRisk) lines.push(...formatKickBassRisk(data.kickBassRisk));
  return lines.join("\n");
}

function formatKickBassRisk(report: KickBassRiskReport): string[] {
  const lines = [
    `onset-aligned kick/bass spectrum v${report.algorithm.version}: ${report.status}${report.reason ? ` — ${report.reason}` : ""}`,
  ];
  if (report.selection && !report.pair) {
    lines.push(
      `  identified ${report.selection.kickCandidates} kick pad candidate(s), ${report.selection.bassCandidates} bass track candidate(s)`,
    );
  }
  if (report.pair) {
    lines.push(
      `  sources: ${report.pair.kick.trackName} / ${report.pair.kick.padName} (${report.pair.kick.trackId}/${report.pair.kick.padId}) ↔ ${report.pair.bass.trackName} (${report.pair.bass.instrument}, ${report.pair.bass.trackId})`,
    );
    lines.push(
      `  measured ${report.measurement.analyzedOnsets}/${report.measurement.detectedOnsets} kick onsets; shared low-band energy at ${report.summary.sharedBandOnsets} (${(report.summary.overlapRate * 100).toFixed(1)}%); risk candidates ${report.summary.riskCandidateOnsets} (${(report.summary.riskCandidateRate * 100).toFixed(1)}%), including ${report.summary.closePeakOnsets} same-bin peak(s); FFT ${report.measurement.fftSize} (${report.measurement.frameMs.toFixed(1)} ms, ${report.measurement.binSpacingHz.toFixed(2)} Hz/bin)`,
    );
    lines.push(
      `  bands: 25–60, 60–120, 120–180 Hz; shared-energy floor ${report.measurement.measurableFloorDbfs} dBFS; candidate if both band levels ≥${report.measurement.candidateFloorDbfs} dBFS within ${report.measurement.maxLevelDifferenceDb} dB, or peaks are within ${report.measurement.samePeakBinToleranceHz.toFixed(2)} Hz`,
    );
    const cooccurrences = report.events.filter((event) => event.sharedBands.length > 0 || event.closePeakCandidate);
    const candidates = cooccurrences.slice(0, 12);
    for (const event of candidates) {
      const kickPeak =
        event.kick.dominantPeakHz === null
          ? "n/a"
          : `${event.kick.dominantPeakHz.toFixed(1)} Hz ${event.kick.dominantPeakDbfs?.toFixed(1) ?? "n/a"} dBFS`;
      const bassPeak =
        event.bass.dominantPeakHz === null
          ? "n/a"
          : `${event.bass.dominantPeakHz.toFixed(1)} Hz ${event.bass.dominantPeakDbfs?.toFixed(1) ?? "n/a"} dBFS`;
      const bandEvidence = event.sharedBands
        .map(
          (band) => `${band} K ${event.kick.bandDbfs[band].toFixed(1)}/B ${event.bass.bandDbfs[band].toFixed(1)} dBFS`,
        )
        .join(", ");
      const classification = event.riskCandidate ? "RISK CANDIDATE" : "shared energy";
      const peakDistance = event.peakDistanceHz === null ? "" : `; peak gap ${event.peakDistanceHz.toFixed(1)} Hz`;
      lines.push(
        `  tick ${event.tick} (${event.onsetSec.toFixed(3)} s): kick ${kickPeak} ↔ bass ${bassPeak}${peakDistance}; ${bandEvidence || "no shared band above floor"}; ${classification}`,
      );
    }
    if (cooccurrences.length > candidates.length) {
      lines.push(
        `  text lists first ${candidates.length} of ${cooccurrences.length} co-occurring onsets; structured data contains ${report.events.length} analyzed events`,
      );
    }
    if (report.measurement.onsetsTruncated)
      lines.push(
        `  onset sample distributed across range; ${report.measurement.detectedOnsets - report.measurement.analyzedOnsets} events omitted`,
      );
  }
  for (const caveat of report.caveats) lines.push(`  caveat: ${caveat}`);
  return lines;
}

function formatArrangementCensus(census: ArrangementCensus): string[] {
  const lines = [
    `arrangement census v${census.analyzer.version}: ${census.counts.clipsAnalyzed}/${census.counts.clipsInScope} clips, ${census.counts.uniquePatterns} unique pattern fingerprints, ${census.counts.repeatedGroups} repeated groups (${census.counts.repeatedOccurrences} repeated occurrences); revision ${census.projectRevision ?? "unknown"}`,
    "  structural facts only — repetition does not imply a problem or identical rendered audio",
  ];
  for (const clip of census.clips.slice(0, 12)) {
    const role = clip.authoredRole ? `role ${clip.authoredRole}` : "role not provided";
    const pattern = clip.fingerprint ? `pattern ${clip.fingerprint}` : "pattern unavailable";
    const activity = clip.metrics
      ? `${clip.metrics.drumHitsPerBar.toFixed(1)} drum hits/bar; ${clip.metrics.notesPerBar.toFixed(1)} notes/bar; pitch ${clip.metrics.pitchMin ?? "n/a"}..${clip.metrics.pitchMax ?? "n/a"}; velocity ${clip.metrics.velocityRange?.map((value) => value.toFixed(2)).join("..") ?? "n/a"} (mean ${clip.metrics.velocityMean?.toFixed(2) ?? "n/a"}, SD ${clip.metrics.velocityStdDev?.toFixed(2) ?? "n/a"})`
      : "pattern metrics unavailable";
    const relation =
      clip.relationToPrevious === "same-content"
        ? "same core content as previous clip"
        : clip.relationToPrevious === "different-content"
          ? "different core content from previous clip"
          : "no comparable previous clip";
    const variation = clip.changeFromPrevious
      ? `; Δ vs previous: ${clip.changeFromPrevious.drumHitsPerBar === null ? "n/a" : `${clip.changeFromPrevious.drumHitsPerBar >= 0 ? "+" : ""}${clip.changeFromPrevious.drumHitsPerBar.toFixed(1)} drum hits/bar`}, ${clip.changeFromPrevious.notesPerBar === null ? "n/a" : `${clip.changeFromPrevious.notesPerBar >= 0 ? "+" : ""}${clip.changeFromPrevious.notesPerBar.toFixed(1)} notes/bar`}, pitch-span ${clip.changeFromPrevious.pitchSpan === null ? "n/a" : `${clip.changeFromPrevious.pitchSpan >= 0 ? "+" : ""}${clip.changeFromPrevious.pitchSpan.toFixed(1)}`}`
      : "";
    const energy = clip.energy
      ? `; master RMS ${clip.energy.rmsDbfs.toFixed(1)} dBFS${clip.energy.deltaRmsDbFromPrevious === null ? "" : ` (${clip.energy.deltaRmsDbFromPrevious >= 0 ? "+" : ""}${clip.energy.deltaRmsDbFromPrevious.toFixed(1)} dB vs previous measured clip)`}`
      : "";
    lines.push(
      `  ${clip.sceneName} (${role}) ticks ${clip.range.startTick}..${clip.range.endTick}: ${activity}; ${pattern}; ${clip.occurrenceCount} occurrence(s); ${relation}${variation}${energy}`,
    );
  }
  if (census.clips.length > 12)
    lines.push(`  text lists first 12 clips; structured data contains ${census.clips.length}`);
  for (const group of census.repeatedPatterns.slice(0, 5)) {
    lines.push(`  repeated pattern ${group.fingerprint}: ${group.occurrences} clips (${group.clipIds.join(", ")})`);
  }
  if (census.energy.status === "not-measured") {
    lines.push(`  master energy: not measured (${census.energy.reason ?? "unavailable"})`);
  }
  if (census.energy.truncated || census.truncated)
    lines.push("  census is capped; see truncated flags in structured data");
  for (const caveat of census.caveats) lines.push(`  caveat: ${caveat}`);
  return lines;
}

const STRIP_CAP = 14;
const TRACK_WINDOW_MAX_BARS = 64;

const trackWindowAnalyzer = defineAnalyzer<MixHealthReport>({
  name: "kyx-mix-health",
  version: "1",
  featureSet: "mix-health",
  analyze: (channels, sampleRate) => analyzeMixHealth(channels, sampleRate),
});

function isFiniteTick(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Copy the window's samples out of every channel (bounded by the window cap). */
function sliceChannels(buffer: AnalyzableBuffer, startSample: number, endSample: number): Float32Array[] {
  const slices: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    slices.push(buffer.getChannelData(channel).slice(startSample, endSample));
  }
  return slices;
}

function monoWindow(buffer: AnalyzableBuffer, startSample: number, endSample: number): Float32Array {
  const length = Math.max(0, endSample - startSample);
  const mono = new Float32Array(length);
  let strongestChannel = 0;
  let strongestPower = -1;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    let power = 0;
    for (let sample = startSample; sample < endSample; sample += 1) {
      const value = data[sample];
      if (Number.isFinite(value)) power += value * value;
    }
    if (power > strongestPower) {
      strongestPower = power;
      strongestChannel = channel;
    }
  }
  const source = buffer.numberOfChannels > 0 ? buffer.getChannelData(strongestChannel) : new Float32Array(0);
  for (let offset = 0; offset < length; offset += 1) {
    const sample = source[startSample + offset];
    mono[offset] = Number.isFinite(sample) ? sample : 0;
  }
  return mono;
}

/** analyzeBufferMetrics over an already-sliced window. */
function measureWindow(buffer: AnalyzableBuffer, startSample: number, endSample: number) {
  const slices = sliceChannels(buffer, startSample, endSample);
  const length = Math.max(0, endSample - startSample);
  return analyzeBufferMetrics({
    length,
    sampleRate: buffer.sampleRate,
    numberOfChannels: slices.length,
    getChannelData: (channel: number) => slices[channel] ?? new Float32Array(length),
  });
}

const RANGE_STAGE: RenderRangeAnalysis["signalStage"] = {
  id: "song-range",
  includes: "the full mix through the master chain, timeline rendered from 0",
  excludes: "nothing — audio before the window is rendered, only the measurement is sliced",
};

/**
 * E1 — full-mix range measurement: render the timeline from 0 through the
 * window end (tails and earlier notes included), then slice the metrics to
 * the window. Master keeps the full chain; strips reuse the buildStemProject
 * bypass exactly like the whole-timeline pass.
 */
async function renderSongWindow(
  services: Services,
  doc: ProjectDocument,
  request: { startTick: number; endTick: number; scope: "master" | "tracks" | "all" },
  signal?: AbortSignal,
): Promise<RenderSummaryData> {
  if (doc.arrangement.clips.length === 0) {
    throw new Error(
      "range analysis needs arrangement clips — a pattern-mode project has no arrangement timeline to slice",
    );
  }
  if (!isFiniteTick(request.startTick) || !isFiniteTick(request.endTick) || request.endTick <= request.startTick) {
    throw new Error("startTick and endTick must be non-negative integer ticks with endTick > startTick");
  }
  const barTicks = ticksPerBar(doc);
  if (request.endTick - request.startTick > TRACK_WINDOW_MAX_BARS * barTicks) {
    throw new Error(`analysis window is limited to ${TRACK_WINDOW_MAX_BARS} bars`);
  }
  const { throwIfAborted } = await import("../rendering/renderer");
  throwIfAborted(signal);

  const projectRevision = storeRevision(services.store);
  const analysisRequest = {
    projectId: doc.id,
    ...(projectRevision === null ? {} : { revision: projectRevision }),
    scope: { kind: "master" as const },
    window: { startTick: request.startTick, endTick: request.endTick },
    stage: "master" as const,
    featureSet: "mix-health",
  };
  const resolved = resolveAnalysisWindow(doc, analysisRequest, 44100);
  if (resolved.endSample <= resolved.startSample) {
    throw new Error(`analysis window resolves to fewer than one sample at 44100 Hz`);
  }

  const { renderProject } = await import("../rendering/renderer");
  const renderOptions = {
    mode: "song" as const,
    sampleRate: 44100 as const,
    tailSeconds: 0,
    minimumDurationTicks: request.endTick,
    arrangementOnly: true,
    signal,
  };
  const kickBassSelection = selectKickBassSourcePair(doc);
  let selectedBassBuffer: AnalyzableBuffer | null = null;

  const strips: RenderStripSummary[] = [];
  let stripCoverage: RenderSummaryData["stripCoverage"];
  if (request.scope !== "master") {
    const candidates = doc.tracks.filter((t) => t.kind !== "group");
    const included = candidates.slice(0, STRIP_CAP);
    stripCoverage = {
      sourceTracksTotal: candidates.length,
      sourceTracksMeasured: included.length,
      sourceTracksOmitted: candidates.length - included.length,
      limit: STRIP_CAP,
    };
    for (const track of included) {
      throwIfAborted(signal);
      const stemDoc = buildStemProject(doc, (candidate) => candidate.id === track.id);
      const buffer = await renderProject(stemDoc, services.bank, { ...renderOptions, masterProcessing: false });
      if (track.id === kickBassSelection.pair?.bass.trackId) selectedBassBuffer = buffer;
      if (buffer.length < resolved.endSample) {
        throw new Error(
          `offline render ended at sample ${buffer.length}; the window needs samples ${resolved.startSample}..${resolved.endSample}`,
        );
      }
      strips.push({
        id: track.id,
        name: track.name,
        kind: track.kind,
        ...measureWindow(buffer, resolved.startSample, resolved.endSample),
      });
    }
  }

  let master: RenderSummaryData["master"] = null;
  let masterBuffer: AnalyzableBuffer | null = null;
  if (request.scope !== "tracks") {
    throwIfAborted(signal);
    const buffer = await renderProject(doc, services.bank, renderOptions);
    if (buffer.length < resolved.endSample) {
      throw new Error(
        `offline render ended at sample ${buffer.length}; the window needs samples ${resolved.startSample}..${resolved.endSample}`,
      );
    }
    masterBuffer = buffer;
    master = measureWindow(buffer, resolved.startSample, resolved.endSample);
  }

  let arrangementCensus = analyzeArrangementCensus(
    doc,
    { startTick: request.startTick, endTick: request.endTick },
    projectRevision,
  );
  const renderedMasterBuffer = masterBuffer;
  if (renderedMasterBuffer) {
    arrangementCensus = measureArrangementCensusEnergy(
      arrangementCensus,
      renderedMasterBuffer,
      (startTick, endTick) => {
        const clipWindow = resolveAnalysisWindow(
          doc,
          { ...analysisRequest, window: { startTick, endTick } },
          renderedMasterBuffer.sampleRate,
        );
        return { startSample: clipWindow.startSample, endSample: clipWindow.endSample };
      },
    );
  }
  const riskWindow = {
    startTick: request.startTick,
    endTick: request.endTick,
    startSec: resolved.startSec,
    endSec: resolved.endSec,
    sampleRate: 44100,
  };
  let kickBassRisk: KickBassRiskReport;
  if (kickBassSelection.pair === null) {
    kickBassRisk = notAnalyzedKickBassRisk(riskWindow, kickBassSelection.reason ?? "source roles are unavailable", {
      kickCandidates: kickBassSelection.kickCandidates,
      bassCandidates: kickBassSelection.bassCandidates,
    });
  } else {
    const pair = kickBassSelection.pair;
    try {
      throwIfAborted(signal);
      const kickStem = buildStemProject(
        makeIsolatedKickDoc(doc, pair),
        (candidate) => candidate.id === pair.kick.trackId,
      );
      const kickBuffer = await renderProject(kickStem, services.bank, { ...renderOptions, masterProcessing: false });
      let bassBuffer = selectedBassBuffer;
      if (bassBuffer === null) {
        throwIfAborted(signal);
        const bassStem = buildStemProject(doc, (candidate) => candidate.id === pair.bass.trackId);
        bassBuffer = await renderProject(bassStem, services.bank, { ...renderOptions, masterProcessing: false });
      }
      if (bassBuffer === null || kickBuffer.length < resolved.endSample || bassBuffer.length < resolved.endSample) {
        kickBassRisk = notAnalyzedKickBassRisk(
          riskWindow,
          `source render ended before the requested analysis window (kick ${kickBuffer.length} samples, bass ${bassBuffer?.length ?? 0} samples; need ${resolved.endSample})`,
          { kickCandidates: kickBassSelection.kickCandidates, bassCandidates: kickBassSelection.bassCandidates },
        );
      } else {
        const bassChannels = Array.from({ length: bassBuffer.numberOfChannels }, (_, channel) =>
          bassBuffer.getChannelData(channel),
        );
        kickBassRisk = analyzeKickBassRisk({
          doc,
          pair,
          kickMono: monoWindow(kickBuffer, resolved.startSample, resolved.endSample),
          bassChannels,
          startSample: resolved.startSample,
          startTick: request.startTick,
          endTick: request.endTick,
          startSec: resolved.startSec,
          endSec: resolved.endSec,
          sampleRate: kickBuffer.sampleRate,
          selectionCounts: {
            kickCandidates: kickBassSelection.kickCandidates,
            bassCandidates: kickBassSelection.bassCandidates,
          },
        });
      }
    } catch (error) {
      throwIfAborted(signal);
      kickBassRisk = notAnalyzedKickBassRisk(
        riskWindow,
        `isolated source render failed: ${error instanceof Error ? error.message : String(error)}`,
        { kickCandidates: kickBassSelection.kickCandidates, bassCandidates: kickBassSelection.bassCandidates },
      );
    }
  }
  const revisionAfterRender = storeRevision(services.store);
  return {
    scope: "range",
    strips,
    master,
    referenceLufs: SONG_LOUDNESS_TARGET_LUFS,
    ...(stripCoverage ? { stripCoverage } : {}),
    arrangementCensus,
    kickBassRisk,
    range: {
      window: { startTick: request.startTick, endTick: request.endTick },
      timing: {
        startSec: resolved.startSec,
        endSec: resolved.endSec,
        durationSec: resolved.endSec - resolved.startSec,
        startSample: resolved.startSample,
        endSample: resolved.endSample,
        sampleRate: 44100,
      },
      projectRevision,
      revisionAfterRender,
      freshness:
        projectRevision === null || revisionAfterRender === null
          ? "unknown"
          : projectRevision === revisionAfterRender
            ? "current"
            : "stale",
      signalStage: RANGE_STAGE,
      caveats: resolved.caveats.map((caveat) => ({ code: caveat.code, detail: caveat.detail })),
    },
  };
}

async function renderTrackWindow(
  services: Services,
  doc: ProjectDocument,
  request: { trackId: string; startTick: number; endTick: number },
  signal?: AbortSignal,
): Promise<TrackWindowAnalysis> {
  const track = doc.tracks.find((candidate) => candidate.id === request.trackId);
  if (!track) throw new Error(`track ${request.trackId} not found`);
  if (track.kind === "group") throw new Error("track-window analysis requires a source track, not a group track");
  if (!isFiniteTick(request.startTick) || !isFiniteTick(request.endTick) || request.endTick <= request.startTick) {
    throw new Error("startTick and endTick must be non-negative integer ticks with endTick > startTick");
  }
  const barTicks = ticksPerBar(doc);
  if (request.endTick - request.startTick > TRACK_WINDOW_MAX_BARS * barTicks) {
    throw new Error(`analysis window is limited to ${TRACK_WINDOW_MAX_BARS} bars`);
  }

  // Store revision + document are captured synchronously before the first
  // await, so the reported revision names the exact snapshot sent to render.
  const projectRevision = storeRevision(services.store);
  const capturedDoc = doc;
  const analysisRequest = {
    projectId: capturedDoc.id,
    ...(projectRevision === null ? {} : { revision: projectRevision }),
    scope: { kind: "track" as const, id: track.id },
    window: { startTick: request.startTick, endTick: request.endTick },
    stage: "track-pre-master" as const,
    featureSet: "mix-health",
  };
  const { renderProject } = await import("../rendering/renderer");
  const hasArrangement =
    capturedDoc.arrangement.clips.length > 0 ||
    (capturedDoc.arrangement.audioClips?.length ?? 0) > 0 ||
    (capturedDoc.arrangement.midiClips?.length ?? 0) > 0 ||
    (capturedDoc.arrangement.automationClips?.length ?? 0) > 0;
  const mode = hasArrangement ? "song" : "pattern";
  const stemDoc = buildStemProject(capturedDoc, (candidate) => candidate.id === track.id);
  const buffer = await renderProject(stemDoc, services.bank, {
    mode,
    sampleRate: 44100,
    tailSeconds: 0,
    minimumDurationTicks: request.endTick,
    arrangementOnly: mode === "song",
    masterProcessing: false,
    signal,
  });

  const resolved = resolveAnalysisWindow(capturedDoc, analysisRequest, buffer.sampleRate);
  if (resolved.endSample <= resolved.startSample) {
    throw new Error(`analysis window resolves to fewer than one sample at ${buffer.sampleRate} Hz`);
  }
  if (resolved.startSample < 0 || resolved.endSample > buffer.length) {
    throw new Error(
      `offline render ended at sample ${buffer.length}; requested window needs samples ${resolved.startSample}..${resolved.endSample}`,
    );
  }
  const revisionAfterRender = storeRevision(services.store);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  const result = trackWindowAnalyzer.run(capturedDoc, analysisRequest, channels, buffer.sampleRate);
  const freshness =
    projectRevision === null || revisionAfterRender === null
      ? "unknown"
      : projectRevision === revisionAfterRender
        ? "current"
        : "stale";

  return {
    track: { id: track.id, name: track.name, kind: track.kind },
    signalStage: {
      id: "track-pre-master",
      includes: "selected track and routed parent-group processing",
      excludes: "other source tracks and the master chain",
    },
    projectRevision,
    revisionAfterRender,
    freshness,
    renderCoverage:
      "isolated track rendered from timeline start through project end; metrics sliced to requested window",
    result,
  };
}

/** The engine path: offline-render master + per-strip stems and measure. */
export async function mcpRenderSummary(
  services: Services,
  request: {
    scope?: "master" | "tracks" | "all";
    trackId?: string;
    startTick?: number;
    endTick?: number;
  },
  signal?: AbortSignal,
): Promise<RenderSummaryData> {
  // AS-009 phase 2: cooperative cancellation — an already-aborted call never
  // starts its first render.
  const { throwIfAborted } = await import("../rendering/renderer");
  throwIfAborted(signal);
  const scope = request.scope ?? "all";
  const doc: ProjectDocument = services.store.getDoc();
  const hasTickWindow = request.startTick !== undefined || request.endTick !== undefined;
  if (hasTickWindow && request.trackId === undefined) {
    // E1: a tick window WITHOUT a trackId measures the FULL MIX inside the
    // window — the chorus-vs-verse surface. The track-window branch below
    // keeps its meaning: an isolated track, pre-master.
    return renderSongWindow(
      services,
      doc,
      {
        startTick: request.startTick as number,
        endTick: request.endTick as number,
        scope,
      },
      signal,
    );
  }
  const hasWindowRequest =
    request.trackId !== undefined || request.startTick !== undefined || request.endTick !== undefined;
  if (hasWindowRequest) {
    if (
      typeof request.trackId !== "string" ||
      request.trackId.length === 0 ||
      request.startTick === undefined ||
      request.endTick === undefined
    ) {
      throw new Error("track-window analysis requires trackId, startTick, and endTick together");
    }
    const trackWindow = await renderTrackWindow(
      services,
      doc,
      {
        trackId: request.trackId,
        startTick: request.startTick,
        endTick: request.endTick,
      },
      signal,
    );
    return {
      scope: "track-window",
      strips: [],
      master: null,
      referenceLufs: SONG_LOUDNESS_TARGET_LUFS,
      trackWindow,
    };
  }
  const { renderProject } = await import("../rendering/renderer");
  const mode = doc.arrangement.clips.length > 0 ? "song" : "pattern";
  const sampleRate = 44100 as const;

  const strips: RenderStripSummary[] = [];
  let stripCoverage: RenderSummaryData["stripCoverage"];
  if (scope !== "master") {
    const candidates = doc.tracks.filter((t) => t.kind !== "group");
    const included = candidates.slice(0, STRIP_CAP);
    stripCoverage = {
      sourceTracksTotal: candidates.length,
      sourceTracksMeasured: included.length,
      sourceTracksOmitted: candidates.length - included.length,
      limit: STRIP_CAP,
    };
    for (const track of included) {
      // The N+1 loop is the big cancellation win: a 14-strip summary that is
      // aborted at strip 3 stops there instead of rendering 11 more stems.
      throwIfAborted(signal);
      const stemDoc = buildStemProject(doc, (candidate) => candidate.id === track.id);
      const buffer = await renderProject(stemDoc, services.bank, {
        mode,
        sampleRate,
        tailSeconds: 0.6,
        masterProcessing: false,
        signal,
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
    throwIfAborted(signal);
    const buffer = await renderProject(doc, services.bank, { mode, sampleRate, tailSeconds: 0.6, signal });
    master = analyzeBufferMetrics(buffer);
  }

  return {
    scope,
    strips,
    master,
    referenceLufs: SONG_LOUDNESS_TARGET_LUFS,
    ...(stripCoverage ? { stripCoverage } : {}),
  };
}
