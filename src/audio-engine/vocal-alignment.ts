/**
 * VOCAL-FIRST ALIGNMENT — pull a taken phrase back onto the entry it was
 * recorded for.
 *
 * THE PROBLEM
 * -----------
 * The recording path already compensates the DEVICE (a calibration wizard
 * measures the acoustic round trip and the take is placed earlier by that
 * amount). What it has never compensated is the HUMAN: a singer enters a
 * phrase tens of milliseconds after the beat, and the clip keeps that offset
 * forever — the take is "late" in a way no knob fixes, because the fix is a
 * CONTENT slip (skip the leading silence), not a timeline move.
 *
 * WHAT THIS MEASURES
 * ------------------
 * The phrase onset inside a bounded window at the head of the take: the first
 * run of short RMS windows that crosses a threshold derived from the take's
 * own peak (with an absolute floor for very quiet takes). The result is a
 * shift in seconds — how much of the head to skip so the phrase lands on the
 * entry.
 *
 * WHAT IT DELIBERATELY WILL NOT DO
 * -------------------------------
 * A DELIBERATE late entry (a pickup, a beat-3 entry, a breath before the line)
 * is a musical choice, not a defect. Auto-application is therefore bounded to
 * latency scale (`AUTO_ALIGN_MAX_SHIFT_SEC`, 120 ms) and requires high
 * confidence; anything larger is only ever offered as a MEASURED, explicitly
 * labelled manual action. Nothing here is applied behind the user's back, and
 * the applied change is a normal undoable content slip.
 *
 * Pure: buffers and numbers in, numbers out — no DOM, no audio context.
 */

export interface PhraseOnsetMeasurement {
  /** Where the phrase starts, in seconds from the window's start. */
  onsetSec: number;
  /** "high" = a clear rise above the floor; "low" = borderline (never auto-applied). */
  confidence: "high" | "low";
}

/** RMS window length for the rise scan. */
export const ALIGN_WINDOW_MS = 5;
/** Consecutive windows above the threshold that count as a phrase start. */
export const ALIGN_MIN_RUN_WINDOWS = 3;
/** Absolute floor (−45 dBFS): below this nothing is signal, whatever the peak. */
export const ALIGN_ABSOLUTE_FLOOR_DB = -45;
/** Threshold relative to the take's own peak (−30 dB): "quiet" is per-take. */
export const ALIGN_RELATIVE_BELOW_PEAK_DB = -30;
/** Peak analysis is capped to this much material (a long clip must stay cheap). */
export const ALIGN_PEAK_ANALYSIS_SEC = 5;
/** A shift below this is measurement noise — reported as "nothing to align". */
export const AUTO_ALIGN_MIN_SHIFT_SEC = 0.005;
/** Latency-scale ceiling for AUTOMATIC alignment. */
export const AUTO_ALIGN_MAX_SHIFT_SEC = 0.12;
/** Head window scanned automatically (a latency correction lives here). */
export const AUTO_ALIGN_SEARCH_SEC = 0.15;
/** Head window scanned for the MANUAL action (a late entry may be deliberate). */
export const MANUAL_ALIGN_SEARCH_SEC = 0.5;

