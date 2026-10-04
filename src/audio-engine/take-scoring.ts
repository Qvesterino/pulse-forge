/**
 * SMART COMPING — per-take audio scoring (PURE, no AudioContext, no store).
 *
 * The take-lane system already records whole passes and `compAudioTakeRange`
 * already assembles a non-destructive comp from them. What is missing is the
 * PRODUCER EAR: when four passes exist, which one should a comp segment come
 * from? Today the user guesses by ear. This module answers with measurable,
 * honest evidence instead of a black-box score:
 *
 *   - GROOVE TIGHTNESS — how close the take's transients sit to the grid
 *     implied by the project tempo (onset detection reuses the same
 *     `detectTransients` the SliceLab/warp tools trust).
 *   - PITCH DRIFT — slow wandering of the fundamental between takes. A take
 *     that slowly drops a quarter tone reads as "out of tune" long before it
 *     clips; autoregression energy below a floor marks unvoiced/noise-only
 *     regions as NOT a pitch failure (honest: drums score no pitch penalty).
 *   - NOISE FLOOR — the quietest moments of the take (below the 10th
 *     percentile frame RMS), so a take recorded with a fan kicking in loses
 *     to a clean one.
 *   - CLIPPING — the share of samples at full scale. A clipped take is the
 *     one thing a comp can never fix, so it carries a hard penalty.
 *
 * Design rules (the whole product leans on them):
 *   - Deterministic: same PCM in, same scores out. No RNG, no model fetch,
 *     no async. All thresholds are named constants, not magic numbers.
 *   - Honest: every number has a unit and a bounded meaning. Scores are
 *     only compared WITHIN one take group (same room, same input); they are
 *     never absolute quality claims.
 *   - Pure: takes `Float32Array` + sample rate + the document's tempo, so it
 *     runs in a worker, a test, or on the main thread identically.
 */

import { detectTransients } from "../audio-workers/onset-detector";

/** Deviation from the take's own MEDIAN that marks a hit as "on-grid".
 *  Relative to the median, the shared detection bias cancels out.
 *  25 ms is clearly inside the "feels locked" band — a 1/16 at 120 BPM is
 *  125 ms, so a take whose hits wander by more than a fifth of the step
 *  reads as human-loose, not machine-tight. */
const GROOVE_SPREAD_TOLERANCE_SEC = 0.025;
/** Frames under this RMS are "silence" for noise-floor ranking. */
const SILENCE_RMS_FLOOR = 1e-4;
/** Samples at |x| >= 0.999 count as clipped (16-bit headroom convention). */
const CLIPPING_THRESHOLD = 0.999;
/** Analysis frame for RMS/percentile metrics, 50 ms. */
const FRAME_SEC = 0.05;
/** Percentile of quiet frames that defines the noise floor. */
const NOISE_FLOOR_PERCENTILE = 0.1;
/** Autocorrelation search floor/ceiling for the fundamental (Hz). */
const PITCH_MIN_HZ = 70;
const PITCH_MAX_HZ = 1000;
/** Relative autocorrelation peak required to call a frame "voiced". */
const VOICED_CORRELATION_MIN = 0.3;
/**
 * Pitch frames must carry real signal, not room noise: RMS at or below
 * −40 dBFS is a fan/hiss/preamp bed, and a perfectly periodic hum would
 * otherwise score as "flawlessly in tune". Measured WITHOUT the tolerance
 * games below — a vocal take sits far above this, a noise bed far below.
 */
const VOICED_RMS_MIN = 0.01;
/** Semitone bandwidth where a take stops being "in tune with itself". */
const PITCH_DRIFT_MAX_SEMITONES = 0.25;

