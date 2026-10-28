import { fftInPlace } from "../audio-engine/spectralEdit";
import { detectTransients } from "../audio-workers/onset-detector";
import { buildArrangementSpans, arrangementSecondsBetweenTicksInSpans } from "../project-model/scene-time";
import { ticksPerBar } from "../project-model/schema";
import type { DrumPad, DrumTrack, InstrumentTrack, ProjectDocument } from "../project-model/types";

const FFT_SIZE = 4096;
const MAX_ANALYZED_ONSETS = 128;
const LOW_FREQUENCY_MIN_HZ = 25;
const LOW_FREQUENCY_MAX_HZ = 180;
const MEASURABLE_FLOOR_DBFS = -70;
const CANDIDATE_FLOOR_DBFS = -45;
const MAX_LEVEL_DIFFERENCE_DB = 18;

type LowBandName = "sub" | "bass" | "upperBass";

interface KickSource {
  track: DrumTrack;
  pad: DrumPad;
  score: number;
}

interface BassSource {
  track: InstrumentTrack;
  score: number;
}

export interface KickBassSourcePair {
  kick: { trackId: string; trackName: string; padId: string; padName: string };
  bass: { trackId: string; trackName: string; instrument: string };
}

export interface KickBassFrequencyReading {
  dominantPeakHz: number | null;
  dominantPeakDbfs: number | null;
  bandDbfs: Record<LowBandName, number>;
}

export interface KickBassRiskEvent {
  tick: number;
  onsetSec: number;
  kick: KickBassFrequencyReading;
  bass: KickBassFrequencyReading;
  sharedBands: LowBandName[];
  riskCandidateBands: LowBandName[];
  peakDistanceHz: number | null;
  closePeakCandidate: boolean;
  riskCandidate: boolean;
}

export interface KickBassRiskReport {
  status: "measured" | "not-analyzed" | "no-kick-onsets";
  reason?: string;
  algorithm: { name: "onset-aligned-kick-bass-spectrum"; version: "1" };
  window: { startTick: number; endTick: number; startSec: number; endSec: number; sampleRate: number };
  pair?: KickBassSourcePair;
  selection?: { kickCandidates: number; bassCandidates: number; rule: string };
  measurement: {
    frameMs: number;
    fftSize: number;
    binSpacingHz: number;
    frequencyRangeHz: [number, number];
    bands: ReadonlyArray<{ name: LowBandName; fromHz: number; toHz: number }>;
    measurableFloorDbfs: number;
    candidateFloorDbfs: number;
    maxLevelDifferenceDb: number;
    samePeakBinToleranceHz: number;
    analyzedOnsets: number;
    detectedOnsets: number;
    onsetsTruncated: boolean;
  };
  summary: {
    sharedBandOnsets: number;
    riskCandidateOnsets: number;
    closePeakOnsets: number;
    overlapRate: number;
    riskCandidateRate: number;
    bandCounts: Record<LowBandName, number>;
  };
  events: KickBassRiskEvent[];
  caveats: string[];
}

export interface KickBassRiskInput {
  doc: ProjectDocument;
  pair: KickBassSourcePair;
  kickMono: Float32Array;
  bassChannels: readonly Float32Array[];
  startSample: number;
  startTick: number;
  endTick: number;
  startSec: number;
  endSec: number;
  sampleRate: number;
  selectionCounts: { kickCandidates: number; bassCandidates: number };
}

type RiskWindow = Pick<KickBassRiskInput, "startTick" | "endTick" | "startSec" | "endSec" | "sampleRate">;

function isNamedKick(name: string): boolean {
  return /(?:^|[\s_.-])(kick|bd|bass[\s_-]?drum)(?:$|[\s_.-])/i.test(name) || /^(kick|bd)[\s_.-]?\d/i.test(name);
}

