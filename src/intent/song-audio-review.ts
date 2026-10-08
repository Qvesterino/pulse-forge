import {
  extractAudioFeaturesV2,
  extractStereoAudioFeatures,
  type AudioFeaturesV2,
  type StereoAudioFeatures,
} from "../ai/audio-features";

export interface SongAudioFinding {
  code: "non-finite-samples" | "near-full-scale" | "near-silence" | "clipping";
  severity: "warning";
  message: string;
  evidence: string;
}

/** Technical signal checks only; these measurements are not an artistic-quality score. */
export interface SongAudioReview {
  durationSeconds: number;
  sampleRate: number;
  peakDbfs: number;
  rmsDbfs: number;
  crestFactor: number;
  lowBandRatio: number;
  zeroCrossingRate: number;
  /** Bounded v2 timbre/voicing summary from the exact audition render. */
  audioFeatures: AudioFeaturesV2;
  /** Missing for mono output; the ledger records stereo dimensions as unavailable. */
  stereoFeatures?: StereoAudioFeatures;
  nonFiniteSamples: number;
  findings: SongAudioFinding[];
}

const toDbfs = (value: number): number => (value > 0 ? Math.round(200 * Math.log10(value)) / 10 : -120);

/** Analyze the exact stereo render used by song audition, without another render or project mutation. */
export function reviewSongAudio(buffer: AudioBuffer): SongAudioReview {
  const channelCount = Math.max(0, Math.floor(buffer.numberOfChannels));
  const frameCount = Math.max(0, Math.floor(buffer.length));
  const sampleRate = Number.isFinite(buffer.sampleRate) && buffer.sampleRate > 0 ? buffer.sampleRate : 0;
  const mono = new Float32Array(frameCount);
  let peak = 0;
  let sumSquares = 0;
  let finiteSamples = 0;
  let nonFiniteSamples = 0;
  let clippedRuns = 0;
  const clippedRunLengths = new Array<number>(Math.max(0, channelCount)).fill(0);
  const CLIP_RUN = 3;
  const CLIP_LEVEL = 0.999;

  const channels = Array.from({ length: channelCount }, (_, channel) => buffer.getChannelData(channel));
  for (let frame = 0; frame < frameCount; frame++) {
    let mixed = 0;
    let mixedChannels = 0;
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
      const sample = channels[channelIndex][frame];
      if (sample === undefined || !Number.isFinite(sample)) {
        nonFiniteSamples++;
        continue;
      }
      const magnitude = Math.abs(sample);
      peak = Math.max(peak, magnitude);
      sumSquares += sample * sample;
      finiteSamples++;
      mixed += sample;
      mixedChannels++;
      // Clipping runs are counted on the PER-CHANNEL signal (a flat-top is
      // per-channel destruction; a shared counter would bridge channels).
      if (magnitude >= CLIP_LEVEL) {
        clippedRunLengths[channelIndex] += 1;
        if (clippedRunLengths[channelIndex] === CLIP_RUN) clippedRuns += 1;
      } else {
        clippedRunLengths[channelIndex] = 0;
      }
    }
    mono[frame] = mixedChannels > 0 ? mixed / mixedChannels : 0;
  }

  const left = channels[0];
  const right = channels[1];
  const stereoFeatures = left && right ? extractStereoAudioFeatures(left, right) : undefined;
  const rms = finiteSamples > 0 ? Math.sqrt(sumSquares / finiteSamples) : 0;
  const crestFactor = rms > 1e-10 ? peak / rms : 0;
  const peakDbfs = toDbfs(peak);
  const rmsDbfs = toDbfs(rms);
  const monoFeatures = extractAudioFeaturesV2(mono, sampleRate || 44_100);
  // Preserve the exact audio.v1 prefix used by existing song/section captures;
  // only the four new mono dimensions come from the advanced extractor.
  const audioFeatures: AudioFeaturesV2 = {
    ...monoFeatures,
    rms: 10 ** (rmsDbfs / 20),
    peak: 10 ** (peakDbfs / 20),
    crestFactor: Math.round(crestFactor * 100) / 100,
  };
  const findings: SongAudioFinding[] = [];

  if (nonFiniteSamples > 0) {
    findings.push({
      code: "non-finite-samples",
      severity: "warning",
      message: "The render contains invalid sample values.",
      evidence: `${nonFiniteSamples} of ${frameCount * channelCount} channel samples were not finite.`,
    });
  }
  if (peak >= 0.999) {
    findings.push({
      code: "near-full-scale",
      severity: "warning",
      message: "The render reaches near full scale; check transient headroom and the master limiter.",
      evidence: `Sample peak ${peakDbfs.toFixed(1)} dBFS.`,
    });
  }
  // Clipping ≠ touching full scale: a single full-scale transient can be
  // intentional, but SUSTAINED flat-tops (≥3 consecutive samples at the rail)
  // are measurable waveform destruction — reported separately so the fix
  // (reduce level before the limiter) has honest evidence.
  if (clippedRuns > 0) {
    findings.push({
      code: "clipping",
      severity: "warning",
      message: "The render contains flat-top clipping runs; reduce level before the master limiter.",
      evidence: `${clippedRuns} run(s) of ≥3 consecutive samples at full scale.`,
    });
  }
  if (rms < 0.001 && peak < 0.01) {
    findings.push({
      code: "near-silence",
      severity: "warning",
      message: "The rendered song is nearly silent; check instrument output and sample availability.",
      evidence: `RMS ${rmsDbfs.toFixed(1)} dBFS; peak ${peakDbfs.toFixed(1)} dBFS.`,
    });
  }

  return {
    durationSeconds: sampleRate > 0 ? frameCount / sampleRate : 0,
    sampleRate,
    peakDbfs,
    rmsDbfs,
    crestFactor: Math.round(crestFactor * 100) / 100,
    lowBandRatio: audioFeatures.lowBandRatio,
    zeroCrossingRate: audioFeatures.zeroCrossingRate,
    audioFeatures,
    ...(stereoFeatures ? { stereoFeatures } : {}),
    nonFiniteSamples,
    findings,
  };
}

