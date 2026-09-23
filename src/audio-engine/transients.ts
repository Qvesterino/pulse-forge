/**
 * Transient (onset) detection for chop-beats slicing.
 *
 * Energy-flux detector tuned for percussive material (drum breaks, loops):
 *  1. short-time RMS envelope (window 1024, hop 256)
 *  2. positive log-energy difference (flux) — attacks light up, decays don't
 *  3. peak picking against an adaptive threshold (local mean + k·σ)
 *  4. minimum inter-onset spacing (default 60 ms) so one hit yields one marker
 *
 * Pure math, no dependencies — unit-testable without an AudioContext.
 */

export interface TransientOptions {
  /**
   * Sensitivity multiplier for the adaptive threshold. Lower = more onsets.
   * Default 1; practical range 0.5–2.
   */
  sensitivity?: number;
}

/** Detect onset times (seconds) in mono channel data. */
export function detectTransients(data: Float32Array, sampleRate: number, options: TransientOptions = {}): number[] {
  const sensitivity = options.sensitivity ?? 1;

  // Guard before any arithmetic — NaN/Infinity sampleRate would produce
  // NaN frame counts that bypass the `frames < 4` check (NaN comparisons
  // are always false) and allocate Float64Array(NaN)-sized garbage.
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return [];

  const windowSize = 1024;
  const hop = 256;
  const frames = Math.max(0, Math.floor((data.length - windowSize) / hop) + 1);
  if (frames < 4) return [];

  // 1. RMS envelope per frame.
  const envelope = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const start = f * hop;
    for (let i = start; i < start + windowSize; i++) sum += data[i] * data[i];
    envelope[f] = Math.sqrt(sum / windowSize);
  }

  // 2. Positive log-energy flux. The log compresses dynamics so a quiet
  // sample's hits still stand out relative to its own noise floor.
  const flux = new Float64Array(frames);
  for (let f = 1; f < frames; f++) {
    const a = Math.log(envelope[f - 1] + 1e-10);
    const b = Math.log(envelope[f] + 1e-10);
    flux[f] = Math.max(0, b - a);
  }

  // 3. Adaptive peak picking. The threshold combines a LOCAL mean (tracks a
  // varying floor) with an anchor to the loudest attack in the material —
  // a purely relative threshold fires on noise-floor fluctuations, and a
  // purely absolute one breaks with level changes. Onsets additionally
  // "re-arm": a new hit is only accepted after the envelope has decayed
  // away from the previous one, so a single decaying hit yields ONE marker.
  const localFrames = Math.max(1, Math.round((0.5 * sampleRate) / hop));
  let globalMaxFlux = 0;
  for (let f = 0; f < frames; f++) if (flux[f] > globalMaxFlux) globalMaxFlux = flux[f];

  const onsets: number[] = [];
  let lastOnsetEnvelope = 0;
  let armed = true;
  for (let f = 1; f < frames; f++) {
    const env = envelope[f];
    if (!armed) {
      if (env < lastOnsetEnvelope * 0.5) armed = true;
      else continue;
    }
    if (flux[f] <= 0) continue;
    // Local mean of flux for threshold.
    let sum = 0;
    let envSum = 0;
    let n = 0;
    for (let j = Math.max(0, f - localFrames); j < Math.min(frames, f + localFrames); j++) {
      sum += flux[j];
      envSum += envelope[j];
      n++;
    }
    const mean = sum / n;
    const envMean = envSum / n;
    // The frame's energy must actually RISE vs its local baseline — kills
    // heavy-tailed log-flux spikes from a stable noise floor. Evaluate on
    // the settled level (a couple of frames ahead): the onset frame itself
    // only partially overlaps the attack, so its own envelope understates
    // the burst.
    const settledEnv = Math.max(env, envelope[f + 1] ?? 0, envelope[f + 2] ?? 0);
    if (settledEnv < envMean * 1.5) continue;
    const threshold = mean * 2.5 * sensitivity + globalMaxFlux * 0.2;
    if (flux[f] < threshold) continue;
    if (flux[f] < flux[f - 1] || flux[f] < flux[f + 1]) continue;
    lastOnsetEnvelope = env;
    armed = false;
    // Onset time = frame center where energy starts rising (back-track one
    // window so the chop catches the attack, not the body).
    onsets.push(Math.max(0, (f * hop - windowSize * 0.5) / sampleRate));
  }
  return onsets;
}

