import type { GenerateOptions, GrooveData } from "../types";
import type { IntentSpec } from "../../intent/types";
import type { NoteEvent, Pattern, ProjectDocument } from "../../project-model/types";
import { measureDrumQuality, measureMelodicQuality } from "../quality";
import { evaluateStyleDistance } from "../style-quality";
import { inferPadRole, type PadRole } from "../pad-roles";
import { resolveGrooveForGeneration } from "../generator";

/**
 * features.v1 — the fixed, versioned feature contract for the Intent Engine
 * ranker (docs/intent-engine-ai-ranker-goal.md, Fáza 0/1).
 *
 * Contract rules (all enforced here):
 * - FIXED feature order — the model consumes values positionally, never by
 *   dynamically sorted keys. `FEATURE_NAMES` is the single source of truth.
 * - Every value is a finite number clipped to [0, 1] (fixed normalization
 *   constants only — never batch-relative min/max, except the four
 *   explicitly batch-relative features which compare against the batch mean
 *   and are themselves clamped to [-1, 1]·0.5+0.5 style encoding).
 * - NaN/Infinity/missing inputs fall back deterministically (0.5 = "neutral"
 *   for fits, 0 = "absent" for measurements — presence flags disambiguate).
 * - Pure function: same project + pattern + intent + engine version ⇒ same
 *   vector. No RNG, no audio engine, no DOM, no network.
 */

export const FEATURE_CONTRACT = {
  version: "features.v1",
  /** Fixed normalization constants id — never batch-normalized. */
  normalizationId: "norm.fixed.v1",
} as const;

/** Extractor inputs — everything deterministic, nothing stateful. */
export interface PatternFeatureInput {
  doc: ProjectDocument;
  pattern: Pattern;
  intent: IntentSpec;
  options: GenerateOptions;
  /** BPM the plan resolved (scene/groove aware); null = project tempo. */
  resolvedBpm: number | null;
  /** Other candidates in the batch (for candidate-relative features). */
  batch?: readonly Pattern[];
}

export interface PatternFeatureVector {
  version: "features.v1";
  values: Float32Array;
  names: readonly string[];
  finite: boolean;
  clippedCount: number;
  /** UUID-free content hash of the feature values (diagnostics + golden fixtures). */
  featureHash: string;
}

/* ────────────────────────── feature names (fixed order) ────────────────────────── */

export const FEATURE_NAMES: readonly string[] = [
  // intent fit (8)
  "intent.densityFit",
  "intent.energyFit",
  "intent.complexityFit",
  "intent.variationFit",
  "intent.lengthFit",
  "intent.bpmInRange",
  "intent.rolesDrumsPresent",
  "intent.rolesMelodicPresent",
  // drum structure (8)
  "drums.density",
  "drums.rowCoverage",
  "drums.downbeatCoverage",
  "drums.backbeatCoverage",
  "drums.anchorCoverage",
  "drums.roleBalance",
  "drums.hatEvenness",
  "drums.ghostRatio",
  // drum groove (6)
  "drums.syncopation",
  "drums.offbeatRatio",
  "drums.styleDistanceFit",
  "drums.barRepetition",
  "drums.velocitySpread",
  "drums.microtimingPresence",
  // melodic structure (10)
  "melodic.noteDensity",
  "melodic.restRatio",
  "melodic.pitchRange",
  "melodic.pitchMean",
  "melodic.durationShort",
  "melodic.durationMedium",
  "melodic.durationLong",
  "melodic.roleBalance",
  "melodic.scaleValidity",
  "melodic.occupiedSteps",
  // melodic motif (6)
  "melodic.motifRepetition",
  "melodic.motifNovelty",
  "melodic.intervalVariety",
  "melodic.repeatedDurations",
  "melodic.phraseContinuity",
  "melodic.longestGap",
  // musical validity (6)
  "valid.timingGrid",
  "valid.pitchBounds",
  "valid.noteOverlap",
  "valid.rowShape",
  "valid.stepMetaBounds",
  "valid.metadataCoverage",
  // candidate-relative (4) — deviation from batch mean, clamped, 0.5 = at mean
  "rel.densityDeviation",
  "rel.energyDeviation",
  "rel.styleDeviation",
  "rel.anchorDeviation",
  // presence flags (6) — 1 = absent/neutral, disambiguates true zeros
  "flags.drumsAbsent",
  "flags.melodicAbsent",
  "flags.stepMetaAbsent",
  "flags.keyAbsent",
  "flags.notesEmpty",
  "flags.patternEmpty",
] as const;

