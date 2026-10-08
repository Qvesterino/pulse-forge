import { FEATURE_V2_NAMES } from "./pattern-features-v2";
import type { SongBuildSection } from "../../intent/song";

export const SONG_DRAMATURGY_FEATURE_CONTRACT = {
  version: "song-dramaturgy.v1",
  normalizationId: "song-fixed.v1",
} as const;

export const SONG_DRAMATURGY_FEATURE_NAMES = [
  "form.sectionCount",
  "form.totalBars",
  "form.roleEntropy",
  "form.repeatedAdjacentRoleRate",
  "form.longSectionShare",
  "energy.meanIntensity",
  "energy.range",
  "energy.rise",
  "energy.fall",
  "energy.netProgression",
  "energy.turnRate",
  "density.range",
  "density.volatility",
  "density.netProgression",
  "complexity.range",
  "complexity.volatility",
  "complexity.netProgression",
  "instrumentation.roleCoverage",
  "instrumentation.turnover",
  "instrumentation.breadth",
  "transition.boundaryRate",
  "transition.typeEntropy",
  "transition.meanStrength",
  "sections.patternContrast",
  "sections.patternSimilarity",
  "melody.meanMotifNovelty",
  "melody.meanMotifRepetition",
  "harmony.meanVoicingMovement",
  "harmony.meanHarmonicRhythm",
  "harmony.meanVoiceRichness",
  "harmony.meanChordDensity",
  "harmony.meanBassRootAlignment",
  "harmony.meanRhythmicAlignment",
] as const;

export const SONG_DRAMATURGY_FEATURE_COUNT = SONG_DRAMATURGY_FEATURE_NAMES.length;

export interface SongDramaturgyFeatureVectorV1 {
  version: typeof SONG_DRAMATURGY_FEATURE_CONTRACT.version;
  values: number[];
}

export type SongPreferenceFocus = "overall" | "development" | "transitions" | "contrast" | "harmony" | "sound" | "mix";

export const SONG_PREFERENCE_FOCUS_OPTIONS: readonly {
  value: SongPreferenceFocus;
  label: string;
}[] = [
  { value: "overall", label: "Celkový dojem" },
  { value: "development", label: "Vývoj a energia" },
  { value: "transitions", label: "Prechody" },
  { value: "contrast", label: "Kontrast a opakovanie" },
  { value: "harmony", label: "Harmónia" },
  { value: "sound", label: "Farba zvuku" },
  { value: "mix", label: "Mix a stereo" },
];

export const SONG_FOCUS_FEATURE_INDICES: Readonly<
  Record<Exclude<SongPreferenceFocus, "sound" | "mix">, readonly number[] | null>
> = {
  overall: null,
  development: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
  transitions: [2, 3, 7, 8, 9, 10, 20, 21, 22],
  contrast: [3, 17, 18, 19, 23, 24, 25, 26],
  harmony: [27, 28, 29, 30, 31, 32],
};

const ROLE_COUNT = 10;
const TRANSITION_STRENGTH: Readonly<Record<NonNullable<SongBuildSection["transitionIn"]>, number>> = {
  fill: 0.45,
  riser: 0.8,
  impact: 0.95,
  drop: 0.9,
  break: 0.72,
  custom: 0.5,
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.5));
}

function mean(values: readonly number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0.5;
}

function weightedMean(values: readonly number[], weights: readonly number[]): number {
  let valueSum = 0;
  let weightSum = 0;
  values.forEach((value, index) => {
    const weight = Math.max(0, weights[index] ?? 0);
    valueSum += value * weight;
    weightSum += weight;
  });
  return weightSum > 0 ? valueSum / weightSum : mean(values);
}

function range(values: readonly number[]): number {
  return values.length > 0 ? Math.max(...values) - Math.min(...values) : 0;
}

function volatility(values: readonly number[]): number {
  if (values.length < 2) return 0;
  return mean(values.slice(1).map((value, index) => Math.abs(value - (values[index] ?? value))));
}

function normalizedNetProgression(values: readonly number[]): number {
  if (values.length < 2) return 0.5;
  return clamp01((values[values.length - 1]! - values[0]! + 1) / 2);
}

function turnRate(values: readonly number[]): number {
  if (values.length < 3) return 0;
  const directions = values.slice(1).map((value, index) => Math.sign(value - (values[index] ?? value)));
  let turns = 0;
  let previous = 0;
  for (const direction of directions) {
    if (direction === 0) continue;
    if (previous !== 0 && direction !== previous) turns++;
    previous = direction;
  }
  return clamp01(turns / Math.max(1, directions.length - 1));
}

function entropy(values: readonly string[], categories: number): number {
  if (values.length < 2) return 0;
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  if (counts.size < 2) return 0;
  const raw = [...counts.values()].reduce((sum, count) => {
    const probability = count / values.length;
    return sum - probability * Math.log(probability);
  }, 0);
  return clamp01(raw / Math.log(Math.max(2, categories)));
}

function adjacentJaccardDistance(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  return 1 - intersection / union.size;
}

function featureIndex(name: string): number {
  return FEATURE_V2_NAMES.indexOf(name);
}

function meanSectionFeature(vectors: readonly ArrayLike<number>[], weights: readonly number[], name: string): number {
  const index = featureIndex(name);
  if (index < 0) return 0.5;
  const values = vectors.flatMap((vector, vectorIndex) => {
    const value = vector[index];
    return typeof value === "number" && Number.isFinite(value)
      ? [{ value, weight: Math.max(0, weights[vectorIndex] ?? 0) }]
      : [];
  });
  const totalWeight = values.reduce((sum, item) => sum + item.weight, 0);
  return totalWeight > 0
    ? values.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight
    : values.length > 0
      ? mean(values.map((item) => item.value))
      : 0.5;
}