function kickCandidates(doc: ProjectDocument): KickSource[] {
  const candidates: KickSource[] = [];
  for (const track of doc.tracks) {
    if (track.kind !== "drum" || track.mute) continue;
    const parent = track.groupId ? doc.tracks.find((item) => item.kind === "group" && item.id === track.groupId) : null;
    if (parent?.mute) continue;
    for (const pad of track.pads) {
      if (pad.mute) continue;
      const synthKick = pad.synth?.type === "kick";
      const namedKick = isNamedKick(pad.name);
      if (!synthKick && !namedKick) continue;
      candidates.push({ track, pad, score: (synthKick ? 2 : 0) + (namedKick ? 1 : 0) });
    }
  }
  return candidates.sort(
    (a, b) => b.score - a.score || a.track.id.localeCompare(b.track.id) || a.pad.id.localeCompare(b.pad.id),
  );
}

function isNamedBass(name: string): boolean {
  return /(?:^|[\s_.-])(bass|sub|808|reese|logdrum)(?:$|[\s_.-])/i.test(name);
}

function bassCandidates(doc: ProjectDocument): BassSource[] {
  const candidates: BassSource[] = [];
  for (const track of doc.tracks) {
    if (track.kind !== "instrument" || track.mute) continue;
    const parent = track.groupId ? doc.tracks.find((item) => item.kind === "group" && item.id === track.groupId) : null;
    if (parent?.mute) continue;
    const instrumentBass = ["bass", "808", "reese", "logdrum"].includes(track.instrument);
    const namedBass = isNamedBass(track.name);
    if (!instrumentBass && !namedBass) continue;
    candidates.push({ track, score: (instrumentBass ? 2 : 0) + (namedBass ? 1 : 0) });
  }
  return candidates.sort((a, b) => b.score - a.score || a.track.id.localeCompare(b.track.id));
}

function hasSoloState(doc: ProjectDocument): boolean {
  return doc.tracks.some((track) => track.solo || (track.kind === "drum" && track.pads.some((pad) => pad.solo)));
}

/** Select only an unambiguous, metadata-supported pair; never guess from arbitrary tracks. */
export function selectKickBassSourcePair(doc: ProjectDocument): {
  pair: KickBassSourcePair | null;
  kickCandidates: number;
  bassCandidates: number;
  reason?: string;
} {
  const kicks = kickCandidates(doc);
  const basses = bassCandidates(doc);
  if (hasSoloState(doc)) {
    return {
      pair: null,
      kickCandidates: kicks.length,
      bassCandidates: basses.length,
      reason:
        "project solo state changes which sources are audible; unsolo the project before comparing isolated tracks",
    };
  }
  if (kicks.length === 0 || basses.length === 0) {
    return {
      pair: null,
      kickCandidates: kicks.length,
      bassCandidates: basses.length,
      reason: `could not identify both roles from project metadata (${kicks.length} kick pad candidate(s), ${basses.length} bass track candidate(s))`,
    };
  }
  const bestKickScore = kicks[0]?.score ?? 0;
  const bestBassScore = basses[0]?.score ?? 0;
  const bestKicks = kicks.filter((candidate) => candidate.score === bestKickScore);
  const bestBasses = basses.filter((candidate) => candidate.score === bestBassScore);
  if (bestKicks.length !== 1 || bestBasses.length !== 1) {
    return {
      pair: null,
      kickCandidates: kicks.length,
      bassCandidates: basses.length,
      reason: `ambiguous source roles (${bestKicks.length} equally ranked kick pad(s), ${bestBasses.length} equally ranked bass track(s))`,
    };
  }
  const kick = bestKicks[0]!;
  const bass = bestBasses[0]!;
  return {
    pair: {
      kick: { trackId: kick.track.id, trackName: kick.track.name, padId: kick.pad.id, padName: kick.pad.name },
      bass: { trackId: bass.track.id, trackName: bass.track.name, instrument: bass.track.instrument },
    },
    kickCandidates: kicks.length,
    bassCandidates: basses.length,
  };
}