function measureRange(
  channels: readonly Float32Array[],
  sampleRate: number,
  rangeStart: number,
  rangeEnd: number,
  searchWindowSec: number,
): PhraseOnsetMeasurement | null {
  const usable = channels.filter((channel): channel is Float32Array => channel != null && channel.length > 0);
  if (usable.length === 0) return null;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return null;
  const frames = Math.min(...usable.map((channel) => channel.length));
  const start = Math.max(0, Math.floor(rangeStart));
  const end = Math.min(frames, Math.floor(rangeEnd));
  if (end - start <= 0) return null;

  const windowFrames = Math.max(1, Math.round((sampleRate * ALIGN_WINDOW_MS) / 1000));
  const searchFrames = Math.min(end - start, Math.max(1, Math.round(sampleRate * searchWindowSec)));

  // Peak over a bounded region of THIS window — the phrase's own level decides
  // what "quiet" means, so a whisper take and a shouted take both work.
  const analysisFrames = Math.min(end - start, Math.round(sampleRate * ALIGN_PEAK_ANALYSIS_SEC));
  let peak = 0;
  for (const channel of usable) {
    for (let index = start; index < start + analysisFrames; index += 1) {
      const value = Math.abs(channel[index]!);
      if (value > peak) peak = value;
    }
  }
  const absoluteFloor = 10 ** (ALIGN_ABSOLUTE_FLOOR_DB / 20);
  if (peak < absoluteFloor) return null; // no usable signal at all
  const threshold = Math.max(absoluteFloor, peak * 10 ** (ALIGN_RELATIVE_BELOW_PEAK_DB / 20));

  const rmsAt = (windowStart: number): number => {
    const windowEnd = Math.min(end, windowStart + windowFrames);
    let sum = 0;
    let count = 0;
    for (const channel of usable) {
      for (let index = windowStart; index < windowEnd; index += 1) {
        const value = channel[index]!;
        sum += value * value;
        count += 1;
      }
    }
    return count > 0 ? Math.sqrt(sum / count) : 0;
  };

  let run = 0;
  let runStart = 0;
  let runSum = 0;
  for (let offset = 0; offset + windowFrames <= searchFrames; offset += windowFrames) {
    const rms = rmsAt(start + offset);
    if (rms >= threshold) {
      if (run === 0) runStart = offset;
      run += 1;
      runSum += rms;
      if (run >= ALIGN_MIN_RUN_WINDOWS) {
        const meanRms = runSum / run;
        return {
          onsetSec: runStart / sampleRate,
          confidence: meanRms >= threshold * 1.5 ? "high" : "low",
        };
      }
    } else {
      run = 0;
      runSum = 0;
    }
  }
  return null; // no phrase start inside the search window
}

/**
 * Measure the phrase onset inside the head of a take.
 * `options.searchWindowSec` widens the scan for the manual action.
 */
export function measurePhraseOnset(
  channels: readonly Float32Array[],
  sampleRate: number,
  options: { searchWindowSec?: number } = {},
): PhraseOnsetMeasurement | null {
  const frames = channels.reduce((longest, channel) => Math.max(longest, channel?.length ?? 0), 0);
  return measureRange(channels, sampleRate, 0, frames, options.searchWindowSec ?? AUTO_ALIGN_SEARCH_SEC);
}

/**
 * The shift to apply AUTOMATICALLY for this measurement, in seconds (positive
 * = skip this much head, moving the phrase earlier). Zero means "do not touch
 * the take": no confident onset, below the noise floor, or larger than a
 * latency-scale correction — the last one is a musical decision, not a fix.
 */
export function autoAlignShiftSec(
  measurement: PhraseOnsetMeasurement | null,
  options: { minShiftSec?: number; maxShiftSec?: number } = {},
): number {
  if (measurement == null || measurement.confidence !== "high") return 0;
  const min = options.minShiftSec ?? AUTO_ALIGN_MIN_SHIFT_SEC;
  const max = options.maxShiftSec ?? AUTO_ALIGN_MAX_SHIFT_SEC;
  const shift = measurement.onsetSec;
  if (!Number.isFinite(shift) || shift < min || shift > max) return 0;
  return shift;
}

export interface AlignablePass {
  startFrame: number;
  endFrame: number;
}

/**
 * Per-pass auto shifts for a loop recording: every pass is measured inside its
 * OWN window, because a singer drifts — the first pass may be 40 ms late and
 * the fourth 15 ms. Entries are 0 where no bounded correction applies.
 */
export function passAlignShifts(
  channels: readonly Float32Array[],
  sampleRate: number,
  passes: readonly AlignablePass[],
  options: { searchWindowSec?: number } = {},
): number[] {
  return passes.map((pass) =>
    autoAlignShiftSec(
      measureRange(
        channels,
        sampleRate,
        pass.startFrame,
        pass.endFrame,
        options.searchWindowSec ?? AUTO_ALIGN_SEARCH_SEC,
      ),
    ),
  );
}

/** "+38 ms" / "−12 ms" — the unit every musician thinks in. */
export function formatShiftMs(shiftSec: number): string {
  const ms = Math.round(shiftSec * 1000);
  return `${ms >= 0 ? "+" : "−"}${Math.abs(ms)} ms`;
}
