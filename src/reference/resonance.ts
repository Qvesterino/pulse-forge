/**
 * RESONANCE ANALYSIS — "nájdi problémovú frekvenciu a odrež ju" (resonance
 * wave).
 *
 * The per-track companion to the MATCH tab: where the match compares a whole
 * mix against a reference, this looks INSIDE one track's stem for narrow
 * problem peaks — the ringy 120 Hz boom, the nasal 900 Hz honk — and turns
 * each into a concrete, undoable EQ cut in the native EQ's own free surgical
 * band vocabulary (free1/free2: fully parametric, ±24 dB, Q 0.1–24).
 *
 * It reuses the FFT periodogram recipe the intent layer's `findResonances`
 * already ships (src/intent/resonance.ts) but adds the two numbers an EQ cut
 * actually needs and the intent detector does not produce:
 *   - **Q** from the −3 dB bandwidth of the peak (a wide hump and a razor
 *     whistle are different problems; the same cut dB at the wrong Q either
 *     does nothing or guts the tone);
 *   - a **bounded cut gain** derived from the peak's prominence (never the
 *     full prominence — a match is broad-stroke, not a resonance copy).
 *
 * Honesty rules:
 *   - a flat spectrum yields NO hits (no invented problems);
 *   - prominence is measured against a LOCAL rolling median, so a legitimately
 *     bass-heavy track does not flag every low band;
 *   - the cut is clamped (−12 dB ceiling, Q clamped 0.1–24) and the panel
 *     still requires an explicit APPLY — nothing auto-notches.
 *
 * Pure math + pure command builder — deterministic, no engine, no clock.
 */

import { fftInPlace } from "../audio-engine/spectralEdit";
import type { Command } from "../commands/types";
import type { ProjectDocument } from "../project-model/types";
import { addEffectWithLandingCommand } from "../commands/effectInstances";
import { setEffectMacroParams } from "../commands/effectParams";

const FFT_SIZE = 4096;
const HOP = FFT_SIZE / 4;
const BINS = FFT_SIZE / 2;

/** A detected resonance with the numbers an EQ cut needs. */
export interface ResonancePeak {
  /** Center frequency in Hz (rounded to 0.1). */
  hz: number;
  /** How far above the local spectral median, in dB. */
  prominenceDb: number;
  /** Estimated Q from the peak's −3 dB bandwidth (clamped 0.1–24). */
  q: number;
  /** The bounded EQ cut this peak suggests, in dB (negative). */
  cutDb: number;
}

/** Minimum prominence for a peak to count as a problem, not spectrum shape. */
export const RESONANCE_MIN_PROMINENCE_DB = 6;
/** The cut never exceeds this — a notch, not a surgical crater. */
export const RESONANCE_MAX_CUT_DB = 12;
/** Q is clamped to the native EQ free band's own range. */
export const RESONANCE_MIN_Q = 0.1;
export const RESONANCE_MAX_Q = 24;

const round = (value: number, digits = 1): number => {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
};

/**
 * Find narrow resonances in one signal. Local maxima in the averaged
 * periodogram above a rolling-median floor, with a −3 dB bandwidth Q
 * estimate and a bounded cut. Sorted by prominence (worst first),
 * deterministic. Pure.
 */
export function analyzeResonances(
  pcm: Float32Array,
  sampleRate: number,
  options: { maxHits?: number; prominenceDb?: number } = {},
): ResonancePeak[] {
  const maxHits = options.maxHits ?? 4;
  const prominence = options.prominenceDb ?? RESONANCE_MIN_PROMINENCE_DB;
  if (pcm.length < FFT_SIZE || !Number.isFinite(sampleRate) || sampleRate <= 0) return [];

  const frames = Math.max(1, Math.floor((pcm.length - FFT_SIZE) / HOP) + 1);
  const acc = new Float64Array(BINS);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
      re[i] = (off + i < pcm.length ? pcm[off + i] : 0) * w;
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let k = 1; k < BINS; k++) acc[k] += re[k]! * re[k]! + im[k]! * im[k]!;
  }

  const level = new Float64Array(BINS);
  for (let k = 1; k < BINS; k++) level[k] = 10 * Math.log10(Math.max(acc[k]!, 1e-20));

  // Rolling median (±8 bins) — the local spectral floor a resonance must beat.
  const W = 8;
  const floor = new Float64Array(BINS);
  for (let k = 1; k < BINS; k++) {
    const lo = Math.max(1, k - W);
    const hi = Math.min(BINS, k + W + 1);
    const window: number[] = [];
    for (let j = lo; j < hi; j++) window.push(level[j]!);
    window.sort((a, b) => a - b);
    floor[k] = window[Math.floor(window.length / 2)]!;
  }

  const nyquistBin = Math.min(BINS, Math.floor((BINS * 20000) / (sampleRate / 2)));
  const peaks: ResonancePeak[] = [];
  for (let k = 2; k < Math.min(BINS - 1, nyquistBin); k++) {
    if (level[k]! <= level[k - 1]! || level[k]! <= level[k + 1]!) continue;
    const prom = level[k]! - floor[k]!;
    if (prom < prominence) continue;
    const hz = round((k * sampleRate) / FFT_SIZE, 1);
    // Cluster: skip if within 3 bins of an already-found (louder) hit.
    if (peaks.some((p) => Math.abs(p.hz - hz) < (3 * sampleRate) / FFT_SIZE)) continue;
    const q = estimateQ(level, k, sampleRate);
    // Broad-stroke cut: 0.7× the prominence (the vendored EqLearn convention),
    // clamped. A wider peak (low Q) is a tone-shape issue, not a resonance —
    // it still reports, but the cut is gentle.
    const cutDb = -Math.min(RESONANCE_MAX_CUT_DB, round(prom * 0.7, 1));
    peaks.push({ hz, prominenceDb: round(prom), q, cutDb });
    if (peaks.length >= maxHits) break;
  }
  return peaks;
}

