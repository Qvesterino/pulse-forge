import type { StepMeta } from "../project-model/types";
import type { GenerateOptions, GrooveData, VelocityLevel } from "./types";
import { generatePadSequence, dequantizeVelocity, getGroovePadModel } from "./markov";
import { canRatchet, ghostMultiplier, inferPadRole, type PadRole } from "./pad-roles";
import { applyPhraseDynamics, buildPhrasePlan } from "./phrase";
import { enforceDrumAnchors, repairDrumRow } from "./quality";
import { enforceSyncopationBudget } from "./style-quality";

export interface DrumRandomStreams {
  variation?: () => number;
  meta?: () => number;
  swing?: number;
  /** SubSeed locks — skip generation for these pad indices, copy prev instead (preserves RNG for others). */
  lockedIndices?: Set<number>;
  prevRows?: Map<number, number[]>;
  prevMeta?: Map<number, Map<number, StepMeta>>;
}

/**
 * Box-Muller transform: convert uniform random to Gaussian (normal distribution).
 * Returns a value centered at 0 with stddev=1, clamped to [-3, 3].
 */
function gaussianRand(rand: () => number): number {
  let u = 0,
    v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(-3, Math.min(3, z)); // clamp to ±3σ
}

/**
 * Apply groove swing to step meta: odd-numbered active steps get a positive
 * microtiming offset (delayed) proportional to groove.swing.
 */