export const FEATURE_COUNT = FEATURE_NAMES.length;

/* ────────────────────────── small pure helpers ────────────────────────── */

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Finite-or-fallback, then clipped to [0, 1]. Returns [value, wasClipped]. */
function unit(value: number | undefined, fallback: number): [number, boolean] {
  const base = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const clamped = clamp01(base);
  return [clamped, clamped !== base];
}

function mean(values: readonly number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

/** Shannon-style balance of a set of shares (1 = perfectly even). */
function balance(shares: readonly number[]): number {
  const total = shares.reduce((sum, value) => sum + value, 0);
  if (total <= 0 || shares.length <= 1) return 0;
  let entropy = 0;
  for (const share of shares) {
    if (share <= 0) continue;
    const p = share / total;
    entropy -= p * Math.log2(p);
  }
  return entropy / Math.log2(shares.length);
}

/** FNV-1a over the rounded feature values — UUID-free, deterministic. */
function hashValues(values: ArrayLike<number>): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    const rounded = Math.round(value * 10_000);
    const bytes = [
      rounded & 0xff,
      (rounded >> 8) & 0xff,
      (rounded >> 16) & 0xff,
      (rounded >> 24) & 0xff,
    ];
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, "0");
}

/* ────────────────────────── extraction context ────────────────────────── */

interface DrumStats {
  present: boolean;
  rows: number[][];
  roles: PadRole[];
  activeRows: number;
  hits: number;
  cells: number;
  density: number;
  velocityMean: number;
  velocities: number[];
  ghosts: number;
  metaEntries: number;
  downbeatCovered: number;
  downbeatTotal: number;
  backbeatCovered: number;
  backbeatTotal: number;
  offbeats: number;
  microtimed: number;
}

function drumStats(doc: ProjectDocument, pattern: Pattern, options: GenerateOptions): DrumStats {
  const drumTrack = doc.tracks.find(
    (track) => track.id === options.drumTrackId && track.kind === "drum",
  ) ?? doc.tracks.find((track) => track.kind === "drum");
  const stats: DrumStats = {
    present: false,
    rows: [],
    roles: [],
    activeRows: 0,
    hits: 0,
    cells: 0,
    density: 0,
    velocityMean: 0,
    velocities: [],
    ghosts: 0,
    metaEntries: 0,
    downbeatCovered: 0,
    downbeatTotal: 0,
    backbeatCovered: 0,
    backbeatTotal: 0,
    offbeats: 0,
    microtimed: 0,
  };
  if (!drumTrack || drumTrack.kind !== "drum") return stats;
  const stepCount = options.stepCount;
  for (const [index, pad] of drumTrack.pads.entries()) {
    const row = pattern.rows[pad.id];
    const role = inferPadRole(pad.name, index);
    stats.roles.push(role);
    if (!row) continue;
    stats.rows.push(row);
    let rowHits = 0;
    for (let step = 0; step < stepCount; step++) {
      const value = row[step] ?? 0;
      stats.cells += 1;
      if (value <= 0) continue;
      rowHits += 1;
      stats.velocities.push(value);
      if (step % 4 === 0) stats.offbeats += role === "closedHat" || role === "openHat" ? 1 : 0;
      if (step % 2 === 1) stats.offbeats += role === "closedHat" ? 1 : 0;
      const meta = pattern.stepMeta?.[pad.id]?.[step];
      if (meta) {
        stats.metaEntries += 1;
        if ((meta.microtiming ?? 0) !== 0) stats.microtimed += 1;
        if ((meta.probability ?? 1) < 0.5 || value < 0.45) stats.ghosts += 1;
      }
      if (value > 0 && (role === "kick" || role === "snare" || role === "clap")) {
        if (step % 16 === 0 || step % 16 === 8) {
          stats.downbeatTotal += role === "kick" ? 1 : 0;
          stats.downbeatCovered += role === "kick" ? 1 : 0;
        }
        if (step % 16 === 4 || step % 16 === 12) {
          stats.backbeatTotal += role === "snare" || role === "clap" ? 1 : 0;
          stats.backbeatCovered += (role === "snare" || role === "clap") && value > 0 ? 1 : 0;
        }
      }
    }
    stats.hits += rowHits;
    if (rowHits > 0) stats.activeRows += 1;
  }
  stats.present = stats.rows.length > 0;
  stats.density = stats.cells > 0 ? stats.hits / stats.cells : 0;
  stats.velocityMean = mean(stats.velocities);
  return stats;
}

