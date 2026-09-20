import type { GrooveData } from "./types";
import type { PadRole } from "./pad-roles";

export interface StyleQualityProfile {
  densityRange: readonly [number, number];
  syncopationRange: readonly [number, number];
  maxDistance: number;
}

export interface StyleDistanceMetrics {
  density: number;
  syncopation: number;
  downbeatRatio: number;
  velocityMean: number;
}

export interface StyleGateResult {
  accepted: boolean;
  distance: number;
  profile: StyleQualityProfile;
  metrics: StyleDistanceMetrics;
  reasons: string[];
}

const GENRE_PROFILES: Record<GrooveData["genre"], StyleQualityProfile> = {
  house: { densityRange: [0.14, 0.72], syncopationRange: [0.12, 0.58], maxDistance: 0.95 },
  techno: { densityRange: [0.12, 0.66], syncopationRange: [0.06, 0.42], maxDistance: 0.95 },
  trap: { densityRange: [0.1, 0.7], syncopationRange: [0.18, 0.72], maxDistance: 1.05 },
  ambient: { densityRange: [0.06, 0.64], syncopationRange: [0.08, 0.78], maxDistance: 1.15 },
  // Drill/phonk sit in the trap family: sparse-but-syncopated kick patterns,
  // generous syncopation tolerance for sliding 808s and memphis swing.
  drill: { densityRange: [0.1, 0.68], syncopationRange: [0.18, 0.76], maxDistance: 1.05 },
  phonk: { densityRange: [0.1, 0.72], syncopationRange: [0.16, 0.74], maxDistance: 1.1 },
  // Jersey: busy bouncy club patterns; DnB: syncopated two-step breaks.
  jersey: { densityRange: [0.14, 0.8], syncopationRange: [0.16, 0.72], maxDistance: 1.0 },
  dnb: { densityRange: [0.12, 0.82], syncopationRange: [0.2, 0.85], maxDistance: 1.1 },
};

const STYLE_OVERRIDES: Record<string, Partial<StyleQualityProfile>> = {
  minimal: { densityRange: [0.06, 0.46], maxDistance: 1.05 },
  // Multi-bar driving phrases intentionally thin out in drop/outro bars.
  driving: { densityRange: [0.08, 0.78], syncopationRange: [0.08, 0.68] },
  rolling: { densityRange: [0.1, 0.78], syncopationRange: [0.16, 0.82], maxDistance: 1.1 },
  glitch: { densityRange: [0.08, 0.82], syncopationRange: [0.1, 0.9], maxDistance: 1.2 },
  drifting: { densityRange: [0.04, 0.68], syncopationRange: [0.04, 0.84] },
  deep: { densityRange: [0.08, 0.62], syncopationRange: [0.1, 0.7], maxDistance: 1.05 },
  funky: { densityRange: [0.12, 0.78], syncopationRange: [0.16, 0.82], maxDistance: 1.1 },
  "uk garage": { densityRange: [0.12, 0.84], syncopationRange: [0.18, 0.88], maxDistance: 1.1 },
  "afro house": { densityRange: [0.12, 0.82], syncopationRange: [0.14, 0.86], maxDistance: 1.1 },
  classic: { densityRange: [0.08, 0.72], syncopationRange: [0.14, 0.76] },
  sparse: { densityRange: [0.04, 0.5], syncopationRange: [0.08, 0.72], maxDistance: 1.1 },
  bouncy: { densityRange: [0.12, 0.8], syncopationRange: [0.15, 0.82], maxDistance: 1.1 },
  industrial: { densityRange: [0.16, 0.84], syncopationRange: [0.04, 0.55], maxDistance: 1.05 },
  dub: { densityRange: [0.08, 0.6], syncopationRange: [0.05, 0.7], maxDistance: 1.05 },
  acid: { densityRange: [0.14, 0.78], syncopationRange: [0.1, 0.76], maxDistance: 1.05 },
  "tech house": { densityRange: [0.12, 0.82], syncopationRange: [0.1, 0.78], maxDistance: 1.1 },
  "ambient techno": { densityRange: [0.08, 0.7], syncopationRange: [0.06, 0.82], maxDistance: 1.15 },
  "lo-fi trap": { densityRange: [0.08, 0.62], syncopationRange: [0.16, 0.78], maxDistance: 1.15 },
  organic: { densityRange: [0.06, 0.68], syncopationRange: [0.12, 0.86], maxDistance: 1.15 },
};

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Weight an off-grid 16th more strongly when it follows an empty step. */
export function syncopationWeight(step: number): number {
  const position = ((step % 16) + 16) % 16;
  if (position % 4 === 0) return 0;
  if (position % 2 === 0) return 0.35;
  return 1;
}

function isAnchor(role: PadRole, step: number): boolean {
  return (role === "kick" && step % 4 === 0) || ((role === "snare" || role === "clap") && step % 8 === 4);
}

function referenceAt(references: readonly number[][], step: number): number {
  return Math.max(...references.map((pattern) => pattern[step % 16] ?? 0), 0);
}

function rowMetrics(rows: readonly (number[] | undefined)[], stepCount: number): StyleDistanceMetrics {
  const activeRows = rows.filter((row): row is number[] => Boolean(row));
  let hits = 0;
  let syncHits = 0;
  let downbeats = 0;
  let velocityTotal = 0;
  for (const row of activeRows) {
    for (let step = 0; step < stepCount; step++) {
      const velocity = row[step] ?? 0;
      if (velocity <= 0) continue;
      hits++;
      velocityTotal += velocity;
      syncHits += syncopationWeight(step);
      if (step % 4 === 0) downbeats++;
    }
  }
  const denominator = Math.max(1, activeRows.length * stepCount);
  return {
    density: round(hits / denominator),
    syncopation: round(hits > 0 ? syncHits / hits : 0),
    downbeatRatio: round(hits > 0 ? downbeats / hits : 0),
    velocityMean: round(hits > 0 ? velocityTotal / hits : 0),
  };
}