function applySwingToMeta(row: number[], padMeta: Map<number, StepMeta>, swing: number): void {
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

/** Prune or densify a row to match density intent (0 sparse → 1 dense). */
function pruneOrDensifyRow(row: number[], density: number | null, rand: () => number, allowGhosts = true): void {
  if (density == null) return;
  // Neutral 0.45–0.55 → no change (preserve golden)
  if (density >= 0.45 && density <= 0.55) return;
  const hits = row.map((v, i) => (v > 0 ? { i, v } : null)).filter(Boolean) as { i: number; v: number }[];
  if (hits.length === 0) return;
  if (density < 0.45) {
    // Sparse: prune weakest hits (20–40% at density 0.2)
    const pruneFrac = (0.5 - density) * 0.8; // 0.5→0, 0.2→0.24
    const toPrune = Math.floor(hits.length * pruneFrac);
    if (toPrune <= 0) return;
    const sorted = [...hits].sort((a, b) => a.v - b.v);
    for (let k = 0; k < toPrune; k++) {
      const pick = sorted[k];
      // Keep anchors (downbeats) 50% of the time even when sparse
      if (pick.i % 4 === 0 && rand() < 0.5) continue;
      row[pick.i] = 0;
    }
  } else if (density > 0.55 && allowGhosts) {
    // Dense: add ghost-like hits in gaps near existing hits
    const addFrac = (density - 0.5) * 0.6; // 0.6→0.06, 0.9→0.24
    for (let i = 0; i < row.length; i++) {
      if (row[i] > 0) continue;
      const hasNeighbor = (i > 0 && row[i - 1] > 0) || (i < row.length - 1 && row[i + 1] > 0);
      if (!hasNeighbor) continue;
      if (rand() < addFrac * 0.5) row[i] = 0.18 + rand() * 0.12;
    }
  }
}

/** Generate drum rows and step meta from a groove */
export function generateDrumPattern(
  groove: GrooveData,
  options: GenerateOptions,
  rand: () => number,
  streams: DrumRandomStreams = {},
  padNames?: readonly string[],
): { rows: number[][]; meta: Map<number, Map<number, StepMeta>> } {
  const diceDensity = (options as GenerateOptions & { _diceDensity?: number })._diceDensity ?? null;
  const diceComplexity = (options as GenerateOptions & { _diceComplexity?: number })._diceComplexity ?? null;
  const rows: number[][] = [];
  const meta = new Map<number, Map<number, StepMeta>>();
  const bars = Math.ceil(options.stepCount / 16);
  const variationRand = streams.variation ?? rand;
  const metaRand = streams.meta ?? rand;
  const phrasePlan = buildPhrasePlan(options.stepCount);

  for (const padIndex of groove.activePads) {
    // SubSeed lock: skip generation entirely, preserve RNG for others
    if (streams.lockedIndices?.has(padIndex)) {
      const prev = streams.prevRows?.get(padIndex);
      if (prev) {
        const sliced = prev.slice(0, options.stepCount);
        while (sliced.length < options.stepCount) sliced.push(0);
        rows[padIndex] = sliced;
      } else {
        rows[padIndex] = new Array(options.stepCount).fill(0);
      }
      const prevM = streams.prevMeta?.get(padIndex);
      if (prevM && prevM.size > 0) meta.set(padIndex, new Map(prevM));
      continue;
    }
    const role = inferPadRole(padNames?.[padIndex], padIndex);
    const cachedPad = getGroovePadModel(groove, padIndex);
    const padPatterns = cachedPad.patterns;
    const model = cachedPad.model;

    // Generate base 16-step sequence
    const baseSequence = generatePadSequence(model, 16, rand, options.temperature);

    // Extend to full stepCount with bar-level variation (dice complexity/variation widens it)
    const barVarChance = diceComplexity != null ? 0.08 + diceComplexity * 0.22 : 0.15; // 0.08 sparse → 0.30 dense
    const fullSequence: number[] = [];
    for (let bar = 0; bar < bars; bar++) {
      for (let step = 0; step < 16 && fullSequence.length < options.stepCount; step++) {
        let level = baseSequence[step];
        if (bar > 0 && level > 0 && variationRand() < barVarChance) {
          level = Math.max(0, Math.min(3, level + (variationRand() < 0.5 ? 1 : -1)));
        }
        fullSequence.push(level);
      }
    }

    // Convert to velocities
    const velocities = fullSequence.map((level) => {
      if (level === 0) return 0;
      let velocity = dequantizeVelocity(level as VelocityLevel, rand);
      velocity += (rand() - 0.5) * options.velocityVariation * 0.3;
      return Math.max(0.1, Math.min(1, velocity));
    });

    rows[padIndex] = velocities;

    // Ghosts are an explicit intent constraint, not just a stylistic hint.
    if (options.constraints?.allowGhosts !== false) {
      addGhostNotes(rows, padIndex, role, options, variationRand);
    }

    // Dice density: prune or densify before anchors (keeps anchors intact after)
    pruneOrDensifyRow(rows[padIndex], diceDensity, variationRand, options.constraints?.allowGhosts !== false);

    // Add fill variation at phrase boundaries (every 4 bars)
    addFillVariation(
      rows[padIndex],
      padIndex,
      options.ghostWeight,
      variationRand,
      4,
      options.constraints?.allowGhosts !== false,
    );

    // Keep genre/style anchors before phrase dynamics are applied.
    if (options.constraints?.preserveAnchors !== false) {
      enforceDrumAnchors(rows[padIndex], padPatterns, role);
    }
    // Complexity relaxes syncopation budget (more off-beat allowed)
    if (diceComplexity == null || diceComplexity < 0.65) {
      enforceSyncopationBudget(rows[padIndex], padPatterns, role);
    }
    applyPhraseDynamics(rows[padIndex], role, phrasePlan, variationRand);

    // Apply phrase-level velocity contour (2-bar sine envelope)
    applyPhraseContour(rows[padIndex], 0.15);
    rows[padIndex] = repairDrumRow(rows[padIndex], options.stepCount);

    // Add step meta
    const padMeta = addStepMeta(rows[padIndex], role, options, metaRand);

    // Swing has one owner: project-level groove settings when requested,
    // otherwise pattern-local metadata carries the groove feel.
    applySwingToMeta(
      rows[padIndex],
      padMeta,
      options.constraints?.allowSwing === false
        ? 0
        : (streams.swing ?? (options.applyGrooveSettings ? 0 : groove.swing)),
    );

    if (padMeta.size > 0) {
      meta.set(padIndex, padMeta);
    }
  }

  return { rows, meta };
}

/** Add ghost notes (low-velocity hits) on empty steps near active hits */
function addGhostNotes(
  rows: number[][],
  padIndex: number,
  role: PadRole,
  options: GenerateOptions,
  rand: () => number,
): void {
  const row = rows[padIndex];
  if (!row) return;

  for (let i = 0; i < row.length; i++) {
    if (row[i] > 0) continue;

    // Check neighbors within ±2 steps
    const prev1 = i > 0 && row[i - 1] > 0;
    const next1 = i < row.length - 1 && row[i + 1] > 0;
    const prev2 = i > 1 && row[i - 2] > 0;
    const next2 = i < row.length - 2 && row[i + 2] > 0;

    const adjacentCount = (prev1 ? 1 : 0) + (next1 ? 1 : 0) + (prev2 ? 1 : 0) + (next2 ? 1 : 0);

    if (adjacentCount === 0) continue;

    // Probability scales with number of active neighbors
    // 1 neighbor: base chance, 2+: higher chance
    const probability =
      (adjacentCount >= 2 ? options.ghostWeight * 0.5 : options.ghostWeight * 0.2) * ghostMultiplier(role);

    if (rand() < probability) {
      // Velocity slightly higher when more neighbors are active
      const baseVelocity = 0.15 + rand() * 0.15; // 0.15 - 0.30
      row[i] = Math.min(0.35, baseVelocity + adjacentCount * 0.03);
    }
  }
}

/** Add microtiming jitter and probability to step meta */
function addStepMeta(
  row: number[],
  role: PadRole,
  options: GenerateOptions,
  rand: () => number,
): Map<number, StepMeta> {
  const diceComplexity = (options as GenerateOptions & { _diceComplexity?: number })._diceComplexity ?? null;
  const ratchetChance = diceComplexity != null ? 0.02 + diceComplexity * 0.12 : 0.04; // 0.02 sparse → 0.14 dense
  const probChance = diceComplexity != null ? 0.04 + diceComplexity * 0.08 : 0.08; // more human variation when complex
  const padMeta = new Map<number, StepMeta>();

  for (let i = 0; i < row.length; i++) {
    if (row[i] <= 0) continue;

    const meta: StepMeta = {};
    let hasChanges = false;

    if (rand() < options.microWeight) {
      const jitter = gaussianRand(rand) * 0.12;
      if (Math.abs(jitter) > 0.03) {
        meta.microtiming = Math.round(jitter * 100) / 100;
        hasChanges = true;
      }
    }

    if (rand() < probChance) {
      meta.probability = 0.6 + rand() * 0.3;
      hasChanges = true;
    }

    if (canRatchet(role) && rand() < ratchetChance) {
      meta.ratchet = 2 + Math.floor(rand() * 3);
      hasChanges = true;
    }

    if (hasChanges) {
      padMeta.set(i, meta);
    }
  }

  return padMeta;
}

/**
 * Apply phrase-level velocity contour: a sine wave envelope over each 2-bar
 * phrase that peaks at the midpoint, creating natural dynamic shaping.
 */
function applyPhraseContour(row: number[], depth: number): void {
  if (depth <= 0) return;
  const phraseLen = 32; // 2 bars
  for (let i = 0; i < row.length; i++) {
    if (row[i] <= 0) continue;
    const posInPhrase = (i % phraseLen) / phraseLen;
    const envelope = Math.sin(posInPhrase * Math.PI); // peaks at midpoint
    const scale = 1 - depth * (1 - envelope);
    row[i] = Math.max(0.1, Math.min(1, row[i] * scale));
  }
}

/**
 * Add fill variation at phrase boundaries: every fillBars bars, boost
 * velocities and add ghost notes in the last 4 steps to simulate a fill.
 */
function addFillVariation(
  row: number[],
  _padIndex: number,
  ghostWeight: number,
  rand: () => number,
  fillBars: number,
  allowGhosts = true,
): void {
  if (!row) return;
  for (let bar = fillBars - 1; bar * 16 < row.length; bar += fillBars) {
    const fillStart = bar * 16;
    const fillEnd = Math.min(fillStart + 16, row.length);
    // Last 4 steps of each fill phrase
    for (let i = Math.max(fillStart, fillEnd - 4); i < fillEnd; i++) {
      if (row[i] > 0) {
        row[i] = Math.min(1, row[i] + 0.1 + rand() * 0.1); // boost existing hits
      } else if (allowGhosts && rand() < ghostWeight * 0.6) {
        row[i] = 0.2 + rand() * 0.15; // add ghost notes
      }
    }
  }
}
