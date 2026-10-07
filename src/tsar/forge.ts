/**
 * TSAR SAMPLE FORGE — drop a WAV, get a playable TSAR patch (docs/TSAR-ROADMAP.md T2).
 *
 * Pure and deterministic: `(pcm, sampleRate, options) -> ForgePlan`. The plan
 * is DATA; a command applies it to a track (T2's `forgeSampleCommand`). No
 * AudioContext, no store, no clock — the same WAV always yields the same plan
 * (invariant #4), and the plan is directly testable.
 *
 * Honesty rules (the same the transcription lanes follow):
 *  - a root the tracker cannot hear is reported as `rootMidi: null` +
 *    `rootConfidence: 0`; the CALLER decides the fallback (the UI defaults to
 *    C4 and says so), the analyzer never invents a pitch;
 *  - every routing decision carries its measured evidence in `reasons`;
 *  - an EMPTY signal yields a `kind: "empty"` plan the caller must refuse to
 *    apply, not a default patch that pretends something was forged.
 *
 * Detection, in order:
 *  1. silence gate — RMS below the floor is "empty", full stop;
 *  2. root frequency — YIN-style difference function at the sustain midpoint
 *     (not plain autocorrelation: for a pure sine its normalized value is
 *     cos(ωL), which is HIGH at small lags and reads the wrong octave);
 *  3. one-shot vs sustained — energy in the first 10 % vs the last 10 %
 *     (a decaying hit vs a held tone);
 *  4. sustained + stable f0 -> wavetable (frame extraction), sustained +
 *     unstable f0 -> granular (texture), short/percussive -> sampler.
 */

import { trackPitch } from "../audio-workers/pitch-tracker";

export type ForgeKind = "empty" | "one-shot" | "sustained";
export type ForgeEngine = "sampler" | "wavetable" | "granular";

export interface ForgePlan {
  kind: ForgeKind;
  engine: ForgeEngine;
  /** Detected root; null when the signal has no readable pitch. */
  rootMidi: number | null;
  /** 0..1 confidence in the root (clarity of the pitch frames). */
  rootConfidence: number;
  /** Detected fundamental in Hz (0 when unreadable). */
  rootHz: number;
  /** True when the source should loop (sustained material). */
  loop: boolean;
  /** Suggested amp envelope derived from the measured shape. */
  envelope: { attackSec: number; releaseSec: number };
  /** 0..1 peak normalization target recommendation. */
  peakNormalize: number;
  /** Human-readable evidence lines (the panel shows these verbatim). */
  reasons: string[];
  /** Non-fatal notes ("no readable pitch — set ROOT manually"). */
  warnings: string[];
}

export interface ForgeOptions {
  /** Silence floor (RMS); below this the source is "empty". */
  silenceRms?: number;
  /** Minimum readable pitch (Hz). */
  fminHz?: number;
  /** Maximum readable pitch (Hz). */
  fmaxHz?: number;
}

const DEFAULT_SILENCE_RMS = 1e-4;
const DEFAULT_FMIN = 40;
const DEFAULT_FMAX = 1050;
/** A source shorter than this is a one-shot regardless of shape. */
const ONESHOT_MAX_SEC = 1.2;
/** Decay ratio (last decile / first decile) below this = one-shot. */
const ONESHOT_DECAY_RATIO = 0.2;
/** f0 spread (semitones, decile medians) above this = unstable -> granular. */
const UNSTABLE_SEMITONES = 0.8;

function rms(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / Math.max(1, data.length));
}

function peak(data: Float32Array): number {
  let max = 0;
  for (let i = 0; i < data.length; i++) {
    const magnitude = Math.abs(data[i]);
    if (magnitude > max) max = magnitude;
  }
  return max;
}