export interface TakeMetrics {
  /** Share of transients within grid tolerance (0..1). NaN when no onsets. */
  grooveTightness: number;
  /**
   * Median absolute onset deviation from the nearest grid line, seconds.
   * Includes the detector's shared pre-peak bias AND the take's own pocket
   * feel — it is a character reading ("rushed/laid back"), NOT a quality
   * score; compare `grooveSpreadSec` for lock.
   */
  grooveMedianDeviationSec: number;
  /**
   * Robust spread of onset deviations around the take's own median (MAD),
   * seconds. The shared detector bias cancels, so this is the take's LOCK:
   * near 0 for machine-locked hits, tens of ms for wandering ones.
   */
  grooveSpreadSec: number;
  /** Noise floor as dBFS (10th-percentile frame RMS). */
  noiseFloorDb: number;
  /** Share of samples at or above full scale (0..1). */
  clippedShare: number;
  /** Median-to-median pitch travel across the take, semitones. NaN if unvoiced. */
  pitchDriftSemitones: number;
  /** Number of voiced frames the pitch estimate came from. */
  voicedFrames: number;
  /** Number of transients the groove score came from. */
  onsetCount: number;
}

export interface TakeScore extends TakeMetrics {
  /**
   * Composite score in arbitrary units, HIGHER IS BETTER, only meaningful
   * against other takes of the same group. Built from the four measurable
   * penalties so a take can be traced back to WHY it lost.
   */
  score: number;
  /** Human-readable evidence lines ("groove 92 % on-grid · −61 dB floor"). */
  evidence: string[];
}

/** RMS of one analysis frame. */
function frameRms(data: Float32Array, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}

/** Sorted copy (percentile lookups need order; input stays untouched). */
function sortedFloats(values: Float64Array): Float64Array {
  return Float64Array.from(values).sort();
}

/** Nearest grid tick (1/16 at the given BPM) to a time in seconds. */
function nearestGridSec(timeSec: number, bpm: number): number {
  const sixteenthSec = 60 / bpm / 4;
  return Math.round(timeSec / sixteenthSec) * sixteenthSec;
}

/**
 * One-frame normalized autocorrelation at a candidate lag. Returns the peak
 * correlation across the lag range (0 when the signal is too short).
 */
function autocorrelationPeak(
  data: Float32Array,
  start: number,
  end: number,
  sampleRate: number,
): { value: number; hz: number } {
  const minLag = Math.max(2, Math.floor(sampleRate / PITCH_MAX_HZ));
  const maxLag = Math.min(Math.floor(sampleRate / PITCH_MIN_HZ), end - start - 1);
  if (maxLag <= minLag || end - start < maxLag + 1) return { value: 0, hz: 0 };
  // Compare only the overlap that every candidate lag can cover, so the
  // score is comparable across lags (full-window normalization would favour
  // long lags).
  const windowLen = end - start - maxLag;
  let energy = 0;
  for (let i = 0; i < windowLen; i++) energy += data[start + i] * data[start + i];
  if (energy <= 0) return { value: 0, hz: 0 };
  let bestCorrelation = 0;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let correlation = 0;
    for (let i = 0; i < windowLen; i++) correlation += data[start + i] * data[start + i + lag];
    const normalized = correlation / energy;
    if (normalized > bestCorrelation) {
      bestCorrelation = normalized;
      bestLag = lag;
    }
  }
  return { value: bestCorrelation, hz: bestLag > 0 ? sampleRate / bestLag : 0 };
}

