import { levelMatchGainsDb, type LevelMatchGains } from "../analysis/levelMatch";
import { binomialTwoSidedPValue } from "../listening/abx-stats";

/**
 * IN-APP BLIND A/B (quality roadmap P4 completion — the app-side half).
 *
 * The offline ABX pipeline (scripts/generate-abx-listening.mts + the static
 * page + trials.jsonl) measures DISCRIMINATION with a human listener and an
 * external server. But an agent working INSIDE KYX could not run a blind
 * comparison of two mix decisions at all — the machinery existed only
 * offline. This module is the in-app half:
 *
 *   - `renderBlindPairPlans` — given two project docs (the A/B variants),
 *     derives the symmetric LUFS level-matching gains from the SAME pure
 *     helper the offline page uses, so neither render is privileged,
 *   - `recordBlindAbTrial` / `summarizeBlindAb` — a session-scoped trial
 *     log with the exact two-sided binomial verdict (chance 0.5), so a
 *     listening session (the human clicking in the UI) accumulates
 *     statistically honest evidence per lane.
 *
 * The agent cannot hear — this makes its comparisons DECIDABLE BY NUMBERS:
 * discrimination p-value on top of the objective loudness/duration stats.
 */

export interface BlindAbPairPlan {
  /** Playback gains (dB) that land both sides on their mean LUFS. */
  gains: LevelMatchGains;
  note: string;
}

/** Symmetric level-matching plan for one A/B pair. Pure; never throws —
 * unmeasurable sides degrade to native levels with matched:false. */
export function planBlindPairGains(lufsA: number | null, lufsB: number | null): BlindAbPairPlan {
  const gains = levelMatchGainsDb(lufsA, lufsB);
  return { gains, note: gains.note };
}

export interface BlindAbTrial {
  lane: string;
  xWas: "A" | "B";
  answer: "A" | "B";
  correct: boolean;
  reactionMs?: number;
  receivedAt: number;
}

/** Session-local ceilings keep repeated MCP calls from growing this log without bound. */
export const BLIND_AB_MAX_LANE_LENGTH = 128;
export const BLIND_AB_MAX_LANES = 64;
export const BLIND_AB_MAX_TRIALS_PER_LANE = 1_000;
export const BLIND_AB_MAX_TRIALS = 5_000;
export const BLIND_AB_MAX_REACTION_MS = 86_400_000;

export class BlindAbTrialLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlindAbTrialLimitError";
  }
}

/** In-memory per-session trial log — the app-side mirror of the offline
 * trials.jsonl. Module-level by design (one listener per app session). */
const trialsByLane = new Map<string, BlindAbTrial[]>();
let trialCount = 0;

/** Test hook — clears every lane's log. */
export function resetBlindAbTrials(): { clearedLanes: number; clearedTrials: number } {
  const clearedLanes = trialsByLane.size;
  const clearedTrials = trialCount;
  trialsByLane.clear();
  trialCount = 0;
  return { clearedLanes, clearedTrials };
}

export function recordBlindAbTrial(trial: {
  lane: string;
  xWas: "A" | "B";
  answer: "A" | "B";
  reactionMs?: number;
}): BlindAbTrial {
  if (trial.lane.length > BLIND_AB_MAX_LANE_LENGTH) {
    throw new BlindAbTrialLimitError(`blind A/B lane names are limited to ${BLIND_AB_MAX_LANE_LENGTH} characters`);
  }
  const currentLane = trialsByLane.get(trial.lane);
  if (currentLane == null && trialsByLane.size >= BLIND_AB_MAX_LANES) {
    throw new BlindAbTrialLimitError(
      `blind A/B session is limited to ${BLIND_AB_MAX_LANES} lanes; reset the log first`,
    );
  }
  if ((currentLane?.length ?? 0) >= BLIND_AB_MAX_TRIALS_PER_LANE) {
    throw new BlindAbTrialLimitError(
      `blind A/B lane is limited to ${BLIND_AB_MAX_TRIALS_PER_LANE} trials; reset the log first`,
    );
  }
  if (trialCount >= BLIND_AB_MAX_TRIALS) {
    throw new BlindAbTrialLimitError(
      `blind A/B session is limited to ${BLIND_AB_MAX_TRIALS} trials; reset the log first`,
    );
  }
  const entry: BlindAbTrial = {
    lane: trial.lane,
    xWas: trial.xWas,
    answer: trial.answer,
    correct: trial.answer === trial.xWas,
    ...(trial.reactionMs !== undefined ? { reactionMs: Math.max(0, Math.round(trial.reactionMs)) } : {}),
    receivedAt: Date.now(),
  };
  const log = currentLane ?? [];
  log.push(entry);
  trialsByLane.set(trial.lane, log);
  trialCount += 1;
  return entry;
}

export interface BlindAbSummary {
  lane: string;
  total: number;
  correct: number;
  /** Two-sided exact binomial p vs chance 0.5 (lower = real discrimination). */
  pValue: number;
  /** Standard haste filter, same threshold the offline ingest uses. */
  hastyExcluded: number;
  /** Human-verdict text: what the evidence actually supports. */
  verdict: string;
}

/** Trials under this reaction time are excluded from the p-value (random
 * clicking is noise, not evidence) — mirrors the offline haste filter. */
export const BLIND_AB_HASTE_MS = 1500;

export function summarizeBlindAb(lane: string): BlindAbSummary | null {
  const log = trialsByLane.get(lane);
  if (!log || log.length === 0) return null;
  const considered = log.filter((t) => t.reactionMs == null || t.reactionMs >= BLIND_AB_HASTE_MS);
  const total = considered.length;
  const correct = considered.filter((t) => t.correct).length;
  const hastyExcluded = log.length - total;
  const pValue = total === 0 ? 1 : binomialTwoSidedPValue(correct, total);
  let verdict: string;
  if (total === 0) {
    verdict = "no usable trials yet (all too hasty to count)";
  } else if (pValue < 0.01) {
    verdict = "STRONG discrimination — the listener reliably tells A from B";
  } else if (pValue < 0.05) {
    verdict = "significant discrimination — likely a real, audible difference";
  } else {
    verdict = "no significant discrimination — A and B are (so far) indistinguishable";
  }
  return { lane, total, correct, pValue, hastyExcluded, verdict };
}