/** Energy of a slice, mean square (not sqrt — a ratio is all we need). */
function sliceEnergy(data: Float32Array, from: number, to: number): number {
  let sum = 0;
  const end = Math.min(data.length, to);
  for (let i = Math.max(0, from); i < end; i++) sum += data[i] * data[i];
  return sum / Math.max(1, end - from);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * YIN-style f0 over a window: the difference function's minimum at the true
 * period. Absolute-threshold descent (the pitch-tracker recipe) avoids the
 * subharmonic trap plain argmin falls into on harmonic-rich material: every
 * multiple of the period is an equally deep minimum, so the FIRST dip below
 * the threshold wins, then descends to that valley's floor.
 */
function detectF0(
  data: Float32Array,
  sampleRate: number,
  fminHz: number,
  fmaxHz: number,
): { hz: number; clarity: number } {
  const win = Math.min(data.length, Math.round(0.05 * sampleRate));
  if (win < 64) return { hz: 0, clarity: 0 };
  const start = Math.max(0, Math.min(data.length - win - 1, Math.round(data.length * 0.4)));
  const minLag = Math.max(2, Math.floor(sampleRate / fmaxHz));
  const maxLag = Math.min(Math.floor(sampleRate / fminHz), win - 1);
  if (maxLag <= minLag) return { hz: 0, clarity: 0 };

  const diff = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < win - lag; i++) {
      const delta = data[start + i]! - data[start + i + lag]!;
      sum += delta * delta;
    }
    diff[lag] = sum;
  }
  // Cumulative-mean normalized difference (0 = perfectly periodic).
  const cmnd = new Float64Array(maxLag + 1);
  let running = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    running += diff[lag]!;
    cmnd[lag] = running === 0 ? 1 : (diff[lag]! * (lag - minLag + 1)) / running;
  }
  // Absolute threshold: first dip below 0.15, descend to its local minimum.
  let pick = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (cmnd[lag]! < 0.15) {
      let valley = lag;
      while (valley + 1 <= maxLag && cmnd[valley + 1]! < cmnd[valley]!) valley++;
      pick = valley;
      break;
    }
  }
  if (pick === 0) {
    // No dip below the threshold: take the global minimum with a clarity gate.
    let best = Number.POSITIVE_INFINITY;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (cmnd[lag]! < best) {
        best = cmnd[lag]!;
        pick = lag;
      }
    }
    if (pick === 0 || best > 0.6) return { hz: 0, clarity: 0 };
    return { hz: sampleRate / pick, clarity: Math.max(0, 1 - best) };
  }
  // Parabolic refinement around the picked valley.
  let refined = pick;
  if (pick > minLag && pick < maxLag) {
    const s0 = cmnd[pick - 1]!;
    const s1 = cmnd[pick]!;
    const s2 = cmnd[pick + 1]!;
    const denom = 2 * (2 * s1 - s2 - s0);
    if (Math.abs(denom) > 1e-12) {
      const shift = (s2 - s0) / denom;
      if (Math.abs(shift) < 1) refined = pick + shift;
    }
  }
  return { hz: sampleRate / refined, clarity: Math.max(0, Math.min(1, 1 - cmnd[pick]!)) };
}

/**
 * f0 via the SHARED pitch tracker (worker-safe primitive) over deciles of the
 * source — used for the stability check. Returns the MIDI values it read.
 */
function trackedMidi(data: Float32Array, sampleRate: number, fminHz: number, fmaxHz: number): number[] {
  const frames = trackPitch(data, sampleRate, { fminHz, fmaxHz, hopMs: 20 });
  const midis: number[] = [];
  for (const frame of frames) {
    if (frame.clarity >= 0.5 && frame.midi > 0) midis.push(frame.midi);
  }
  return midis;
}

function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

/**
 * Build the Forge plan. Deterministic; never throws.
 */