function referenceMetrics(groove: GrooveData, stepCount: number): StyleDistanceMetrics {
  const rows = groove.activePads.map((padIndex) => {
    const row = new Array<number>(stepCount).fill(0);
    for (let step = 0; step < stepCount; step++) {
      row[step] = referenceAt(
        groove.patterns.map((pattern) => pattern[padIndex] ?? []),
        step,
      );
    }
    return row;
  });
  return rowMetrics(rows, stepCount);
}

export function getStyleQualityProfile(genre: GrooveData["genre"], style?: string): StyleQualityProfile {
  const base = GENRE_PROFILES[genre];
  const override = style ? STYLE_OVERRIDES[style.trim().toLowerCase()] : undefined;
  return {
    densityRange: override?.densityRange ?? base.densityRange,
    syncopationRange: override?.syncopationRange ?? base.syncopationRange,
    maxDistance: override?.maxDistance ?? base.maxDistance,
  };
}

/** Compare a generated result with the style's reference envelope. */
export function evaluateStyleDistance(
  groove: GrooveData,
  rows: readonly (number[] | undefined)[],
  stepCount: number,
): StyleGateResult {
  const profile = getStyleQualityProfile(groove.genre, groove.name);
  // Defensive sanitization: NaN/Infinity velocities propagate to the distance
  // metric through density / syncopation / velocityMean arithmetic.
  const safeRows = rows.map((row) =>
    row ? row.map((value) => (Number.isFinite(value) && value > 0 ? value : 0)) : row,
  );
  const metrics = rowMetrics(safeRows, stepCount);
  const reference = referenceMetrics(groove, stepCount);
  // NaN guard: a non-finite stepCount (e.g. NaN, Infinity) propagates through
  // density/syncopation/velocityMean arithmetic and yields NaN distance metrics.
  // Coerce each side to a finite scalar before subtracting so the result is
  // well-defined even on degenerate inputs.
  const safeSub = (a: number, b: number): number => {
    const sa = Number.isFinite(a) ? a : 0;
    const sb = Number.isFinite(b) ? b : 0;
    return Math.abs(sa - sb);
  };
  const densityDistance = safeSub(metrics.density, reference.density) / Math.max(0.08, safeSub(0, reference.density));
  const syncDistance = safeSub(metrics.syncopation, reference.syncopation) / 0.5;
  const downbeatDistance = safeSub(metrics.downbeatRatio, reference.downbeatRatio) / 0.5;
  const velocityDistance = safeSub(metrics.velocityMean, reference.velocityMean);
  const distance = round(densityDistance * 0.4 + syncDistance * 0.3 + downbeatDistance * 0.2 + velocityDistance * 0.1);
  const reasons: string[] = [];
  if (metrics.density < profile.densityRange[0] || metrics.density > profile.densityRange[1]) {
    reasons.push("density-out-of-range");
  }
  if (metrics.syncopation < profile.syncopationRange[0] || metrics.syncopation > profile.syncopationRange[1]) {
    reasons.push("syncopation-out-of-range");
  }
  if (distance > profile.maxDistance) reasons.push("style-distance-too-large");

  return { accepted: reasons.length === 0, distance, profile, metrics, reasons };
}

interface SyncopationBudget {
  min: number;
  max: number;
}

function budgetForRole(role: PadRole): SyncopationBudget {
  switch (role) {
    case "kick":
      return { min: 0, max: 0.28 };
    case "snare":
    case "clap":
      return { min: 0.03, max: 0.38 };
    case "closedHat":
      return { min: 0.2, max: 0.82 };
    case "openHat":
    case "perc":
      return { min: 0.12, max: 0.72 };
    case "tom":
      return { min: 0.04, max: 0.55 };
    default:
      return { min: 0.05, max: 0.7 };
  }
}

function rowSyncopation(row: readonly number[]): number {
  let hits = 0;
  let weighted = 0;
  for (let step = 0; step < row.length; step++) {
    if ((row[step] ?? 0) <= 0) continue;
    hits++;
    weighted += syncopationWeight(step);
  }
  return hits > 0 ? weighted / hits : 0;
}

/** Keep ornamentation inside a role-specific syncopation budget. */
export function enforceSyncopationBudget(row: number[], references: readonly number[][], role: PadRole): void {
  const budget = budgetForRole(role);
  let score = rowSyncopation(row);

  if (score > budget.max) {
    const candidates = row
      .map((velocity, step) => ({ velocity, step, weight: syncopationWeight(step) }))
      .filter((candidate) => candidate.velocity > 0 && candidate.weight > 0 && !isAnchor(role, candidate.step))
      .sort((a, b) => a.velocity - b.velocity || b.weight - a.weight || b.step - a.step);
    for (const candidate of candidates) {
      row[candidate.step] = 0;
      score = rowSyncopation(row);
      if (score <= budget.max) break;
    }
  }

  if (score < budget.min) {
    const candidates = row
      .map((velocity, step) => ({
        velocity,
        step,
        reference: referenceAt(references, step),
        weight: syncopationWeight(step),
      }))
      .filter(
        (candidate) =>
          candidate.velocity <= 0 &&
          candidate.reference > 0 &&
          candidate.weight > 0.5 &&
          !isAnchor(role, candidate.step),
      )
      .sort((a, b) => b.reference - a.reference || b.weight - a.weight || a.step - b.step);
    for (const candidate of candidates) {
      row[candidate.step] = Math.max(0.1, Math.min(1, candidate.reference * 0.55));
      score = rowSyncopation(row);
      if (score >= budget.min) break;
    }
  }
}