const LOW_BANDS: ReadonlyArray<{ name: LowBandName; fromHz: number; toHz: number }> = [
  { name: "sub", fromHz: 25, toHz: 60 },
  { name: "bass", fromHz: 60, toHz: 120 },
  { name: "upperBass", fromHz: 120, toHz: 180 },
];

function spectrumReading(
  channels: readonly Float32Array[],
  sampleStart: number,
  sampleRate: number,
): KickBassFrequencyReading {
  let windowPower = 0;
  let hannSum = 0;
  for (let i = 0; i < FFT_SIZE; i += 1) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
    windowPower += hann * hann;
    hannSum += hann;
  }
  const power: Record<LowBandName, number> = { sub: 0, bass: 0, upperBass: 0 };
  let dominantPeakHz: number | null = null;
  let dominantPeakDbfs: number | null = null;
  let peakAmplitude = 0;
  const binHz = sampleRate / FFT_SIZE;
  const sourceChannelCount = Math.max(1, channels.length);
  for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
    const channel = channels[channelIndex]!;
    const real = new Float64Array(FFT_SIZE);
    const imaginary = new Float64Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i += 1) {
      const sample = channel[sampleStart + i];
      const value = Number.isFinite(sample) ? sample : 0;
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
      real[i] = value * hann;
    }
    fftInPlace(real, imaginary);
    for (let bin = 1; bin < FFT_SIZE / 2; bin += 1) {
      const frequency = bin * binHz;
      if (frequency < LOW_FREQUENCY_MIN_HZ || frequency > LOW_FREQUENCY_MAX_HZ) continue;
      const magnitudeSquared = real[bin]! * real[bin]! + imaginary[bin]! * imaginary[bin]!;
      // One-sided Parseval power, normalized by the Hann window's energy.
      const rmsPower = (2 * magnitudeSquared) / (FFT_SIZE * windowPower);
      const band = LOW_BANDS.find((candidate) => frequency >= candidate.fromHz && frequency < candidate.toHz);
      if (band) power[band.name] += rmsPower / sourceChannelCount;

      // Coherent-gain-corrected peak amplitude gives a useful low-tone estimate.
      const peakAmplitudeAtBin = (2 * Math.sqrt(magnitudeSquared)) / Math.max(1, hannSum);
      if (peakAmplitudeAtBin > peakAmplitude) {
        peakAmplitude = peakAmplitudeAtBin;
        dominantPeakHz = frequency;
        dominantPeakDbfs = 20 * Math.log10(Math.max(peakAmplitudeAtBin, 1e-8));
      }
    }
  }
  const bandDbfs = {
    sub: 10 * Math.log10(Math.max(power.sub, 1e-20)),
    bass: 10 * Math.log10(Math.max(power.bass, 1e-20)),
    upperBass: 10 * Math.log10(Math.max(power.upperBass, 1e-20)),
  };
  return { dominantPeakHz, dominantPeakDbfs, bandDbfs };
}

function secondsAtTick(doc: ProjectDocument, tick: number, spans: ReturnType<typeof buildArrangementSpans>): number {
  return arrangementSecondsBetweenTicksInSpans(spans, 0, tick, doc.bpm);
}

function tickAtSeconds(
  doc: ProjectDocument,
  seconds: number,
  startTick: number,
  endTick: number,
  spans: ReturnType<typeof buildArrangementSpans>,
): number {
  let low = startTick;
  let high = endTick;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (secondsAtTick(doc, middle, spans) < seconds) low = middle + 1;
    else high = middle;
  }
  const upper = Math.max(startTick, Math.min(endTick, low));
  const lower = Math.max(startTick, upper - 1);
  return seconds - secondsAtTick(doc, lower, spans) <= secondsAtTick(doc, upper, spans) - seconds ? lower : upper;
}

