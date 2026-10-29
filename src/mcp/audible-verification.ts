import { analyzeLoudnessBuffer } from "../audio-engine/kweighting";
import { computeStftDbFrames } from "../audio-engine/spectralEdit";
import { resolveAnalysisWindow } from "../analysis/contract";
import { storeRevision } from "./revision";
import { publishAudibleVerification } from "../analysis/audible-verification-store";
import { tickAtBar } from "../project-model/schema";
import type { ProjectDocument } from "../project-model/types";
import type { Services } from "../services";
import { renderTrack } from "../rendering/track-renderer";

/**
 * AUDIBLE VERIFICATION (experience-friction follow-up, "did the sound really
 * change?").
 *
 * Two-phase on purpose: capture a bounded render BEFORE the edit, then
 * compare the same scope AFTER it. A single after-the-fact call cannot know
 * the previous sound, and undoing the document just to render a baseline
 * would mutate history and race the user. The baseline is a bounded mono
 * fingerprint (2-4 bars, at most 8 live tokens), not a project snapshot.
 *
 * The render uses the same `renderProject` path exports take, the same
 * `resolveAnalysisWindow` mapping analysis uses, and the existing loudness /
 * STFT code. No new DSP.
 */

const SAMPLE_RATE = 44100;
const MIN_BARS = 2;
const MAX_BARS = 4;
const MAX_CAPTURES = 8;
const CAPTURE_TTL_MS = 10 * 60_000;
const SILENCE_RMS = 1e-4;
const RESIDUAL_CHANGED_DB = -60;
const LUFS_CHANGED = 0.1;
const BAND_CHANGED_DB = 0.5;

export interface AudibleVerificationRequest {
  op: "capture" | "compare";
  /** Stable track id. Omit for the full mix (master). */
  trackId?: string;
  /** 1-based start bar. Capture only. */
  startBar?: number;
  /** 2..4 bars. Capture only. */
  bars?: number;
  /** Capture token. Compare only. */
  token?: string;
}

export interface AudibleBands {
  lowDb: number;
  midDb: number;
  highDb: number;
}

export interface AudibleMetrics {
  lufs: number | null;
  peakDb: number;
  rmsDb: number;
  crestDb: number;
  durationSec: number;
  sampleRate: number;
  bands: AudibleBands | null;
  contentHash: string;
}

export interface AudibleScope {
  kind: "track" | "master";
  trackId?: string;
  trackName: string;
  startBar: number;
  bars: number;
  startTick: number;
  endTick: number;
}

export interface AudibleComparison {
  verified: boolean;
  audibleChanged: boolean;
  verdict: "changed" | "unchanged" | "inconclusive";
  deltas: {
    lufs: number | null;
    rmsDb: number;
    peakDb: number;
    nullResidualDb: number | null;
    durationSec: number;
  };
  bands: {
    before: AudibleBands | null;
    after: AudibleBands | null;
    delta: AudibleBands | null;
    dominant: { band: "low" | "mid" | "high"; centerHz: number; deltaDb: number } | null;
  };
  caveats: string[];
}

export interface AudibleVerificationResult {
  op: "capture" | "compare";
  token: string;
  scope: AudibleScope;
  revisionBefore: number | null;
  revisionAfter: number | null;
  before: AudibleMetrics;
  after: AudibleMetrics | null;
  comparison: AudibleComparison | null;
}

interface CaptureRecord {
  docId: string;
  scope: AudibleScope;
  revision: number | null;
  mono: Float32Array;
  metrics: AudibleMetrics;
  at: number;
}

const captures = new Map<string, CaptureRecord>();
let tokenCounter = 0;

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function db(value: number): number {
  return 20 * Math.log10(Math.max(value, 1e-7));
}

function mixToMono(channels: readonly Float32Array[]): Float32Array {
  const length = channels.reduce((max, channel) => Math.max(max, channel.length), 0);
  const mono = new Float32Array(length);
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index += 1) mono[index] += channel[index]!;
  }
  if (channels.length > 1) {
    for (let index = 0; index < mono.length; index += 1) mono[index] /= channels.length;
  }
  return mono;
}

