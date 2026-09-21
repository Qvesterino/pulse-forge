export interface ReferenceBeatGrid {
  /** First-beat offset from t=0 in seconds. */
  offsetSeconds: number;
  /** All beat timestamps in seconds from t=0, 6-decimal precision. */
  beatTimes: number[];
  /** 0..1 how well the grid lines up with onset peaks (peak-vs-mean ratio, clipped). */
  alignment: number;
}

/**
 * Estimate the beat phase of a fixed-period grid against the onset envelope,
 * then emit beat timestamps. Phase search uses at least 16 steps and up to
 * 4× the period in steps; alignment is the (best − mean) / mean of the
 * phase-search scores, clipped to [0, 1].
 *
 * Ported verbatim from audiokey-analyzer/src/analysis/beatGrid.ts
 * (Apache-2.0 / project-owned, see docs/REFERENCE-MAP-ROADMAP.md §B).
 */
export function estimateBeatGrid(
  envelope: Float32Array,
  frameRate: number,
  bpm: number,
  durationSeconds: number,
): ReferenceBeatGrid {
  const periodFrames = (frameRate * 60) / bpm;
  if (!Number.isFinite(periodFrames) || periodFrames < 2 || envelope.length < periodFrames * 2) {
    return { offsetSeconds: 0, beatTimes: [], alignment: 0 };
  }

  const phaseSteps = Math.max(16, Math.round(periodFrames * 4));
  let bestPhase = 0;
  let bestScore = -Infinity;
  let meanScore = 0;

  for (let s = 0; s < phaseSteps; s++) {
    const phase = (periodFrames * s) / phaseSteps;
    let sum = 0;
    let count = 0;
    for (let pos = phase; pos < envelope.length - 1; pos += periodFrames) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      sum += envelope[i0] * (1 - frac) + envelope[i0 + 1] * frac;
      count++;
    }
    const score = count > 0 ? sum / count : 0;
    meanScore += score;
    if (score > bestScore + 1e-12) {
      bestScore = score;
      bestPhase = phase;
    }
  }
  meanScore /= phaseSteps;

  const offsetSeconds = bestPhase / frameRate;
  const beatInterval = 60 / bpm;
  const beatTimes: number[] = [];
  for (let t = offsetSeconds; t < durationSeconds; t += beatInterval) {
    beatTimes.push(Number(t.toFixed(6)));
  }

  const alignment = meanScore > 0 ? Math.min(1, (bestScore - meanScore) / meanScore) : 0;
  return { offsetSeconds, beatTimes, alignment };
}