function emptyReport(input: RiskWindow, reason: string, status: KickBassRiskReport["status"]): KickBassRiskReport {
  return {
    status,
    reason,
    algorithm: { name: "onset-aligned-kick-bass-spectrum", version: "1" },
    window: {
      startTick: input.startTick,
      endTick: input.endTick,
      startSec: input.startSec,
      endSec: input.endSec,
      sampleRate: input.sampleRate,
    },
    measurement: {
      frameMs: (FFT_SIZE / input.sampleRate) * 1000,
      fftSize: FFT_SIZE,
      binSpacingHz: input.sampleRate / FFT_SIZE,
      frequencyRangeHz: [LOW_FREQUENCY_MIN_HZ, LOW_FREQUENCY_MAX_HZ],
      bands: LOW_BANDS,
      measurableFloorDbfs: MEASURABLE_FLOOR_DBFS,
      candidateFloorDbfs: CANDIDATE_FLOOR_DBFS,
      maxLevelDifferenceDb: MAX_LEVEL_DIFFERENCE_DB,
      samePeakBinToleranceHz: input.sampleRate / FFT_SIZE,
      analyzedOnsets: 0,
      detectedOnsets: 0,
      onsetsTruncated: false,
    },
    summary: {
      sharedBandOnsets: 0,
      riskCandidateOnsets: 0,
      closePeakOnsets: 0,
      overlapRate: 0,
      riskCandidateRate: 0,
      bandCounts: { sub: 0, bass: 0, upperBass: 0 },
    },
    events: [],
    caveats: [
      "isolated source stems are measured pre-master; co-presence is not proof of masking or phase cancellation",
    ],
  };
}

export function notAnalyzedKickBassRisk(
  window: { startTick: number; endTick: number; startSec: number; endSec: number; sampleRate: number },
  reason: string,
  selectionCounts: { kickCandidates: number; bassCandidates: number },
): KickBassRiskReport {
  const report = emptyReport(window, reason, "not-analyzed");
  report.selection = {
    ...selectionCounts,
    rule: "one highest-ranked kick pad and bass instrument selected from explicit synth/instrument metadata or role names",
  };
  return report;
}

/**
 * Compare each detected kick-pad onset with a 92.9 ms low-frequency spectrum
 * from the kick and bass source stems at the same arrangement sample position.
 */
