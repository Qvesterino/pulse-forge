import type { NoteEvent, MusicalKey } from "../project-model/types";
import { parseKey, SCALE_INTERVALS } from "../project-model/scales";
import type { GrooveData } from "./types";
import type { PadRole } from "./pad-roles";
import { DEFAULT_AI_METER, isAnchorForRole, isDefaultMeter, referencePhase, stepInBar, type AiMeter } from "./meter";

function clampVelocity(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(0.1, Math.min(1, value));
}

/** The groove row's own length — the reference grid the phase folds onto. */
function referenceLength(references: readonly number[][]): number {
  for (const reference of references) {
    if (reference.length > 0) return reference.length;
  }
  return DEFAULT_AI_METER.stepsPerBar;
}

/**
 * The groove's own velocity for this role, taken from the reference hit
 * NEAREST the anchor (cyclically inside the reference's bar).
 *
 * Used when the metre has to WRITE an anchor the groove's material cannot
 * express: the anchor's loudness still comes from the groove, so the written
 * skeleton wears the genre's accent character instead of a flat default.
 */
function nearestRoleVelocity(references: readonly number[][], phase: number, length: number): number {
  let bestValue = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < length; index++) {
    const value = Math.max(...references.map((pattern) => pattern[index] ?? 0), 0);
    if (value <= 0) continue;
    const forward = (phase - index + length) % length;
    const backward = (index - phase + length) % length;
    const distance = Math.min(forward, backward);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestValue = value;
    }
  }
  return bestValue;
}

/**
 * Preserve style anchors that a sparse sampler must not erase.
 *
 * The anchors are the METRE's: the kick on the pulse, the snare on the
 * backbeat (ADR 0057 Stage 2b). In 4/4 that is the legacy set — kick on
 * 0/4/8/12, snare on 4/12 — so the rule is unchanged there; in 3/4 the snare
 * lands on beat 2 only, and in 6/8 on the shuffle's 2 & 5.
 *
 * The reference row is read at the metrical bar's phase, so the second bar of
 * a pattern draws the groove's FIRST bar again rather than reaching past the
 * end of the groove's material.
 *
 * TWO PATHS, and the difference is measured, not cosmetic:
 *
 * - REPAIR (every metre): the reference has a hit at the anchor, the sampler
 *   dropped it → put the reference's own hit back. This is the legacy rule.
 * - WRITE (any metre but 4/4): the reference has NOTHING at the anchor — the
 *   groove library is 4/4 material, so it carries no skeleton for a 3/4 or a
 *   6/8 bar. Without this path the generator would write a truncated 4/4 bar
 *   and call it 6/8. The metre writes the anchor, and the groove still writes
 *   its loudness (the nearest reference hit of that role).
 *
 * 4/4 is deliberately excluded from the WRITE path: that metre's behaviour is
 * the promise the overwhelming majority of the product depends on, and its
 * material already carries the metrical skeleton. Stage 2c (metrical groove
 * content) will make the WRITE path unnecessary everywhere, because the
 * reference will then hold the anchors itself.
 */
export function enforceDrumAnchors(
  row: number[],
  references: readonly number[][],
  role: PadRole,
  meter: AiMeter = DEFAULT_AI_METER,
): void {
  if (role !== "kick" && role !== "snare" && role !== "clap") return;

  const length = referenceLength(references);
  const frozen = isDefaultMeter(meter.signature);
  for (let step = 0; step < row.length; step++) {
    if (!isAnchorForRole(meter, role === "kick" ? "kick" : "snare", step)) continue;
    if (row[step] > 0) continue;
    const phase = referencePhase(meter, step, length);
    const reference = Math.max(...references.map((pattern) => pattern[phase] ?? 0), 0);
    if (reference > 0) {
      // Deterministic repair: keep the reference's character, but leave room
      // for velocity contour and later phrase dynamics.
      row[step] = clampVelocity(Math.max(reference * 0.85, 0.35));
      continue;
    }
    if (frozen) continue;
    const nearest = nearestRoleVelocity(references, phase, length);
    if (nearest <= 0) continue;
    row[step] = clampVelocity(Math.max(nearest * 0.85, 0.35));
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

/**
 * Lightweight deterministic quality metrics for golden tests and diagnostics.
 *
 * The metrics are measured against the DOCUMENT's metre (ADR 0057 Stage 2b):
 * the syncopation count asks what falls off the metrical pulse, the anchor
 * coverage asks which of the metrical anchors survived, and the bar-repetition
 * slices the row at the metrical bar line. In 4/4 all three are the legacy
 * measurements.
 */
export function measureDrumQuality(
  groove: GrooveData,
  rows: readonly (number[] | undefined)[],
  roles: readonly PadRole[],
  stepCount: number,
  meter: AiMeter = DEFAULT_AI_METER,
): QualityMetrics {
  const hits: number[] = [];
  let syncopated = 0;
  let anchors = 0;
  let coveredAnchors = 0;
  const halfPulse = meter.pulseSteps / 2;

  for (let pad = 0; pad < rows.length; pad++) {
    const row = rows[pad];
    if (!row) continue;
    const role = roles[pad] ?? "unknown";
    const references = groove.patterns.map((pattern) => pattern[pad] ?? []);
    const length = referenceLength(references);
    for (let step = 0; step < stepCount; step++) {
      const value = row[step] ?? 0;
      const inBar = stepInBar(meter, step);
      if (value > 0) {
        hits.push(value);
        const offPulse = inBar % meter.pulseSteps !== 0 && (halfPulse <= 0 || inBar % halfPulse !== 0);
        if (offPulse) syncopated++;
      }
      const isAnchor =
        (role === "kick" && isAnchorForRole(meter, "kick", step)) ||
        ((role === "snare" || role === "clap") && isAnchorForRole(meter, "snare", step));
      if (isAnchor) {
        const reference = Math.max(
          ...references.map((pattern) => pattern[referencePhase(meter, step, length)] ?? 0),
          0,
        );
        if (reference > 0) {
          anchors++;
          if (value > 0) coveredAnchors++;
        }
      }
    }
  }

  const mean = hits.length > 0 ? hits.reduce((sum, value) => sum + value, 0) / hits.length : 0;
  const variance = hits.length > 0 ? hits.reduce((sum, value) => sum + (value - mean) ** 2, 0) / hits.length : 0;
  const stepsPerBar = meter.stepsPerBar;
  const bars = Math.ceil(stepCount / stepsPerBar);
  let repeatedPairs = 0;
  let comparedPairs = 0;
  for (let pad = 0; pad < rows.length; pad++) {
    const row = rows[pad];
    if (!row) continue;
    for (let bar = 1; bar < bars; bar++) {
      comparedPairs++;
      const previous = row.slice((bar - 1) * stepsPerBar, bar * stepsPerBar).join(",");
      const current = row.slice(bar * stepsPerBar, (bar + 1) * stepsPerBar).join(",");
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