/** Median of an already-sorted array (interpolated for even counts). */
function medianOfSorted(sorted: Float64Array | number[]): number {
  if (sorted.length === 0) return Number.NaN;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Semitone distance between two frequencies (0 when either is 0/unvoiced). */
function semitoneDistance(hzA: number, hzB: number): number {
  if (hzA <= 0 || hzB <= 0) return Number.NaN;
  return Math.abs(12 * Math.log2(hzA / hzB));
}

/**
 * Measure one take. `bpm` is the project tempo the take was performed to —
 * the grid the groove tightness is judged against. Returns NaN metrics (and
 * empty evidence) for degenerate input rather than throwing: a take lane
 * that failed to record is a data problem the UI should report, not crash on.
 */
export function measureTake(data: Float32Array, sampleRate: number, bpm: number): TakeMetrics {
  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const empty: TakeMetrics = {
    grooveTightness: Number.NaN,
    grooveMedianDeviationSec: Number.NaN,
    grooveSpreadSec: Number.NaN,
    noiseFloorDb: Number.NaN,
    clippedShare: 0,
    pitchDriftSemitones: Number.NaN,
    voicedFrames: 0,
    onsetCount: 0,
  };
  if (!data || data.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) return empty;

  // Clipping: one pass, count full-scale samples.
  let clipped = 0;
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) >= CLIPPING_THRESHOLD) clipped++;
  }
  const clippedShare = clipped / data.length;

  // Frame RMS for the noise floor.
  const frameLen = Math.max(1, Math.round(FRAME_SEC * sampleRate));
  const frameCount = Math.max(1, Math.floor(data.length / frameLen));
  const frameRmsValues = new Float64Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const start = f * frameLen;
    frameRmsValues[f] = frameRms(data, start, Math.min(start + frameLen, data.length));
  }
  const sortedRms = sortedFloats(frameRmsValues);
  const floorIndex = Math.min(sortedRms.length - 1, Math.max(0, Math.floor(NOISE_FLOOR_PERCENTILE * sortedRms.length)));
  const floorRms = Math.max(sortedRms[floorIndex], SILENCE_RMS_FLOOR);
  const noiseFloorDb = 20 * Math.log10(floorRms);

  // Groove: transients against the 1/16 grid. The detector's pre-peak
  // latency shifts every onset by the same systematic amount, so tightness
  // is judged against the take's own MEDIAN deviation (the shared bias
  // cancels) while the median itself still reports the take's overall feel.
  const onsets = data.length > sampleRate * 0.05 ? detectTransients(data, sampleRate, 1) : [];
  const deviations: number[] = [];
  for (const onset of onsets) {
    deviations.push(Math.abs(onset - nearestGridSec(onset, safeBpm)));
  }
  const sortedDeviations = Float64Array.from(deviations).sort();
  const grooveMedianDeviationSec = deviations.length > 0 ? medianOfSorted(sortedDeviations) : Number.NaN;
  let grooveTightness = Number.NaN;
  let grooveSpreadSec = Number.NaN;
  if (deviations.length > 0) {
    const spreads = deviations.map((deviation) => Math.abs(deviation - grooveMedianDeviationSec));
    grooveSpreadSec = medianOfSorted(Float64Array.from(spreads).sort());
    const onGridCount = spreads.filter((spread) => spread <= GROOVE_SPREAD_TOLERANCE_SEC).length;
    grooveTightness = onGridCount / deviations.length;
  }

  // Pitch drift: one autocorrelation estimate per 0.5 s voiced frame. Voiced
  // requires BOTH a periodic peak and real energy (RMS gate) — a periodic fan
  // would otherwise win the pitch axis with a perfect score.
  const pitchFrame = Math.round(0.5 * sampleRate);
  const voicedHz: number[] = [];
  for (let start = 0; start + pitchFrame <= data.length; start += pitchFrame) {
    const rms = frameRms(data, start, start + pitchFrame);
    if (rms < VOICED_RMS_MIN) continue;
    const peak = autocorrelationPeak(data, start, start + pitchFrame, sampleRate);
    if (peak.value >= VOICED_CORRELATION_MIN && peak.hz >= PITCH_MIN_HZ && peak.hz <= PITCH_MAX_HZ) {
      voicedHz.push(peak.hz);
    }
  }
  let pitchDriftSemitones = Number.NaN;
  if (voicedHz.length >= 2) {
    // Drift = the span between the first and last voiced thirds of the take:
    // a take that starts in tune and sags by the end is the classic comping
    // loss, and a stable take across both halves is the classic winner.
    const third = Math.max(1, Math.floor(voicedHz.length / 3));
    const headMedian = medianOfSorted(Float64Array.from(voicedHz.slice(0, third)).sort());
    const tailMedian = medianOfSorted(Float64Array.from(voicedHz.slice(-third)).sort());
    pitchDriftSemitones = semitoneDistance(headMedian, tailMedian);
  }

  return {
    grooveTightness,
    grooveMedianDeviationSec,
    grooveSpreadSec,
    noiseFloorDb,
    clippedShare,
    pitchDriftSemitones,
    voicedFrames: voicedHz.length,
    onsetCount: onsets.length,
  };
}