interface MelodicStats {
  present: boolean;
  notes: NoteEvent[];
  perTrackShares: number[];
  overlaps: number;
  onGrid: number;
  inBounds: number;
  crossingPhrase: number;
  longestGapSteps: number;
  intervalVariety: number;
  repeatedDurationPattern: number;
}

function melodicStats(pattern: Pattern, options: GenerateOptions): MelodicStats {
  const trackIds = Object.keys(pattern.notes ?? {});
  const notes: NoteEvent[] = [];
  const perTrackShares: number[] = [];
  let overlaps = 0;
  let onGrid = 0;
  let inBounds = 0;
  for (const trackId of trackIds) {
    const trackNotes = pattern.notes?.[trackId] ?? [];
    perTrackShares.push(trackNotes.length);
    const sorted = [...trackNotes].sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length; i++) {
      notes.push(sorted[i]);
      if (Number.isInteger(sorted[i].start / 30)) onGrid += 1; // 128th grid
      if (sorted[i].pitch >= 12 && sorted[i].pitch <= 108) inBounds += 1;
      const next = sorted[i + 1];
      if (next && next.start < sorted[i].start + Math.max(0, sorted[i].duration)) overlaps += 1;
    }
  }
  const stepCount = options.stepCount;
  const phraseBars = Math.max(1, Math.floor(stepCount / 16 / 4) || 1);
  const phraseTicks = phraseBars * 16 * 120;
  let crossingPhrase = 0;
  let longestGap = 0;
  const sortedAll = [...notes].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sortedAll.length; i++) {
    const note = sortedAll[i];
    if (i > 0) {
      const gap = note.start - (sortedAll[i - 1].start + Math.max(0, sortedAll[i - 1].duration));
      longestGap = Math.max(longestGap, gap);
    }
    if (Math.floor(note.start / phraseTicks) !== Math.floor((note.start + Math.max(0, note.duration) - 1) / phraseTicks))
      crossingPhrase += 1;
  }
  // Interval variety + repeated duration patterns (3-gram style, mirrors quality.ts).
  const intervalKeys = new Set<string>();
  const durationKeys = new Map<string, number>();
  for (let i = 0; i + 2 < sortedAll.length; i++) {
    const i1 = sortedAll[i + 1].pitch - sortedAll[i].pitch;
    const i2 = sortedAll[i + 2].pitch - sortedAll[i + 1].pitch;
    intervalKeys.add(`${i1}:${i2}`);
    const dKey = `${Math.round(sortedAll[i].duration / 120)},${Math.round(sortedAll[i + 1].duration / 120)}`;
    durationKeys.set(dKey, (durationKeys.get(dKey) ?? 0) + 1);
  }
  const repeated = [...durationKeys.values()].reduce((sum, count) => sum + (count > 1 ? 1 : 0), 0);
  return {
    present: notes.length > 0,
    notes: sortedAll,
    perTrackShares,
    overlaps,
    onGrid,
    inBounds,
    crossingPhrase,
    longestGapSteps: longestGap / 120,
    intervalVariety: sortedAll.length > 2 ? intervalKeys.size / Math.max(1, sortedAll.length - 2) : 0,
    repeatedDurationPattern: durationKeys.size > 0 ? repeated / durationKeys.size : 0,
  };
}

