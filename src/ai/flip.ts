import { detectLoopBpm } from "../audio-engine/bpm-detect";
import { extractGroove, type StealGrooveMap } from "../audio-engine/groove-extract";
import type { GenerateOptions } from "./types";

/**
 * AI Flip — turns an imported loop into a native PF pattern.
 *
 * The loop is analysed (tempo + groove), the generator produces a fresh
 * pattern in the target genre at the PROJECT tempo/key, and the loop's own
 * groove (timing + accents) is baked on top. The result: a new scene with
 * your loop's feel, playable and editable like any PF pattern — no audio
 * dependency, no pitch artifacts, infinitely tweakable.
 *
 * Pure analysis + option mapping (no async, no bank) — the UI orchestrates
 * the commands: generatePatternCommand → stealGrooveIntoPattern.
 */

export interface LoopFlipAnalysis {
  /** Detected loop tempo (the feel lives in the loop, not the project). */
  bpm: number;
  /** Suggested pattern length in bars (loop duration folded to 1..4 bars). */
  bars: number;
  /** Extracted groove at the loop's own tempo — apply at the PROJECT tempo. */
  groove: StealGrooveMap;
  /** 16ths per bar used for the groove grid. */
  stepsPerBar: number;
}

const FLIP_STEPS_PER_BAR = 16;

export function analyzeLoopForFlip(data: Float32Array, sampleRate: number): LoopFlipAnalysis | null {
  const detected = detectLoopBpm(data, sampleRate);
  if (!detected) return null;
  const duration = data.length / sampleRate;
  const barSec = (60 / detected.bpm) * 4;
  const bars = Math.max(1, Math.min(4, Math.round(duration / barSec)));
  // The groove grid always maps ONE bar (16 steps) — longer loops fold onto
  // it, accents accumulate from the strongest pass (extractGroove handles it).
  const groove = extractGroove(data, sampleRate, detected.bpm, FLIP_STEPS_PER_BAR);
  if (!groove) return null;
  return { bpm: detected.bpm, bars, groove, stepsPerBar: FLIP_STEPS_PER_BAR };
}

/**
 * Map the loop analysis onto generator options. `stepCount` spans the flipped
 * pattern (bars × 16); timing/accents come later via stealGrooveIntoPattern,
 * which folds its map across the pattern length.
 */
export function buildFlipOptions(
  analysis: LoopFlipAnalysis,
  genre: GenerateOptions["genre"],
  seed: string,
): GenerateOptions {
  const stepCount = Math.max(16, Math.min(64, analysis.bars * analysis.stepsPerBar));
  return {
    genre,
    seed,
    stepCount,
    ghostWeight: 0.35,
    microWeight: 0.35,
    velocityVariation: 0.5,
    temperature: 0.8,
    replaceMode: "new",
  };
}

/** Deterministic default seed derived from the analysis (same flip → same flip). */
export function flipSeed(analysis: LoopFlipAnalysis): string {
  return `flip-${Math.round(analysis.bpm * 10)}-${analysis.bars}b`;
}