/**
 * Q from the −3 dB bandwidth around a peak: walk down each side of the peak
 * to where the level falls 3 dB below the peak, then Q = f0 / bandwidth.
 * Clamped to the native EQ free band's 0.1–24 range; a peak so wide its
 * shoulders never drop 3 dB within the search span reads the minimum Q
 * (a broad hump wants a broad, gentle cut).
 */
function estimateQ(level: Float64Array, peak: number, sampleRate: number): number {
  const target = level[peak]! - 3;
  const binHz = sampleRate / FFT_SIZE;
  let loBin = peak;
  while (loBin > 1 && level[loBin]! > target) loBin--;
  let hiBin = peak;
  while (hiBin < BINS - 1 && level[hiBin]! > target) hiBin++;
  const bandwidthHz = Math.max(1, (hiBin - loBin) * binHz);
  const f0Hz = (peak * sampleRate) / FFT_SIZE;
  const q = f0Hz / bandwidthHz;
  if (!Number.isFinite(q)) return RESONANCE_MIN_Q;
  return round(Math.max(RESONANCE_MIN_Q, Math.min(RESONANCE_MAX_Q, q)), 2);
}

/* ────────────────────────── the apply command ────────────────────────── */

/** Which free surgical band a peak should land on (two per EQ instance). */
export type FreeBandSlot = "free1" | "free2";

/**
 * Build ONE command that notches a set of detected peaks on a track:
 *   - reuse the track's existing non-bypassed `eq` when present, else add one;
 *   - write each peak to a free band as a BELL (freeNType 0) with the measured
 *     frequency, a bounded negative gain, and the estimated Q.
 *
 * All peaks fold into a single undo step. The native EQ exposes exactly two
 * free bands, so at most two peaks are applied per call; the caller passes
 * them in priority order and the panel can re-run to catch the next pair.
 * Returns null when there is nothing to apply or the track is missing.
 */
export function applyResonanceCutsCommand(
  doc: ProjectDocument,
  trackId: string,
  peaks: readonly ResonancePeak[],
): Command | null {
  const track = doc.tracks.find((candidate) => candidate.id === trackId);
  if (!track || peaks.length === 0) return null;
  const usable = peaks.slice(0, 2);
  if (usable.length === 0) return null;

  const slots: FreeBandSlot[] = ["free1", "free2"];
  const existingEq = track.effects.find((fx) => fx.type === "eq" && !fx.bypassed);

  if (existingEq) {
    const edits = usable.flatMap((peak, index) => {
      const slot = slots[index]!;
      return [
        { fxId: existingEq.id, paramId: `${slot}Type`, value: 0 },
        { fxId: existingEq.id, paramId: `${slot}Freq`, value: peak.hz },
        { fxId: existingEq.id, paramId: `${slot}Gain`, value: peak.cutDb },
        { fxId: existingEq.id, paramId: `${slot}Q`, value: peak.q },
      ];
    });
    return setEffectMacroParams(doc, trackId, edits);
  }

  const landing: Record<string, number> = {};
  usable.forEach((peak, index) => {
    const slot = slots[index]!;
    landing[`${slot}Type`] = 0;
    landing[`${slot}Freq`] = peak.hz;
    landing[`${slot}Gain`] = peak.cutDb;
    landing[`${slot}Q`] = peak.q;
  });
  return addEffectWithLandingCommand(doc, trackId, "eq", landing);
}

/** One-line evidence for a peak ("120.0 Hz · +11.3 dB over the local floor · Q 3.8"). */
export function describeResonance(peak: ResonancePeak): string {
  return `${peak.hz.toFixed(1)} Hz · ${peak.prominenceDb.toFixed(1)} dB over the local floor · Q ${peak.q} → cut ${peak.cutDb.toFixed(1)} dB`;
}