/* ────────────────────────── the extractor ────────────────────────── */

export function extractPatternFeatures(input: PatternFeatureInput): PatternFeatureVector {
  const { doc, pattern, intent, options } = input;
  const values: number[] = [];
  let clippedCount = 0;
  const push = (value: number | undefined, fallback = 0): void => {
    const [v, clipped] = unit(value, fallback);
    if (clipped) clippedCount += 1;
    values.push(v);
  };

  const groove: GrooveData = resolveGrooveForGeneration(doc, options);
  const stepCount = Math.max(1, options.stepCount);
  const bars = Math.max(1, stepCount / 16);
  const drums = drumStats(doc, pattern, options);
  const melodic = melodicStats(pattern, options);
  const drumQuality = measureDrumQuality(groove, drums.rows, drums.roles, stepCount);
  const styleGate = evaluateStyleDistance(groove, drums.rows, stepCount);
  const melodicQuality = measureMelodicQuality(melodic.notes, stepCount, options.key ?? doc.key);

  const intentBpmIn = (bpm: number): boolean =>
    !intent.bpmRange || (bpm >= intent.bpmRange[0] && bpm <= intent.bpmRange[1]);

  // ── intent fit (8) ──
  push(drums.present ? 1 - Math.abs(drums.density - clamp01(intent.density)) : 0.5);
  push(drums.present ? 1 - Math.abs(drums.velocityMean - clamp01(intent.energy)) : 0.5);
  push(
    drums.present
      ? 1 - Math.abs(drums.cells > 0 ? drums.metaEntries / drums.cells : 0 - clamp01(intent.complexity))
      : 0.5,
  );
  push(1 - Math.abs(drumQuality.barRepetition - clamp01(intent.variation)));
  const lengthBars = intent.length > 0 ? intent.length : bars;
  push(1 - Math.min(1, Math.abs(bars - lengthBars) / Math.max(1, lengthBars)));
  push(intentBpmIn(input.resolvedBpm ?? doc.bpm) ? 1 : 0);
  push(intent.roles.includes("drums") ? 1 : 0);
  push(intent.roles.some((role) => role !== "drums") ? 1 : 0);

  // ── drum structure (8) ──
  push(drums.density);
  push(drums.rows.length > 0 ? drums.activeRows / drums.rows.length : 0);
  push(drums.downbeatTotal > 0 ? drums.downbeatCovered / drums.downbeatTotal : 0.5);
  push(drums.backbeatTotal > 0 ? drums.backbeatCovered / drums.backbeatTotal : 0.5);
  push(drumQuality.anchorCoverage);
  push(balance(drumRolesShares(drums.roles, drums.rows, stepCount)));
  push(drums.present ? hatEvenness(drums.roles, drums.rows, stepCount) : 0);
  push(drums.hits > 0 ? drums.ghosts / drums.hits : 0);

  // ── drum groove (6) ──
  push(drumQuality.syncopation);
  push(drums.hits > 0 ? drums.offbeats / drums.hits : 0);
  push(1 - clamp01(Number.isFinite(styleGate.distance) ? styleGate.distance : 1));
  push(drumQuality.barRepetition);
  push(drumQuality.velocityContrast);
  push(drums.metaEntries > 0 ? drums.microtimed / Math.max(1, drums.metaEntries) : 0);

  // ── melodic structure (10) ──
  const melodicCells = Math.max(1, stepCount * Math.max(1, melodic.perTrackShares.length));
  push(melodic.notes.length / melodicCells);
  push(melodicQuality.restRatio);
  push(clamp01(melodicQuality.pitchRange / 24));
  push(clamp01(((melodic.notes.reduce((sum, note) => sum + note.pitch, 0) / Math.max(1, melodic.notes.length)) - 24) / 60));
  push(clamp01(melodicQuality.durationDistribution.short / Math.max(1, melodic.notes.length)));
  push(clamp01(melodicQuality.durationDistribution.medium / Math.max(1, melodic.notes.length)));
  push(clamp01(melodicQuality.durationDistribution.long / Math.max(1, melodic.notes.length)));
  push(balance(melodic.perTrackShares));
  push(melodicQuality.scaleValidity);
  push(clamp01(melodicQuality.occupiedStepRatio));

  // ── melodic motif (6) ──
  push(melodicQuality.motifRepetition);
  push(melodicQuality.motifNovelty);
  push(clamp01(melodic.intervalVariety * 2));
  push(clamp01(melodic.repeatedDurationPattern));
  push(melodic.notes.length > 0 ? 1 - clamp01(melodic.crossingPhrase / melodic.notes.length) : 1);
  push(clamp01(melodic.longestGapSteps / Math.max(1, stepCount)));

  // ── musical validity (6) ──
  push(melodic.notes.length > 0 ? melodic.onGrid / melodic.notes.length : 1);
  push(melodic.notes.length > 0 ? melodic.inBounds / melodic.notes.length : 1);
  push(melodic.notes.length > 0 ? 1 - clamp01(melodic.overlaps / melodic.notes.length) : 1);
  push(validRowShape(pattern, stepCount));
  push(validStepMeta(pattern, stepCount));
  push(drums.cells > 0 ? clamp01(drums.metaEntries / Math.max(1, drums.hits)) : 0.5);

  // ── candidate-relative (4): 0.5 + 0.5 × clamped deviation from batch mean ──
  const batch = input.batch ?? [pattern];
  const batchStats = batch.map((candidate) => candidateDensityEnergy(candidate, options));
  const meanDensity = mean(batchStats.map((s) => s.density));
  const meanEnergy = mean(batchStats.map((s) => s.energy));
  const meanStyle = mean(batch.map((candidate) => styleDistanceOf(candidate, doc, options)));
  const meanAnchor = mean(batch.map((candidate) => anchorCoverageOf(candidate, doc, options)));
  const deviation = (value: number, batchMean: number): number =>
    0.5 + 0.5 * Math.max(-1, Math.min(1, batchMean > 0 || batchMean < 0 ? (value - batchMean) * 2 : 0));
  push(deviation(drums.density, meanDensity));
  push(deviation(drums.velocityMean, meanEnergy));
  push(deviation(styleGate.distance, meanStyle));
  push(deviation(drumQuality.anchorCoverage, meanAnchor));

  // ── presence flags (6): 1 = absent/neutral ──
  push(drums.present ? 0 : 1);
  push(melodic.present ? 0 : 1);
  push(drums.metaEntries > 0 || Object.keys(pattern.notes ?? {}).length > 0 ? 0 : 1);
  push(options.key ?? doc.key ? 0 : 1);
  push(melodic.notes.length > 0 ? 0 : 1);
  push(drums.hits > 0 || melodic.notes.length > 0 ? 0 : 1);

  // ── contract enforcement: finite + clipped Float32Array ──
  const finalValues = new Float32Array(values.length);
  let finite = true;
  for (let i = 0; i < values.length; i++) {
    const raw = values[i];
    const value = Number.isFinite(raw) ? raw : 0;
    if (!Number.isFinite(raw)) finite = false;
    finalValues[i] = Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;
  }
  return {
    version: FEATURE_CONTRACT.version,
    values: finalValues,
    names: FEATURE_NAMES,
    finite,
    clippedCount,
    featureHash: hashValues(finalValues),
  };
}