export function analyzeKickBassRisk(input: KickBassRiskInput): KickBassRiskReport {
  const base = emptyReport(input, "", "measured");
  const onsetTimes = detectTransients(input.kickMono, input.sampleRate, 1);
  if (onsetTimes.length === 0) {
    const report = emptyReport(
      input,
      "the isolated kick pad produced no confident onsets in this window",
      "no-kick-onsets",
    );
    report.pair = input.pair;
    report.selection = {
      ...input.selectionCounts,
      rule: "one highest-ranked kick pad and bass instrument selected from explicit synth/instrument metadata or role names",
    };
    return report;
  }
  const selectedTimes =
    onsetTimes.length <= MAX_ANALYZED_ONSETS
      ? onsetTimes
      : Array.from(
          { length: MAX_ANALYZED_ONSETS },
          (_, index) => onsetTimes[Math.floor((index * (onsetTimes.length - 1)) / (MAX_ANALYZED_ONSETS - 1))]!,
        );
  const spans = buildArrangementSpans(
    input.doc.arrangement.clips,
    input.doc.scenes,
    input.doc.bpm,
    ticksPerBar(input.doc),
  );
  const bandCounts: Record<LowBandName, number> = { sub: 0, bass: 0, upperBass: 0 };
  const events: KickBassRiskEvent[] = [];
  let riskCandidateOnsets = 0;
  let closePeakOnsets = 0;
  for (const onsetSecInWindow of selectedTimes) {
    const relativeSample = Math.max(0, Math.round(onsetSecInWindow * input.sampleRate));
    const absoluteSample = input.startSample + relativeSample;
    const kick = spectrumReading([input.kickMono], relativeSample, input.sampleRate);
    const bass = spectrumReading(input.bassChannels, absoluteSample, input.sampleRate);
    const sharedBands = LOW_BANDS.filter(
      ({ name }) => kick.bandDbfs[name] >= MEASURABLE_FLOOR_DBFS && bass.bandDbfs[name] >= MEASURABLE_FLOOR_DBFS,
    ).map(({ name }) => name);
    const riskCandidateBands = LOW_BANDS.filter(({ name }) => {
      const kickDb = kick.bandDbfs[name];
      const bassDb = bass.bandDbfs[name];
      return (
        kickDb >= CANDIDATE_FLOOR_DBFS &&
        bassDb >= CANDIDATE_FLOOR_DBFS &&
        Math.abs(kickDb - bassDb) <= MAX_LEVEL_DIFFERENCE_DB
      );
    }).map(({ name }) => name);
    const peakDistanceHz =
      kick.dominantPeakHz !== null && bass.dominantPeakHz !== null
        ? Math.abs(kick.dominantPeakHz - bass.dominantPeakHz)
        : null;
    const closePeakCandidate =
      peakDistanceHz !== null &&
      peakDistanceHz <= input.sampleRate / FFT_SIZE &&
      (kick.dominantPeakDbfs ?? -160) >= CANDIDATE_FLOOR_DBFS &&
      (bass.dominantPeakDbfs ?? -160) >= CANDIDATE_FLOOR_DBFS;
    const onsetSec = input.startSec + onsetSecInWindow;
    const riskCandidate = riskCandidateBands.length > 0 || closePeakCandidate;
    if (riskCandidate) riskCandidateOnsets += 1;
    if (closePeakCandidate) closePeakOnsets += 1;
    for (const band of sharedBands) bandCounts[band] += 1;
    events.push({
      tick: tickAtSeconds(input.doc, onsetSec, input.startTick, input.endTick, spans),
      onsetSec: Math.round(onsetSec * 1000) / 1000,
      kick,
      bass,
      sharedBands,
      riskCandidateBands,
      peakDistanceHz: peakDistanceHz === null ? null : Math.round(peakDistanceHz * 10) / 10,
      closePeakCandidate,
      riskCandidate,
    });
  }
  const sharedBandOnsets = events.filter((event) => event.sharedBands.length > 0).length;
  const count = events.length;
  return {
    ...base,
    pair: input.pair,
    selection: {
      ...input.selectionCounts,
      rule: "one highest-ranked kick pad and bass instrument selected from explicit synth/instrument metadata or role names",
    },
    measurement: {
      ...base.measurement,
      analyzedOnsets: count,
      detectedOnsets: onsetTimes.length,
      onsetsTruncated: onsetTimes.length > count,
    },
    summary: {
      sharedBandOnsets,
      riskCandidateOnsets,
      closePeakOnsets,
      overlapRate: count > 0 ? sharedBandOnsets / count : 0,
      riskCandidateRate: count > 0 ? riskCandidateOnsets / count : 0,
      bandCounts,
    },
    events,
    caveats: [
      "kick onsets come from isolated kick-pad PCM; low-band spectra are measured from isolated pre-master source stems",
      "stereo low-band power is averaged across channels to avoid phase cancellation in the analysis downmix; the onset detector uses the strongest kick channel",
      "shared band energy and same-bin peaks identify co-occurrence candidates; they do not prove masking, phase cancellation, or a need to change the mix",
      "onset ticks are mapped back through the arrangement tempo spans and rounded to the nearest arrangement tick",
      ...(onsetTimes.length > count
        ? [
            `${onsetTimes.length - count} detected onsets were omitted; the analyzed sample is distributed evenly across the range`,
          ]
        : []),
    ],
  };
}

export function makeIsolatedKickDoc(doc: ProjectDocument, pair: KickBassSourcePair): ProjectDocument {
  const stemDoc = { ...doc, tracks: doc.tracks.map((track) => ({ ...track })) };
  const isolated = stemDoc.tracks.find(
    (track): track is DrumTrack => track.id === pair.kick.trackId && track.kind === "drum",
  );
  if (isolated) {
    isolated.pads = isolated.pads.map((pad) => ({ ...pad, mute: pad.id !== pair.kick.padId, solo: false }));
  }
  return stemDoc;
}