function hashMono(mono: Float32Array): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < mono.length; index += 1) {
    const value = Math.round((mono[index] ?? 0) * 32768) | 0;
    hash ^= value & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (value >> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16).padStart(8, "0")}:${mono.length}`;
}

function bandPower(frames: readonly Float32Array[], sampleRate: number, lowHz: number, highHz: number) {
  const fftSize = 2048;
  const binHz = sampleRate / fftSize;
  const startBin = Math.max(0, Math.floor(lowHz / binHz));
  const endBin = Math.min(fftSize / 2, Math.ceil(highHz / binHz));
  let power = 0;
  let count = 0;
  for (const frame of frames) {
    for (let bin = startBin; bin < endBin; bin += 1) {
      power += 10 ** ((frame[bin] ?? -160) / 10);
      count += 1;
    }
  }
  return count > 0 ? 10 * Math.log10(Math.max(power / count, 1e-16)) : -160;
}

function bandsOf(mono: Float32Array, sampleRate: number): AudibleBands | null {
  if (mono.length < 2048) return null;
  const frames = computeStftDbFrames(mono);
  if (frames.length === 0) return null;
  const nyquist = sampleRate / 2;
  return {
    lowDb: round(bandPower(frames, sampleRate, 20, 200), 1),
    midDb: round(bandPower(frames, sampleRate, 200, 2_000), 1),
    highDb: round(bandPower(frames, sampleRate, 2_000, nyquist), 1),
  };
}

function metricsOf(channels: readonly Float32Array[], sampleRate: number): AudibleMetrics {
  const mono = mixToMono(channels);
  let peak = 0;
  let sumSquares = 0;
  let count = 0;
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index += 1) {
      const sample = channel[index] ?? 0;
      peak = Math.max(peak, Math.abs(sample));
      sumSquares += sample * sample;
      count += 1;
    }
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, count));
  const reading = analyzeLoudnessBuffer(channels, sampleRate);
  return {
    lufs: reading.measured ? round(reading.integrated, 1) : null,
    peakDb: round(db(peak), 1),
    rmsDb: round(db(rms), 1),
    crestDb: round(db(peak) - db(rms), 1),
    durationSec: round(mono.length / sampleRate, 3),
    sampleRate,
    bands: bandsOf(mono, sampleRate),
    contentHash: hashMono(mono),
  };
}

function bandCenter(band: "low" | "mid" | "high", sampleRate: number): number {
  const nyquist = sampleRate / 2;
  if (band === "low") return Math.round(Math.sqrt(20 * 200));
  if (band === "mid") return Math.round(Math.sqrt(200 * 2_000));
  return Math.round(Math.sqrt(2_000 * nyquist));
}

function bandDelta(before: AudibleBands | null, after: AudibleBands | null): AudibleBands | null {
  if (!before || !after) return null;
  return {
    lowDb: round(after.lowDb - before.lowDb, 1),
    midDb: round(after.midDb - before.midDb, 1),
    highDb: round(after.highDb - before.highDb, 1),
  };
}

/**
 * Pure PCM comparison: the same math the browser gate runs, testable without
 * Web Audio. Identical PCM has no residual; a gain edit shows its dB delta; a
 * silent baseline can never claim a verified audible change.
 */
export function compareAudiblePcm(
  beforeMono: Float32Array,
  beforeMetrics: AudibleMetrics,
  afterMono: Float32Array,
  afterMetrics: AudibleMetrics,
  sampleRate: number,
): AudibleComparison {
  const beforeRms = 10 ** (beforeMetrics.rmsDb / 20);
  const afterRms = 10 ** (afterMetrics.rmsDb / 20);
  const beforeSilent = beforeRms < SILENCE_RMS;
  const afterSilent = afterRms < SILENCE_RMS;
  const caveats: string[] = [];
  const durationDelta = round(afterMetrics.durationSec - beforeMetrics.durationSec, 3);
  if (Math.abs(durationDelta) > 0.01)
    caveats.push("the two renders have different durations; comparison uses the overlap");

  let nullResidualDb: number | null = null;
  const overlap = Math.min(beforeMono.length, afterMono.length);
  if (overlap > 0 && !beforeSilent) {
    let diffPower = 0;
    let basePower = 0;
    for (let index = 0; index < overlap; index += 1) {
      const base = beforeMono[index] ?? 0;
      const diff = (afterMono[index] ?? 0) - base;
      diffPower += diff * diff;
      basePower += base * base;
    }
    if (basePower > 0) nullResidualDb = round(10 * Math.log10(Math.max(diffPower / basePower, 1e-12)), 1);
  }
  if (beforeSilent || afterSilent) caveats.push("one render is below the silence floor");

  const lufsDelta =
    beforeMetrics.lufs == null || afterMetrics.lufs == null ? null : round(afterMetrics.lufs - beforeMetrics.lufs, 1);
  const bands = bandDelta(beforeMetrics.bands, afterMetrics.bands);
  const dominantCandidates: Array<{ band: "low" | "mid" | "high"; deltaDb: number }> = bands
    ? [
        { band: "low", deltaDb: bands.lowDb },
        { band: "mid", deltaDb: bands.midDb },
        { band: "high", deltaDb: bands.highDb },
      ]
    : [];
  const dominant = dominantCandidates.sort((a, b) => Math.abs(b.deltaDb) - Math.abs(a.deltaDb))[0] ?? null;

  const verified = !(beforeSilent && afterSilent);
  const audibleChanged = verified
    ? beforeSilent !== afterSilent ||
      (nullResidualDb != null && nullResidualDb > RESIDUAL_CHANGED_DB) ||
      (lufsDelta != null && Math.abs(lufsDelta) >= LUFS_CHANGED) ||
      (dominant != null && Math.abs(dominant.deltaDb) >= BAND_CHANGED_DB)
    : false;

  return {
    verified,
    audibleChanged,
    verdict: !verified ? "inconclusive" : audibleChanged ? "changed" : "unchanged",
    deltas: {
      lufs: lufsDelta,
      rmsDb: round(afterMetrics.rmsDb - beforeMetrics.rmsDb, 1),
      peakDb: round(afterMetrics.peakDb - beforeMetrics.peakDb, 1),
      nullResidualDb,
      durationSec: durationDelta,
    },
    bands: {
      before: beforeMetrics.bands,
      after: afterMetrics.bands,
      delta: bands,
      dominant: dominant == null ? null : { ...dominant, centerHz: bandCenter(dominant.band, sampleRate) },
    },
    caveats,
  };
}

function scopeFromRequest(doc: ProjectDocument, request: AudibleVerificationRequest): AudibleScope {
  const startBar = Math.round(Number(request.startBar));
  const bars = Math.round(Number(request.bars ?? 2));
  if (!Number.isFinite(startBar) || startBar < 1) throw new Error("startBar must be a 1-based integer");
  if (!Number.isFinite(bars) || bars < MIN_BARS || bars > MAX_BARS) {
    throw new Error(`bars must be between ${MIN_BARS} and ${MAX_BARS}`);
  }
  const trackId = typeof request.trackId === "string" ? request.trackId.trim() : "";
  const track = trackId === "" ? null : doc.tracks.find((candidate) => candidate.id === trackId);
  if (trackId !== "" && track == null) throw new Error(`track ${trackId} not found`);
  return {
    kind: track == null ? "master" : "track",
    ...(track == null ? {} : { trackId: track.id }),
    trackName: track?.name ?? "Master",
    startBar,
    bars,
    startTick: tickAtBar(startBar, doc),
    endTick: tickAtBar(startBar + bars, doc),
  };
}

function scopeLabel(scope: AudibleScope): string {
  return scope.kind === "master" ? "master mix" : `track "${scope.trackName}"`;
}

async function renderScope(
  services: Pick<Services, "store" | "bank">,
  doc: ProjectDocument,
  scope: AudibleScope,
  signal?: AbortSignal,
): Promise<{ channels: Float32Array[]; metrics: AudibleMetrics; revision: number | null }> {
  const hasArrangement =
    doc.arrangement.clips.length > 0 ||
    (doc.arrangement.audioClips?.length ?? 0) > 0 ||
    (doc.arrangement.midiClips?.length ?? 0) > 0 ||
    (doc.arrangement.automationClips?.length ?? 0) > 0;
  const mode = hasArrangement ? "song" : "pattern";
  const revision = storeRevision(services.store);
  const { renderProject } = await import("../rendering/renderer");
  const options = {
    mode,
    sampleRate: SAMPLE_RATE,
    tailSeconds: 0,
    minimumDurationTicks: scope.endTick,
    arrangementOnly: mode === "song",
    signal,
  } as const;
  const buffer =
    scope.kind === "track"
      ? await renderTrack(doc, scope.trackId!, services.bank, { ...options, masterProcessing: false })
      : await renderProject(doc, services.bank, options);

  const resolved = resolveAnalysisWindow(
    doc,
    {
      ...(revision == null ? {} : { revision }),
      scope: scope.kind === "track" ? { kind: "track", id: scope.trackId } : { kind: "master" },
      window: { startTick: scope.startTick, endTick: scope.endTick },
    },
    buffer.sampleRate,
  );
  const start = Math.max(0, Math.floor(resolved.startSample));
  const end = Math.min(buffer.length, Math.ceil(resolved.endSample));
  if (end <= start) throw new Error("the verification window resolves to fewer than one rendered sample");
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
    buffer.getChannelData(channel).slice(start, end),
  );
  return { channels, metrics: metricsOf(channels, buffer.sampleRate), revision };
}

function pruneCaptures(): void {
  const cutoff = Date.now() - CAPTURE_TTL_MS;
  for (const [token, capture] of captures) {
    if (capture.at < cutoff) captures.delete(token);
  }
  while (captures.size > MAX_CAPTURES) {
    const oldest = captures.keys().next().value as string | undefined;
    if (oldest == null) break;
    captures.delete(oldest);
  }
}

export async function runAudibleVerification(
  services: Pick<Services, "store" | "bank">,
  request: AudibleVerificationRequest,
  signal?: AbortSignal,
): Promise<AudibleVerificationResult> {
  if (request.op === "capture") {
    const doc = services.store.getDoc();
    const scope = scopeFromRequest(doc, request);
    const rendered = await renderScope(services, doc, scope, signal);
    tokenCounter += 1;
    const token = `aud-${doc.id.slice(0, 8)}-${tokenCounter}-${rendered.metrics.contentHash.slice(0, 8)}`;
    captures.set(token, {
      docId: doc.id,
      scope,
      revision: rendered.revision,
      mono: mixToMono(rendered.channels),
      metrics: rendered.metrics,
      at: Date.now(),
    });
    pruneCaptures();
    return {
      op: "capture",
      token,
      scope,
      revisionBefore: rendered.revision,
      revisionAfter: rendered.revision,
      before: rendered.metrics,
      after: null,
      comparison: null,
    };
  }

  const token = typeof request.token === "string" ? request.token.trim() : "";
  const capture = token === "" ? undefined : captures.get(token);
  if (capture == null) throw new Error("verification token is unknown or expired — capture the baseline first");
  const doc = services.store.getDoc();
  if (doc.id !== capture.docId) {
    throw new Error("verification token belongs to a different project — capture on the open project");
  }
  const rendered = await renderScope(services, doc, capture.scope, signal);
  const comparison = compareAudiblePcm(
    capture.mono,
    capture.metrics,
    mixToMono(rendered.channels),
    rendered.metrics,
    rendered.metrics.sampleRate,
  );
  const revisionAfter = storeRevision(services.store);
  publishAudibleVerification({
    docId: doc.id,
    revision: revisionAfter,
    scopeLabel: scopeLabel(capture.scope),
    audibleChanged: comparison.audibleChanged,
    verified: comparison.verified,
    lufsDelta: comparison.deltas.lufs,
    nullResidualDb: comparison.deltas.nullResidualDb,
    dominantBand: comparison.bands.dominant,
    at: Date.now(),
  });
  return {
    op: "compare",
    token,
    scope: capture.scope,
    revisionBefore: capture.revision,
    revisionAfter,
    before: capture.metrics,
    after: rendered.metrics,
    comparison,
  };
}

/** Exported for the pure comparison test; not part of the host contract. */
export const AUDIBLE_VERIFICATION_DEFAULTS = {
  minBars: MIN_BARS,
  maxBars: MAX_BARS,
  residualChangedDb: RESIDUAL_CHANGED_DB,
  lufsChanged: LUFS_CHANGED,
  bandChangedDb: BAND_CHANGED_DB,
};