export function forgePlan(pcm: Float32Array, sampleRate: number, options: ForgeOptions = {}): ForgePlan {
  const silenceRms = options.silenceRms ?? DEFAULT_SILENCE_RMS;
  const fminHz = options.fminHz ?? DEFAULT_FMIN;
  const fmaxHz = options.fmaxHz ?? DEFAULT_FMAX;
  const reasons: string[] = [];
  const warnings: string[] = [];

  const empty: ForgePlan = {
    kind: "empty",
    engine: "sampler",
    rootMidi: null,
    rootConfidence: 0,
    rootHz: 0,
    loop: false,
    envelope: { attackSec: 0.003, releaseSec: 0.1 },
    peakNormalize: 1,
    reasons,
    warnings,
  };
  if (!pcm || pcm.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    warnings.push("no audio to analyse");
    return empty;
  }
  const level = rms(pcm);
  if (level < silenceRms) {
    warnings.push(`source is silent (RMS ${level.toExponential(1)}) — nothing to forge`);
    return empty;
  }
  const sourcePeak = peak(pcm);
  const durationSec = pcm.length / sampleRate;

  // ---- Root detection ----
  const { hz, clarity } = detectF0(pcm, sampleRate, fminHz, fmaxHz);
  let rootMidi: number | null = null;
  let rootConfidence = 0;
  if (hz > 0) {
    rootMidi = Math.round(hzToMidi(hz));
    rootConfidence = Number(clarity.toFixed(3));
    reasons.push(`root ≈ ${hz.toFixed(1)} Hz (MIDI ${rootMidi}), clarity ${clarity.toFixed(2)}`);
  } else {
    warnings.push("no readable pitch — set ROOT manually (defaults to C4)");
  }

  // ---- One-shot vs sustained ----
  // Compare the median energy of 8 windows in the first 30 % against the last
  // 30 %. First/last DECILE comparison fails on any source with amplitude
  // modulation or a tail fade: the golden pad's 0.4 Hz AM happened to sit at
  // its minimum in the final decile and read as a decay (measured during T2).
  // Medians over wider windows are robust to both AM and a short release tail.
  const windowCount = 8;
  const windowLength = Math.max(1, Math.floor(pcm.length / windowCount));
  const earlyEnergies: number[] = [];
  const lateEnergies: number[] = [];
  for (let w = 0; w < windowCount; w++) {
    const energy = sliceEnergy(pcm, w * windowLength, (w + 1) * windowLength);
    if (w < 3) earlyEnergies.push(energy);
    if (w >= windowCount - 3) lateEnergies.push(energy);
  }
  const earlyMedian = median(earlyEnergies);
  const lateMedian = median(lateEnergies);
  const decayRatio = lateMedian / Math.max(1e-12, earlyMedian);
  // "Short" is about the source's absolute length; the ratio catches the rest.
  const short = durationSec <= ONESHOT_MAX_SEC;
  const decaying = decayRatio < ONESHOT_DECAY_RATIO;
  const kind: ForgeKind = short || decaying ? "one-shot" : "sustained";
  reasons.push(
    short
      ? `short source (${durationSec.toFixed(2)} s) → one-shot`
      : decaying
        ? `energy decays to ${(decayRatio * 100).toFixed(1)} % (late/early median) → one-shot`
        : `energy sustains (${(decayRatio * 100).toFixed(0)} % late/early median) → sustained`,
  );

  // ---- f0 stability (sustained only; granular vs wavetable) ----
  let stable = true;
  if (kind === "sustained" && rootMidi !== null) {
    const midis = trackedMidi(pcm, sampleRate, fminHz, fmaxHz);
    if (midis.length >= 4) {
      const third = Math.max(1, Math.floor(midis.length / 3));
      const spread = Math.abs(median(midis.slice(-third)) - median(midis.slice(0, third)));
      stable = spread <= UNSTABLE_SEMITONES;
      reasons.push(`f0 spread ${spread.toFixed(2)} st across the take`);
    } else {
      // Not enough voiced frames to judge: stay conservative (wavetable is the
      // safer route — a single readable period is exactly its requirement).
      reasons.push("too few voiced frames for a stability verdict — assuming stable");
    }
  }

  const engine: ForgeEngine = kind === "one-shot" ? "sampler" : stable ? "wavetable" : "granular";
  reasons.push(`engine ${engine}${kind === "sustained" ? (stable ? " (stable f0)" : " (drifting f0)") : ""}`);

  // ---- Envelope + normalization ----
  // Attack: the time to reach 90 % of the peak (first occurrence).
  let attackSec = 0.003;
  if (sourcePeak > 0) {
    const threshold = sourcePeak * 0.9;
    for (let i = 0; i < pcm.length; i++) {
      if (Math.abs(pcm[i]!) >= threshold) {
        attackSec = Math.max(0.001, Math.min(1, i / sampleRate));
        break;
      }
    }
  }
  // Release: time from the last 5 %-of-peak point to the end (one-shot tail).
  let releaseSec = 0.1;
  if (kind === "one-shot" && sourcePeak > 0) {
    const threshold = sourcePeak * 0.05;
    for (let i = pcm.length - 1; i >= 0; i--) {
      if (Math.abs(pcm[i]!) >= threshold) {
        releaseSec = Math.max(0.02, Math.min(2, (pcm.length - i) / sampleRate));
        break;
      }
    }
  }
  reasons.push(`attack ${(attackSec * 1000).toFixed(0)} ms, release ${(releaseSec * 1000).toFixed(0)} ms`);

  return {
    kind,
    engine,
    rootMidi,
    rootConfidence,
    rootHz: Number(hz.toFixed(4)),
    loop: kind === "sustained",
    envelope: { attackSec: Number(attackSec.toFixed(4)), releaseSec: Number(releaseSec.toFixed(4)) },
    peakNormalize: sourcePeak > 0 ? Number((1 / sourcePeak).toFixed(4)) : 1,
    reasons,
    warnings,
  };
}
