import type { StepMeta } from '../project-model/types';
import type { GenerateOptions, GrooveData, VelocityLevel } from './types';
import { buildPadModel, generatePadSequence, dequantizeVelocity } from './markov';

/**
 * Apply groove swing to step meta: odd-numbered active steps get a positive
 * microtiming offset (delayed) proportional to groove.swing. This bakes the
 * swing feel into the pattern itself so it sounds correct even if the project
 * groove is set to 0.
 */
function applySwingToMeta(
  row: number[],
  padMeta: Map<number, StepMeta>,
  swing: number,
): void {
  if (swing <= 0) return;
  // Swing is expressed as a fraction of a step: 0..1 → 0..0.5 steps delay
  // on odd 16th notes. We encode this as microtiming in range -1..1 where
  // +1 = one full step late. So swing of 0.3 → microtiming = 0.3 * 0.5 = 0.15.
  const swingMicro = swing * 0.5;
  for (let i = 0; i < row.length; i++) {
    if (row[i] <= 0) continue;
    if (i % 2 !== 1) continue; // only odd steps

    const existing = padMeta.get(i);
    const existingMicro = existing?.microtiming ?? 0;
    // Add swing on top of any existing microtiming (don't overwrite)
    const newMicro = Math.max(-1, Math.min(1, existingMicro + swingMicro));
    const rounded = Math.round(newMicro * 100) / 100;
    if (rounded !== 0) {
      padMeta.set(i, { ...existing, microtiming: rounded });
    } else if (existing) {
      padMeta.set(i, existing);
    }
  }
}

/** Generate drum rows and step meta from a groove */
export function generateDrumPattern(
  groove: GrooveData,
  options: GenerateOptions,
  rand: () => number,
): { rows: number[][]; meta: Map<number, Map<number, StepMeta>> } {
  const rows: number[][] = [];
  const meta = new Map<number, Map<number, StepMeta>>();

  for (const padIndex of groove.activePads) {
    // Extract this pad's patterns from the groove data
    const padPatterns: number[][] = groove.patterns.map(p => (p[padIndex] as number[] | undefined) ?? new Array(16).fill(0) as number[]);

    // Build Markov model for this pad
    const model = buildPadModel(padIndex, padPatterns);

    // Generate the sequence
    const sequence = generatePadSequence(model, options.stepCount, rand);

    // Convert quantized levels to musical velocities
    const velocities = sequence.map((level) => {
      if (level === 0) return 0;
      let velocity = dequantizeVelocity(level as VelocityLevel, rand);
      // Apply velocity variation
      velocity += (rand() - 0.5) * options.velocityVariation * 0.3;
      return Math.max(0.1, Math.min(1, velocity));
    });

    rows[padIndex] = velocities;

    // Add ghost notes on empty steps adjacent to hits
    addGhostNotes(rows, padIndex, options, rand);

    // Add microtiming and probability metadata
    const padMeta = addStepMeta(rows[padIndex], padIndex, options, rand);

    // Apply groove swing to odd-numbered active steps
    applySwingToMeta(rows[padIndex], padMeta, groove.swing);

    if (padMeta.size > 0) {
      meta.set(padIndex, padMeta);
    }
  }

  return { rows, meta };
}

/** Add ghost notes (low-velocity hits) on empty steps next to active hits */
function addGhostNotes(
  rows: number[][],
  padIndex: number,
  options: GenerateOptions,
  rand: () => number,
): void {
  const row = rows[padIndex];
  if (!row) return;

  for (let i = 0; i < row.length; i++) {
    if (row[i] > 0) continue;

    // Check if adjacent to an active hit
    const prevActive = i > 0 && row[i - 1] > 0;
    const nextActive = i < row.length - 1 && row[i + 1] > 0;

    if ((prevActive || nextActive) && rand() < options.ghostWeight * 0.3) {
      row[i] = 0.15 + rand() * 0.15; // 0.15 - 0.30 velocity
    }
  }
}

/** Add microtiming jitter and probability to step meta */
function addStepMeta(
  row: number[],
  padIndex: number,
  options: GenerateOptions,
  rand: () => number,
): Map<number, StepMeta> {
  const padMeta = new Map<number, StepMeta>();

  for (let i = 0; i < row.length; i++) {
    if (row[i] <= 0) continue;

    const meta: StepMeta = {};
    let hasChanges = false;

    // Microtiming jitter
    if (rand() < options.microWeight) {
      const jitter = (rand() - 0.5) * 0.4;
      if (Math.abs(jitter) > 0.05) {
        meta.microtiming = Math.round(jitter * 100) / 100;
        hasChanges = true;
      }
    }

    // Low probability for some hits (creates variation across passes)
    if (rand() < 0.08) {
      meta.probability = 0.6 + rand() * 0.3; // 0.6 - 0.9
      hasChanges = true;
    }

    // Occasional ratchet on hat/percussion
    if ((padIndex === 8 || padIndex === 7 || padIndex === 14) && rand() < 0.04) {
      meta.ratchet = 2;
      hasChanges = true;
    }

    if (hasChanges) {
      padMeta.set(i, meta);
    }
  }

  return padMeta;
}