/** dB helper for evidence lines. */
function fmtDb(db: number): string {
  return Number.isFinite(db) ? `${db.toFixed(0)} dB` : "n/a";
}

/** Percent helper for evidence lines. */
function fmtPct(share: number): string {
  return Number.isFinite(share) ? `${Math.round(share * 100)} %` : "n/a";
}

/**
 * Turn raw metrics into a comparable score with evidence. The weights are the
 * product decision made explicit: tightness is what a comp is FOR, clipping
 * is what a comp can never repair, so they dominate; pitch and floor break
 * ties between two similarly tight takes.
 */
export function scoreTake(metrics: TakeMetrics): TakeScore {
  // Start from groove tightness (0..1 → 0..50). No onsets (synth pad,
  // unmeasurable) means the take is scored only on its other axes — honest
  // fallback, not a zero.
  let score = 0;
  const evidence: string[] = [];
  if (Number.isFinite(metrics.grooveTightness) && metrics.onsetCount > 0) {
    score += metrics.grooveTightness * 50;
    evidence.push(
      `groove ${fmtPct(metrics.grooveTightness)} locked (spread ±${(metrics.grooveSpreadSec * 1000).toFixed(0)} ms, feel ${(metrics.grooveMedianDeviationSec * 1000).toFixed(0)} ms)`,
    );
  } else {
    evidence.push("no transients to judge groove");
  }

  // Pitch drift (0..50 → 0..25 penalty inverted). Unvoiced takes (drums,
  // percussion) skip this axis instead of being punished for it.
  if (Number.isFinite(metrics.pitchDriftSemitones) && metrics.voicedFrames >= 2) {
    const driftPenalty = Math.min(1, metrics.pitchDriftSemitones / PITCH_DRIFT_MAX_SEMITONES);
    score += 25 * (1 - driftPenalty);
    evidence.push(
      `pitch drift ${metrics.pitchDriftSemitones.toFixed(2)} st over ${metrics.voicedFrames} voiced frames`,
    );
  } else {
    evidence.push("no voiced pitch to judge");
  }

  // Noise floor: 0..25. A floor at −70 dBFS or BELOW earns the full share (a
  // quieter room cannot score less than a quiet one — the axis is inverted
  // in dB, so the fraction runs from the loud end); a floor at −40 dBFS or
  // louder earns nothing. Every 10 dB of fan/hiss costs a third.
  const floorScore = Number.isFinite(metrics.noiseFloorDb)
    ? 25 * Math.max(0, Math.min(1, (-40 - metrics.noiseFloorDb) / 30))
    : 0;
  score += floorScore;
  evidence.push(`floor ${fmtDb(metrics.noiseFloorDb)}`);

  // Clipping: hard penalty (0..25 share lost).
  const clippingShare = Number.isFinite(metrics.clippedShare) ? Math.min(1, metrics.clippedShare * 40) : 0;
  score += 25 * (1 - clippingShare);
  evidence.push(metrics.clippedShare > 0 ? `CLIPPED ${fmtPct(metrics.clippedShare)} of samples` : "no clipping");

  return { ...metrics, score, evidence };
}

/**
 * Rank takes within one group. Returns the input order with scores attached
 * (the caller decides how to present ties). Every entry is measured with the
 * same grid, so the comparison is apples-to-apples.
 */
export function scoreTakes(takes: Array<{ data: Float32Array; sampleRate: number }>, bpm: number): TakeScore[] {
  return takes.map((take) => scoreTake(measureTake(take.data, take.sampleRate, bpm)));
}
