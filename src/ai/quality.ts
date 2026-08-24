import type { NoteEvent, MusicalKey } from '../project-model/types';
import { parseKey, SCALE_INTERVALS } from '../project-model/scales';
import type { GrooveData } from './types';
import type { PadRole } from './pad-roles';

function clampVelocity(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(0.1, Math.min(1, value));
}

/** Preserve style anchors that a sparse sampler must not erase. */
export function enforceDrumAnchors(
  row: number[],
  references: readonly number[][],
  role: PadRole,
): void {
  if (role !== 'kick' && role !== 'snare' && role !== 'clap') return;

  const anchorPeriod = role === 'kick' ? 4 : 8;
  const anchorOffset = role === 'kick' ? 0 : 4;
  for (let step = anchorOffset; step < row.length; step += anchorPeriod) {
    const reference = Math.max(...references.map(pattern => pattern[step % 16] ?? 0), 0);
    if (reference <= 0 || row[step] > 0) continue;
    // Deterministic repair: keep the reference's character, but leave room
    // for velocity contour and later phrase dynamics.
    row[step] = clampVelocity(Math.max(reference * 0.85, 0.35));
  }
}

/** Repair row shape and velocity values after all stochastic transformations. */
export function repairDrumRow(row: number[] | undefined, stepCount: number): number[] {
  const repaired = new Array<number>(stepCount).fill(0);
  for (let step = 0; step < stepCount; step++) {
    repaired[step] = clampVelocity(row?.[step] ?? 0);
  }
  return repaired;
}

export interface QualityMetrics {
  velocityContrast: number;
  syncopation: number;
  barRepetition: number;
  anchorCoverage: number;
}

/** Lightweight deterministic quality metrics for golden tests and diagnostics. */
export function measureDrumQuality(
  groove: GrooveData,
  rows: readonly (number[] | undefined)[],
  roles: readonly PadRole[],
  stepCount: number,
): QualityMetrics {
  const hits: number[] = [];
  let syncopated = 0;
  let anchors = 0;
  let coveredAnchors = 0;

  for (let pad = 0; pad < rows.length; pad++) {
    const row = rows[pad];
    if (!row) continue;
    const role = roles[pad] ?? 'unknown';
    const references = groove.patterns.map(pattern => pattern[pad] ?? []);
    for (let step = 0; step < stepCount; step++) {
      const value = row[step] ?? 0;
      if (value > 0) {
        hits.push(value);
        if (step % 4 === 1 || step % 4 === 3) syncopated++;
      }
      if ((role === 'kick' && step % 4 === 0) || ((role === 'snare' || role === 'clap') && step % 8 === 4)) {
        const reference = Math.max(...references.map(pattern => pattern[step % 16] ?? 0), 0);
        if (reference > 0) {
          anchors++;
          if (value > 0) coveredAnchors++;
        }
      }
    }
  }

  const mean = hits.length > 0 ? hits.reduce((sum, value) => sum + value, 0) / hits.length : 0;
  const variance = hits.length > 0
    ? hits.reduce((sum, value) => sum + (value - mean) ** 2, 0) / hits.length
    : 0;
  const bars = Math.ceil(stepCount / 16);
  let repeatedPairs = 0;
  let comparedPairs = 0;
  for (let pad = 0; pad < rows.length; pad++) {
    const row = rows[pad];
    if (!row) continue;
    for (let bar = 1; bar < bars; bar++) {
      comparedPairs++;
      const previous = row.slice((bar - 1) * 16, bar * 16).join(',');
      const current = row.slice(bar * 16, (bar + 1) * 16).join(',');
      if (previous === current) repeatedPairs++;
    }
  }

  return {
    velocityContrast: Math.round(Math.sqrt(variance) * 1_000_000) / 1_000_000,
    syncopation: Math.round((hits.length > 0 ? syncopated / hits.length : 0) * 1_000_000) / 1_000_000,
    barRepetition: Math.round((comparedPairs > 0 ? repeatedPairs / comparedPairs : 0) * 1_000_000) / 1_000_000,
    anchorCoverage: Math.round((anchors > 0 ? coveredAnchors / anchors : 1) * 1_000_000) / 1_000_000,
  };
}

export interface MelodicQualityMetrics {
  noteDensity: number;
  pitchRange: number;
  scaleValidity: number;
  occupiedStepRatio: number;
}

/** Measure melodic shape without introducing runtime randomness or state. */
export function measureMelodicQuality(
  notes: readonly NoteEvent[],
  stepCount: number,
  key?: MusicalKey,
): MelodicQualityMetrics {
  const pitches = notes.map(note => note.pitch);
  const pitchRange = pitches.length > 0 ? Math.max(...pitches) - Math.min(...pitches) : 0;
  let validScaleNotes = 0;
  let occupiedTicks = 0;
  let intervals: readonly number[] | undefined;
  let root = 0;
  if (key) {
    const parsed = parseKey(key);
    if (parsed) {
      root = parsed.root;
      intervals = SCALE_INTERVALS[parsed.scaleType];
    }
  }

  for (const note of notes) {
    if (!intervals || intervals.includes(((note.pitch - root) % 12 + 12) % 12)) validScaleNotes++;
    occupiedTicks += Math.max(0, note.duration);
  }
  const patternTicks = Math.max(1, stepCount * 120);
  return {
    noteDensity: Math.round((stepCount > 0 ? notes.length / stepCount : 0) * 1_000_000) / 1_000_000,
    pitchRange,
    scaleValidity: Math.round((notes.length > 0 ? validScaleNotes / notes.length : 1) * 1_000_000) / 1_000_000,
    occupiedStepRatio: Math.round(Math.min(1, occupiedTicks / patternTicks) * 1_000_000) / 1_000_000,
  };
}