/* ────────────────────────── shared small extractors ────────────────────────── */

function drumRolesShares(roles: readonly PadRole[], rows: readonly (number[] | undefined)[], stepCount: number): number[] {
  const share = new Map<PadRole, number>();
  for (const [index, role] of roles.entries()) {
    const row = rows[index];
    if (!row) continue;
    let hits = 0;
    for (let step = 0; step < stepCount; step++) if ((row[step] ?? 0) > 0) hits += 1;
    share.set(role, (share.get(role) ?? 0) + hits);
  }
  return [...share.values()];
}

function hatEvenness(roles: readonly PadRole[], rows: readonly (number[] | undefined)[], stepCount: number): number {
  for (const [index, role] of roles.entries()) {
    if (role !== "closedHat" && role !== "openHat") continue;
    const row = rows[index];
    if (!row) continue;
    let even = 0;
    let total = 0;
    for (let step = 0; step < stepCount; step += 2) {
      total += 1;
      if ((row[step] ?? 0) > 0) even += 1;
    }
    if (total > 0) return even / total;
  }
  return 0.5;
}

function validRowShape(pattern: Pattern, stepCount: number): number {
  const rows = Object.values(pattern.rows ?? {});
  if (rows.length === 0) return 1;
  const ok = rows.filter((row) => Array.isArray(row) && row.length >= stepCount).length;
  return ok / rows.length;
}