// ── Per-section meters + evidence-based revival suggestions ───────────────
//
// Whole-song metrics cannot honestly point at a section. Segmenting the SAME
// audition buffer by the song form's bar boundaries can: a loud-carrying
// section sitting far below the song's own reference level is measurable
// evidence, and the suggestion it produces is a targeted, audition-first
// revise — never an automatic fix. Breaks/intros/outros/builds are SUPPOSED
// to breathe, so quietness there suggests nothing.

export interface SongSectionMeter {
  role: string;
  startSecond: number;
  seconds: number;
  rmsDbfs: number;
  peakDbfs: number;
}

export interface SongSectionSuggestion {
  role: string;
  attribute: "energy";
  delta: number;
  /** Evidence line shown with the suggestion chip. */
  reason: string;
}

const LOUD_CARRYING_ROLES = new Set(["drop", "chorus", "verse"]);
/** How far below the song's reference level a section must sit to suggest. */
const QUIET_GAP_DB = 8;
/** A section essentially without signal is a build problem, not a balance one. */
const MIN_SIGNAL_DBFS = -60;

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Per-section RMS/peak meters from the song audition buffer (pure). */
export function analyzeSongSections(
  buffer: AudioBuffer,
  sections: ReadonlyArray<{ role: string; bars: number }>,
  bpm: number,
): SongSectionMeter[] {
  const channelCount = Math.max(0, Math.floor(buffer.numberOfChannels));
  const frameCount = Math.max(0, Math.floor(buffer.length));
  const sampleRate = Number.isFinite(buffer.sampleRate) && buffer.sampleRate > 0 ? buffer.sampleRate : 0;
  if (channelCount === 0 || frameCount === 0 || sampleRate === 0 || !Number.isFinite(bpm) || bpm <= 0) return [];
  const secondsPerBar = (60 / bpm) * 4;

  const bounds: Array<{ role: string; start: number; end: number }> = [];
  let cursor = 0;
  for (const section of sections) {
    if (!Number.isFinite(section.bars) || section.bars <= 0) continue;
    const start = Math.min(cursor * secondsPerBar * sampleRate, frameCount);
    cursor += section.bars;
    const end = Math.min(Math.round(cursor * secondsPerBar * sampleRate), frameCount);
    if (end <= start) continue;
    bounds.push({ role: section.role, start, end });
  }
  if (bounds.length === 0) return [];

  const channels = Array.from({ length: channelCount }, (_, channel) => buffer.getChannelData(channel));
  const sums = bounds.map(() => ({ sumSquares: 0, count: 0, peak: 0 }));
  for (const channel of channels) {
    for (let index = 0; index < bounds.length; index++) {
      const { start, end } = bounds[index];
      const bucket = sums[index];
      for (let frame = Math.floor(start); frame < end; frame++) {
        const sample = channel[frame];
        if (sample === undefined || !Number.isFinite(sample)) continue;
        bucket.sumSquares += sample * sample;
        bucket.count += 1;
        bucket.peak = Math.max(bucket.peak, Math.abs(sample));
      }
    }
  }

  return bounds.map((bound, index) => {
    const bucket = sums[index];
    const rms = bucket.count > 0 ? Math.sqrt(bucket.sumSquares / bucket.count) : 0;
    return {
      role: bound.role,
      startSecond: Math.round((bound.start / sampleRate) * 10) / 10,
      seconds: Math.round(((bound.end - bound.start) / sampleRate) * 10) / 10,
      rmsDbfs: toDbfs(rms),
      peakDbfs: toDbfs(bucket.peak),
    };
  });
}

/**
 * Evidence-based revival suggestions: loud-carrying sections sitting
 * ≥ QUIET_GAP_DB below the song's own median loud-carrying level. Pure and
 * deterministic; an empty result is the normal healthy case.
 */
export function suggestSectionRevivals(meters: ReadonlyArray<SongSectionMeter>): SongSectionSuggestion[] {
  const carrying = meters.filter((meter) => LOUD_CARRYING_ROLES.has(meter.role));
  if (carrying.length < 2) return [];
  const reference = median(carrying.map((meter) => meter.rmsDbfs));
  const suggestions: SongSectionSuggestion[] = [];
  for (const meter of carrying) {
    const gap = reference - meter.rmsDbfs;
    if (gap >= QUIET_GAP_DB && meter.rmsDbfs > MIN_SIGNAL_DBFS) {
      suggestions.push({
        role: meter.role,
        attribute: "energy",
        delta: 0.15,
        reason: `${meter.role} pôsobí ticho — ${Math.round(gap)} dB pod úrovňou zvyšku skladby (${meter.rmsDbfs.toFixed(0)} dBFS RMS)`,
      });
    }
  }
  return suggestions;
}