/** Grid slice boundaries (seconds) at `divisionsPerBeat` for a BPM. */
export function gridSlicePoints(bpm: number, divisionsPerBeat: number, durationSec: number): number[] {
  // BPM = 0 / NaN / Infinity → step is NaN or Infinity → the loop
  // never advances. Return [] rather than an infinite / empty
  // ambiguous array.
  if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(divisionsPerBeat) || divisionsPerBeat <= 0) {
    return [];
  }
  // Audit 12 D3: a non-finite duration would loop forever (t += finite step
  // never reaches Infinity), OOM-ing the tab. Guard like every other input.
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  const step = 60 / bpm / divisionsPerBeat;
  const points: number[] = [];
  for (let t = 0; t < durationSec - 1e-6; t += step) points.push(t);
  return points;
}

/**
 * Snap transient times to the nearest grid line (MPC "grid-lock" chop):
 * keeps only onsets, but each lands exactly on the grid.
 */
export function snapToGrid(times: number[], bpm: number, divisionsPerBeat: number): number[] {
  // BPM = 0 / NaN / Infinity → step is NaN → snap = NaN. Collapse every
  // time to 0 (the grid step is "infinite" so all onsets land on the
  // leading edge) — better than poisoning the result with NaN.
  if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(divisionsPerBeat) || divisionsPerBeat <= 0) {
    return times
      .map((t) => Math.max(0, t))
      .filter((t) => t === 0);
  }
  const step = 60 / bpm / divisionsPerBeat;
  const snapped = times.map((t) => Math.max(0, Math.round(t / step) * step));
  // Deduplicate (two onsets can collapse onto one grid line).
  return [...new Set(snapped.map((t) => +t.toFixed(6)))].sort((a, b) => a - b);
}

/** Turn slice start-points into [start, end) regions covering the source. */
export function pointsToSlices(points: number[], durationSec: number): { start: number; end: number }[] {
  return points.map((start, i) => ({
    start,
    end: i + 1 < points.length ? points[i + 1] : durationSec,
  }));
}

/**
 * Snap a slice point to the nearest zero crossing (±256 samples) so chops
 * never start mid-cycle with a click. Falls back to the input position when
 * no crossing is found.
 */
export function zeroCrossSnap(data: Float32Array, sampleRate: number, seconds: number): number {
  const idx = Math.floor(seconds * sampleRate);
  const search = 256;
  let bestIdx = idx;
  let bestDist = Infinity;
  const start = Math.max(1, idx - search);
  const end = Math.min(data.length - 1, idx + search);
  for (let i = start; i < end; i++) {
    if (data[i] === 0) {
      const dist = Math.abs(i - idx);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    } else if (data[i] * data[i + 1] < 0 || data[i] * data[i + 1] === 0) {
      // Linear interpolate zero crossing between i and i+1
      const t = Math.abs(data[i]) / (Math.abs(data[i]) + Math.abs(data[i + 1]));
      const interp = i + t;
      const dist = Math.abs(interp - idx);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = Math.round(interp);
      }
    }
  }
  return bestDist === Infinity ? seconds : bestIdx / sampleRate;
}

/**
 * One-click auto-chop: detector onset times → zero-cross-snapped [start,end)
 * slice regions covering the whole take. Pure — shared by SliceLab-adjacent
 * flows and the resample AUTO-CHOP button.
 */
export function slicesFromOnsets(
  times: number[],
  durationSec: number,
  data?: Float32Array,
  sampleRate?: number,
): { start: number; end: number }[] {
  const duration = Math.max(0, durationSec);
  const points = [0, ...times].filter((t) => Number.isFinite(t) && t >= 0 && t <= duration);
  const unique = [...new Set(points.map((t) => +t.toFixed(6)))].sort((a, b) => a - b);
  // The leading zero stays exactly at 0 (never trim a take's attack); the
  // remaining points snap to zero crossings when audio is provided.
  const snap =
    data && sampleRate && Number.isFinite(sampleRate) && sampleRate > 0
      ? (t: number) => zeroCrossSnap(data, sampleRate, t)
      : (t: number) => t;
  const snapped = unique.map((t, i) => (i === 0 ? t : snap(t)));
  const ordered = [...new Set(snapped.map((t) => +t.toFixed(6)))].sort((a, b) => a - b);
  return pointsToSlices(ordered, duration).filter((slice) => slice.end > slice.start);
}