function validStepMeta(pattern: Pattern, stepCount: number): number {
  const entries = Object.entries(pattern.stepMeta ?? {});
  if (entries.length === 0) return 1;
  let ok = 0;
  let total = 0;
  for (const [padId, steps] of entries) {
    for (const [stepKey, meta] of Object.entries(steps)) {
      const step = Number(stepKey);
      total += 1;
      const row = pattern.rows?.[padId];
      if (
        Number.isInteger(step) &&
        step >= 0 &&
        step < stepCount &&
        (row?.[step] ?? 0) > 0 &&
        (!meta.probability || (meta.probability >= 0 && meta.probability <= 1))
      )
        ok += 1;
    }
  }
  return total > 0 ? ok / total : 1;
}

function candidateDensityEnergy(
  candidate: Pattern,
  options: GenerateOptions,
): { density: number; energy: number } {
  let hits = 0;
  let cells = 0;
  const velocities: number[] = [];
  for (const row of Object.values(candidate.rows ?? {})) {
    for (let step = 0; step < options.stepCount; step++) {
      cells += 1;
      const value = row[step] ?? 0;
      if (value > 0) {
        hits += 1;
        velocities.push(value);
      }
    }
  }
  return { density: cells > 0 ? hits / cells : 0, energy: mean(velocities) };
}

function styleDistanceOf(candidate: Pattern, doc: ProjectDocument, options: GenerateOptions): number {
  const groove: GrooveData = resolveGrooveForGeneration(doc, options);
  const rows = Object.values(candidate.rows ?? {});
  return evaluateStyleDistance(groove, rows, options.stepCount).distance;
}

function anchorCoverageOf(candidate: Pattern, doc: ProjectDocument, options: GenerateOptions): number {
  const groove: GrooveData = resolveGrooveForGeneration(doc, options);
  const drumTrack = doc.tracks.find((track) => track.kind === "drum");
  const rows = drumTrack?.kind === "drum" ? drumTrack.pads.map((pad) => candidate.rows?.[pad.id]) : [];
  const roles = drumTrack?.kind === "drum" ? drumTrack.pads.map((pad, index) => inferPadRole(pad.name, index)) : [];
  return measureDrumQuality(groove, rows, roles, options.stepCount).anchorCoverage;
}