/**
 * Extract a privacy-safe, fixed-width description of song form and section
 * evolution. This is kept separate from pattern features.v2 so old pattern
 * axes are never silently reinterpreted as arrangement dramaturgy.
 */
export function extractSongDramaturgyFeatures(
  sections: readonly SongBuildSection[],
  sectionFeatureVectors: readonly ArrayLike<number>[],
): SongDramaturgyFeatureVectorV1 {
  const count = sections.length;
  if (count === 0) {
    return {
      version: SONG_DRAMATURGY_FEATURE_CONTRACT.version,
      values: new Array(SONG_DRAMATURGY_FEATURE_COUNT).fill(0.5),
    };
  }
  const bars = sections.map((section) => Math.max(1, Number.isFinite(section.bars) ? section.bars : 1));
  const totalBars = bars.reduce((sum, value) => sum + value, 0);
  const intensities = sections.map((section) => clamp01(section.intensity));
  const densities = sections.map((section) => clamp01(section.densityDelta + 0.5));
  const complexities = sections.map((section) => clamp01(section.complexityDelta + 0.5));
  const roles = sections.map((section) => section.role);
  const actualRoles = sections.map((section) => section.roles);
  const transitions = sections.flatMap((section, index) =>
    index > 0 && section.transitionIn ? [section.transitionIn] : [],
  );
  const boundaryRate = transitions.length / Math.max(1, count - 1);
  const roleCounts = new Map<string, number>();
  for (const role of roles) roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
  const repeatedAdjacentRoleRate =
    count < 2 ? 0 : roles.slice(1).filter((role, index) => role === roles[index]).length / (count - 1);
  const roleCoverage = weightedMean(
    actualRoles.map((sectionRoles) => clamp01(new Set(sectionRoles).size / 4)),
    bars,
  );
  const instrumentationTurnover =
    count < 2
      ? 0
      : mean(
          actualRoles
            .slice(1)
            .map((sectionRoles, index) => adjacentJaccardDistance(actualRoles[index] ?? [], sectionRoles)),
        );
  const roleBreadth = clamp01(new Set(actualRoles.flat()).size / 4);
  const transitionStrength = transitions.length > 0 ? mean(transitions.map((type) => TRANSITION_STRENGTH[type])) : 0;
  const patternContrasts = sectionFeatureVectors.slice(1).map((vector, index) => {
    const previous = sectionFeatureVectors[index];
    if (!previous) return 0;
    const width = Math.min(previous.length, vector.length);
    if (width === 0) return 0;
    let difference = 0;
    for (let feature = 0; feature < width; feature++) {
      difference += Math.abs((previous[feature] ?? 0.5) - (vector[feature] ?? 0.5));
    }
    return difference / width;
  });
  const values = [
    clamp01(count / 12),
    clamp01(totalBars / 64),
    entropy(roles, ROLE_COUNT),
    clamp01(repeatedAdjacentRoleRate),
    clamp01(bars.filter((barCount) => barCount >= 8).reduce((sum, value) => sum + value, 0) / totalBars),
    weightedMean(intensities, bars),
    range(intensities),
    mean(intensities.slice(1).map((value, index) => Math.max(0, value - (intensities[index] ?? value)))),
    mean(intensities.slice(1).map((value, index) => Math.max(0, (intensities[index] ?? value) - value))),
    normalizedNetProgression(intensities),
    turnRate(intensities),
    range(densities),
    volatility(densities),
    normalizedNetProgression(densities),
    range(complexities),
    volatility(complexities),
    normalizedNetProgression(complexities),
    roleCoverage,
    clamp01(instrumentationTurnover),
    roleBreadth,
    clamp01(boundaryRate),
    entropy(transitions, 6),
    clamp01(transitionStrength),
    clamp01(mean(patternContrasts)),
    clamp01(1 - mean(patternContrasts)),
    meanSectionFeature(sectionFeatureVectors, bars, "melodic.motifNovelty"),
    meanSectionFeature(sectionFeatureVectors, bars, "melodic.motifRepetition"),
    meanSectionFeature(sectionFeatureVectors, bars, "harmony.voicingMovement"),
    meanSectionFeature(sectionFeatureVectors, bars, "harmony.harmonicRhythm"),
    meanSectionFeature(sectionFeatureVectors, bars, "harmony.voiceRichness"),
    meanSectionFeature(sectionFeatureVectors, bars, "harmony.chordDensity"),
    meanSectionFeature(sectionFeatureVectors, bars, "bass.rootAlignment"),
    meanSectionFeature(sectionFeatureVectors, bars, "arrangement.rhythmicAlignment"),
  ].map((value) => Math.round(clamp01(value) * 10_000) / 10_000);
  return { version: SONG_DRAMATURGY_FEATURE_CONTRACT.version, values };
}

export function isSongDramaturgyFeatureVector(value: unknown): value is SongDramaturgyFeatureVectorV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === SONG_DRAMATURGY_FEATURE_CONTRACT.version &&
    Array.isArray(record.values) &&
    record.values.length === SONG_DRAMATURGY_FEATURE_COUNT &&
    record.values.every(
      (feature) => typeof feature === "number" && Number.isFinite(feature) && feature >= 0 && feature <= 1,
    )
  );
}

export function cloneSongDramaturgyFeatureVector(vector: SongDramaturgyFeatureVectorV1): SongDramaturgyFeatureVectorV1 {
  return { version: vector.version, values: [...vector.values] };
}
