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
