import type { NoteEvent, MusicalKey } from "../project-model/types";
import { parseKey, SCALE_INTERVALS } from "../project-model/scales";
import type { GrooveData } from "./types";
import type { PadRole } from "./pad-roles";

function clampVelocity(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(0.1, Math.min(1, value));
}

/** Preserve style anchors that a sparse sampler must not erase. */
export function enforceDrumAnchors(row: number[], references: readonly number[][], role: PadRole): void {
  if (role !== "kick" && role !== "snare" && role !== "clap") return;

  const anchorPeriod = role === "kick" ? 4 : 8;
  const anchorOffset = role === "kick" ? 0 : 4;
  for (let step = anchorOffset; step < row.length; step += anchorPeriod) {
    const reference = Math.max(...references.map((pattern) => pattern[step % 16] ?? 0), 0);
    if (reference <= 0 || row[step] > 0) continue;
    // Deterministic repair: keep the reference's character, but leave room
    // for velocity contour and later phrase dynamics.
    row[step] = clampVelocity(Math.max(reference * 0.85, 0.35));
  }
}

/** Repair row shape and velocity values after all stochastic transformations. */
export function repairDrumRow(row: number[] | undefined, stepCount: number): number[] {
  const safeStepCount = Number.isFinite(stepCount) && stepCount > 0 ? Math.min(256, Math.floor(stepCount)) : 16;
  const repaired = new Array<number>(safeStepCount).fill(0);
  for (let step = 0; step < safeStepCount; step++) {
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
    const role = roles[pad] ?? "unknown";
    const references = groove.patterns.map((pattern) => pattern[pad] ?? []);
    for (let step = 0; step < stepCount; step++) {
      const value = row[step] ?? 0;
      if (value > 0) {
        hits.push(value);
        if (step % 4 === 1 || step % 4 === 3) syncopated++;
      }
      if ((role === "kick" && step % 4 === 0) || ((role === "snare" || role === "clap") && step % 8 === 4)) {
        const reference = Math.max(...references.map((pattern) => pattern[step % 16] ?? 0), 0);
        if (reference > 0) {
          anchors++;
          if (value > 0) coveredAnchors++;
        }
      }
    }
  }

  const mean = hits.length > 0 ? hits.reduce((sum, value) => sum + value, 0) / hits.length : 0;
  const variance = hits.length > 0 ? hits.reduce((sum, value) => sum + (value - mean) ** 2, 0) / hits.length : 0;
  const bars = Math.ceil(stepCount / 16);
  let repeatedPairs = 0;
  let comparedPairs = 0;
  for (let pad = 0; pad < rows.length; pad++) {
    const row = rows[pad];
    if (!row) continue;
    for (let bar = 1; bar < bars; bar++) {
      comparedPairs++;
      const previous = row.slice((bar - 1) * 16, bar * 16).join(",");
      const current = row.slice(bar * 16, (bar + 1) * 16).join(",");
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
  restRatio: number;
  durationDistribution: {
    short: number;
    medium: number;
    long: number;
  };
  motifRepetition: number;
  motifNovelty: number;
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Measure melodic shape without introducing runtime randomness or state. */
export function measureMelodicQuality(
  notes: readonly NoteEvent[],
  stepCount: number,
  key?: MusicalKey,
): MelodicQualityMetrics {
  const pitches = notes.map((note) => note.pitch);
  const pitchRange = pitches.length > 0 ? Math.max(...pitches) - Math.min(...pitches) : 0;
  let validScaleNotes = 0;
  const occupiedSteps = new Set<number>();
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
    if (!intervals || intervals.includes((((note.pitch - root) % 12) + 12) % 12)) validScaleNotes++;
    const startStep = Math.max(0, Math.floor(note.start / 120));
    const endStep = Math.min(stepCount, Math.ceil((note.start + Math.max(0, note.duration)) / 120));
    for (let step = startStep; step < endStep; step++) occupiedSteps.add(step);
  }
  const sortedNotes = [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const durationCounts = { short: 0, medium: 0, long: 0 };
  for (const note of sortedNotes) {
    const durationSteps = Math.max(0, note.duration) / 120;
    if (durationSteps <= 1) durationCounts.short++;
    else if (durationSteps <= 4) durationCounts.medium++;
    else durationCounts.long++;
  }
  const durationDenominator = Math.max(1, sortedNotes.length);
  const intervalMotifs = new Map<string, number>();
  for (let index = 0; index + 3 < sortedNotes.length; index++) {
    const key = [1, 2, 3]
      .map((offset) => {
        const interval = sortedNotes[index + offset].pitch - sortedNotes[index + offset - 1].pitch;
        const duration = Math.round(Math.max(0, sortedNotes[index + offset].duration) / 120);
        return `${interval}:${duration}`;
      })
      .join("|");
    intervalMotifs.set(key, (intervalMotifs.get(key) ?? 0) + 1);
  }
  const motifTotal = [...intervalMotifs.values()].reduce((sum, count) => sum + count, 0);
  const repeatedMotifs = [...intervalMotifs.values()]
    .filter((count) => count > 1)
    .reduce((sum, count) => sum + count, 0);
  const motifRepetition = motifTotal > 0 ? repeatedMotifs / motifTotal : 0;
  const occupiedStepRatio = Math.min(1, occupiedSteps.size / Math.max(1, stepCount));
  return {
    noteDensity: rounded(stepCount > 0 ? notes.length / stepCount : 0),
    pitchRange,
    scaleValidity: rounded(notes.length > 0 ? validScaleNotes / notes.length : 1),
    occupiedStepRatio: rounded(occupiedStepRatio),
    restRatio: rounded(1 - occupiedStepRatio),
    durationDistribution: {
      short: rounded(durationCounts.short / durationDenominator),
      medium: rounded(durationCounts.medium / durationDenominator),
      long: rounded(durationCounts.long / durationDenominator),
    },
    motifRepetition: rounded(motifRepetition),
    motifNovelty: rounded(1 - motifRepetition),
  };
}
